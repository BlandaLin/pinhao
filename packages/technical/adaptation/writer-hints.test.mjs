import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { adaptationTools } from '../adaptation.mjs';
import { createAdapterLab } from './adapter-lab.mjs';
import { createDisplayVerifier } from './display-review.mjs';

test('real embedded writer tool accepts typed consumer navigation and delivers host sidecar to independent reviewer without embedding it in code', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-writer-hints-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }));
  const gameDir = path.join(root, 'game'), workspaceDir = path.join(root, 'work'), projectDir = path.join(root, 'project');
  await mkdir(path.join(gameDir, 'data'), { recursive: true }); await mkdir(path.join(gameDir, 'js/plugins'), { recursive: true }); await mkdir(workspaceDir);
  const file = 'data/CommonEvents.json', pointer = '/1/list/0/parameters/0';
  await writeFile(path.join(gameDir, file), JSON.stringify([null, { id: 1, name: 'Internal event', list: [{ code: 356, indent: 0, parameters: ['NOTICE_PANEL Complete menu text 32'] }, { code: 0, parameters: [] }] }]));
  await writeFile(path.join(gameDir, 'js/rpg_objects.js'), `Game_Interpreter.prototype.command356 = function() { var args = this._params[0].split(' '); var command = args.shift(); this.pluginCommand(command, args); return true; };`);
  await writeFile(path.join(gameDir, 'js/plugins.js'), `var $plugins = [{name:'Notice',status:true,parameters:{}}];`);
  await writeFile(path.join(gameDir, 'js/plugins/Notice.js'), `Game_Interpreter.prototype.pluginCommand = function(command,args) { if(command==='NOTICE_PANEL') { $gameMessage.add(args.slice(0,-1).join(' ')); this.fontSize=Number(args[args.length-1]); } };`);
  let reviews = 0;
  const displayVerifier = createDisplayVerifier({ connectionFor: () => ({ baseUrl: 'http://local.invalid', model: 'independent-fixture' }),
    projectFor: () => ({ id: 'project', workspaceDir: projectDir }), generate: async ({ tools, prompt }) => {
      reviews++; const row = JSON.parse(prompt).units[0];
      assert.equal(row.producerHints.some(hint => hint.resourceRef?.path === 'js/plugins/Notice.js' || hint.resourceRef?.file === 'js/plugins/Notice.js'), true);
      assert.equal(row.producerHints.some(hint => hint.note === 'host-sidecar-only'), true);
      await assert.rejects(tools.finish_review.execute({ decisions: [{ ref: row.ref, status: 'display-supported', reason: 'Author navigation is not independent evidence.', evidenceIds: [], consumerEvidenceIds: [] }] }), error => error.code === 'DISPLAY_REVIEW_EVIDENCE_REQUIRED');
      const source = await tools.read_resource.execute({ file }), consumer = await tools.read_resource.execute({ file: 'js/plugins/Notice.js' });
      await tools.read_resource.execute({ file: 'js/plugins.js' });
      await tools.finish_review.execute({ decisions: [{ ref: row.ref, status: 'display-supported', reason: 'Independent active plugin and source read completed.', evidenceIds: [source.receiptId], consumerEvidenceIds: [consumer.receiptId] }] });
    } });
  const lab = await createAdapterLab({ dataDir: path.join(root, 'lab'), displayVerifier });
  const host = adaptationTools({ project: { id: 'project', name: 'Neutral', engine: 'MV', workspaceDir: projectDir }, inventory: {}, coverage: { needsAdaptation: true }, lab,
    gameDir, workspaceDir, state: { id: 'host-session', events: [] }, assignment: { id: 'resource-owner', files: [file] } });
  t.after(async () => { await host.close(); await host.flush(); });
  assert.ok(host.tools.write_embedded_text_adapter.inputSchema.jsonSchema.properties.selections.items.properties.consumerHints);
  const consumer = await host.tools.read_resource.execute({ file: 'js/plugins/Notice.js', root: 'source' });
  const input = { selections: [{ file, pointer, text: 'Complete menu text', reason: 'Enabled Notice plugin joins all text arguments before font size.',
    consumerHints: [{ receiptRef: consumer.receiptId, resourceRef: { file: 'js/plugins/Notice.js' }, relation: 'renders', note: 'host-sidecar-only' }] }] };
  const candidate = await host.tools.write_embedded_text_adapter.execute(input);
  assert.ok(candidate.candidateId, JSON.stringify(candidate));
  const stored = await lab.inspectAdapter({ candidateId: candidate.candidateId, projectId: 'project', workDir: workspaceDir });
  assert.doesNotMatch(stored.code, /host-sidecar-only|consumerHints/);
  const repeated = await host.tools.write_embedded_text_adapter.execute({ selections: [{ ...input.selections[0], consumerHints: [{ resourceRef: { file: 'js/plugins/Notice.js' }, note: 'updated-navigation-only' }] }] });
  assert.equal(repeated.candidateId, candidate.candidateId, 'navigation does not change executable writer identity');
  const validation = await host.tools.validate_adapter.execute({ candidateId: candidate.candidateId });
  assert.equal(validation.passed, true, JSON.stringify(validation.error)); assert.equal(reviews, 1);
});

