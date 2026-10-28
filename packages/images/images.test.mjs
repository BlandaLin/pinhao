import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { applyImageText, imageCandidates, prepareImages, stageImageText } from './index.mjs';
import { createHash } from 'node:crypto';
import { readRequestArtifact } from '../core/request-artifacts.mjs';

const rootDir = path.resolve('local/images-tests');
const fontPath = path.resolve('local/runtime/fonts/LXGWWenKai-Regular.ttf');
await mkdir(rootDir, { recursive: true });

async function fixture(t, { response, image, replies } = {}) {
  const root = await mkdtemp(path.join(rootDir, 'image-'));
  const gameDir = path.join(root, 'game');
  await mkdir(path.join(gameDir, 'img', 'system'), { recursive: true });
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const content = replies?.[requests.length - 1] ?? response ?? { regions: [{ source: 'Start', box: { left: 8, top: 8, width: 180, height: 40 } }] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'ocr-test', object: 'chat.completion', created: 0, model: 'test', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const connection = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'neutral-vision-test', apiKey: 'test-key-never-persist' };
  const label = image ?? await sharp({ create: { width: 200, height: 60, channels: 4, background: '#eeeeee' } }).composite([{ input: Buffer.from('<svg width="200" height="60"><text x="24" y="37" fill="#111111" font-size="24">Start</text></svg>') }]).png().toBuffer();
  await writeFile(path.join(gameDir, 'img', 'system', 'Menu.png'), label);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  const args = { gameDir, inventory: [{ file: 'img/system/Menu.png' }], connection, fontPath };
  return { root, gameDir, requests, args, label };
}

test('candidate scope includes named UI, excludes CG and reports deterministic excluded range', () => {
  assert.deepEqual(imageCandidates([{ file: 'img/system/Menu.png' }, { file: 'img/pictures/tutorial1.jpg' }, { file: 'img/CG/menu.png' }, { file: 'img/pictures/scene001.png' }, { file: 'img/system/Menu.png' }]), { files: ['img/pictures/tutorial1.jpg', 'img/system/Menu.png'], excluded: ['img/CG/menu.png', 'img/pictures/scene001.png'] });
  assert.throws(() => imageCandidates([{ file: '../other.png' }]));
  assert.throws(() => imageCandidates([{ file: 'C:/other.png' }]));
});

test('archive image sources are materialized only for actual OCR and changed-image staging', async t => {
  const f = await fixture(t);
  const image = 'img/system/Menu.png', calls = [];
  await rm(path.join(f.gameDir, image));
  const materialize = async files => {
    calls.push(...files);
    for (const file of files) {
      assert.equal(file, image);
      await writeFile(path.join(f.gameDir, file), f.label);
    }
  };
  const prepared = await prepareImages({ ...f.args, inventory: [{ file: image }, { file: 'img/CG/scene.png' }], materialize });
  assert.deepEqual(calls, [image]);
  assert.equal(prepared.units.length, 1);
  await rm(path.join(f.gameDir, image));
  const staged = await stageImageText({ sourceDir: f.gameDir, outputDir: path.join(f.root, 'staged-archive'),
    binding: prepared.binding, translations: [{ id: prepared.units[0].id, translation: '\u5f00\u59cb' }], fontPath, materialize });
  assert.equal(staged.changed, 1);
  assert.deepEqual(calls, [image, image]);
  assert.deepEqual(await readFile(path.join(f.gameDir, image)), f.label);
});

test('archive materialization participates in header discovery and source failures are not hidden', async t => {
  const f = await fixture(t), calls = [];
  const packed = 'img/system/packed.bin';
  const materialize = async files => {
    calls.push(...files);
    for (const file of files) await writeFile(path.join(f.gameDir, file), f.label);
  };
  const result = await prepareImages({ ...f.args, inventory: [{ file: packed }], materialize });
  assert.equal(result.units.length, 1);
  assert.deepEqual(calls, [packed, packed]);
  const sourceChanged = Object.assign(new Error('ASAR original changed'), { code: 'SOURCE_CHANGED' });
  await assert.rejects(prepareImages({ ...f.args, materialize: async () => { throw sourceChanged; } }), { code: 'SOURCE_CHANGED' });
  assert.equal(f.requests.length, 1);
});

