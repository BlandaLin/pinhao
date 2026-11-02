import path from 'node:path';

const fail = message => { throw Object.assign(new Error(message), { code: 'FORMAT_TABLE_INVALID' }); };
const size = text => Buffer.byteLength(text, 'utf8');

// Port of toolkit/text_formats.py csv_cells: keep lexical field spans, not line numbers.
// Pure functions are also serialized into generated QuickJS adapters.
export function tableCells(text, delimiter) {
  if (![',', '\t'].includes(delimiter)) throw new Error('Table delimiter must be comma or tab');
  const rows = []; let row = [], pos = 0;
  while (pos < text.length) {
    const start = pos; let value = '';
    if (text[pos] === '"') {
      pos++; let closed = false;
      while (pos < text.length) {
        const character = text[pos++];
        if (character !== '"') { value += character; continue; }
        if (text[pos] === '"') { value += '"'; pos++; continue; }
        closed = true; break;
      }
      if (!closed || pos < text.length && ![delimiter, '\r', '\n'].includes(text[pos])) throw new Error('Malformed quoted table field');
    } else {
      while (pos < text.length && ![delimiter, '\r', '\n'].includes(text[pos])) {
        if (text[pos] === '"') throw new Error('Quote inside unquoted table field');
        value += text[pos++];
      }
    }
    row.push({ value, start, end: pos });
    if (pos === text.length) { rows.push(row); break; }
    if (text[pos] === delimiter) {
      pos++;
      if (pos === text.length) { row.push({ value: '', start: pos, end: pos }); rows.push(row); }
      continue;
    }
    pos += text.slice(pos, pos + 2) === '\r\n' ? 2 : 1;
    rows.push(row); row = [];
  }
  if (!rows.length || !rows[0].length) throw new Error('Empty table');
  const header = rows[0].map(cell => cell.value);
  if (header.some(value => !value) || new Set(header).size !== header.length) throw new Error('Table headers must be nonempty and unique');
  if (rows.some(cells => cells.length !== header.length)) throw new Error('Table column count changed');
  return { header, rows };
}

export function renderTableCell(value) {
  if (typeof value !== 'string') throw new Error('Table value must be text');
  return '"' + value.replaceAll('"', '""') + '"';
}

function document(bytes, delimiter) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail('Table reader requires valid UTF-8; other encodings need a qualified reader'); }
  const bom = text.startsWith('\ufeff') ? '\ufeff' : '';
  text = text.slice(bom.length);
  try {
    const parsed = tableCells(text, delimiter); let cursor = 0, byteCursor = size(bom);
    for (const row of parsed.rows) for (const cell of row) {
      byteCursor += size(text.slice(cursor, cell.start)); cell.byteStart = byteCursor;
      byteCursor += size(text.slice(cell.start, cell.end)); cell.byteEnd = byteCursor; cursor = cell.end;
    }
    return { ...parsed, text, bom, delimiter, encoding: 'utf-8' };
  }
  catch (error) { fail(error.message); }
}

function schemaFor(locator) {
  const schema = locator.table;
  if (locator.format !== 'table-cell' || locator.encoding !== 'utf-8' || !schema
      || ![',', '\t'].includes(schema.delimiter)
      || ['keyColumn', 'sourceColumn', 'targetColumn', 'key'].some(key => typeof schema[key] !== 'string' || !schema[key])
      || schema.targetColumn === schema.keyColumn || schema.sourceColumn === schema.keyColumn) {
    throw Object.assign(new Error('CSV/TSV needs table-cell, utf-8, delimiter, key/source/target columns and a unique key; use the structured table reader'), { code: 'FORMAT_TABLE_SCHEMA_REQUIRED' });
  }
  return schema;
}

function select(doc, schema) {
  const columns = ['keyColumn', 'sourceColumn', 'targetColumn'].map(name => doc.header.indexOf(schema[name]));
  if (columns.some(column => column < 0)) fail('Table schema column is missing');
  if (!doc.keyedRows) {
    doc.keyedRows = new Map();
    for (const cells of doc.rows.slice(1)) {
      const key = cells[columns[0]].value;
      if (!key || doc.keyedRows.has(key)) fail('Table keys must be nonempty and unique');
      doc.keyedRows.set(key, cells);
    }
  }
  const cells = doc.keyedRows.get(schema.key);
  if (!cells) fail('Table key no longer exists');
  return { cell: cells[columns[2]], source: cells[columns[1]].value };
}

