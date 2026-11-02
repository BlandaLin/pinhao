import test from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createService, defaultSettings } from './service.mjs';
import { createStore } from './workspace-store.mjs';
import { createNativeTools } from './native-tools.mjs';
import { readSupplementManifest } from './adaptive-worker.mjs';
import { createAdapterLab } from '../technical/adaptation/adapter-lab.mjs';
import { runAdaptation } from '../technical/adaptation.mjs';
import { productWorker } from '../../apps/desktop/electron/host.mjs';
import { sha256 } from '../exchange/index.mjs';

const member = 'data/story.json';
const carriers = ['a.zip', 'b.zip'];
const originalCaption = 'A complete hidden caption.';
const translations = { 'a:caption': '第一份档案的完整译文。', 'b:caption': '第二份档案的不同译文。' };
const nativeTranslation = '保留已有人工校对的原生译文。';

function adapter(carrier) {
  const id = `${carrier[0]}:caption`;
  return {
    manifest: { schemaVersion: 1, id: `service-container-${carrier[0]}`, version: '1.0.0',
      engine: 'Neutral Native', license: 'MIT', scope: { files: [member] }, container: { file: carrier, format: 'zip' } },
    code: `({detect(){return true},extract(h){const d=JSON.parse(h.readText('${member}'));return {units:[{id:'${id}',source:d.text,kind:'message',context:{file:'${member}'},locator:{file:'${member}',pointer:'/text'}}]}},validate(){return {valid:true}},roundtrip(h){h.writeBytes('${member}',h.readBytes('${member}'));return {}},build(h,i){const d=JSON.parse(h.readText('${member}'));d.text=i.translations['${id}']??d.text;h.writeText('${member}',JSON.stringify(d));return {}},assemble(){return {}}})`,
  };
}

