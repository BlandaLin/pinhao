import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import path from 'node:path';

const magic = Buffer.from('5850330d0a200a1a8b6701', 'hex');
const maxIndex = 128 * 1024 * 1024, maxText = 16 * 1024 * 1024;
const tag = /\[(?:[^\[\]\r\n"']|"[^"\r\n]*"|'[^'\r\n]*'|\[[^\]\r\n]*\])*\]/g;
const fail = message => { throw Object.assign(new Error(message), { code: 'FORMAT_PRESERVATION_FAILED' }); };
const integer = (buffer, offset) => {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('XP3 offset exceeds the exact integer range');
  return Number(value);
};
function memberName(value) {
  const name = value.replaceAll('\\', '/');
  if (!name || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) fail('Unsafe XP3 member identity');
  return name;
}
function chunks(buffer) {
  const result = [];
  for (let offset = 0; offset < buffer.length;) {
    if (offset + 12 > buffer.length) fail('Truncated XP3 index chunk');
    const kind = buffer.toString('ascii', offset, offset + 4), length = integer(buffer, offset + 4);
    offset += 12;
    if (length > buffer.length - offset) fail('XP3 index chunk exceeds its container');
    result.push([kind, buffer.subarray(offset, offset + length)]); offset += length;
  }
  return result;
}
function decompress(buffer, length) {
  const result = inflateSync(buffer, { maxOutputLength: length + 1, info: true });
  if (result.buffer.length !== length || result.engine.bytesWritten !== buffer.length) fail('XP3 compressed payload length differs');
  return result.buffer;
}
async function exact(handle, offset, length) {
  const buffer = Buffer.alloc(length); let cursor = 0;
  while (cursor < length) {
    const { bytesRead } = await handle.read(buffer, cursor, length - cursor, offset + cursor);
    if (!bytesRead) fail('Truncated XP3 payload'); cursor += bytesRead;
  }
  return buffer;
}
async function archive(handle) {
  const { size } = await handle.stat();
  if (!(await exact(handle, 0, magic.length)).equals(magic)) fail('Expected a standard XP3 carrier; executable overlays require the native member route');
  let pointer = integer(await exact(handle, magic.length, 8), 0);
  const indices = new Set(), entries = new Map(), names = new Set();
  while (true) {
    if (pointer < 19 || pointer >= size || indices.has(pointer)) fail('Invalid or cyclic XP3 index');
    indices.add(pointer);
    const flag = (await exact(handle, pointer, 1))[0];
    if (flag & ~0x81) fail('Unsupported XP3 index flags');
    const sizes = await exact(handle, pointer + 1, flag & 1 ? 16 : 8);
    const packed = integer(sizes, 0), length = flag & 1 ? integer(sizes, 8) : packed;
    const start = pointer + 1 + sizes.length;
    if (Math.max(packed, length) > maxIndex || start + packed > size) fail('XP3 index length is invalid');
    const raw = await exact(handle, start, packed);
    for (const [kind, item] of chunks(flag & 1 ? decompress(raw, length) : raw)) {
      if (kind !== 'File') continue;
      const fields = new Map();
      for (const [key, value] of chunks(item)) { if (fields.has(key)) fail('Duplicate XP3 metadata'); fields.set(key, value); }
      const info = fields.get('info'), segments = fields.get('segm'), checksum = fields.get('adlr');
      if (!info || info.length < 22 || !segments || segments.length % 28 || checksum?.length !== 4 || info.length !== 22 + info.readUInt16LE(20) * 2) fail('Malformed XP3 file metadata');
      const name = memberName(new TextDecoder('utf-16le', { fatal: true }).decode(info.subarray(22)));
      const folded = name.toLowerCase();
      if (names.has(folded)) fail('XP3 member identities collide'); names.add(folded);
      const parts = [];
      for (let cursor = 0; cursor < segments.length; cursor += 28) {
        const method = segments.readUInt32LE(cursor), offset = integer(segments, cursor + 4), decoded = integer(segments, cursor + 12), stored = integer(segments, cursor + 20);
        if (method > 1 || offset < 19 || offset + stored > size || !method && decoded !== stored || method && Math.max(decoded, stored) > maxIndex) fail('Invalid XP3 segment');
        parts.push({ method, offset, decoded, stored });
      }
      if (parts.reduce((n, part) => n + part.decoded, 0) !== integer(info, 4) || parts.reduce((n, part) => n + part.stored, 0) !== integer(info, 12)) fail('XP3 segment totals differ');
      entries.set(name, { name, size: integer(info, 4), flags: info.readUInt32LE(0), checksum: checksum.readUInt32LE(0), parts });
    }
    if (!(flag & 0x80)) break;
    pointer = integer(await exact(handle, start + packed, 8), 0);
  }
  for (const name of entries.keys()) {
    const pieces = name.split('/'); pieces.pop();
    while (pieces.length) { if (names.has(pieces.join('/').toLowerCase())) fail('XP3 file/directory collision'); pieces.pop(); }
  }
  return entries;
}
async function payload(handle, entry, collect = false) {
  if (collect && entry.size > maxText) fail('XP3 script exceeds the supported text member limit');
  const digest = createHash('sha256'), buffers = []; let a = 1, b = 0;
  const consume = bytes => {
    digest.update(bytes); if (collect) buffers.push(bytes);
    for (let start = 0; start < bytes.length; start += 5552) {
      for (const value of bytes.subarray(start, start + 5552)) { a += value; b += a; }
      a %= 65521; b %= 65521;
    }
  };
  for (const part of entry.parts) {
    if (part.method) consume(decompress(await exact(handle, part.offset, part.stored), part.decoded));
    else for (let offset = 0; offset < part.stored; offset += 1024 * 1024) consume(await exact(handle, part.offset + offset, Math.min(1024 * 1024, part.stored - offset)));
  }
  if (((b * 65536 + a) >>> 0) !== entry.checksum) fail('XP3 checksum does not match decoded bytes; an extraction filter is required');
  return { hash: digest.digest('hex'), bytes: collect ? Buffer.concat(buffers) : undefined };
}
function document(bytes) {
  let encoding, bom = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; bom = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; bom = 2; }
  else if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) { encoding = 'utf-8'; bom = 3; }
  else {
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8', bom }; }
    catch { encoding = 'shift_jis'; }
  }
  return { text: new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(bom)), encoding, bom };
}
function displayRanges(text) {
  const ranges = []; let blocked, start, end;
  const flush = () => { if (start !== undefined && text.slice(start, end).trim()) ranges.push({ start, end, kind: 'paragraph' }); start = end = undefined; };
  for (const match of text.matchAll(/[^\n]*\n|[^\n]+$/g)) {
    const line = match[0], trimmed = line.trim(), offset = match.index + line.length - line.trimStart().length;
    if (blocked) {
      if (blocked === 'comment' && trimmed === '*/' || new RegExp(`^(?:\\[end${blocked}\\]|@end${blocked})$`, 'i').test(trimmed)) blocked = undefined;
      continue;
    }
    if (trimmed === '/*') { flush(); blocked = 'comment'; continue; }
    if (!trimmed || /^[;*#]/.test(trimmed)) { flush(); continue; }
    const directive = /^(?:@|\[)(iscript|html)\b/i.exec(trimmed);
    if (directive) { flush(); blocked = directive[1].toLowerCase() === 'iscript' ? 'script' : 'html'; continue; }
    const wholeTag = trimmed.match(tag)?.[0] === trimmed;
    if (trimmed.startsWith('@') || wholeTag) {
      flush();
      for (const attr of trimmed.matchAll(/\b(text|jname|placeholder|title)\s*=\s*("([^"\r\n]*)"|'([^'\r\n]*)')/g)) {
        const value = attr[3] ?? attr[4];
        if (value.startsWith('&') || value.startsWith('%')) continue;
        const begin = offset + attr.index + attr[0].indexOf(attr[2]) + 1;
        ranges.push({ start: begin, end: begin + value.length, kind: 'attribute', quote: attr[2][0] });
      }
      continue;
    }
    if (/\[(?:iscript|html)\b/i.test(trimmed)) fail('Embedded script block is not a supported text span');
    start ??= match.index; end = match.index + line.replace(/[\r\n]+$/, '').length;
  }
  flush(); if (blocked) fail('Unclosed KAG script/comment block');
  return ranges;
}
function locate(bytes, doc, unit) {
  const locator = unit.locator;
  if (!['kag-text', 'container-member-text'].includes(locator.format)) fail('XP3 text locator must explicitly identify the KAG display grammar');
  const declared = locator.encoding?.toLowerCase().replaceAll('_', '-').replace('utf-16-le', 'utf-16le').replace('utf-16-be', 'utf-16be');
  if (declared && declared !== doc.encoding && !(declared === 'cp932' && doc.encoding === 'shift_jis')) fail('XP3 member encoding differs from locator');
  let start, end;
  if (Number.isSafeInteger(locator.byteStart) && Number.isSafeInteger(locator.byteEnd)) {
    if (locator.byteStart < doc.bom || locator.byteEnd < locator.byteStart || locator.byteEnd > bytes.length) fail('Member byte span is out of range');
    const decoder = () => new TextDecoder(doc.encoding, { fatal: true });
    start = decoder().decode(bytes.subarray(doc.bom, locator.byteStart)).length;
    end = start + decoder().decode(bytes.subarray(locator.byteStart, locator.byteEnd)).length;
  } else fail('Container text requires member-relative byteStart/byteEnd');
  if (doc.text.slice(start, end) !== unit.rawSource) fail('XP3 member text does not match its locator');
  return { start, end };
}
async function verifyFiles({ beforePaths, afterPaths, units, translations, signal }) {
  for (const file of Object.keys(beforePaths)) {
    const beforeHandle = await open(beforePaths[file], 'r'); let afterHandle;
    try {
      afterHandle = await open(afterPaths[file], 'r');
      const before = await archive(beforeHandle), after = await archive(afterHandle);
      if (before.size !== after.size || [...before.keys()].some(name => !after.has(name))) fail('XP3 membership changed');
      const byMember = new Map();
      for (const unit of units.filter(unit => unit.locator.file === file)) {
        const name = memberName(unit.locator.member), list = byMember.get(name) ?? [];
        list.push(unit); byMember.set(name, list);
      }
      for (const member of byMember.keys()) if (!before.has(member)) fail('XP3 text member is missing');
      for (const [name, original] of before) {
        signal?.throwIfAborted(); const actual = after.get(name), selected = byMember.get(name);
        if (original.flags !== actual.flags) fail('XP3 member flags changed');
        const first = await payload(beforeHandle, original, !!selected), second = await payload(afterHandle, actual, !!selected);
        if (!selected) { if (first.hash !== second.hash) fail('Non-target XP3 member changed'); continue; }
        if (path.posix.extname(name).toLowerCase() !== '.ks') fail('The qualified XP3 text profile only accepts KAG script members');
        const doc = document(first.bytes), output = document(second.bytes), ranges = displayRanges(doc.text);
        const spans = selected.map(unit => ({ unit, ...locate(first.bytes, doc, unit) })).sort((a, b) => a.start - b.start);
        let cursor = 0; const pieces = [];
        for (const span of spans) {
          const range = ranges.find(range => range.start === span.start && range.end === span.end);
          if (!range || span.start < cursor) fail('Locator is not a complete, non-overlapping KAG display unit');
          const value = translations[span.unit.id] ?? span.unit.rawSource;
          if (range.kind === 'attribute' && (value.includes(range.quote) || /[\[\]\r\n]/.test(value))) fail('Translation changes a KAG command attribute grammar');
          if (range.kind === 'paragraph' && /(?:^|\r?\n)[ \t]*[#*@;]/.test(value)) fail('Translation introduces a KAG command line');
          if (range.kind === 'paragraph' && JSON.stringify(span.unit.rawSource.match(tag) ?? []) !== JSON.stringify(value.match(tag) ?? [])) fail('Translation changes KAG command tags');
          pieces.push(doc.text.slice(cursor, span.start), value); cursor = span.end;
        }
        pieces.push(doc.text.slice(cursor));
        if (pieces.join('') !== output.text) fail('XP3 output changes non-target script text or does not contain the requested translation');
        displayRanges(output.text);
      }
    } finally { await Promise.all([beforeHandle.close(), afterHandle?.close()]); }
  }
  return { status: 'passed', claims: { structure: 'passed', targets: 'passed', preservation: 'passed', derivedFields: 'passed' } };
}

export function xp3TextProfile(contentRef) {
  return { capabilityId: 'builtin-xp3-kag-text', profileFamily: 'xp3-kag-members',
    locatorContracts: ['container-member-text-span'], claims: ['structure', 'targets', 'preservation', 'derivedFields'],
    integrationModes: ['independent', 'exclusive-resource-group'], contentRef,
    limits: { archive: 'standard XP3 / zlib / checksummed unfiltered members', member: '.ks', encoding: ['utf-8', 'utf-16le', 'utf-16be', 'cp932'],
      locator: { file: 'archive.xp3', member: 'scenario/story.ks', format: 'kag-text', encoding: 'utf-16le', byteStart: 'member-relative including BOM', byteEnd: 'exclusive member-relative' },
      displayGrammar: 'complete KAG paragraphs or static text/jname/placeholder/title attributes; excludes script, HTML, labels and references' },
    match: ({ units }) => {
      const selected = units.filter(unit => path.extname(unit.locator?.file ?? '').toLowerCase() === '.xp3' && typeof unit.locator?.member === 'string');
      if (!selected.length) return null;
      return { writeSet: [...new Set(selected.map(unit => unit.locator.file))], unitIds: selected.map(unit => unit.id) };
    },
    identity: locator => JSON.stringify([locator.file, locator.member, locator.format, locator.encoding, locator.byteStart, locator.byteEnd]),
    verifyFiles };
}
