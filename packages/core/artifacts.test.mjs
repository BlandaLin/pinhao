import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, readdir, cp, rm, symlink, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createService } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { removeArtifact } from './artifacts.mjs';

const root = path.resolve('local/artifact-tests');
await mkdir(root, { recursive: true });
async function fixture(t) {
  const directory = await mkdtemp(path.join(root, 'artifact-'));
  const gameDir = path.join(directory, 'original');
  const dataDir = path.join(directory, 'data');
  await mkdir(gameDir);
  await writeFile(path.join(gameDir, 'original.txt'), 'untouched');
  const calls = [];
  let failAssembly = false, failZip = false;
  const worker = async (command, args) => {
    calls.push({ command, args });
    if (command === 'probe') return { engine: 'MV' };
    if (command === 'extract') { await mkdir(args.workspaceDir, { recursive: true }); return { units: [{ id: 'one', kind: 'message', source: 'neutral line', tokens: [] }], workspaceDir: args.workspaceDir }; }
    if (command === 'roundtrip' || command === 'validate') return {};
    if (command === 'build') { await mkdir(args.outputDir, { recursive: true }); await writeFile(path.join(args.outputDir, 'overlay.txt'), 'native data'); return { buildDir: args.outputDir }; }
    if (command === 'assemble') {
      await mkdir(args.outputDir, { recursive: true }); await writeFile(path.join(args.outputDir, 'Game.exe'), 'neutral fixture');
      if (failAssembly) throw new Error('assembly fixture failed');
      return { outputDir: args.outputDir, launchPath: path.join(args.outputDir, 'Game.exe') };
    }
    if (command === 'zip') { if (failZip) throw new Error('zip fixture failed'); await cp(args.sourceDir, args.filePath, { recursive: true }); return {}; }
    if (command === 'unzip') { await cp(args.filePath, args.outputDir, { recursive: true }); return {}; }
    throw new Error(`Unexpected command: ${command}`);
  };
  const service = await createService({ dataDir, worker, scriptTools: null });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }); });
  const project = await service.createProject({ gameDir });
  const unit = (await service.listText({ projectId: project.id })).units[0];
  return { directory, dataDir, gameDir, service, project, unit, calls, failAssembly: () => { failAssembly = true; }, failZip: () => { failZip = true; } };
}
async function edit(f, translation, notes = '') {
  const unit = (await f.service.listText({ projectId: f.project.id })).units[0];
  return f.service.saveText({ projectId: f.project.id, unitId: unit.id, translation, notes, expectedRevision: unit.revision });
}

async function plainArtifact(t) {
  const directory = await mkdtemp(path.join(root, 'preflight-')), owner = path.join(directory, 'outputs');
  const output = path.join(owner, 'generated');
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'keep.txt'), 'ordinary generated data');
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }));
  return { directory, owner, output };
}

test('artifact inspection tolerates a real file disappearing between listing and lstat', async t => {
  const f = await plainArtifact(t), victim = path.join(f.output, 'ephemeral.tmp');
  await writeFile(victim, 'temporary');
  const original = fs.promises.lstat; let removed = false;
  fs.promises.lstat = async (entry, ...args) => {
    if (entry === victim && !removed) { await unlink(victim); removed = true; }
    return original(entry, ...args);
  };
  syncBuiltinESMExports();
  try { assert.equal((await removeArtifact(f.output, f.owner)).removed, true); }
  finally { fs.promises.lstat = original; syncBuiltinESMExports(); }
  assert.equal(removed, true);
  await assert.rejects(stat(f.output), { code: 'ENOENT' });
});

test('artifact inspection tolerates a nested directory disappearing before readdir', async t => {
  const f = await plainArtifact(t), victim = path.join(f.output, 'temporary-directory');
  await mkdir(victim); await writeFile(path.join(victim, 'temporary.txt'), 'temporary');
  const original = fs.promises.readdir; let removed = false;
  fs.promises.readdir = async (entry, ...args) => {
    if (entry === victim && !removed) { await rm(victim, { recursive: true }); removed = true; }
    return original(entry, ...args);
  };
  syncBuiltinESMExports();
  try { assert.equal((await removeArtifact(f.output, f.owner)).removed, true); }
  finally { fs.promises.readdir = original; syncBuiltinESMExports(); }
  assert.equal(removed, true);
  await assert.rejects(stat(f.output), { code: 'ENOENT' });
});