async function fixture(t) {
  const base = path.resolve(process.env.PINHAO_SERVICE_TEST_TEMP ?? path.join(os.tmpdir(), 'pinhao-service-container'));
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'repair-'));
  const gameDir = path.join(root, 'game'), dataDir = path.join(root, 'profile');
  const bundledPython = path.resolve('local/runtime/python/python.exe');
  const pythonPath = process.env.PINHAO_PYTHON ?? await access(bundledPython).then(() => bundledPython,
    () => process.platform === 'win32' ? 'python' : 'python3');
  const codec = productWorker({ pythonPath, workerPath: path.resolve('adapters/python/worker.py'),
    toolkitPath: path.resolve('kits/workbench-tutorial/toolkit'), dependencyDir: path.resolve('local/dependencies'), timeoutMs: 60000 });
  const codecCalls = [];
  const realCodec = async (command, args, options) => {
    codecCalls.push({ command, archive: args.archive, outputFile: args.outputFile });
    return codec(command, args, options);
  };
  const archiveResolver = createNativeTools({ worker: realCodec });
  const lab = await createAdapterLab({ dataDir: path.join(root, 'lab'), archiveResolver, trustedTools: archiveResolver.trustedTools });
  await mkdir(path.join(gameDir, 'data'), { recursive: true });
  await mkdir(path.join(gameDir, 'save'));
  await writeFile(path.join(gameDir, 'Game.exe'), 'Neutral marker, not a playable game.');
  await writeFile(path.join(gameDir, 'save', 'private.sav'), 'Neutral save must remain unchanged.');
  const nativeDocument = { text: 'An existing complete native caption.', logic: { switch: 9 } };
  await writeFile(path.join(gameDir, 'data', 'native.json'), JSON.stringify(nativeDocument));
  const memberDocuments = new Map(), binaryMembers = new Map();
  for (const [index, carrier] of carriers.entries()) {
    const loose = path.join(root, `loose-${index}`);
    await mkdir(path.join(loose, 'data'), { recursive: true });
    const document = { text: originalCaption, untouchedText: `Do not translate this field ${index}.`, logic: { id: index + 10 } };
    const binary = Buffer.from([0, index, 2, 3, 255]);
    memberDocuments.set(carrier, document); binaryMembers.set(carrier, binary);
    await writeFile(path.join(loose, member), JSON.stringify(document));
    await writeFile(path.join(loose, 'untouched.bin'), binary);
    const packed = await realCodec('native_repack', { inputDir: loose, outputFile: path.join(gameDir, carrier), format: 'zip' });
    assert.equal(packed.memberReadback, true, JSON.stringify(packed.error));
  }
  await assert.rejects(access(path.join(gameDir, member)), { code: 'ENOENT' }, 'The original has archives, not loose adapter members');
  const originalHashes = new Map(await Promise.all(['Game.exe', 'data/native.json', 'save/private.sav', ...carriers]
    .map(async file => [file, sha256(await readFile(path.join(gameDir, file)))])));
  const withStore = action => { const store = createStore(dataDir); try { return action(store); } finally { store.close(); } };
  const calls = { sessions: [], accepted: [], translated: [], outcomes: [], nativeBuildTargets: [], nativeBuild: 0, nativeAssemble: 0 };
  let service;
  t.after(async () => {
    await service?.close();
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(base), 'Only this isolated fixture may be removed');
    await rm(resolved, { recursive: true, force: true, maxRetries: 6, retryDelay: 30 });
  });
  const worker = async (command, args) => {
    if (command === 'catalog') return { engines: [] };
    if (command === 'assistInfo') return { supported: false, modes: [] };
    if (command === 'probe') return { engine: 'Neutral Native', root: '.', capabilities: { extract: true, nativeBuild: true, assist: false } };
    if (command === 'extract') {
      await mkdir(args.workspaceDir, { recursive: true });
      await writeFile(path.join(args.workspaceDir, 'manifest.json'), JSON.stringify({ units: { 'native:caption': { controls: {} } } }));
      return { workspaceDir: args.workspaceDir, sourceFingerprint: sha256(nativeDocument), units: [{ id: 'native:caption',
        source: nativeDocument.text, kind: 'message', tokens: [], context: { file: 'data/native.json' } }],
      coverage: { resources: [{ file: 'data/native.json', status: 'text_extracted', units: 1 }] } };
    }
    if (['roundtrip', 'validate'].includes(command)) return { valid: true, passed: true };
    if (command === 'build') {
      calls.nativeBuild++;
      calls.nativeBuildTargets.push(args.translations.map(row => row.id));
      assert.ok(args.translations.every(row => row.id === 'native:caption'), 'Supplemental targets never enter the mature native writer');
      const document = { ...nativeDocument, text: args.translations.find(row => row.id === 'native:caption')?.translation ?? nativeDocument.text };
      await mkdir(path.join(args.outputDir, 'data'), { recursive: true });
      await writeFile(path.join(args.outputDir, 'data', 'native.json'), JSON.stringify(document));
      return { buildDir: args.outputDir };
    }
    if (command === 'assemble') {
      calls.nativeAssemble++;
      assert.equal(args.deferSupplementalText, true, 'Service applies checked text after the mature assembler');
      assert.equal(args.adapterOverlayFiles, undefined, 'Custom containers are not native packed-member overlays');
      await cp(args.gameDir, args.outputDir, { recursive: true });
      await cp(args.buildDir, args.outputDir, { recursive: true });
      return { outputDir: args.outputDir, launchPath: path.join(args.outputDir, 'Game.exe') };
    }
    throw new Error(`Unexpected neutral service command ${command}`);
  };
  service = await createService({ dataDir, worker, adapterLab: lab, scriptTools: null, imageTools: null,
    technicalProvider: async () => ({ decision: 'native-standard', summary: 'Neutral native route', selectedCandidateIds: [] }),
    coverageScanner: async ({ units = [] }) => {
      const covered = new Set(units.map(unit => unit.context?.carrier));
      const missing = carriers.filter(carrier => !covered.has(carrier));
      return { unitCount: units.length, completeness: missing.length ? 'partial' : 'complete', needsAdaptation: missing.length > 0,
        resources: carriers.map(file => ({ file, kind: covered.has(file) ? 'extracted' : 'display-text-candidate', units: covered.has(file) ? 1 : 0 })),
        dynamicCandidates: [], triggers: missing.length ? ['suspected-omission'] : [],
        summary: { extracted: covered.size, 'display-text-candidate': missing.length, unresolvedCandidates: 0 } };
    },
    provider: async ({ wire }) => ({ records: wire.payload.units.map(unit => {
      const current = withStore(store => store.unit(project.id, unit.id));
      calls.translated.push(current.legacyId);
      assert.ok(Object.hasOwn(translations, current.legacyId), 'Existing manual native translation must not be repurchased');
      return { id: unit.id, translation: translations[current.legacyId], notes: '' };
    }) }),
    adaptationProvider: async args => {
      const outcome = await runAdaptation({ ...args,
      onAcceptedBatch: async record => { calls.accepted.push(record); return args.onAcceptedBatch(record); },
      generate: async ({ tools }) => {
        const owned = args.assignment?.files;
        assert.equal(owned?.length, 1, 'The normal service assigns each physical carrier to a resource job');
        const carrier = owned[0]; assert.ok(carriers.includes(carrier)); calls.sessions.push(carrier);
        const saved = await tools.write_adapter.execute(adapter(carrier)); assert.ok(saved.candidateId, JSON.stringify(saved.error));
        const validated = await tools.validate_adapter.execute({ candidateId: saved.candidateId });
        assert.equal(validated.passed, true, JSON.stringify(validated.error));
        const accepted = await tools.submit_recipe.execute({ candidateId: saved.candidateId, validationId: validated.validationId, metadata: {} });
        assert.equal(accepted.accepted, true, JSON.stringify(accepted));
        return { finishReason: 'stop' };
      } });
      calls.outcomes.push({ status: outcome.status, reason: outcome.reason, error: outcome.error,
        events: outcome.state?.events?.slice(-5).map(({ tool, ok, error }) => ({ tool, ok, error })) });
      return outcome;
    },
  });
  await service.saveSettings({ ...defaultSettings(), concurrency: 1, proofreading: false, processImages: false,
    connection: { baseUrl: 'http://127.0.0.1:1/v1', model: 'neutral-container-fixture' } });
  const project = await service.createProject({ gameDir });
  assert.equal(project.status, 'ready'); assert.equal(project.total, 1); assert.equal(project.coverage.needsAdaptation, true);
  const existing = (await service.listText({ projectId: project.id })).units[0];
  await service.saveText({ projectId: project.id, unitId: existing.id, expectedRevision: existing.revision,
    translation: nativeTranslation, notes: 'Preserved independent native edit.', action: 'confirm' });
  return { service, project, gameDir, root, codec: realCodec, codecCalls, calls, originalHashes, memberDocuments, binaryMembers, withStore };
}