test('packed-engine image staging writes authenticated PNG copies and leaves original resources intact', async t => {
  const f = await fixture(t);
  const prepared = await prepareImages(f.args);
  const outputDir = path.join(f.root, 'staged');
  const result = await stageImageText({ sourceDir: f.gameDir, outputDir, binding: prepared.binding,
    translations: [{ id: prepared.units[0].id, translation: '开始' }], fontPath });
  assert.equal(result.changed, 1);
  const png = await readFile(path.join(outputDir, 'img/system/Menu.png'));
  assert.notDeepEqual(png, f.label);
  assert.equal(result.files[0].sha256, createHash('sha256').update(png).digest('hex'));
  assert.equal(result.files[0].sourceHash, createHash('sha256').update(f.label).digest('hex'));
  assert.deepEqual(await readFile(path.join(f.gameDir, 'img/system/Menu.png')), f.label);
  await assert.rejects(stageImageText({ sourceDir: f.gameDir, outputDir: path.join(f.root, 'invalid'), binding: prepared.binding,
    translations: [{ id: 'unknown', translation: '开始' }], fontPath }), /未知/);
});

test('image staging skips a missing source while retaining other translated PNGs', async t => {
  const f = await fixture(t);
  const prepared = await prepareImages(f.args);
  const missing = { ...prepared.binding.files[0], relative: 'img/system/Missing.png',
    regions: prepared.binding.files[0].regions.map(region => ({ ...region, id: `${region.id}:missing` })) };
  const binding = { ...prepared.binding, files: [missing, ...prepared.binding.files] };
  const translations = binding.files.flatMap(file => file.regions.map(region => ({ id: region.id, translation: '开始' })));
  const result = await stageImageText({ sourceDir: f.gameDir, outputDir: path.join(f.root, 'staged'),
    binding, translations, fontPath });
  assert.equal(result.changed, 1);
  assert.equal(result.files[0].file, 'img/system/Menu.png');
  assert.equal(result.issues[0].code, 'IMAGE_REDRAW_FAILED');
  assert.equal(result.issues[0].file, 'img/system/Missing.png');
});

test('real SDK sends image data, extracts whole blocks, hashes source and retains relative locators', async t => {
  const f = await fixture(t);
  const progress = [];
  const result = await prepareImages({ ...f.args, onProgress: item => progress.push(item) });
  assert.equal(f.requests.length, 1);
  // Vision OCR must bound its own output instead of leaving the response open-ended.
  const ceiling = f.requests[0].max_tokens ?? f.requests[0].max_completion_tokens;
  assert.ok(Number.isInteger(ceiling) && ceiling > 0, `OCR requests declare a positive output ceiling, got ${String(ceiling)}`);
  const content = f.requests[0].messages.find(message => message.role === 'user').content;
  assert(content.some(item => item.type === 'image_url' && item.image_url.url.startsWith('data:image/png;base64,')));
  assert.equal(result.units.length, 1);
  assert.equal(result.units[0].kind, 'image_text');
  assert.equal(result.units[0].translation, 'Start');
  assert.equal(result.units[0].context.file, 'img/system/Menu.png');
  assert.match(result.units[0].context.imageSourceHash, /^[a-f0-9]{64}$/);
  assert.equal(result.binding.files[0].sourceHash, result.units[0].context.imageSourceHash);
  assert(!JSON.stringify(result).includes('test-key-never-persist'));
  assert.equal(result.done, true);
  assert.equal(progress[0].completed, 1);
  assert.deepEqual(await readFile(path.join(f.gameDir, 'img/system/Menu.png')), f.label);
});

test('optional OCR keeps actual model request artifacts outside the image writeback binding', async t => {
  const f = await fixture(t);
  const result = await prepareImages({ ...f.args, artifactDir: path.join(f.root, 'private-requests') });
  assert.equal(result.requestArtifacts.length, 1);
  const reference = result.requestArtifacts[0];
  assert.equal(reference.finalBodyCaptured, true);
  const request = await readRequestArtifact(reference);
  const capturedCeiling = request.body.max_tokens ?? request.body.max_completion_tokens;
  assert.ok(Number.isInteger(capturedCeiling) && capturedCeiling > 0, `the captured artifact shows the output ceiling, got ${String(capturedCeiling)}`);
  assert.ok(request.body.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.image_url?.url.startsWith('data:image/png;base64,'))));
  assert.equal(JSON.stringify(request).includes('test-key-never-persist'), false);
  assert.equal(JSON.stringify(result.binding).includes('private-requests'), false);
  assert.match(await readFile(path.join(reference.directory, 'final.txt'), 'utf8'), /regions/);
});

