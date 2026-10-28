import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { createFormatCapabilities } from './format-capabilities.mjs';
import { verifyFormatGroups } from './format-verification.mjs';

const magic = Buffer.from('5850330d0a200a1a8b6701', 'hex');
const u64 = value => { const raw = Buffer.alloc(8); raw.writeBigUInt64LE(BigInt(value)); return raw; };
const u32 = value => { const raw = Buffer.alloc(4); raw.writeUInt32LE(value); return raw; };
const chunk = (kind, bytes) => Buffer.concat([Buffer.from(kind), u64(bytes.length), bytes]);
function adler(bytes) { let a = 1, b = 0; for (const value of bytes) { a = (a + value) % 65521; b = (b + a) % 65521; } return (b * 65536 + a) >>> 0; }
function archive(files, compressed = true) {
  const data = [], index = []; let offset = 19;
  for (const [name, bytes] of Object.entries(files)) {
    const payload = compressed ? deflateSync(bytes) : bytes, encoded = Buffer.from(name, 'utf16le'), chars = Buffer.alloc(2);
    chars.writeUInt16LE(encoded.length / 2);
    const info = Buffer.concat([u32(0), u64(bytes.length), u64(payload.length), chars, encoded]);
    const segment = Buffer.concat([u32(compressed ? 1 : 0), u64(offset), u64(bytes.length), u64(payload.length)]);
    index.push(chunk('File', Buffer.concat([chunk('info', info), chunk('segm', segment), chunk('adlr', u32(adler(bytes)))])));
    data.push(payload); offset += payload.length;
  }
  const raw = Buffer.concat(index), packed = deflateSync(raw);
  return Buffer.concat([magic, u64(offset), ...data, Buffer.from([1]), u64(packed.length), u64(raw.length), packed]);
}
const encoded = text => Buffer.concat([Buffer.from([255, 254]), Buffer.from(text, 'utf16le')]);
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-xp3-proof-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const gameDir = path.join(root, 'before'), outputDir = path.join(root, 'after');
  await mkdir(gameDir); await mkdir(outputDir);
  const text = '*start\n[iscript]\nvar state = "Logic";\n[endscript]\n[link text="Choice" target=*next]\nHello[r]world[p]\n';
  const source = 'Hello[r]world[p]', begin = text.indexOf(source);
  const unit = { id: 'kag:line', source, rawSource: source, locator: { file: 'data.xp3', member: 'scenario/first.ks', format: 'kag-text', encoding: 'utf-16le', byteStart: 2 + begin * 2, byteEnd: 2 + (begin + source.length) * 2 } };
  const files = { 'scenario/first.ks': encoded(text), 'image/opaque.bin': Buffer.from([0, 1, 20, 30, 255]) };
  await writeFile(path.join(gameDir, 'data.xp3'), archive(files));
  const manifest = { scope: { files: ['data.xp3'] } }, catalog = await createFormatCapabilities();
  const plan = await catalog.plan({ units: [unit], manifest });
  const candidate = { candidateId: 'candidate-test', codeHash: 'a'.repeat(64), manifest };
  return { gameDir, outputDir, text, source, unit, files, catalog, plan, candidate,
    verify: translations => verifyFormatGroups({ catalog, plan, candidate, gameDir, outputDir, units: [unit], translations, purpose: 'candidate-sample' }) };
}

test('host independently verifies UTF16 KAG members and variable length Chinese in compressed XP3', async t => {
  const f = await fixture(t), translation = '你好，欢迎来到这里[r]请继续[p]';
  await writeFile(path.join(f.outputDir, 'data.xp3'), archive({ ...f.files, 'scenario/first.ks': encoded(f.text.replace(f.source, translation)) }, false));
  const receipts = await f.verify({ 'kag:line': translation });
  assert.equal(receipts[0].claims.preservation, 'passed');
  assert.equal(receipts[0].capabilityRef.capabilityId, 'builtin-xp3-kag-text');
  assert.notEqual(receipts[0].beforeHashes['data.xp3'], receipts[0].outputHashes['data.xp3']);
});

test('host rejects code/comment locations, wrong member offsets, changed media and changed control tags', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.outputDir, 'data.xp3'), archive(f.files));
  const logic = f.text.indexOf('Logic'), bad = { ...f.unit, rawSource: 'Logic', locator: { ...f.unit.locator, byteStart: 2 + logic * 2, byteEnd: 2 + (logic + 5) * 2 } };
  const plan = await f.catalog.plan({ units: [bad], manifest: f.candidate.manifest });
  await assert.rejects(verifyFormatGroups({ ...f, units: [bad], plan, translations: {}, purpose: 'candidate-sample' }), { code: 'FORMAT_PRESERVATION_FAILED' });
  await writeFile(path.join(f.outputDir, 'data.xp3'), archive({ ...f.files, 'image/opaque.bin': Buffer.from('changed') }));
  await assert.rejects(f.verify({}), /Non-target/);
  const removed = '你好世界';
  await writeFile(path.join(f.outputDir, 'data.xp3'), archive({ ...f.files, 'scenario/first.ks': encoded(f.text.replace(f.source, removed)) }));
  await assert.rejects(f.verify({ 'kag:line': removed }), /command tags/);
  const absolute = { ...f.unit, locator: { ...f.unit.locator, byteStart: 19, byteEnd: 24 } };
  await writeFile(path.join(f.outputDir, 'data.xp3'), archive(f.files));
  await assert.rejects(verifyFormatGroups({ ...f, units: [absolute], translations: {}, purpose: 'candidate-sample' }));
});

test('binary archives cannot pass by merely claiming UTF8 byte spans or adding an arbitrary member grammar', async t => {
  const f = await fixture(t), { member, format, ...flat } = f.unit.locator;
  await assert.rejects(f.catalog.plan({ units: [{ ...f.unit, locator: flat }], manifest: f.candidate.manifest }), { code: 'FORMAT_UNSUPPORTED' });
  await writeFile(path.join(f.outputDir, 'data.xp3'), archive(f.files));
  const bad = { ...f.unit, locator: { ...f.unit.locator, format: 'anything' } };
  const plan = await f.catalog.plan({ units: [bad], manifest: f.candidate.manifest });
  await assert.rejects(verifyFormatGroups({ ...f, units: [bad], plan, translations: {}, purpose: 'candidate-sample' }), /display grammar/);
});

test('member-relative UTF8 offsets can be verified through an explicit UTF16 output migration', async t => {
  const f = await fixture(t), begin = f.text.indexOf(f.source), translation = '变长中文[r]正文[p]';
  const unit = { ...f.unit, locator: { ...f.unit.locator, encoding: 'utf-8', byteStart: Buffer.byteLength(f.text.slice(0, begin)), byteEnd: Buffer.byteLength(f.text.slice(0, begin + f.source.length)) } };
  const plan = await f.catalog.plan({ units: [unit], manifest: f.candidate.manifest });
  await writeFile(path.join(f.gameDir, 'data.xp3'), archive({ ...f.files, 'scenario/first.ks': Buffer.from(f.text) }));
  await writeFile(path.join(f.outputDir, 'data.xp3'), archive({ ...f.files, 'scenario/first.ks': encoded(f.text.replace(f.source, translation)) }));
  const receipt = await verifyFormatGroups({ ...f, units: [unit], plan, translations: { 'kag:line': translation }, purpose: 'candidate-sample' });
  assert.equal(receipt[0].claims.targets, 'passed');
});