test('normal service accepts two real ZIP member writers and publishes independent native carriers without touching originals', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  await f.service.startProject({ projectId: f.project.id });
  let completed;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const detail = await f.service.getProject({ projectId: f.project.id });
    assert.ok(!['failed', 'paused'].includes(detail.status), JSON.stringify({ status: detail.status, error: detail.lastError,
      issues: detail.issues, tasks: f.withStore(store => store.tasks(f.project.id)).map(task => ({ role: task.role, status: task.status, error: task.error })) }));
    if (detail.status === 'completed') { completed = detail; break; }
    await delay(15);
  }
  assert.ok(completed, 'The service did not reach a published build');
  assert.equal(completed.total, 3, JSON.stringify({ calls: f.calls, issues: completed.issues,
    tasks: f.withStore(store => store.tasks(f.project.id)).map(task => ({ role: task.role, status: task.status, error: task.error })) }));
  assert.equal(completed.publication.integrated, 2);
  assert.equal(completed.publication.pendingIntegration, 0); assert.equal(completed.builds.length, 1);
  assert.deepEqual(f.calls.sessions.slice().sort(), carriers);
  assert.equal(f.calls.accepted.length, 2); assert.deepEqual(f.calls.translated.slice().sort(), Object.keys(translations));
  const units = (await f.service.listText({ projectId: f.project.id, limit: 20 })).units;
  const storedProject = f.withStore(store => store.one('projects', f.project.id));
  const registry = await readSupplementManifest(storedProject.workbenchDir, storedProject.publication.compositeManifestRef);
  assert.equal(registry.adapters.length, 2);
  for (const item of registry.adapters) {
    assert.deepEqual(item.files, [member]);
    const binding = JSON.parse((await readFile(path.join(item.workspaceDir, 'pinhao-adapter-binding.json'), 'utf8')).trim().split('\n').at(-1));
    assert.equal(item.baselineDir, binding.gameDir);
    if (process.platform === 'win32' && !process.env.PINHAO_SERVICE_TEST_TEMP) {
      assert.ok(path.join(item.baselineDir, member).length > 260, 'Default service acceptance must exercise the real deep member path');
    }
    assert.notEqual(path.resolve(item.baselineDir), path.resolve(item.sourceView.originalGameDir));
    assert.deepEqual(Object.keys(item.carrierHashes), [item.sourceView.container.file]);
  }
  const product = completed.builds[0];
  assert.equal(product.runtimeVerified, false, 'Archive readback is not gameplay verification');
  assert.equal(product.validationProofs.length, 2); assert.ok(product.validationProofs.every(proof => proof.finalProofRef));
  assert.ok(f.calls.nativeBuild > 0); assert.ok(f.calls.nativeAssemble > 0);
  assert.ok(f.calls.nativeBuildTargets.some(ids => ids.includes('native:caption')), 'Final native build must include the preserved native target');
  assert.deepEqual(JSON.parse(await readFile(path.join(product.path, 'data/native.json'), 'utf8')),
    { text: nativeTranslation, logic: { switch: 9 } });
  for (const carrier of carriers) {
    const id = `${carrier[0]}:caption`, unit = units.find(unit => unit.legacyId === id);
    assert.ok(unit, `The ${carrier} location must become a formal workbench unit`);
    assert.equal(unit.context.carrier, carrier); assert.equal(unit.context.file, member);
    assert.equal(unit.translation, translations[id]); assert.equal(unit.status, 'translated');
    const checked = path.join(f.root, `checked-${carrier[0]}`);
    const unpacked = await f.codec('native_unpack', { archive: path.join(product.path, carrier), outputDir: checked, format: 'zip' });
    assert.equal(unpacked.files, 2, JSON.stringify(unpacked.error));
    assert.deepEqual(JSON.parse(await readFile(path.join(checked, member), 'utf8')),
      { ...f.memberDocuments.get(carrier), text: translations[id] });
    assert.equal(sha256(await readFile(path.join(checked, 'untouched.bin'))), sha256(f.binaryMembers.get(carrier)));
    assert.notEqual(sha256(await readFile(path.join(product.path, carrier))), f.originalHashes.get(carrier));
    assert.ok(f.codecCalls.some(call => call.command === 'native_repack' && call.outputFile?.endsWith(carrier)));
  }
  await assert.rejects(access(path.join(product.path, member)), { code: 'ENOENT' }, 'Members remain packed, not emitted as loose substitutes');
  for (const [file, hash] of f.originalHashes) assert.equal(sha256(await readFile(path.join(f.gameDir, file))), hash, `Original ${file} changed`);
  assert.equal(sha256(await readFile(path.join(product.path, 'save/private.sav'))), f.originalHashes.get('save/private.sav'));
});
