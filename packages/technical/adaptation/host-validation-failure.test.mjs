import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAdapterLab } from './adapter-lab.mjs';
import { runAdaptation } from '../adaptation.mjs';

const manifest = { schemaVersion: 1, id: 'host-root-caption', version: '1.0.0', engine: 'Fixture', license: 'GPL-3.0-or-later', scope: { files: ['data/dialogue.json'] } };
const code = `({detect(){return true},extract(host){const data=JSON.parse(host.readText('data/dialogue.json'));return {units:[{id:'line',source:data.text,kind:'message',locator:{file:'data/dialogue.json',pointer:'/text'}}]}},validate(){return {valid:true}},roundtrip(host){host.writeBytes('data/dialogue.json',host.readBytes('data/dialogue.json'));return {}},build(host,input){const data=JSON.parse(host.readText('data/dialogue.json'));if(Object.hasOwn(input.translations,'line'))data.text=input.translations.line;host.writeText('data/dialogue.json',JSON.stringify(data));return {}},assemble(){return {complete:true}}})`;

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-host-output-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }));
  const gameDir = path.join(directory, 'game'), workspaceDir = path.join(directory, 'work');
  await mkdir(path.join(gameDir, 'data'), { recursive: true });
  await writeFile(path.join(gameDir, 'data/dialogue.json'), '{"text":"A complete neutral caption.","identity":"keep"}');
  const lab = await createAdapterLab({ dataDir: path.join(directory, 'lab') });
  return { directory, gameDir, workspaceDir, lab };
}

for (const removeRoot of [false, true]) test(`host-created sample root ENOENT ${removeRoot ? 'with a missing root' : 'despite a present root'} preserves validation and stops the model`, async t => {
  const f = await fixture(t), before = await readFile(path.join(f.gameDir, 'data/dialogue.json'));
  const original = fs.promises.lstat;
  let injected = false, generated = 0, candidateId, failure;
  fs.promises.lstat = async (file, ...args) => {
    const resource = String(file);
    if (!injected && path.resolve(resource).startsWith(f.directory + path.sep) && path.basename(resource) === 'sample'
        && fs.existsSync(path.join(resource, 'data/dialogue.json'))) {
      injected = true;
      if (removeRoot) fs.rmSync(resource, { recursive: true, force: true });
      throw Object.assign(new Error('Injected host output-root lstat failure after real QuickJS build'), { code: 'ENOENT', syscall: 'lstat', path: path.resolve(resource) });
    }
    return original(file, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(runAdaptation({ project: { id: 'project', name: 'Neutral', engine: 'Fixture', workspaceDir: f.workspaceDir },
      lab: f.lab, gameDir: f.gameDir, workspaceDir: f.workspaceDir, statePath: path.join(f.workspaceDir, 'progress.jsonl'),
      generate: async ({ tools }) => {
        generated++;
        const candidate = await tools.write_adapter.execute({ manifest, code }); candidateId = candidate.candidateId;
        assert.ok(candidateId, JSON.stringify(candidate));
        await tools.validate_adapter.execute({ candidateId });
        return { finishReason: 'stop' };
      } }), error => { failure = error; return error.hostFailure === true && error.code === 'HOST_VALIDATION_OUTPUT_UNAVAILABLE'; });
  } finally { fs.promises.lstat = original; syncBuiltinESMExports(); }
  assert.equal(injected, true); assert.equal(generated, 1, 'a host validation error must not become another model repair window');
  assert.equal(failure.evidence.candidateId, candidateId); assert.ok(failure.evidence.validationId);
  const validation = JSON.parse(await readFile(failure.evidence.validationRecordFile, 'utf8'));
  assert.equal(validation.passed, false); assert.equal(validation.error.hostFailure, true);
  assert.equal(validation.checks.roundtrip, 'passed');
  assert.equal(validation.evidence.some(row => row.action === 'build' && row.ok === true && row.writes.includes('data/dialogue.json')), true);
  if (removeRoot) assert.equal(validation.error.evidence.confirmation.code, 'ENOENT');
  else assert.equal(validation.error.evidence.confirmation.kind, 'directory-present');
  assert.deepEqual(await readFile(path.join(f.gameDir, 'data/dialogue.json')), before);
  const restored = await f.lab.validateAdapter({ candidateId, gameDir: f.gameDir, projectId: 'project', workDir: f.workspaceDir });
  assert.equal(restored.passed, true, JSON.stringify(restored.error));
  assert.notEqual(restored.validationId, failure.evidence.validationId); assert.equal(generated, 1, 'the retained candidate is revalidated locally');
});

for (const missing of ['source', 'output']) test(`missing guest ${missing} resources remain candidate validation failures, not host root failures`, async t => {
  const f = await fixture(t);
  const build = missing === 'source' ? `build(host){host.readText('data/missing.json');return {}}` : 'build(){return {}}';
  const badCode = code.replace(/build\(host,input\)\{.*?return \{\}\}/, build);
  const candidate = await f.lab.writeAdapter({ manifest, code: badCode });
  const validation = await f.lab.validateAdapter({ ...candidate, gameDir: f.gameDir, workspaceDir: f.workspaceDir });
  assert.equal(validation.passed, false); assert.notEqual(validation.error.hostFailure, true);
  assert.notEqual(validation.error.code, 'HOST_VALIDATION_OUTPUT_UNAVAILABLE');
  if (missing === 'source') assert.match(validation.error.message, /missing\.json/);
  else assert.match(validation.error.message, /回读|结构|文字/);
});
