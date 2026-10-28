import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAdaptation, readAdaptationState } from './adaptation.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-checkpoint-lock-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }));
  const gameDir = path.join(root, 'game'); await mkdir(gameDir); await writeFile(path.join(gameDir, 'story.json'), '{"text":"A complete scene."}');
  const extraction = { workspaceDir: path.join(root, 'extraction'), units: [{ id: 'line-1', source: 'A complete scene.', kind: 'message',
    context: { file: 'story.json' }, locator: { file: 'story.json', pointer: '/text' } }], binding: { recipeId: 'recipe-1' } };
  let submitted = 0;
  const lab = { tryRecipes: async () => null, listRecipes: async () => [], listTools: async () => [],
    writeAdapter: async () => ({ candidateId: 'candidate-1', codeHash: 'code-1' }),
    validateAdapter: async () => ({ validationId: 'proof-1', passed: true, checks: { roundtrip: true, sample: true } }),
    submitRecipe: async () => { submitted++; return { recipeId: 'recipe-1' }; }, extractRecipe: async () => extraction };
  return { root, statePath: path.join(root, 'progress.jsonl'), get submitted() { return submitted; },
    input: { lab, project: { id: 'lock-1', name: 'Checkpoint lock', engine: 'Godot' }, gameDir, workspaceDir: path.join(root, 'work'), inventory: { unitCount: 0 } } };
}

async function readLock(file, holdMs) {
  const encoded = Buffer.from(file, 'utf8').toString('base64');
  const wait = holdMs === undefined ? '$null=[Console]::In.ReadLine()' : `Start-Sleep -Milliseconds ${holdMs}`;
  const command = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));$f=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);try{[Console]::Out.WriteLine('lock-ready');[Console]::Out.Flush();${wait}}finally{$f.Dispose()}`;
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Lock helper exited ${code}`))); });
  let output = '';
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Windows lock helper did not become ready')), 10000);
    child.stdout.on('data', bytes => { output += bytes; if (output.includes('lock-ready')) { clearTimeout(timeout); resolve(); } });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { if (!output.includes('lock-ready')) { clearTimeout(timeout); reject(new Error('Windows lock helper exited before ready')); } });
  });
  return { closed, release: () => child.stdin.end('release\n') };
}

async function prepared(tools) {
  const candidate = await tools.write_adapter.execute({ manifest: { id: 'lock-adapter' }, code: '({})' });
  const validation = await tools.validate_adapter.execute({ candidateId: candidate.candidateId });
  assert.equal(validation.passed, true);
  return { candidateId: candidate.candidateId, validationId: validation.validationId, metadata: {} };
}

test('real Windows short non-Delete read lock retries the same checkpoint save, not the model', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); let generated = 0, lock;
  const result = await runAdaptation({ ...f.input, statePath: f.statePath, generate: async ({ tools }) => {
    generated++; const candidate = await prepared(tools);
    ({ closed: lock } = await readLock(f.statePath, 350));
    await assert.rejects(rename(f.statePath, `${f.statePath}.lock-check`), error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
    assert.equal((await tools.submit_recipe.execute(candidate)).taskComplete, true);
  } });
  await lock;
  assert.equal(result.status, 'verified'); assert.equal(generated, 1); assert.equal(f.submitted, 1);
  const state = await readAdaptationState(f.statePath);
  assert.equal(state.candidateId, 'candidate-1'); assert.equal(state.validationId, 'proof-1'); assert.equal(state.status, 'verified');
});

test('a persistent Windows rename lock fails explicitly while retaining the last complete candidate and proof', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); let generated = 0, lock;
  try {
    await assert.rejects(runAdaptation({ ...f.input, statePath: f.statePath, generate: async ({ tools }) => {
      generated++; const candidate = await prepared(tools);
      lock = await readLock(f.statePath);
      await tools.submit_recipe.execute(candidate);
    } }), error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
    assert.equal(generated, 1); assert.equal(f.submitted, 0);
    const state = await readAdaptationState(f.statePath);
    assert.equal(state.candidateId, 'candidate-1'); assert.equal(state.validationId, 'proof-1'); assert.equal(state.validation.passed, true);
  } finally { lock?.release(); await lock?.closed; }
});