export function readTable({ bytes, file }) {
  const delimiter = path.extname(file).toLowerCase() === '.tsv' ? '\t' : ',';
  const doc = document(bytes, delimiter);
  return { format: 'table-cells-1', encoding: doc.encoding, bom: !!doc.bom, delimiter,
    header: doc.header, rows: doc.rows.slice(1).map(cells => cells.map(cell => ({ value: cell.value,
      byteStart: cell.byteStart, byteEnd: cell.byteEnd }))),
    selectionContract: { format: 'table-cell', encoding: 'utf-8', table: { delimiter, keyColumn: 'existing unique header',
      sourceColumn: 'existing display source header', targetColumn: 'existing writable display header (not key)', key: 'unique row key' } },
    rendering: 'double-quoted field; double each embedded quote; preserve all other bytes; offsets include BOM' };
}

export function verifyTable({ before, after, units, translations = {}, requestedIds = Object.keys(translations) }) {
  const selected = new Map(), requested = new Set(requestedIds); let doc, delimiter, schemaIdentity;
  for (const unit of units) {
    const schema = schemaFor(unit.locator);
    const identity = JSON.stringify([schema.delimiter, schema.keyColumn, schema.sourceColumn, schema.targetColumn]);
    if (schemaIdentity !== undefined && schemaIdentity !== identity) fail('One table write group requires one consistent key/source/target schema');
    schemaIdentity = identity;
    if (delimiter !== undefined && delimiter !== schema.delimiter) fail('Conflicting table dialects for one resource');
    delimiter = schema.delimiter; doc ??= document(before, delimiter);
    const { cell, source } = select(doc, schema);
    const start = cell.byteStart, end = cell.byteEnd;
    if (unit.locator.byteStart !== start || unit.locator.byteEnd !== end || (cell.value || source) !== unit.rawSource) fail('Table field span/source no longer matches the unique key and column');
    if (selected.has(start)) fail('Duplicate table field target');
    selected.set(start, { end, value: requested.has(unit.id) ? translations[unit.id] : cell.value });
  }
  if (!doc) fail('Table verification needs selected fields');
  const output = document(after, delimiter);
  if (JSON.stringify(output.header) !== JSON.stringify(doc.header) || output.rows.length !== doc.rows.length || output.bom !== doc.bom) fail('Table header, row count or BOM changed');
  let cursor = 0; const pieces = [];
  for (let row = 0; row < doc.rows.length; row++) for (let column = 0; column < doc.header.length; column++) {
    const cell = doc.rows[row][column], actual = output.rows[row][column];
    const start = cell.byteStart, target = selected.get(start);
    if (actual.value !== (target ? target.value : cell.value)) fail('Table target readback or non-target value differs');
    if (target) {
      // A writer may retain the lexical representation of an unchanged field.
      const encoded = target.value === cell.value ? before.subarray(start, target.end) : Buffer.from(renderTableCell(target.value));
      pieces.push(before.subarray(cursor, start), encoded); cursor = target.end;
    }
  }
  pieces.push(before.subarray(cursor));
  if (!Buffer.concat(pieces).equals(after)) fail('Table writer changed non-target bytes or did not use the qualified field rendering');
  return { status: 'passed', claims: { structure: 'passed', targets: 'passed', preservation: 'passed', derivedFields: 'passed' } };
}

export function tableProfile(contentRef) {
  return { capabilityId: 'builtin-table-cells', profileFamily: 'table-cells', contentRef,
    claims: ['structure', 'targets', 'preservation', 'derivedFields'], locatorContracts: ['keyed-table-cell'],
    integrationModes: ['independent', 'exclusive-resource-group'],
    limits: { encoding: ['utf-8'], dialects: ['csv-comma-doublequote', 'tsv-tab-doublequote'],
      displayAuthorization: 'consumer evidence required; headers/extensions do not authorize translation', locator: 'table-cell with delimiter/keyColumn/sourceColumn/targetColumn/key and lexical byteStart/byteEnd' },
    read: readTable,
    match: ({ units }) => {
      const selected = units.filter(unit => unit.locator?.format === 'table-cell');
      if (!selected.length) return null;
      for (const unit of selected) schemaFor(unit.locator);
      return { writeSet: [...new Set(selected.map(unit => unit.locator.file))], unitIds: selected.map(unit => unit.id) };
    },
    identity: locator => JSON.stringify([locator.file, locator.format, locator.encoding, locator.table, locator.byteStart, locator.byteEnd]),
    verify: ({ before, after, units, translations, requestedIds }) => {
      for (const file of Object.keys(before)) verifyTable({ before: before[file], after: after[file], units: units.filter(unit => unit.locator.file === file), translations, requestedIds });
      return { status: 'passed', claims: { structure: 'passed', targets: 'passed', preservation: 'passed', derivedFields: 'passed' } };
    } };
}

