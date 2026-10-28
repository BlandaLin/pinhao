import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanupDesktopStage } from '../../../../scripts/desktop-stage-lifecycle.mjs';

test('only a newly owned stage is removed; releases and older stages remain', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-stage-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stageRoot = path.join(root, 'desktop-stage'), stage = path.join(stageRoot, 'new');
  const previous = path.join(stageRoot, 'previous'), release = path.join(root, 'release');
  await mkdir(stage, { recursive: true }); await mkdir(previous); await mkdir(release);
  await writeFile(path.join(stage, 'payload'), 'small fixture');
  await assert.rejects(cleanupDesktopStage({ stageRoot, stage }), /unowned/);
  await assert.rejects(cleanupDesktopStage({ stageRoot, stage: release, createdByThisRun: true }), /immediate child/);
  await assert.rejects(cleanupDesktopStage({ stageRoot, stage: stageRoot, createdByThisRun: true }), /immediate child/);
  await cleanupDesktopStage({ stageRoot, stage, createdByThisRun: true });
  await assert.rejects(access(stage), { code: 'ENOENT' });
  await access(previous); await access(release);
});