test('a disappeared file does not bypass gameplay-save or child-link protection', async t => {
  for (const kind of ['save', 'link']) await t.test(kind, async t => {
    const f = await plainArtifact(t), victim = path.join(f.output, 'ephemeral.tmp');
    await writeFile(victim, 'temporary');
    let protectedFile;
    if (kind === 'save') {
      protectedFile = path.join(f.output, 'file1.rmmzsave'); await writeFile(protectedFile, 'private progress');
    } else {
      const outside = path.join(f.directory, 'outside'); await mkdir(outside);
      protectedFile = path.join(outside, 'keep.txt'); await writeFile(protectedFile, 'private progress');
      await symlink(outside, path.join(f.output, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    const original = fs.promises.lstat; let removed = false;
    fs.promises.lstat = async (entry, ...args) => {
      if (entry === victim && !removed) { await unlink(victim); removed = true; }
      return original(entry, ...args);
    };
    syncBuiltinESMExports();
    try { assert.equal((await removeArtifact(f.output, f.owner, { protectSaves: true })).removed, false); }
    finally { fs.promises.lstat = original; syncBuiltinESMExports(); }
    assert.equal(removed, true);
    assert.equal(await readFile(protectedFile, 'utf8'), 'private progress');
    assert.equal(await readFile(path.join(f.output, 'keep.txt'), 'utf8'), 'ordinary generated data');
  });
});

test('artifact inspection still propagates permission errors from lstat and readdir', async t => {
  for (const operation of ['lstat', 'readdir']) await t.test(operation, async t => {
    const f = await plainArtifact(t), folder = path.join(f.output, 'nested'); await mkdir(folder);
    const victim = operation === 'lstat' ? path.join(f.output, 'keep.txt') : folder;
    const original = fs.promises[operation];
    fs.promises[operation] = async (entry, ...args) => {
      if (entry === victim) throw Object.assign(new Error('Permission denied'), { code: 'EACCES', path: entry });
      return original(entry, ...args);
    };
    syncBuiltinESMExports();
    try { await assert.rejects(removeArtifact(f.output, f.owner), { code: 'EACCES', path: victim }); }
    finally { fs.promises[operation] = original; syncBuiltinESMExports(); }
    assert.equal(await readFile(path.join(f.output, 'keep.txt'), 'utf8'), 'ordinary generated data');
  });
});

test('build cache follows writable content, not notes, revisions or the font filename', async (t) => {
  const f = await fixture(t);
  const firstFont = path.join(f.directory, 'font-a.ttf'), secondFont = path.join(f.directory, 'font-b.ttf');
  await writeFile(firstFont, 'font fixture'); await writeFile(secondFont, 'font fixture');
  await f.service.saveSettings({ ...(await f.service.snapshot()).settings, fontPath: firstFont });
  await edit(f, '中性文字');
  const first = await f.service.buildProject({ projectId: f.project.id });
  await edit(f, '中性文字', 'New proofreading note');
  await f.service.saveSettings({ ...(await f.service.snapshot()).settings, fontPath: secondFont });
  const reused = await f.service.buildProject({ projectId: f.project.id });
  assert.equal(first.id, reused.id);
  assert.equal(f.calls.filter(({ command }) => command === 'assemble').length, 1);
  assert.equal(f.calls.find(({ command }) => command === 'roundtrip').args.outputDir, undefined);
  assert.deepEqual(await readdir(path.join(f.project.workspaceDir, 'builds')), []);
  await edit(f, '新文字');
  const changed = await f.service.buildProject({ projectId: f.project.id });
  assert.notEqual(changed.id, first.id);
  assert.equal((await f.service.getProject({ projectId: f.project.id })).builds.length, 1);
  await assert.rejects(stat(first.path), { code: 'ENOENT' });
});

test('successful builds prune old managed outputs and manual cleanup releases remaining known overlays', async (t) => {
  const f = await fixture(t);
  await edit(f, '初版'); const first = await f.service.buildProject({ projectId: f.project.id });
  await edit(f, '新版'); const latest = await f.service.buildProject({ projectId: f.project.id });
  await assert.rejects(stat(first.path), { code: 'ENOENT' });
  const oldOverlay = path.join(f.project.workspaceDir, 'builds', latest.id);
  await mkdir(oldOverlay, { recursive: true }); await writeFile(path.join(oldOverlay, 'cache.dat'), 'old overlay');
  const result = await f.service.cleanupProject({ projectId: f.project.id });
  assert.equal(result.removed, 0); assert.equal(result.retained, 0); assert.ok(result.freedBytes > 0);
  await assert.rejects(stat(first.path), { code: 'ENOENT' });
  await assert.rejects(stat(oldOverlay), { code: 'ENOENT' });
  assert.ok((await stat(latest.launchPath)).isFile());
  assert.equal(await readFile(path.join(f.gameDir, 'original.txt'), 'utf8'), 'untouched');
  assert.equal((await f.service.listText({ projectId: f.project.id })).units[0].translation, '新版');
  assert.deepEqual((await f.service.getProject({ projectId: f.project.id })).builds.map(({ id }) => id), [latest.id]);
});

test('history cleanup retains old games containing saves and custom output locations', async (t) => {
  const f = await fixture(t);
  // Translations must clear the truncation guard (>=15% of the 12-codepoint source), so the
  // fixture uses plausible short output instead of a single character.
  await edit(f, '版本一'); const saved = await f.service.buildProject({ projectId: f.project.id });
  await mkdir(path.join(saved.path, 'save')); await writeFile(path.join(saved.path, 'save', 'file1.rmmzsave'), 'private progress');
  await edit(f, '版本二'); const custom = await f.service.buildProject({ projectId: f.project.id, outputDir: path.join(f.directory, 'chosen-output') });
  await edit(f, '版本三'); const latest = await f.service.buildProject({ projectId: f.project.id });
  const result = await f.service.cleanupProject({ projectId: f.project.id });
  assert.equal(result.removed, 0); assert.equal(result.retained, 2);
  assert.equal(await readFile(path.join(saved.path, 'save', 'file1.rmmzsave'), 'utf8'), 'private progress');
  assert.ok((await stat(custom.launchPath)).isFile()); assert.ok((await stat(latest.launchPath)).isFile());
});

test('an output with a missing launcher is rebuilt instead of reused', async (t) => {
  const f = await fixture(t);
  const first = await f.service.buildProject({ projectId: f.project.id });
  await rm(first.launchPath);
  const rebuilt = await f.service.buildProject({ projectId: f.project.id });
  assert.notEqual(first.id, rebuilt.id); assert.ok((await stat(rebuilt.launchPath)).isFile());
});

test('history cleanup keeps all assets when any file is locked by a Windows game', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  const owner = path.join(f.directory, 'outputs'), directory = path.join(owner, 'old');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'a-asset.txt'), 'asset');
  const executable = path.join(directory, 'z-game.exe'); await writeFile(executable, 'neutral');
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$file=[System.IO.File]::Open($env:PINHAO_LOCK_FIXTURE, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read); [Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null; $file.Dispose()"], { env: { ...process.env, PINHAO_LOCK_FIXTURE: executable }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise((resolve) => holder.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Lock fixture timed out')), 10000);
      holder.stdout.on('data', (value) => { if (value.toString().includes('ready')) { clearTimeout(timeout); resolve(); } });
      holder.once('error', error => { clearTimeout(timeout); reject(error); });
      holder.once('exit', () => { clearTimeout(timeout); reject(new Error('Lock fixture exited early')); });
    });
    assert.equal((await removeArtifact(directory, owner, { protectSaves: true })).removed, false);
    assert.equal(await readFile(path.join(directory, 'a-asset.txt'), 'utf8'), 'asset');
    assert.equal(await readFile(executable, 'utf8'), 'neutral');
  } finally { holder.stdin.end('\n'); await exited; }
});

