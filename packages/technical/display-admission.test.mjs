import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAdapterLab } from './adaptation/adapter-lab.mjs';
import { createDisplayVerifier } from './adaptation/display-review.mjs';

const manifest = { schemaVersion: 1, id: 'admission-fixture', version: '1.0.0', engine: 'Fixture', license: 'GPL-3.0-or-later', scope: { files: ['scene.json'] } };
const code = `({detect(){return true},extract(h){const d=JSON.parse(h.readText('scene.json'));return {units:Object.keys(d).map(k=>({id:k,source:d[k],kind:'dialogue',context:{file:'scene.json'},locator:{file:'scene.json',pointer:'/'+k}}))}},validate(){return {valid:true}},roundtrip(h){h.writeBytes('scene.json',h.readBytes('scene.json'));return {}},build(h,i){const d=JSON.parse(h.readText('scene.json'));for(const u of i.units)if(Object.hasOwn(i.translations,u.id))d[u.id]=i.translations[u.id];h.writeText('scene.json',JSON.stringify(d));return {}},assemble(){return {}}})`;

async function fixture(t, data) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-display-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gameDir = path.join(root, 'game'), workspaceDir = path.join(root, 'work');
  await mkdir(gameDir); await mkdir(workspaceDir);
  await writeFile(path.join(gameDir, 'scene.json'), JSON.stringify(data));
  await writeFile(path.join(gameDir, 'consumer.js'), 'screen.text = scene.body;');
  let calls = 0;
  const displayVerifier = createDisplayVerifier({ connectionFor: () => ({ baseUrl: 'https://fixture.invalid/v1', model: 'independent-fixture' }),
    generate: async ({ tools, prompt }) => {
      calls++;
      const { units } = JSON.parse(prompt);
      const source = await tools.read_resource.execute({ file: 'scene.json' });
      const consumer = await tools.read_resource.execute({ file: 'consumer.js' });
      await tools.finish_review.execute({ decisions: units.map(unit => ({ ref: unit.ref,
        status: unit.locator.pointer === '/body' ? 'display-supported' : 'non-display',
        reason: unit.locator.pointer === '/body' ? 'The observed screen sink consumes body.' : 'The consumer does not use the editor note.',
        evidenceIds: [source.evidenceId], consumerEvidenceIds: [consumer.evidenceId] })) });
    } });
  const dataDir = path.join(root, 'lab');
  const lab = await createAdapterLab({ dataDir, displayVerifier });
  const candidate = await lab.writeAdapter({ manifest, code });
  return { root, gameDir, workspaceDir, dataDir, lab, candidate, displayVerifier, calls: () => calls };
}

test('mechanical success cannot admit a generated editor-note unit', async t => {
  const f = await fixture(t, { body: 'Welcome to the inn.', note: 'An instruction for the author.' });
  const before = await readFile(path.join(f.gameDir, 'scene.json'));
  const checked = await f.lab.validateAdapter({ ...f.candidate, gameDir: f.gameDir, workspaceDir: f.workspaceDir });
  assert.equal(checked.checks.structure, 'passed');
  assert.equal(checked.checks.sample, 'passed');
  assert.equal(checked.passed, false);
  assert.equal(checked.displayReview.decisions.length, 2);
  assert.equal(checked.error.code, 'ADAPTER_DISPLAY_REVIEW_FAILED');
  await assert.rejects(f.lab.submitRecipe({ ...f.candidate, validationId: checked.validationId }));
  const again = await f.lab.validateAdapter({ ...f.candidate, gameDir: f.gameDir, workspaceDir: f.workspaceDir });
  assert.equal(again.passed, false);
  assert.equal(f.calls(), 1, 'a completed negative review is not repurchased');
  assert.deepEqual(await readFile(path.join(f.gameDir, 'scene.json')), before);
});

test('display proof is reused then invalidated by a same-size consumer change', async t => {
  const f = await fixture(t, { body: 'Welcome to the inn.' });
  const checked = await f.lab.validateAdapter({ ...f.candidate, gameDir: f.gameDir, workspaceDir: f.workspaceDir });
  assert.equal(checked.passed, true, checked.error?.message);
  assert.equal(checked.checks.display, 'passed');
  assert.equal(checked.runtime.status, 'pending');
  const again = await f.lab.validateAdapter({ ...f.candidate, gameDir: f.gameDir, workspaceDir: f.workspaceDir });
  assert.equal(again.reused, true);
  assert.equal(f.calls(), 1);
  await writeFile(path.join(f.gameDir, 'consumer.js'), 'screen.text = scene.note;');
  await assert.rejects(f.lab.submitRecipe({ ...f.candidate, validationId: checked.validationId }), /依赖|协议/);
});

test('a structural-only proof cannot bypass a configured semantic reviewer', async t => {
  const f = await fixture(t, { body: 'Welcome to the inn.' });
  const structural = await createAdapterLab({ dataDir: f.dataDir });
  const old = await structural.validateAdapter({ ...f.candidate, gameDir: f.gameDir, workspaceDir: f.workspaceDir });
  assert.equal(old.passed, true);
  await assert.rejects(f.lab.submitRecipe({ ...f.candidate, validationId: old.validationId }), /依赖|协议/);
  const checked = await f.lab.validateAdapter({ ...f.candidate, gameDir: f.gameDir, workspaceDir: f.workspaceDir });
  assert.equal(checked.passed, true, checked.error?.message);
  assert.equal(checked.reused, undefined);
  assert.equal(f.calls(), 1);
});
