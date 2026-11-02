import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createNativeTools } from './native-tools.mjs';
import { productWorker } from '../../apps/desktop/electron/host.mjs';
import { createAdapterLab } from '../technical/adaptation/adapter-lab.mjs';
import { adaptationTools } from '../technical/adaptation.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const parent = path.resolve('local/native-archive-selection-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'case-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }));
  const gameDir = path.join(root, 'game'), workDir = path.join(root, 'task'), source = path.join(root, 'source');
  for (const dir of [gameDir, workDir, path.join(source, 'data')]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(source, 'data/story.txt'), 'A complete source caption.');
  await writeFile(path.join(source, 'media.bin'), Buffer.alloc(1024 * 1024, 17));
  const bundledPython = path.resolve('local/runtime/python/python.exe');
  const pythonPath = process.env.PINHAO_PYTHON ?? await access(bundledPython).then(() => bundledPython, () => process.platform === 'win32' ? 'python' : 'python3');
  const realWorker = productWorker({ pythonPath, workerPath: path.resolve('adapters/python/worker.py'),
    toolkitPath: path.resolve('kits/workbench-tutorial/toolkit'), dependencyDir: path.resolve('local/dependencies'), timeoutMs: 60000 });
  const calls = [], native = createNativeTools({ worker: async (command, input, options) => {
    calls.push({ command, input }); return realWorker(command, input, options);
  } });
  return { root, source, gameDir, workDir, realWorker, native, calls };
}

test('Agent indexes, selects, reuses and safely repacks actual ZIP/XP3/RGSS carriers', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  for (const format of ['zip', 'xp3', 'rgss']) {
    const file = `game.${format === 'rgss' ? 'rgssad' : format}`, archive = path.join(f.gameDir, file);
    await f.realWorker('native_repack', { inputDir: f.source, outputFile: archive, format });
    const before = digest(await readFile(archive)), tools = f.native.trustedTools;
    const page = await tools.native_archive_index.execute({ ...f, args: [file, format, '--limit', '1'] });
    assert.equal(page.archiveMembers, 2); assert.equal(page.total, 2); assert.equal(page.nextOffset, 1);
    assert.equal(page.filesMaterialized, 0); assert.equal(page.capabilities.repack, true);
    await assert.rejects(access(path.join(f.workDir, 'native-archives')), { code: 'ENOENT' });
    const filtered = await tools.native_archive_index.execute({ ...f, args: [file, '--contains', 'STORY'] });
    assert.equal(filtered.members.length, 1); assert.equal(filtered.members[0].path, 'data/story.txt');
    const query = { ...f, args: [file, format, '--files', '["data/story.txt"]'] };
    const selected = await tools.native_unpack.execute(query), reused = await tools.native_unpack.execute(query);
    assert.equal(reused.artifactId, selected.artifactId); assert.equal(reused.reused, true);
    assert.deepEqual(selected.selectedFiles, ['data/story.txt']); assert.equal(selected.completeFilesystemView, false);
    assert.equal(selected.unselectedMembers, 1); assert.deepEqual(selected.opaqueMembers, []);
    const selectedDir = path.join(f.workDir, selected.memberRoot);
    await assert.rejects(access(path.join(selectedDir, 'media.bin')), { code: 'ENOENT' });
    const other = await tools.native_unpack.execute({ ...f, args: [file, format, '--files', '["media.bin"]'] });
    assert.notEqual(other.artifactId, selected.artifactId);
    await writeFile(path.join(selectedDir, 'data/story.txt'), 'A changed and much longer complete caption.');
    const result = await tools.native_repack.execute({ ...f, args: [selected.memberRoot, `output/${file}`, format, file] });
    assert.equal(result.files, 2); assert.equal(result.memberReadback, true);
    const checked = path.join(f.root, `checked-${format}`);
    await f.realWorker('native_unpack', { archive: path.join(f.workDir, 'output', file), outputDir: checked, format });
    assert.equal(await readFile(path.join(checked, 'data/story.txt'), 'utf8'), 'A changed and much longer complete caption.');
    assert.equal(digest(await readFile(path.join(checked, 'media.bin'))), digest(await readFile(path.join(f.source, 'media.bin'))));
    assert.equal(digest(await readFile(archive)), before);
    // Preserve the previous task output, but use another task for the next carrier's no-materialization assertion.
    f.workDir = path.join(f.root, `task-${format}`); await mkdir(f.workDir);
  }
});

test('archive directory caching is bound to current file identity and cancellation', async t => {
  const f = await fixture(t), file = path.join(f.gameDir, 'game.zip');
  await writeFile(file, 'first carrier');
  let reads = 0;
  const native = createNativeTools({ worker: async (_command, input) => {
    reads++;
    return { format: 'zip', archiveHash: digest(await readFile(input.archive)), members: [{ path: 'caption.txt', size: 10 }] };
  } });
  const query = { ...f, args: ['game.zip'] };
  const first = await native.trustedTools.native_archive_index.execute(query);
  await native.trustedTools.native_archive_index.execute(query); assert.equal(reads, 1);
  const sibling = { ...query, workDir: path.join(f.root, 'sibling') };
  await native.trustedTools.native_archive_index.execute(sibling);
  native.release({ workDir: f.workDir });
  await native.trustedTools.native_archive_index.execute(sibling); assert.equal(reads, 1);
  native.release({ workDir: sibling.workDir });
  await native.trustedTools.native_archive_index.execute(query); assert.equal(reads, 2);
  await writeFile(file, 'second larger carrier');
  const next = await native.trustedTools.native_archive_index.execute(query);
  assert.equal(reads, 3); assert.notEqual(next.archiveHash, first.archiveHash);
  const controller = new AbortController(); controller.abort(new DOMException('Stopped', 'AbortError'));
  await assert.rejects(native.trustedTools.native_archive_index.execute({ ...query, signal: controller.signal }), { name: 'AbortError' });
});