test('artifact cleanup rejects parent junctions and links to another directory', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.directory, 'outside'); await mkdir(outside); await mkdir(path.join(outside, 'child'));
  await writeFile(path.join(outside, 'child', 'keep.txt'), 'keep');
  const linked = path.join(f.directory, 'junction');
  await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await removeArtifact(path.join(linked, 'child'), linked)).removed, false);
  assert.equal(await readFile(path.join(outside, 'child', 'keep.txt'), 'utf8'), 'keep');
  await assert.rejects(removeArtifact(f.gameDir, path.join(f.directory, 'unrelated')), /所属输出/);
});

test('exports and ordinary imports remove their staging directories even after failure', async (t) => {
  const f = await fixture(t), filePath = path.join(f.directory, 'handoff.zip');
  await f.service.exportPackage({ projectId: f.project.id, filePath });
  assert.deepEqual(await readdir(path.join(f.project.workspaceDir, 'exchange')), []);
  await f.service.importPackage({ projectId: f.project.id, filePath });
  assert.deepEqual(await readdir(path.join(f.project.workspaceDir, 'exchange')), []);
  f.failZip();
  await assert.rejects(f.service.exportPackage({ projectId: f.project.id, filePath: path.join(f.directory, 'failed.zip') }), /zip fixture/);
  assert.deepEqual(await readdir(path.join(f.project.workspaceDir, 'exchange')), []);
});

test('failed automatic assembly discards its partial output and overlay but preserves the previous game', async (t) => {
  const f = await fixture(t);
  await edit(f, '旧成品'); const first = await f.service.buildProject({ projectId: f.project.id });
  await edit(f, '新内容'); f.failAssembly();
  await assert.rejects(f.service.buildProject({ projectId: f.project.id }), /assembly fixture/);
  assert.deepEqual((await readdir(f.directory)).filter(name => name.includes('-汉化版')), [path.basename(first.path)]);
  assert.deepEqual(await readdir(path.join(f.project.workspaceDir, 'builds')), []);
  assert.equal((await f.service.getProject({ projectId: f.project.id })).builds.length, 1);
});

test('cleanup waits for preparation and running projects', async (t) => {
  const f = await fixture(t);
  const store = createStore(f.dataDir);
  store.put('projects', { ...store.one('projects', f.project.id), status: 'running' }); store.close();
  await assert.rejects(f.service.cleanupProject({ projectId: f.project.id }), /处理完成/);
});
