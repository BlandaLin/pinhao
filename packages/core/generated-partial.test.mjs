import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { createAdapterLab } from '../technical/adaptation/adapter-lab.mjs';
import { runAdaptation } from '../technical/adaptation.mjs';

const root = path.resolve('local', 'generated-partial-tests');
await mkdir(root, { recursive: true });
const secrets = {
  encrypt: value => `test:${Buffer.from(value).toString('base64')}`,
  decrypt: value => Buffer.from(value.slice(5), 'base64').toString(),
};
const source = { lines: ['a quiet room.', 'a short path.', 'a distant sign.'], logic: { switch: 9, asset: 'keep.png' } };
const translations = ['示例甲。', '示例乙。'];

function adapter(index) {
  const manifest = { schemaVersion: 1, id: `neutral-partial-${index}`, version: '1.0.0', engine: 'Neutral Generated Resource',
    scope: { files: ['data/custom.json'] }, license: 'GPL-3.0-or-later', sources: [] };
  const code = `({detect(){return {matched:true}},extract(host){const data=JSON.parse(host.readText('data/custom.json'));return {units:[{id:'line:${index}',source:data.lines[${index}],kind:'dialogue',context:{file:'data/custom.json',scene:'neutral'},locator:{file:'data/custom.json',pointer:'/lines/${index}'}}]}},validate(){return {valid:true}},roundtrip(host){host.writeBytes('data/custom.json',host.readBytes('data/custom.json'));return {}},build(host,input){const data=JSON.parse(host.readText('data/custom.json'));if(Object.hasOwn(input.translations,'line:${index}'))data.lines[${index}]=input.translations['line:${index}'];host.writeText('data/custom.json',JSON.stringify(data));return {}},assemble(){return {complete:true}}})`;
  return { manifest, code };
}

async function completed(service, projectId) {
  const deadline = Date.now() + 30000;
  let project;
  while (Date.now() < deadline) {
    project = await service.getProject({ projectId });
    if (project.status === 'completed') return project;
    if (['paused', 'failed'].includes(project.status)) throw new Error(`Partial generation did not continue: ${project.lastError ?? project.stage}`);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error(`Partial generation timed out: ${JSON.stringify(project)}`);
}

async function fixture(t, batches) {
  const directory = await mkdtemp(path.join(root, 'flow-'));
  const gameDir = path.join(directory, 'game'), dataDir = path.join(directory, 'profile'), labDir = path.join(directory, 'recipes');
  await mkdir(path.join(gameDir, 'data'), { recursive: true });
  await mkdir(path.join(gameDir, 'save'));
  await writeFile(path.join(gameDir, 'Game.exe'), 'neutral launcher marker');
  await writeFile(path.join(gameDir, 'data', 'custom.json'), JSON.stringify(source));
  await writeFile(path.join(gameDir, 'save', 'private-save.sav'), 'preserved save');
  const calls = { native: [], dispatch: [], provider: [], sessions: 0 };
  const create = async () => {
    const lab = await createAdapterLab({ dataDir: labDir });
    const dispatch = lab.dispatch.bind(lab);
    lab.dispatch = async (command, args, signal) => {
      const result = await dispatch(command, args, signal);
      if (result) calls.dispatch.push({ command, workspaceDir: args.workspaceDir });
      return result;
    };
    return createService({ dataDir, secrets, adapterLab: lab, scriptTools: null, imageTools: null,
      worker: async command => {
        calls.native.push(command);
        if (command === 'catalog') return { engines: [] };
        if (command === 'assistInfo') return { supported: false, modes: [] };
        if (command === 'probe') throw Object.assign(new Error('Neutral engine requires adaptation'), { code: 'UNKNOWN_ENGINE' });
        throw new Error(`Generated base must handle ${command} through the real adapter lab`);
      },
      provider: async ({ wire, role }) => {
        const { units } = wire.payload;
        calls.provider.push({ role, ids: units.map(unit => unit.id) });
        return { records: units.map(unit => ({ id: unit.id, translation: role === 'proofreading' ? unit.currentTranslation : translations[source.lines.indexOf(unit.source)], notes: '' })) };
      },
      technicalProvider: async () => ({ decision: 'native-standard', summary: 'Neutral resource inspection', selectedCandidateIds: [] }),
      adaptationProvider: args => runAdaptation({ ...args, generate: async ({ tools }) => {
        if (++calls.sessions !== 1) return { finishReason: 'stop' };
        for (let index = 0; index < batches; index++) {
          const candidate = await tools.write_adapter.execute(adapter(index));
          assert.ok(candidate.candidateId, candidate.error?.message);
          const validation = await tools.validate_adapter.execute({ candidateId: candidate.candidateId });
          assert.equal(validation.passed, true, validation.error?.message);
          const submitted = await tools.submit_recipe.execute({ candidateId: candidate.candidateId, validationId: validation.validationId, metadata: {} });
          assert.equal(submitted.accepted, true, submitted.error?.message);
          assert.equal(submitted.taskComplete, false, 'the third display field remains uncovered');
        }
        return { finishReason: 'stop' };
      } }),
    });
  };
  let service = await create();
  const settings = defaultSettings();
  settings.connection.model = 'neutral-local-fixture';
  settings.connection.apiKey = 'neutral-fixture-key';
  settings.pauseOnLocalFailure = false;
  await service.saveSettings(settings);
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); });
  return { gameDir, calls, get service() { return service; }, reopen: async () => { await service.close(); service = await create(); } };
}

