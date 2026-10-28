import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { runAdaptation } from '../technical/adaptation.mjs';
import { checkedPath } from '../technical/adaptation/paths.mjs';

const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('Windows default service source-copy routing reaches real independent-review SDK wire', { skip: process.platform !== 'win32', timeout: 25000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-win-source-route-'));
  const gameDir = path.join(directory, 'game'), dataDir = path.join(directory, 'profile');
  const attempted = gate(), hold = gate(), requests = [];
  let service;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      assert.equal(req.url, '/v1/chat/completions');
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); requests.push(body);
      const observed = body.messages.filter(row => row.role === 'tool').map(row => JSON.parse(row.content));
      const call = observed.length >= 2 ? { name: 'finish_review', arguments: { decisions: [{ ref: '1', status: 'display-supported',
        reason: 'The independently read event caption reaches the enabled message plugin.',
        evidenceIds: [observed[0].receiptId], consumerEvidenceIds: [observed[1].receiptId] }] } }
        : observed.length ? { name: 'read_resource', arguments: { file: 'js/plugins/Notice.js', sourceIndex: 1 } }
        : { name: 'read_resource', arguments: { file: 'data/CommonEvents.json', sourceIndex: 0 } };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `local-${requests.length}`, object: 'chat.completion', created: 1, model: 'local-sdk',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
          tool_calls: [{ id: `call-${requests.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }));
    } catch (error) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: error.message } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    hold.resolve(); await service?.close();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
  });
  await mkdir(path.join(gameDir, 'data'), { recursive: true });
  await writeFile(path.join(gameDir, 'data/CommonEvents.json'), JSON.stringify([null, { id: 1, list: [{ code: 356, indent: 0, parameters: ['NOTE A neutral caption. 24'] }] }]));
  await mkdir(path.join(gameDir, 'js/plugins'), { recursive: true });
  await writeFile(path.join(gameDir, 'js/rpg_objects.js'), "Game_Interpreter.prototype.command356=function(){var args=this._params[0].split(' ');var command=args.shift();this.pluginCommand(command,args);return true;};");
  await writeFile(path.join(gameDir, 'js/plugins.js'), "var $plugins=[{name:'Notice',status:true}];");
  await writeFile(path.join(gameDir, 'js/plugins/Notice.js'), "Game_Interpreter.prototype.pluginCommand=function(command,args){if(command==='NOTE')$gameMessage.add(args.slice(0,-1).join(' '));};");
  const worker = async (command, args) => {
    if (command === 'catalog') return { engines: [] };
    if (command === 'probe') return { engine: 'RPG Maker MV', root: '.', capabilities: { extract: true, nativeBuild: true } };
    if (command === 'extract') {
      await mkdir(args.workspaceDir, { recursive: true });
      await writeFile(path.join(args.workspaceDir, 'manifest.json'), JSON.stringify({ units: { native: { controls: {} } } }));
      return { workspaceDir: args.workspaceDir, units: [{ id: 'native', source: 'A native caption.', kind: 'message', tokens: [], context: {} }], coverage: {} };
    }
    if (command === 'roundtrip' || command === 'validate') return { valid: true, passed: true };
    throw new Error(`Unexpected neutral worker operation: ${command}`);
  };
  service = await createService({ dataDir, worker, scriptTools: null, imageTools: null,
    secrets: { encrypt: value => value, decrypt: value => value },
    coverageScanner: async () => ({ needsAdaptation: true, completeness: 'partial', triggers: ['suspected-omission'],
      resources: [{ file: 'data/CommonEvents.json', kind: 'display-text-candidate' }], summary: { unresolvedCandidates: 1 } }),
    adaptationProvider: args => runAdaptation({ ...args, generate: async ({ tools }) => {
      const relative = path.relative(path.join(args.project.workspaceDir, 'technical'), args.gameDir);
      assert.equal(relative.split(path.sep).at(-1), 'source');
      assert.ok(relative.includes('\\'), 'the default caller must actually traverse a Windows-native relative path');
      await assert.rejects(checkedPath(path.join(args.project.workspaceDir, 'technical'), relative), /资源路径须使用项目内的相对路径/);
      await assert.rejects(readFile(path.join(args.gameDir, 'js/rpg_objects.js')), { code: 'ENOENT' }, 'the qualifier must resolve an unmaterialized dependency from the verified original');
      assert.equal(requests.length, 0, 'the old native-backslash argument fails before any independent-review HTTP');
      const candidate = await tools.write_adapter.execute({ manifest: { schemaVersion: 1, id: 'windows-source-caption', version: '1.0.0', engine: 'RPG Maker MV', license: 'GPL-3.0-or-later', scope: { files: ['data/CommonEvents.json'] } },
        code: `({detect(){return true},extract(host){const data=JSON.parse(host.readText('data/CommonEvents.json'));return {units:[{id:'caption-a',source:data[1].list[0].parameters[0].slice(5,-3),kind:'message',locator:{file:'data/CommonEvents.json',pointer:'/1/list/0/parameters/0',segment:{syntax:'rpgmaker-plugin-command',prefix:'NOTE ',suffix:' 24'}},context:{file:'data/CommonEvents.json'}}]}},validate(){return {valid:true}},roundtrip(host){host.writeBytes('data/CommonEvents.json',host.readBytes('data/CommonEvents.json'));return {}},build(host,input){const data=JSON.parse(host.readText('data/CommonEvents.json'));if(Object.hasOwn(input.translations,'caption-a'))data[1].list[0].parameters[0]='NOTE '+input.translations['caption-a']+' 24';host.writeText('data/CommonEvents.json',JSON.stringify(data));return {}},assemble(){return {complete:true}}})` });
      if (!candidate.candidateId) { attempted.resolve({ candidate }); await hold.promise; return { finishReason: 'stop' }; }
      const validation = await tools.validate_adapter.execute({ candidateId: candidate.candidateId });
      attempted.resolve({ candidate, validation }); await hold.promise; return { finishReason: 'stop' };
    } }) });
  // Deliberately do not inject adapterLab or displayVerifier: exercise getLab's real defaults.
  const settings = defaultSettings(); settings.connection = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'local-sdk', apiKey: 'local-sentinel-only' };
  settings.concurrency = 1; settings.processImages = false;
  await service.saveSettings(settings);
  const project = await service.createProject({ gameDir });
  await service.startProject({ projectId: project.id });
  const result = await Promise.race([attempted.promise, new Promise((_, reject) => {
    const timer = setTimeout(async () => { const current = await service.getProject({ projectId: project.id }); reject(new Error(`Default route never reached validation: ${current.lastError ?? current.stage}`)); }, 15000);
    timer.unref(); attempted.promise.finally(() => clearTimeout(timer));
  })]);
  assert.ok(result.candidate.candidateId, JSON.stringify(result));
  assert.equal(result.validation?.passed, true, JSON.stringify(result.validation));
  assert.equal(requests.length, 3, 'source routing must reach actual source, consumer and finish SDK calls, not fail before HTTP');
  const prompt = JSON.parse(requests[0].messages.find(row => row.role === 'user').content);
  assert.equal(prompt.units[0].source, 'A neutral caption.');
  const read = requests[1].messages.filter(row => row.role === 'tool').map(row => JSON.parse(row.content))[0];
  assert.match(read.content, /NOTE A neutral caption/); assert.ok(read.receiptId);
  await service.pauseProject({ projectId: project.id }); hold.resolve();
});