test('invalid OCR retries twice, skips original, never returns partially trusted boxes', async t => {
  const f = await fixture(t, { response: { regions: [{ source: 'Start', box: { left: -1, top: 2, width: 20, height: 20 } }] } });
  const result = await prepareImages(f.args);
  assert.equal(f.requests.length, 2);
  assert.equal(result.units.length, 0);
  assert.equal(result.issues[0].code, 'IMAGE_OCR_FAILED');
  assert.deepEqual(await readFile(path.join(f.gameDir, 'img/system/Menu.png')), f.label);
});

test('transient response failure retries, batches resume by stable candidate offset', async t => {
  const f = await fixture(t, { replies: ['not JSON', { regions: [] }] });
  await cp(path.join(f.gameDir, 'img/system/Menu.png'), path.join(f.gameDir, 'img/system/Title.png'));
  const inventory = [{ file: 'img/system/Menu.png' }, { file: 'img/system/Title.png' }, { file: 'img/pictures/CG01.png' }];
  const first = await prepareImages({ ...f.args, inventory, limit: 1 });
  assert.equal(first.nextOffset, 1);
  assert.equal(first.done, false);
  assert.equal(first.binding.scope.excludedCount, 1);
  const second = await prepareImages({ ...f.args, inventory, offset: first.nextOffset, limit: 1 });
  assert.equal(second.done, true);
  assert.equal(second.binding.scope.offset, 1);
  // Title.png is a byte-identical copy of Menu.png, so the content cache reuses its result and no
  // third request is issued: the two attempts below are Menu's own (invalid JSON, then empty regions).
  assert.equal(f.requests.length, 2);
});