for (const batches of [1, 2]) test(`unknown engine continues with ${batches} verified partial ${batches === 1 ? 'recipe' : 'same-resource recipes'} and retains uncovered text`, async t => {
  const f = await fixture(t, batches);
  const original = await readFile(path.join(f.gameDir, 'data', 'custom.json'));
  const project = await f.service.createProject({ gameDir: f.gameDir });
  assert.equal(project.status, 'failed');
  assert.equal(project.total, 0);
  await f.service.startProject({ projectId: project.id });
  const result = await completed(f.service, project.id);
  assert.equal(result.total, batches);
  assert.equal(result.proofread, batches);
  assert.equal(result.adaptationPending, false, 'pending coverage does not block accepted text');
  assert.equal(result.adaptationDeferred, true);
  assert.equal(result.adaptationAvailable, true, 'the user can return to unresolved resources');
  assert.equal(result.coverage.needsAdaptation, true);
  assert.ok(result.coverage.summary.unresolvedCandidates >= 1);
  assert.equal(result.builds.at(-1).checks.find(item => item.name === '资源文字覆盖').status, 'pending');
  const built = JSON.parse(await readFile(path.join(result.builds.at(-1).path, 'data', 'custom.json'), 'utf8'));
  assert.deepEqual(built, { ...source, lines: source.lines.map((line, index) => index < batches ? translations[index] : line) });
  assert.ok(f.calls.provider.some(call => call.role === 'translation'));
  assert.ok(f.calls.provider.some(call => call.role === 'proofreading'));
  assert.ok(f.calls.dispatch.some(call => call.command === 'build'));
  assert.ok(f.calls.dispatch.some(call => call.command === 'assemble'));
  assert.ok(f.calls.native.every(command => ['catalog', 'probe', 'assistInfo'].includes(command)), 'the generated base owns native writeback and assembly');
  if (batches === 2) {
    const units = (await f.service.listText({ projectId: project.id })).units;
    const first = units.find(unit => unit.legacyId === 'line:0');
    await f.service.saveText({ projectId: project.id, unitId: first.id, expectedRevision: first.revision, translation: '人工确认示例。', notes: 'keep reviewed wording', action: 'confirm' });
    const sessions = f.calls.sessions;
    await f.reopen();
    const preserved = (await f.service.listText({ projectId: project.id })).units.find(unit => unit.id === first.id);
    assert.equal(preserved.translation, '人工确认示例。');
    assert.equal(preserved.notes, 'keep reviewed wording');
    await f.service.startProject({ projectId: project.id });
    const rebuilt = await completed(f.service, project.id);
    assert.equal(f.calls.sessions, sessions, 'retained technical coverage is deferred across restart');
    const output = JSON.parse(await readFile(path.join(rebuilt.builds.at(-1).path, 'data', 'custom.json'), 'utf8'));
    assert.deepEqual(output, { ...source, lines: ['人工确认示例。', translations[1], source.lines[2]] });
    assert.equal((await f.service.listText({ projectId: project.id })).units.find(unit => unit.id === first.id).revision, preserved.revision);
  }
  assert.deepEqual(await readFile(path.join(f.gameDir, 'data', 'custom.json')), original);
  assert.equal(await readFile(path.join(f.gameDir, 'save', 'private-save.sav'), 'utf8'), 'preserved save');
});
