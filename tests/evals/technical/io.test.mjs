import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { collectArtifacts, freezeEnvironment } from './io.mjs';
import { createAdaptationSource } from '../../../packages/core/adaptive-worker.mjs';
import { createDisplayVerifier } from '../../../packages/technical/adaptation/display-review.mjs';
import { createDisplaySourceResolver } from '../../../packages/technical/adaptation/source-origins.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
test('evaluation source freeze includes runtime profile YAML bytes, not only JavaScript', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-profile-freeze-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  for (const directory of ['packages/technical', 'apps/desktop/electron', 'adapters/python', 'kits/workbench-tutorial/toolkit', 'dependencies']) await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{}'); await writeFile(path.join(root, 'package-lock.json'), '{}');
  await writeFile(path.join(root, 'python.exe'), 'neutral executable identity');
  await writeFile(path.join(root, 'packages/technical/runtime.yml'), 'enabled: true\n');
  await writeFile(path.join(root, 'packages/technical/model.yaml'), 'route: local\n');
  const config = { sourceRoot: root, dependencyDir: path.join(root, 'dependencies'), pythonPath: path.join(root, 'python.exe') };
  const before = await freezeEnvironment(config);
  assert.equal(before['source/packages/technical/runtime.yml'], digest('enabled: true\n'));
  assert.equal(before['source/packages/technical/model.yaml'], digest('route: local\n'));
  await writeFile(path.join(root, 'packages/technical/runtime.yml'), 'enabled: false\n');
  const after = await freezeEnvironment(config);
  assert.notEqual(before['source/packages/technical/runtime.yml'], after['source/packages/technical/runtime.yml']);
});
test('collector replays host source-copy display proof against authorized originals and rejects changed consumers or forged snapshots', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-collector-origin-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const gameDir = path.join(root, 'original'), workspaceDir = path.join(root, 'project'), dataDir = path.join(root, 'profile');
  const sourceDir = path.join(workspaceDir, 'technical', 'request', 'source'), work = path.join(workspaceDir, 'technical', 'request', 'job');
  const bytes = '{"body":"A neutral visible sentence."}', file = 'story.json';
  await mkdir(gameDir); await mkdir(path.join(dataDir, 'validations'), { recursive: true });
  await writeFile(path.join(gameDir, file), bytes); await writeFile(path.join(gameDir, 'consumer.js'), 'show(story.body);');
  await createAdaptationSource({ gameDir, outputDir: sourceDir, files: [file, 'consumer.js'] });
  const project = { id: 'collector-origin', gameDir, workspaceDir, resourceRoot: '.' };
  const config = { sourceRoot: path.resolve(import.meta.dirname, '../../..'), gameDir, baseUrl: 'https://invalid.local', model: 'fixture' };
  const verifier = createDisplayVerifier({ connectionFor: () => ({ baseUrl: config.baseUrl, model: config.model }), projectFor: () => project,
    readRootsFor: () => [gameDir], sourceResolverFor: ({ roots }) => createDisplaySourceResolver({ projectId: project.id, roots,
      sourceCopyPath: sourceDir, allowedSourceRoots: [gameDir] }),
    generate: async ({ tools }) => {
      const read = await tools.read_resource.execute({ file });
      const consumer = await tools.read_resource.execute({ file: 'consumer.js' });
      await tools.list_files.execute({ relativePath: '', limit: 100 });
      await tools.finish_review.execute({ decisions: [{ ref: '1', status: 'display-supported', reason: 'The actual consumer displays this exact body.',
        evidenceIds: [read.evidenceId], consumerEvidenceIds: [consumer.evidenceId] }] });
    } });
  const units = [{ id: 'visible-body', source: 'A neutral visible sentence.', locator: { file, pointer: '/body' } }];
  const displayReview = await verifier({ projectId: project.id, gameDir: sourceDir, workspaceDir: work, units,
    candidate: { candidateId: 'candidate-origin', codeHash: 'a'.repeat(64), manifest: { scope: { files: [file] } } } });
  assert.equal(displayReview.status, 'passed');
  const sample = path.join(work, 'sample'), roundtrip = path.join(work, 'roundtrip');
  await mkdir(sample); await mkdir(roundtrip);
  await writeFile(path.join(sample, file), '{"body":"Changed neutral sample."}'); await writeFile(path.join(roundtrip, file), bytes);
  const validation = { validationId: 'origin-validation', gameDir: sourceDir, resourceHashes: { [file]: digest(bytes) }, sample: { path: sample }, displayReview };
  await writeFile(path.join(dataDir, 'validations', 'origin.json'), JSON.stringify(validation));
  const candidateId = 'candidate-origin', candidateDirectory = path.join(dataDir, 'candidates');
  const bindingDirectory = path.join(workspaceDir, 'candidates', candidateId);
  await mkdir(candidateDirectory); await mkdir(bindingDirectory, { recursive: true });
  await writeFile(path.join(candidateDirectory, `${candidateId}.json`), JSON.stringify({ candidateId, codeHash: 'a'.repeat(64) }));
  const binding = { format: 'pinhao-adapter-binding', version: 1, candidateId, validationId: validation.validationId, units };
  const bindingBytes = JSON.stringify(binding), bindingFile = path.join(bindingDirectory, 'pinhao-adapter-binding.json');
  await writeFile(bindingFile, bindingBytes);
  const collect = () => collectArtifacts({ config, dataDir, workspaceDir, database: { project, tasks: [], units: [] } });
  const initial = await collect();
  assert.equal(initial.artifacts.candidates.length, 1, 'the candidate metadata remains counted once');
  assert.equal(initial.artifacts.bindings.length, 1, 'a binding nested under candidates is not another candidate with the same ID');
  assert.equal(initial.artifacts.bindings[0].path, bindingFile);
  assert.equal(initial.artifacts.bindings[0].sha256, digest(bindingBytes));
  assert.deepEqual(JSON.parse(initial.artifacts.bindings[0].text), binding);
  assert.equal(initial.freshness[validation.validationId].displayFresh, true);
  assert.equal(initial.freshness[validation.validationId].complete, true);
  await writeFile(path.join(gameDir, 'consumer.js'), 'debugOnly(story.body);');
  assert.equal(await readFile(path.join(sourceDir, 'consumer.js'), 'utf8'), 'show(story.body);');
  assert.equal((await collect()).freshness[validation.validationId].displayFresh, false, 'unchanged work bytes cannot hide a changed actual consumer');
  await writeFile(path.join(gameDir, 'consumer.js'), 'show(story.body);');
  const snapshotFile = `${sourceDir}.snapshot.json`, snapshot = JSON.parse(await readFile(snapshotFile, 'utf8'));
  const alien = path.join(root, 'unregistered'); await mkdir(alien);
  await writeFile(snapshotFile, JSON.stringify({ ...snapshot, source: alien, sourceRoots: [alien] }));
  const rejected = await collect();
  assert.equal(rejected.freshness[validation.validationId].displayFresh, false);
  assert.equal(rejected.freshness[validation.validationId].complete, false);
});
