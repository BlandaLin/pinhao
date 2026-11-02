import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { runAdaptation } from './adaptation.mjs';
import { technicalToolCharacters } from './adaptation/context-map.mjs';

test('generic host results use resolved capacity while exact large evidence remains readable', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-tool-capacity-'));
  try {
    const connection = { contextWindow: 16384, maxOutputTokens: 4096 };
    const content = 'neutral capacity evidence '.repeat(5000) + 'EXACT_TAIL';
    await runAdaptation({ project: { id: 'all-tools', engine: 'Fixture' }, gameDir: directory,
      workspaceDir: path.join(directory, 'work'), connection,
      lab: { tryRecipes: async () => null, runTool: async () => ({ status: 'completed', content }) },
      generate: async ({ tools }) => {
        const output = await tools.run_tool.execute({ tool: 'fixture', args: [] });
        assert.ok(JSON.stringify(output).length <= technicalToolCharacters(connection));
        assert.ok(output.outputTruncated);
        assert.equal(output.nextCall.tool, 'read_evidence');
        const tail = await tools.read_evidence.execute({ evidenceId: output.evidenceId,
          pointer: '/content', offset: content.length - 10, length: 10 });
        assert.equal(tail.content, 'EXACT_TAIL');
      } });
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3 }); }
});

test('large context keeps a resource map and precise full-evidence navigation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-context-map-'));
  try {
    const clusters = Array.from({ length: 19 }, (_, i) => ({ id: `cluster-${i}`, file: 'data.bin',
      evidenceHash: 'a'.repeat(64), examples: [{ metadata: 'neutral '.repeat(700) }] }));
    let context, complete;
    const requests = [];
    const server = http.createServer(async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk;
      requests.push(JSON.parse(raw));
      response.writeHead(200, { 'content-type': 'application/json' });
      const message = requests.length === 1 ? { role: 'assistant', content: null, tool_calls: [
        { id: 'map-call', type: 'function', function: { name: 'inspect_context', arguments: '{}' } },
      ] } : { role: 'assistant', content: 'Evidence map received.' };
      response.end(JSON.stringify({ id: 'map-response', model: 'fixture', object: 'chat.completion',
        choices: [{ index: 0, message, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
    await runAdaptation({ project: { id: 'map', name: 'Neutral', engine: 'Unity' },
      gameDir: directory, workspaceDir: path.join(directory, 'work'),
      connection: { contextWindow: 32768, maxOutputTokens: 4096 },
      coverage: { unknownClusters: clusters, resources: [], summary: {} },
      lab: { tryRecipes: async () => null, listTools: async () => [{ name: 'native_inspect' }] },
      generate: async ({ tools }) => {
        context = await tools.inspect_context.execute({});
        complete = await tools.read_evidence.execute({ evidenceId: context.evidenceId,
          pointer: '/coverage/unknownClusters/18/examples/0/metadata', length: 2000 });
      } });
    assert.ok(JSON.stringify(context).length < 16000);
    assert.equal(context.tools.trusted[0].name, 'native_inspect');
    assert.ok(context.progress);
    assert.equal(context.coverage.unknownTotal, 19);
    assert.ok(context.coverage.unknownClusters[0].read.input.pointer.startsWith('/coverage/unknownClusters/'));
    assert.match(JSON.stringify(complete), /neutral neutral/);
    await runAdaptation({ project: { id: 'sdk-map', name: 'Neutral', engine: 'Unity' },
      gameDir: directory, workspaceDir: path.join(directory, 'sdk-work'),
      connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture', contextWindow: 32768, maxOutputTokens: 4096 },
      coverage: { unknownClusters: clusters, resources: [], summary: {} },
      lab: { tryRecipes: async () => null, listTools: async () => [{ name: 'native_inspect' }] } });
    const tool = requests[1].messages.find(message => message.role === 'tool');
    assert.ok(tool.content.length < 16000);
    assert.match(tool.content, /native_inspect/);
    assert.match(tool.content, /\/coverage\/unknownClusters\//);
    assert.equal(requests.length, 2);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3 }); }
});
