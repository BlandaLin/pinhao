import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { runAdaptation } from '../technical/adaptation.mjs';
import { sha256 } from '../exchange/index.mjs';

const parent = path.resolve('local', 'native-handoff-tests');
await mkdir(parent, { recursive: true });
const resource = 'data/scene.json';
const lines = ['The lamp lights the path.', 'The wind carries a quiet song.'];
const secrets = { encrypt: value => `fixture:${value}`, decrypt: value => value.slice(8) };

async function completed(service, projectId) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const project = await service.getProject({ projectId });
    if (project.status === 'completed') return project;
    if (['paused', 'failed'].includes(project.status)) assert.fail(JSON.stringify(project));
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Native handoff did not finish within its local test deadline');
}

async function fixture(t, { extractFailures = 0, roundtripFailures = 0, roundtripResult } = {}) {
  const directory = await mkdtemp(path.join(parent, 'case-'));
  const gameDir = path.join(directory, 'game'), dataDir = path.join(directory, 'profile');
  await mkdir(path.join(gameDir, 'data'), { recursive: true });
  await mkdir(path.join(gameDir, 'save'));
  const original = JSON.stringify({ lines, logic: { switch: 7 } });
  await writeFile(path.join(gameDir, resource), original);
  await writeFile(path.join(gameDir, 'save/current.dat'), 'retain neutral saved progress');
  await writeFile(path.join(gameDir, 'Game.exe'), 'neutral launcher marker');
  const calls = { extract: 0, roundtrip: 0, models: 0, nativeSummary: undefined, tools: [], translation: 0, proofreading: 0, build: 0, assemble: 0 };
  const worker = async (command, input, options = {}) => {
    options.signal?.throwIfAborted();
    if (command === 'catalog') return { engines: [], nativeRevision: 'native-handoff-fixture-1' };
    if (command === 'assistInfo') return { supported: false, modes: [] };
    if (command === 'probe') return { engine: 'RPG Maker MZ', root: '.', capabilities: { extract: true, nativeBuild: true, assist: false, assistModes: [] } };
    if (command === 'extract') {
      calls.extract++;
      if (calls.extract <= extractFailures) throw new Error('Neutral codec needs a technical retry');
      const source = await readFile(path.join(input.gameDir, resource), 'utf8');
      const units = JSON.parse(source).lines.map((source, index) => ({ id: `native:${index}`, source, kind: 'message', tokens: [], context: { file: resource } }));
      await mkdir(path.join(input.workspaceDir, 'technical'), { recursive: true });
      await writeFile(path.join(input.workspaceDir, 'manifest.json'), JSON.stringify({ engine: 'RPG Maker MZ', units: Object.fromEntries(units.map(unit => [unit.id, { controls: {} }])) }));
      await writeFile(path.join(input.workspaceDir, 'technical/product-source.json'), JSON.stringify({ sourceFiles: { [resource]: sha256(source) } }));
      return { ok: true, result: { workspaceDir: input.workspaceDir, units, sourceFingerprint: sha256(source), files: [resource] } };
    }
    if (command === 'roundtrip') {
      calls.roundtrip++;
      if (calls.roundtrip <= roundtripFailures) throw new Error('Neutral first roundtrip needs recovery');
      return { ok: true, result: roundtripResult ?? { passed: true, byteIdentical: true } };
    }
    if (command === 'validate') return { ok: true, result: { valid: true } };
    if (command === 'build') {
      calls.build++;
      const data = JSON.parse(original);
      for (const row of input.translations) data.lines[Number(row.id.split(':')[1])] = row.translation;
      await mkdir(path.join(input.outputDir, 'data'), { recursive: true });
      await writeFile(path.join(input.outputDir, resource), JSON.stringify(data));
      return { ok: true, result: { buildDir: input.outputDir } };
    }
    if (command === 'assemble') {
      calls.assemble++;
      await cp(gameDir, input.outputDir, { recursive: true }); await cp(input.buildDir, input.outputDir, { recursive: true });
      return { ok: true, result: { outputDir: input.outputDir, launchPath: path.join(input.outputDir, 'Game.exe') } };
    }
    throw new Error(`Unexpected native handoff command ${command}`);
  };
  const service = await createService({ dataDir, worker, secrets, scriptTools: null, imageTools: null,
    coverageScanner: async ({ units = [] }) => ({
      unitCount: units.length, completeness: units.length ? 'complete' : 'partial', needsAdaptation: !units.length,
      summary: { extracted: units.length ? 1 : 0, 'display-text-candidate': units.length ? 0 : 1, unresolvedCandidates: units.length ? 0 : 2 },
      resources: [{ file: resource, kind: units.length ? 'extracted' : 'display-text-candidate', units: units.length }],
      dynamicCandidates: units.length ? [] : lines.map((source, index) => ({ id: `candidate-${index}`, file: resource, source })),
      triggers: units.length ? [] : ['suspected-omission'],
    }),
    technicalProvider: async () => ({ decision: 'native-standard', summary: 'Neutral native writer verified', selectedCandidateIds: [] }),
    provider: async ({ role, wire }) => {
      calls[role]++;
      return { records: wire.payload.units.map(unit => ({ id: unit.id,
        translation: role === 'proofreading' ? unit.currentTranslation : `译文：${unit.source}`, notes: '' })) };
    },
    adaptationProvider: args => runAdaptation({ ...args, generate: async ({ tools }) => {
      calls.models++;
      const summary = await tools.run_tool.execute({ tool: 'native_extract', args: [] });
      calls.tools.push('native_extract'); calls.nativeSummary = summary;
      assert.equal(summary.error, undefined, JSON.stringify(summary));
      assert.equal(summary.unitCount, lines.length); assert.equal(summary.units, undefined);
      const inspected = await tools.run_tool.execute({ tool: 'native_inspect', args: ['--file', resource, '--limit', '2'] });
      calls.tools.push('native_inspect');
      assert.equal(inspected.error, undefined, JSON.stringify(inspected));
      assert.deepEqual(inspected.units.map(unit => unit.source), lines);
      const accepted = await tools.run_tool.execute({ tool: 'native_accept', args: [] });
      calls.tools.push('native_accept');
      assert.equal(accepted.error, undefined, JSON.stringify(accepted));
      assert.equal(accepted.acceptedNativeResultId, summary.nativeResultId);
      assert.equal(accepted.nativeExtraction, undefined);
    } }),
  });
  const settings = defaultSettings(); settings.connection.model = 'native-handoff-fixture'; settings.connection.apiKey = 'local-fixture-key';
  await service.saveSettings(settings);
  t.after(async () => {
    await service.close();
    assert.equal(path.dirname(directory), parent);
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
  });
  return { service, calls, gameDir, original };
}

