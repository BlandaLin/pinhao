import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeWorkerError, registerNativeFailure, validateNativeArtifact } from './native-failure.mjs';
import { unitFileMatches } from './unit-location.mjs';
import { adaptationTools } from '../adaptation.mjs';
import { inspectFilePage, readSlice } from './paths.mjs';
import { createAdapterLab } from './adapter-lab.mjs';
import { createNativeTools } from '../../core/native-tools.mjs';

async function fixture(t) {
  const base = path.resolve('local/native-failure-tests');
  await mkdir(base, { recursive: true });
  const projectDir = await mkdtemp(path.join(base, 'case-'));
  t.after(async () => { assert.equal(path.dirname(projectDir), base); await rm(projectDir, { recursive: true, force: true, maxRetries: 3 }); });
  const workspaceDir = path.join(projectDir, 'workbench'), attemptId = `native-attempt-${randomUUID()}`;
  const relativePath = `workbench-native-attempts/${attemptId}`, root = path.join(projectDir, relativePath);
  await mkdir(root, { recursive: true });
  const recovered = 'label neutral:\n    "A complete recovered display line."\n';
  const manifest = JSON.stringify({ protocol: 'pinhao-native-attempt-1', attemptId, status: 'failed', resources: [
    { file: 'Game_Data/a', status: 'failed', detail: 'First actual neutral decoder failure', material: {
      file: 'recovered.rpy', sha256: createHash('sha256').update(recovered).digest('hex'), bytes: Buffer.byteLength(recovered),
    } },
    { file: 'Game_Data/b', status: 'failed', detail: 'Second actual neutral decoder failure' },
  ] });
  await writeFile(path.join(root, 'attempt.json'), manifest);
  await writeFile(path.join(root, 'recovered.rpy'), recovered);
  const error = { code: 'NATIVE_TEXT_UNAVAILABLE', message: 'No carrier opened', attemptId,
    diagnostic: { category: 'native', phase: 'extract', engine: 'Unity' },
    artifacts: [{ artifactId: attemptId, kind: 'native-attempt', relativePath, sha256: createHash('sha256').update(manifest).digest('hex') }] };
  return { projectDir, workspaceDir, root, attemptId, error };
}

test('native envelope retains finite diagnostics without arbitrary worker fields', () => {
  const error = nativeWorkerError({ code: 'NATIVE_DEPENDENCY_INVALID', message: 'Wrong codec ABI',
    diagnostic: { category: 'dependency', dependencyId: 'pgmm-codec', state: 'invalid', phase: 'probe', arbitrary: 'not copied' }, arbitrary: 'not copied' });
  assert.equal(error.code, 'NATIVE_DEPENDENCY_INVALID');
  assert.equal(error.hostFailure, true);
  assert.equal(error.diagnostic.dependencyId, 'pgmm-codec');
  assert.equal(error.arbitrary, undefined);
  assert.equal(error.diagnostic.arbitrary, undefined);
  assert.equal(nativeWorkerError(null).message, 'Native tool failed');
});

test('native attempt registration survives a fresh reader without requiring a workbench manifest', async t => {
  const f = await fixture(t), failure = await registerNativeFailure(f);
  const artifact = JSON.parse(JSON.stringify(failure.repairBundle.artifacts[0]));
  assert.equal(await validateNativeArtifact(artifact), f.root);
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'attempt.json'), 'utf8')).resources.length, 2);
});

test('native attempt registration rejects foreign paths, hashes and identity', async t => {
  const f = await fixture(t);
  await assert.rejects(registerNativeFailure({ ...f, error: { ...f.error, artifacts: [{ ...f.error.artifacts[0], relativePath: '../foreign' }] } }), { code: 'NATIVE_ARTIFACT_INVALID' });
  await assert.rejects(registerNativeFailure({ ...f, error: { ...f.error, artifacts: [{ ...f.error.artifacts[0], sha256: '0'.repeat(64) }] } }), { code: 'NATIVE_ARTIFACT_INVALID' });
  await assert.rejects(registerNativeFailure({ ...f, projectDir: path.join(f.projectDir, 'foreign') }));
  const failure = await registerNativeFailure(f);
  await writeFile(path.join(f.root, 'attempt.json'), '{}');
  await assert.rejects(validateNativeArtifact(failure.repairBundle.artifacts[0]), { code: 'NATIVE_ARTIFACT_INVALID' });
});

test('native attempt reads reject altered and unregistered material', async t => {
  const f = await fixture(t), failure = await registerNativeFailure(f), artifact = failure.repairBundle.artifacts[0];
  assert.equal(await validateNativeArtifact(artifact, 'recovered.rpy'), f.root);
  await writeFile(path.join(f.root, 'recovered.rpy'), 'altered evidence');
  await assert.rejects(validateNativeArtifact(artifact, 'recovered.rpy'), { code: 'NATIVE_ARTIFACT_INVALID' });
  await writeFile(path.join(f.root, 'extra.txt'), 'unregistered');
  await assert.rejects(validateNativeArtifact(artifact, 'extra.txt'), { code: 'NATIVE_ARTIFACT_FILE_INVALID' });
});