test('normal Agent run_tool reaches indexed selection with positional prefix and validated flags', { timeout: 60000 }, async t => {
  const f = await fixture(t), archive = path.join(f.gameDir, 'normal.zip');
  await f.realWorker('native_repack', { inputDir: f.source, outputFile: archive });
  const lab = await createAdapterLab({ dataDir: path.join(f.root, 'lab'), trustedTools: f.native.trustedTools });
  const session = adaptationTools({ project: { id: 'archive-agent', engine: 'Fixture' }, inventory: {}, lab,
    gameDir: f.gameDir, workspaceDir: f.workDir, state: { status: 'running', failures: {}, events: [] } });
  t.after(async () => { await session.close(); await session.flush(); });
  const indexed = await session.tools.run_tool.execute({ tool: 'native_archive_index',
    args: ['normal.zip', '--contains', '.txt', '--offset', '0', '--limit', '1000'] });
  assert.equal(indexed.error, undefined, JSON.stringify(indexed.error));
  assert.equal(indexed.total, 1); assert.equal(indexed.limit, 100);
  const selected = await session.tools.run_tool.execute({ tool: 'native_unpack',
    args: ['normal.zip', 'zip', '--files', '["data/story.txt"]'] });
  assert.equal(selected.error, undefined, JSON.stringify(selected.error));
  assert.equal(selected.members.length, 1); assert.equal(selected.completeFilesystemView, false);
  await assert.rejects(access(path.join(f.workDir, selected.memberRoot, 'media.bin')), { code: 'ENOENT' });
  const invalid = await session.tools.run_tool.execute({ tool: 'native_unpack', args: ['normal.zip', '--invented', 'value'] });
  assert.equal(invalid.error.code, 'TOOL_ARGS_REJECTED');
  assert.match(invalid.error.message, /--files/);
});

test('ASAR selection binds external member changes without requiring unrelated sidecars', { timeout: 60000 }, async t => {
  const f = await fixture(t), archive = path.join(f.gameDir, 'app.asar');
  const original = 'First caption.', changed = 'Other caption.';
  assert.equal(original.length, changed.length);
  const tree = { files: { 'caption.txt': { size: original.length, unpacked: true }, 'missing.bin': { size: 8192, unpacked: true } } };
  const raw = Buffer.from(JSON.stringify(tree)), padded = Buffer.alloc(Math.ceil(raw.length / 4) * 4); raw.copy(padded);
  const header = Buffer.alloc(16); header.writeUInt32LE(4); header.writeUInt32LE(padded.length + 8, 4);
  header.writeUInt32LE(padded.length + 4, 8); header.writeUInt32LE(raw.length, 12);
  await writeFile(archive, Buffer.concat([header, padded]));
  await mkdir(`${archive}.unpacked`); await writeFile(path.join(`${archive}.unpacked`, 'caption.txt'), original);
  const before = digest(await readFile(archive)), query = { ...f, args: ['app.asar', 'asar', '--files', '["caption.txt"]'] };
  const indexed = await f.native.trustedTools.native_archive_index.execute({ ...f, args: ['app.asar'] });
  assert.equal(indexed.capabilities.repack, false); assert.equal(indexed.archiveMembers, 2);
  const first = await f.native.trustedTools.native_unpack.execute(query);
  await writeFile(path.join(`${archive}.unpacked`, 'caption.txt'), changed);
  const second = await f.native.trustedTools.native_unpack.execute(query);
  assert.notEqual(first.artifactId, second.artifactId);
  assert.equal(await readFile(path.join(f.workDir, first.memberRoot, 'caption.txt'), 'utf8'), original);
  assert.equal(await readFile(path.join(f.workDir, second.memberRoot, 'caption.txt'), 'utf8'), changed);
  assert.equal(digest(await readFile(archive)), before);
  assert.equal(second.completeFilesystemView, false);
});

test('archive tools reject malformed selection and paging rather than silently expanding everything', () => {
  const tools = createNativeTools({ worker: () => { throw new Error('must not execute'); } }).trustedTools;
  for (const args of [[], ['../private.zip'], ['game.zip', '--files', '[]'], ['game.zip', '--files', '["../outside"]'],
    ['game.zip', '--files', '["A.txt","a.txt"]'], ['game.zip', '--files', 'no json'], ['game.zip', '--unknown', '1']]) {
    assert.equal(tools.native_unpack.validateArgs(args), false, JSON.stringify(args));
  }
  for (const args of [['game.zip', '--limit', '101'], ['game.zip', '--offset', '-1'], ['game.zip', '--offset'], ['game.zip', '--limit', '1', '--limit', '2']]) {
    assert.equal(tools.native_archive_index.validateArgs(args), false, JSON.stringify(args));
  }
  assert.equal(tools.native_unpack.validateArgs(['app.asar', 'asar', '--files', '["story.txt"]']), true);
  assert.equal(tools.native_repack.validateArgs(['members', 'output/app.asar', 'asar', 'app.asar']), false);
});