test('a writer with no hints forwards only actual source-read navigation and returns the next real validation call', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-writer-navigation-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }));
  const gameDir = path.join(root, 'game'), workspaceDir = path.join(root, 'work'), projectDir = path.join(root, 'project');
  await mkdir(gameDir); await mkdir(workspaceDir);
  await writeFile(path.join(gameDir, 'story.json'), '{"caption":"A full visible caption.","identity":"keep"}');
  await writeFile(path.join(gameDir, 'screen.js'), 'function render(data) { caption.textContent = data.caption; }');
  await writeFile(path.join(workspaceDir, 'notes.txt'), 'Investigator notes are not consumer evidence.');
  let sourceOrigin, reviewed = 0;
  const displayVerifier = createDisplayVerifier({ connectionFor: () => ({ baseUrl: 'http://local.invalid', model: 'review-fixture' }),
    projectFor: () => ({ id: 'project', workspaceDir: projectDir }), sourceOriginFor: () => sourceOrigin,
    generate: async ({ tools, prompt }) => {
      reviewed++;
      const message = JSON.parse(prompt), row = message.units[0];
      assert.equal(row.producerHints, undefined, 'shared navigation is not copied into each text row');
      assert.equal(message.producerHints.length, 1);
      assert.equal(message.producerHints[0].relation, 'investigated');
      const call = message.producerHints[0].nextCall;
      assert.equal(call.tool, 'read_resource'); assert.equal(call.input.file, 'screen.js');
      await assert.rejects(tools.finish_review.execute({ decisions: [{ ref: row.ref, status: 'display-supported',
        reason: 'Navigation cannot establish a verdict.', evidenceIds: [], consumerEvidenceIds: [] }] }), { code: 'DISPLAY_REVIEW_EVIDENCE_REQUIRED' });
      const source = await tools.read_resource.execute({ file: 'story.json' }), consumer = await tools.read_resource.execute(call.input);
      await tools.finish_review.execute({ decisions: [{ ref: row.ref, status: 'display-supported', reason: 'Read actual source and rendering consumer.',
        evidenceIds: [source.receiptId], consumerEvidenceIds: [consumer.receiptId] }] });
    } });
  const lab = await createAdapterLab({ dataDir: path.join(root, 'lab'), displayVerifier });
  const host = adaptationTools({ project: { id: 'project', engine: 'Fixture', workspaceDir: projectDir }, inventory: {},
    coverage: { needsAdaptation: true }, lab, gameDir, workspaceDir, state: { id: 'nav-session', events: [], failures: {} } });
  t.after(async () => { await host.close(); await host.flush(); });
  await host.tools.read_resource.execute({ file: 'notes.txt', root: 'work' });
  await host.tools.read_resource.execute({ file: 'screen.js', root: 'source' });
  await host.tools.read_resource.execute({ file: 'screen.js', root: 'source' });
  await host.tools.read_resource.execute({ file: 'missing.js', root: 'source' });
  const code = `({detect(){return true},extract(host){return {units:[{id:'caption',source:JSON.parse(host.readText('story.json')).caption,locator:{file:'story.json',pointer:'/caption'}}]}},validate(){return true},roundtrip(host){host.writeBytes('story.json',host.readBytes('story.json'));return {}},build(host,input){const data=JSON.parse(host.readText('story.json'));data.caption=input.translations.caption??data.caption;host.writeText('story.json',JSON.stringify(data));return {}},assemble(){return {}}})`;
  const candidate = await host.tools.write_adapter.execute({ manifest: { schemaVersion: 1, id: 'navigation-json', version: '1.0.0',
    engine: 'Fixture', scope: { files: ['story.json'] }, license: 'GPL-3.0-or-later' }, code });
  assert.equal(candidate.consumerNavigationCount, 1, JSON.stringify(candidate));
  assert.deepEqual(candidate.nextCall, { tool: 'validate_adapter', input: { candidateId: candidate.candidateId } });
  const saved = await lab.inspectAdapter({ candidateId: candidate.candidateId, projectId: 'project', workDir: workspaceDir });
  const sidecar = JSON.parse(await readFile(path.join(workspaceDir, 'technical-lab', 'candidates', `${candidate.candidateId}.json`), 'utf8'));
  assert.equal(sidecar.producerHints[0].hints.length, 1);
  const hint = sidecar.producerHints[0].hints[0];
  assert.equal(hint.resourceRef.path, 'screen.js');
  assert.equal(hint.qualification, 'host-verified-navigation');
  sourceOrigin = hint.resourceRef.originId;
  assert.doesNotMatch(saved.code, /investigated|receipt-|Investigator notes/);
  const validation = await host.tools.validate_adapter.execute(candidate.nextCall.input);
  assert.equal(validation.passed, true, JSON.stringify(validation));
  assert.deepEqual(validation.nextCall, { tool: 'submit_recipe', input: { candidateId: candidate.candidateId,
    validationId: validation.validationId, metadata: {} } });
  assert.equal(reviewed, 1);
});
