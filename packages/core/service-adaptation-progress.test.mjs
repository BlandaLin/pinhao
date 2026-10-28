import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createService, defaultSettings } from './service.mjs';

const secrets = { encrypt: value => `neutral:${value}`, decrypt: value => value.slice(8) };
async function fixture(t, advance) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-progress-windows-')), gameDir = path.join(root, 'game');
  await mkdir(gameDir); await writeFile(path.join(gameDir, 'story.txt'), 'A complete neutral scene.');
  let windows = 0;
  const worker = async (command, input) => {
    if (command === 'catalog') return { engines: [] };
    if (command === 'assistInfo') return { supported: false, modes: [] };
    if (command === 'probe') return { engine: 'Neutral', root: '.', capabilities: { extract: true, nativeBuild: true } };
    if (command === 'extract') { await mkdir(input.workspaceDir, { recursive: true }); await writeFile(path.join(input.workspaceDir, 'manifest.json'), JSON.stringify({ units: { 'line:1': { controls: {} } } })); return { workspaceDir: input.workspaceDir, units: [{ id: 'line:1', source: 'A complete neutral scene.', kind: 'message', tokens: [], context: { file: 'story.txt' } }], sourceFingerprint: 'neutral-stable' }; }
    if (command === 'roundtrip' || command === 'validate') return { valid: true, passed: true };
    throw new Error(`Neutral fixture stops before output: ${command}`);
  };
  const service = await createService({ dataDir: path.join(root, 'profile'), worker, secrets, scriptTools: null, imageTools: null,
    coverageScanner: async () => ({ resources: [{ file: 'story.txt', kind: 'display-text-candidate' }], dynamicCandidates: [], triggers: ['suspected-omission'], needsAdaptation: true, summary: {} }),
    adaptationProvider: async () => { windows++; return { status: 'needs-review', retryable: true, continuationNeeded: true, progressMade: advance, progressFingerprint: advance ? `new-evidence-${windows}` : 'unchanged', reason: 'neutral investigation evidence' }; },
  });
  const settings = defaultSettings(); settings.concurrency = 3; settings.pauseOnLocalFailure = true; settings.connection.model = 'neutral'; settings.connection.apiKey = 'neutral-value';
  await service.saveSettings(settings);
  const project = await service.createProject({ gameDir });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return { service, project, windows: () => windows };
}

test('A10 genuine technical evidence stays inside a bounded window allowance instead of billing windows forever', { timeout: 30000 }, async t => {
  const f = await fixture(t, true); await f.service.startProject({ projectId: f.project.id });
  const deadline = Date.now() + 15000;
  let current;
  while (Date.now() < deadline) {
    current = await f.service.getProject({ projectId: f.project.id });
    if (['paused', 'failed'].includes(current.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  // A window that keeps claiming fresh evidence must still settle: the allowance is cumulative,
  // so the project stops instead of opening a new request window indefinitely.
  assert.ok(['paused', 'failed'].includes(current.status),
    `the window allowance settles the project, observed ${current.status} after ${f.windows()} windows`);
  assert.ok(f.windows() >= 1 && f.windows() <= 16, `observed ${f.windows()} windows within the 16-window allowance`);
  assert.equal((await f.service.listText({ projectId: f.project.id })).units.length, 1);
});

test('A10 unchanged technical evidence stops without endless request windows', { timeout: 30000 }, async t => {
  const f = await fixture(t, false); await f.service.startProject({ projectId: f.project.id });
  const deadline = Date.now() + 15000; let current;
  do { current = await f.service.getProject({ projectId: f.project.id }); if (['paused', 'failed'].includes(current.status)) break; await new Promise(resolve => setTimeout(resolve, 10)); } while (Date.now() < deadline);
  assert.ok(['paused', 'failed'].includes(current.status), current.stage);
  assert.ok(f.windows() >= 1 && f.windows() <= 2, `observed ${f.windows()} windows`);
});