test('failed native tool evidence reaches read_failure and survives checkpoint reopening', async t => {
  const f = await fixture(t), nativeFailure = await registerNativeFailure(f), state = { attempts: 0, failures: {}, events: [] };
  let saved;
  const options = { project: { id: 'neutral-project' }, inventory: {}, gameDir: f.projectDir, workspaceDir: path.join(f.projectDir, 'task'),
    trustedToolNames: ['native_extract'], runtimePolicy: 'external', state, persist: value => { saved = structuredClone(value); },
    lab: { runTool: async () => { throw Object.assign(new Error('Native decoder failed'), { nativeFailure }); },
      readResource: ({ gameDir, file, ...input }) => readSlice(gameDir, file, input),
      inspectFiles: ({ gameDir, limit }) => inspectFilePage(gameDir, { limit }) } };
  const session = adaptationTools(options);
  const failed = await session.tools.run_tool.execute({ tool: 'native_extract', args: [] });
  assert.ok(failed.error);
  const summary = await session.tools.read_failure.execute({});
  assert.equal(summary.nativeAttempts[0].attemptId, f.attemptId);
  assert.equal(JSON.stringify(summary).includes(f.projectDir), false);
  await session.close();
  assert.ok(saved.nativeFailures[f.attemptId]);
  const reopened = adaptationTools({ ...options, state: JSON.parse(JSON.stringify(saved)) });
  const page = await reopened.tools.read_failure.execute({ artifactId: f.attemptId, file: 'recovered.rpy' });
  assert.match(page.content, /complete recovered display line/);
  assert.ok((await reopened.tools.read_failure.execute({ artifactId: f.attemptId, file: '../outside' })).error);
  await reopened.close();
});

test('shared unit path matching recognizes real and virtual locations without substring matches', () => {
  const unit = { file: '__unity_text__/one.json', context: { carrier: 'Game_Data/level0' } };
  assert.equal(unitFileMatches(unit, 'Game_Data\\level0'), true);
  assert.equal(unitFileMatches(unit, '__unity_text__/one.json'), true);
  assert.equal(unitFileMatches(unit, 'Game_Data/level'), false);
  assert.equal(unitFileMatches({ locator: { file: 'res://scene.tscn' } }, './scene.tscn'), true);
  assert.equal(unitFileMatches({ context: { adaptationLocator: { file: 'data/Map001.json' } } }, 'data/Map001.json'), true);
});

test('native diagnostic logs are readable with the real lab without relaxing private game resource filtering', async t => {
  const f = await fixture(t), manifestPath = path.join(f.root, 'attempt.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')), log = 'A real retained native diagnostic log.\n';
  manifest.logs = [{ file: 'gdre-stdout.log', bytes: Buffer.byteLength(log), sha256: createHash('sha256').update(log).digest('hex') }];
  await writeFile(path.join(f.root, 'gdre-stdout.log'), log);
  const bytes = JSON.stringify(manifest);
  await writeFile(manifestPath, bytes);
  f.error.artifacts[0].sha256 = createHash('sha256').update(bytes).digest('hex');
  const failure = await registerNativeFailure(f), lab = await createAdapterLab({ dataDir: path.join(f.projectDir, 'lab') });
  const session = adaptationTools({ project: { id: 'neutral-real-lab' }, inventory: {}, failure, lab,
    gameDir: f.projectDir, workspaceDir: path.join(f.projectDir, 'task'), state: { attempts: 0, failures: {}, events: [] }, runtimePolicy: 'external' });
  const first = await session.tools.read_failure.execute({ artifactId: f.attemptId, limit: 1 });
  const second = await session.tools.read_failure.execute({ artifactId: f.attemptId, offset: first.nextOffset, limit: 1 });
  assert.notEqual(first.files[0].path, second.files[0].path);
  assert.equal(first.total, 3);
  assert.equal((await session.tools.read_failure.execute({ artifactId: f.attemptId, file: 'gdre-stdout.log' })).content, log);
  await assert.rejects(lab.readResource({ gameDir: f.root, file: 'gdre-stdout.log' }), /存档|私人/);
  await session.close();
});

test('published native extraction restores its attempt handle before an adaptation checkpoint exists', async t => {
  const f = await fixture(t), nativeFailure = await registerNativeFailure(f);
  await mkdir(f.workspaceDir);
  const manifest = '{}';
  await writeFile(path.join(f.workspaceDir, 'manifest.json'), manifest);
  await writeFile(path.join(f.projectDir, 'host-native-result.json'), JSON.stringify({ format: 'pinhao-native-result-1', id: 'neutral-published',
    gameDir: f.projectDir, probe: { engine: 'neutral' }, manifestHash: createHash('sha256').update(manifest).digest('hex'), nativeFailure,
    extraction: { workspaceDir: f.workspaceDir, units: [] } }));
  const tools = createNativeTools({ worker: async () => { throw new Error('Published extraction must be reused'); } });
  const restored = await tools.trustedTools.native_extract.execute({ gameDir: f.projectDir, workDir: f.projectDir, args: [] });
  assert.equal(restored.reused, true);
  assert.equal(restored.nativeFailure.attemptId, f.attemptId);
});