async function assertProduct(f, project) {
  assert.equal(project.total, lines.length); assert.equal(project.proofread, lines.length);
  assert.equal(project.adaptationPending, false); assert.equal(project.adaptationAvailable, false);
  assert.equal(project.builds.length, 1); assert.ok(f.calls.build >= 1); assert.equal(f.calls.assemble, 1);
  assert.ok(f.calls.translation && f.calls.proofreading);
  const output = JSON.parse(await readFile(path.join(project.builds[0].path, resource), 'utf8'));
  assert.deepEqual(output, { lines: lines.map(source => `译文：${source}`), logic: { switch: 7 } });
  assert.equal(await readFile(path.join(f.gameDir, resource), 'utf8'), f.original);
  assert.equal(await readFile(path.join(f.gameDir, 'save/current.dat'), 'utf8'), 'retain neutral saved progress');
}

test('technical native tools hand recovered extraction to the mature writer and complete production', async t => {
  const f = await fixture(t, { extractFailures: 2 });
  const created = await f.service.createProject({ gameDir: f.gameDir });
  assert.equal(created.status, 'failed'); assert.equal(created.total, 0); assert.equal(f.calls.extract, 1);
  await f.service.startProject({ projectId: created.id });
  const result = await completed(f.service, created.id);
  assert.equal(f.calls.extract, 3, 'Initial preparation and native retry fail; the Agent calls the same registered native extractor once');
  assert.equal(f.calls.models, 1); assert.deepEqual(f.calls.tools, ['native_extract', 'native_inspect', 'native_accept']);
  assert.equal(f.calls.nativeSummary.reused, undefined);
  await assertProduct(f, result);
});

test('an extracted stage survives failed roundtrip and the Agent rechecks it without extracting again', async t => {
  const f = await fixture(t, { roundtripFailures: 2 });
  const created = await f.service.createProject({ gameDir: f.gameDir });
  assert.equal(created.status, 'failed'); assert.equal(created.total, 0); assert.equal(f.calls.extract, 1);
  await f.service.startProject({ projectId: created.id });
  const result = await completed(f.service, created.id);
  assert.equal(f.calls.extract, 1, 'The current pipeline already staged complete text; the Agent reuses it instead of extracting again');
  assert.equal(f.calls.nativeSummary.reused, true); assert.equal(f.calls.models, 1);
  assert.ok(f.calls.roundtrip >= 3, 'Native acceptance and preparation both check the retained workbench');
  await assertProduct(f, result);
});

test('explicit native structural equality is accepted without claiming byte identity', async t => {
  const f = await fixture(t, { roundtripResult: { byteIdentical: false, nativeSemanticRoundtrip: true, status: 'native_roundtrip_structurally_equal' } });
  const project = await f.service.createProject({ gameDir: f.gameDir });
  assert.equal(project.total, lines.length);
  assert.equal(project.status, 'ready');
  assert.equal(f.calls.models, 0);
});

test('semantic metadata never overrides a failed check or an unexplained byte difference', async t => {
  for (const result of [{ byteIdentical: false },
    { byteIdentical: false, nativeSemanticRoundtrip: true },
    { byteIdentical: false, nativeSemanticRoundtrip: true, status: 'native_roundtrip_structurally_equal', passed: false }]) {
    const f = await fixture(t, { roundtripResult: result });
    const project = await f.service.createProject({ gameDir: f.gameDir });
    assert.equal(project.total, 0);
    assert.equal(project.status, 'failed');
  }
});