// Generated code uses the same lexical parser/renderer, but the host verifies the
// emitted bytes independently and reparses every actual build, not only a sample.
export function tableAdapterCode(selections) {
  function adapter(specifications, parse, render) {
    const byteSize = text => { let n = 0; for (const ch of text) { const c = ch.codePointAt(0); n += c < 128 ? 1 : c < 2048 ? 2 : c < 65536 ? 3 : 4; } return n; };
    const load = (host, file) => {
      const original = host.readText(file), bom = original.startsWith('\ufeff') ? '\ufeff' : '', text = original.slice(bom.length);
      const specs = specifications.filter(item => item.file === file), doc = parse(text, specs[0].table.delimiter);
      let cursor = 0, byteCursor = byteSize(bom);
      for (const row of doc.rows) for (const cell of row) {
        byteCursor += byteSize(text.slice(cursor, cell.start)); cell.byteStart = byteCursor;
        byteCursor += byteSize(text.slice(cell.start, cell.end)); cell.byteEnd = byteCursor; cursor = cell.end;
      }
      const schema = specs[0].table, keyed = new Map(), keyColumn = doc.header.indexOf(schema.keyColumn);
      if (keyColumn < 0) throw new Error('Table key column changed');
      for (const row of doc.rows.slice(1)) {
        const key = row[keyColumn].value;
        if (!key || keyed.has(key)) throw new Error('Table key missing or duplicated');
        keyed.set(key, row);
      }
      const targets = specs.map(spec => {
        const keyIndex = doc.header.indexOf(spec.table.keyColumn), targetIndex = doc.header.indexOf(spec.table.targetColumn), sourceIndex = doc.header.indexOf(spec.table.sourceColumn);
        if (Math.min(keyIndex, targetIndex, sourceIndex) < 0 || targetIndex === keyIndex) throw new Error('Table columns changed');
        if (JSON.stringify([spec.table.delimiter, spec.table.keyColumn, spec.table.sourceColumn, spec.table.targetColumn]) !== JSON.stringify([schema.delimiter, schema.keyColumn, schema.sourceColumn, schema.targetColumn])) throw new Error('Conflicting table schemas');
        const row = keyed.get(spec.table.key);
        if (!row) throw new Error('Table key missing');
        const cell = row[targetIndex], value = cell.value || row[sourceIndex].value;
        return { spec, cell, value, locator: { file, format: 'table-cell', encoding: 'utf-8', table: spec.table,
          byteStart: cell.byteStart, byteEnd: cell.byteEnd } };
      });
      return { text, bom, targets };
    };
    const files = [...new Set(specifications.map(item => item.file))];
    return { detect: () => true,
      extract(host) { return { units: files.flatMap(file => load(host, file).targets.map(({ spec, value, locator }) => ({ id: spec.id, source: value, kind: 'table-display', locator, context: { file, table: spec.table, ...(spec.reason ? { reason: spec.reason } : {}) } }))) }; },
      validate: () => ({ valid: true }),
      roundtrip(host) { for (const file of files) host.writeBytes(file, host.readBytes(file)); },
      build(host, input) { for (const file of files) {
        const { text, bom, targets } = load(host, file); let cursor = 0; const pieces = [bom];
        for (const { spec, cell } of targets.sort((a, b) => a.cell.start - b.cell.start)) {
          if (cell.start < cursor) throw new Error('Overlapping table targets');
          const value = Object.hasOwn(input.translations, spec.id) ? input.translations[spec.id] : cell.value;
          pieces.push(text.slice(cursor, cell.start), value === cell.value ? text.slice(cell.start, cell.end) : render(value)); cursor = cell.end;
        }
        pieces.push(text.slice(cursor)); host.writeText(file, pieces.join(''));
      } }, assemble: () => ({ complete: true }) };
  }
  return `(${adapter.toString()})(${JSON.stringify(selections)},${tableCells.toString()},${renderTableCell.toString()})`;
}