test('aborted OCR task stays resumable rather than becoming a skipped image', async t => {
  const f = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareImages({ ...f.args, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.requests.length, 0);
});

test('flat PNG label redraw uses bundled font and preserves all outside pixels and original', async t => {
  const f = await fixture(t);
  const result = await prepareImages(f.args);
  const outputDir = path.join(f.root, 'output'); await cp(f.gameDir, outputDir, { recursive: true });
  const applied = await applyImageText({ outputDir, binding: result.binding, translations: [{ id: result.units[0].id, translation: '开始' }], fontPath });
  assert.deepEqual(applied.issues, []);
  assert.equal(applied.changed, 1);
  const before = await sharp(f.label).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const outBytes = await readFile(path.join(outputDir, 'img/system/Menu.png'));
  const after = await sharp(outBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(after.info.width, before.info.width); assert.equal(after.info.height, before.info.height);
  let insideChanges = 0;
  for (let y = 0; y < before.info.height; y++) for (let x = 0; x < before.info.width; x++) {
    const at = (y * before.info.width + x) * 4;
    const same = before.data.subarray(at, at + 4).equals(after.data.subarray(at, at + 4));
    if (x < 8 || y < 8 || x >= 188 || y >= 48) assert(same, `outside pixel changed at ${x},${y}`);
    else if (!same) insideChanges++;
  }
  assert(insideChanges > 100);
  assert.deepEqual(await readFile(path.join(f.gameDir, 'img/system/Menu.png')), f.label);
});

test('baseline change and complex backgrounds preserve the current PNG', async t => {
  const noise = await sharp({ create: { width: 200, height: 60, channels: 4, noise: { type: 'gaussian', mean: 128, sigma: 50 } } }).png().toBuffer();
  const f = await fixture(t, { image: noise });
  const result = await prepareImages(f.args);
  const outputDir = path.join(f.root, 'output'); await cp(f.gameDir, outputDir, { recursive: true });
  const translations = [{ id: result.units[0].id, translation: '开始' }];
  const complex = await applyImageText({ outputDir, binding: result.binding, translations, fontPath });
  assert.equal(complex.changed, 0); assert.equal(complex.issues[0].code, 'IMAGE_COMPLEX_BACKGROUND');
  assert.deepEqual(await readFile(path.join(outputDir, 'img/system/Menu.png')), noise);
  await writeFile(path.join(outputDir, 'img/system/Menu.png'), f.label.subarray(0, 50));
  const stale = await applyImageText({ outputDir, binding: result.binding, translations, fontPath });
  assert.equal(stale.changed, 0); assert.equal(stale.issues[0].code, 'IMAGE_BASELINE_CHANGED');
});

test('unknown and duplicate IDs are rejected before output writes', async t => {
  const f = await fixture(t);
  const result = await prepareImages(f.args);
  const outputDir = path.join(f.root, 'output'); await cp(f.gameDir, outputDir, { recursive: true });
  await assert.rejects(applyImageText({ outputDir, binding: result.binding, translations: [{ id: 'unknown', translation: '开始' }], fontPath }), /未知/);
  const row = { id: result.units[0].id, translation: '开始' };
  await assert.rejects(applyImageText({ outputDir, binding: result.binding, translations: [row, row], fontPath }), /重复/);
  assert.deepEqual(await readFile(path.join(outputDir, 'img/system/Menu.png')), f.label);
});

test('JPEG text can enter workbench while native lossy assets remain untouched', async t => {
  const f = await fixture(t);
  const jpeg = await sharp(f.label).jpeg().toBuffer();
  await writeFile(path.join(f.gameDir, 'img/system/Menu.jpg'), jpeg);
  const result = await prepareImages({ ...f.args, inventory: [{ file: 'img/system/Menu.jpg' }] });
  const outputDir = path.join(f.root, 'output'); await cp(f.gameDir, outputDir, { recursive: true });
  const applied = await applyImageText({ outputDir, binding: result.binding, translations: [{ id: result.units[0].id, translation: '开始' }], fontPath });
  assert.equal(applied.changed, 0); assert.equal(applied.issues[0].code, 'IMAGE_REDRAW_FORMAT');
  assert.deepEqual(await readFile(path.join(outputDir, 'img/system/Menu.jpg')), jpeg);
});

test('transparent label canvas keeps its alpha and literal markup is rendered as text', async t => {
  const image = await sharp({ create: { width: 200, height: 60, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: Buffer.from('<svg width="200" height="60"><text x="24" y="37" fill="#111111" font-size="24">Start</text></svg>') }]).png().toBuffer();
  const f = await fixture(t, { image });
  const result = await prepareImages(f.args);
  const outputDir = path.join(f.root, 'output'); await cp(f.gameDir, outputDir, { recursive: true });
  const applied = await applyImageText({ outputDir, binding: result.binding, translations: [{ id: result.units[0].id, translation: 'A < B & C' }], fontPath });
  assert.equal(applied.changed, 1); assert.deepEqual(applied.issues, []);
  const after = await sharp(await readFile(path.join(outputDir, 'img/system/Menu.png'))).ensureAlpha().raw().toBuffer();
  assert.equal(after[3], 0);
  assert(after.some((value, index) => index % 4 === 3 && value > 0));
});

test('overdense translation preserves readable source label rather than shrinking to tiny text', async t => {
  const f = await fixture(t);
  const result = await prepareImages(f.args);
  const outputDir = path.join(f.root, 'output'); await cp(f.gameDir, outputDir, { recursive: true });
  const applied = await applyImageText({ outputDir, binding: result.binding, translations: [{ id: result.units[0].id, translation: '很长的中性说明。'.repeat(80) }], fontPath });
  assert.equal(applied.changed, 0); assert.equal(applied.issues[0].code, 'IMAGE_TEXT_FIT');
  assert.deepEqual(await readFile(path.join(outputDir, 'img/system/Menu.png')), f.label);
});

test('OCR and returned translations normalize Windows paragraph line endings', async t => {
  const f = await fixture(t, { response: { regions: [{ source: 'Start\r\nNow', box: { left: 8, top: 8, width: 180, height: 40 } }] } });
  const result = await prepareImages(f.args);
  assert.equal(result.units[0].source, 'Start\nNow');
  const outputDir = path.join(f.root, 'output'); await cp(f.gameDir, outputDir, { recursive: true });
  const applied = await applyImageText({ outputDir, binding: result.binding, translations: [{ id: result.units[0].id, translation: '开始\r\n制作' }], fontPath });
  assert.equal(applied.changed, 1); assert.deepEqual(applied.issues, []);
});
