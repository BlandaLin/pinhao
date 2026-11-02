import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { checkedPath, relativeFile } from './paths.mjs';
import { readTable, verifyTable, tableAdapterCode } from './table-format.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const fileOf = unit => String(unit.locator?.file ?? unit.context?.adaptationLocator?.file ?? unit.context?.file ?? '').replace(/^res:\/\//, '').replaceAll('\\', '/').replace(/^\.\//, '');
const folded = file => file.toLowerCase();

/** Agent chooses evidenced fields; the host supplies syntax and lexical spans. */
export async function createTableSelections({ selections, gameDir, engine, assignment, existingUnits = [], id }) {
  if (!Array.isArray(selections) || !selections.length || selections.length > 2000) throw new Error('Select 1..2000 complete table display fields');
  const documents = new Map(), specs = [], seen = new Set(), producerHints = [], names = new Map();
  for (const selection of selections) {
    const file = relativeFile(selection.file);
    if (assignment && !assignment.files.includes(file)) throw new Error('Table field is outside the current assignment; request scope first');
    if (typeof selection.reason !== 'string' || !selection.reason.trim() || selection.reason.length > 4000) throw new Error('Table field needs actual display consumer evidence in reason');
    if (names.has(folded(file)) && names.get(folded(file)) !== file) throw new Error('Table files collide on Windows');
    names.set(folded(file), file);
    let document = documents.get(file);
    if (!document) {
      const source = await checkedPath(gameDir, file);
      if ((await lstat(source)).size > 16 * 1024 * 1024) throw new Error('Table selection uses text resources up to 16 MiB');
      const bytes = await readFile(source), view = readTable({ bytes, file });
      document = { bytes, view }; documents.set(file, document);
    }
    const { view, bytes } = document;
    const delimiter = selection.delimiter ?? view.delimiter;
    if (delimiter !== view.delimiter) throw new Error('Explicit table dialect differs from the trusted parsed view');
    const table = { delimiter, keyColumn: selection.keyColumn, sourceColumn: selection.sourceColumn, targetColumn: selection.targetColumn, key: selection.key };
    if (Object.values(table).some(value => typeof value !== 'string' || !value)) throw new Error('Table key/source/target columns and key must be explicit strings');
    const [keyColumn, sourceColumn, targetColumn] = [table.keyColumn, table.sourceColumn, table.targetColumn].map(name => view.header.indexOf(name));
    if (Math.min(keyColumn, sourceColumn, targetColumn) < 0 || keyColumn === sourceColumn || keyColumn === targetColumn) throw new Error('Table columns are missing or overlap the key identity');
    const rows = view.rows.filter(row => row[keyColumn].value === table.key);
    if (rows.length !== 1) throw new Error('Table key must identify exactly one record');
    const cell = rows[0][targetColumn], source = cell.value || rows[0][sourceColumn].value;
    if (!source.trim()) throw new Error('Table selection has no complete nonempty display source');
    const locator = { file, format: 'table-cell', encoding: 'utf-8', table, byteStart: cell.byteStart, byteEnd: cell.byteEnd };
    const unitId = `table:${hash([file, table.keyColumn, table.targetColumn, table.key])}`;
    if (seen.has(unitId)) throw new Error('Duplicate table field selection');
    for (const unit of existingUnits) {
      if (folded(fileOf(unit)) !== folded(file)) continue;
      const owned = unit.locator ?? unit.context?.adaptationLocator;
      const sameCell = owned?.table?.keyColumn === table.keyColumn && owned.table.targetColumn === table.targetColumn && owned.table.key === table.key;
      const overlapping = Number.isSafeInteger(owned?.byteStart) && Number.isSafeInteger(owned?.byteEnd)
        && (owned.byteStart === locator.byteStart || owned.byteStart < locator.byteEnd && owned.byteEnd > locator.byteStart);
      if (sameCell || overlapping) throw new Error('Table field is already owned by an existing extractor');
    }
    const prior = specs.filter(spec => spec.file === file);
    const schema = JSON.stringify([delimiter, table.keyColumn, table.sourceColumn, table.targetColumn]);
    if (prior.some(spec => JSON.stringify([spec.table.delimiter, spec.table.keyColumn, spec.table.sourceColumn, spec.table.targetColumn]) !== schema)) throw new Error('One table write group requires one consistent key/source/target schema');
    // Validate every key and the source span with the independent host oracle.
    verifyTable({ before: bytes, after: bytes, units: [{ id: unitId, rawSource: source, locator }], translations: {} });
    seen.add(unitId); specs.push({ id: unitId, file, table, reason: selection.reason });
    producerHints.push({ unitId, selector: { file, table }, hints: [{ reason: selection.reason }] });
  }
  specs.sort((a, b) => a.file.localeCompare(b.file) || a.id.localeCompare(b.id));
  return { manifest: { schemaVersion: 1, id: id ?? `table-${hash(specs.map(({ reason, ...spec }) => spec))}`, version: '1.0.0', engine: engine || 'unknown',
    scope: { files: [...documents.keys()].sort() }, license: 'GPL-3.0-or-later', sources: [] }, code: tableAdapterCode(specs), producerHints };
}
