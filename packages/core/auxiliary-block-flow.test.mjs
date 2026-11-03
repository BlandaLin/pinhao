import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sdkProvider, taskPrompt } from './provider.mjs';

const units = [
  { id: 'neutral-guild', source: 'Guild counter', translation: '公会柜台', kind: 'dialogue', revision: 0, tokens: [], context: {} },
  { id: 'neutral-inn', source: 'Welcome to the inn.', translation: '欢迎去旅店。', kind: 'dialogue', revision: 0, tokens: [], context: {} },
];

async function localReply(t, body) {
  const requests = [], failures = [];
  const server = http.createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      requests.push(JSON.parse(raw));
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (let offset = 0; offset < body.length; offset += 7) {
        response.write(`data: ${JSON.stringify({ id: 'neutral-auxiliary', choices: [{ index: 0,
          delta: { content: body.slice(offset, offset + 7) }, finish_reason: null }] })}\n\n`);
      }
      response.write(`data: ${JSON.stringify({ id: 'neutral-auxiliary', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 29, completion_tokens: 41, total_tokens: 70 } })}\n\n`);
      response.end('data: [DONE]\n\n');
    } catch (error) { failures.push(error); response.destroy(error); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.deepEqual(failures, [], 'The local endpoint must not hide test failures');
  });
  return { requests, connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'neutral-auxiliary' } };
}

test('SDK accepts pretty term/remark rows without discarding or re-requesting translation body', async t => {
  const raw = '[u1]\n公会柜台\n[u2]\n欢迎来到旅店。\n[完成]\n[附加信息]\n{\n'
    + '"terms": [\n["u1", "Guild", "公会"]\n],\n'
    + '"remarks": [\n["u2", "A polite greeting."]\n],\n"notes": "[完成] inside a note is not a protocol marker."\n}';
  const endpoint = await localReply(t, raw), prompt = taskPrompt('translation', units, 'zh-Hans');
  const result = await sdkProvider({ ...prompt, ...endpoint, signal: AbortSignal.timeout(5000) });
  assert.equal(endpoint.requests.length, 1);
  assert.equal(result.transportRequests, 1);
  assert.equal(result.responseRepair, undefined);
  assert.deepEqual(result.records.map(row => row.id), units.map(unit => unit.id));
  assert.deepEqual(result.records.map(row => row.translation), ['公会柜台', '欢迎来到旅店。']);
  assert.deepEqual(result.records[0].termChoices, [{ source: 'Guild', translation: '公会' }]);
  assert.equal(result.records[1].notes, 'A polite greeting.');
  assert.equal(result.readingNotes, '[完成] inside a note is not a protocol marker.');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.usage.inputTokens, 29);
  assert.equal(result.usage.outputTokens, 41);
});

test('SDK returns complete review coverage from one response with pretty auxiliary rows', async t => {
  const raw = '[u2]\n欢迎来到旅店。\n[完成]\n[附加信息]\n{\n"remarks": [\n'
    + '["u2", "Corrected the direction of the greeting."]\n],\n"notes": "No other change is needed."\n}';
  const endpoint = await localReply(t, raw), prompt = taskPrompt('proofreading', units, 'zh-Hans', [], [], { reviewProtocol: true });
  const result = await sdkProvider({ ...prompt, ...endpoint, signal: AbortSignal.timeout(5000) });
  assert.equal(endpoint.requests.length, 1);
  assert.equal(result.transportRequests, 1);
  assert.equal(result.responseRepair, undefined, 'A legal auxiliary row does not request protocol repair');
  assert.deepEqual(result.review.reviewedIds, units.map(unit => unit.id));
  assert.deepEqual(result.review.edits, [{ id: units[1].id, translation: '欢迎来到旅店。', notes: 'Corrected the direction of the greeting.' }]);
});

test('SDK does not infer full review completion from valid auxiliary rows alone', async t => {
  const raw = '[u2]\n欢迎来到旅店。\n[附加信息]\n{\n"remarks": [\n["u2", "Corrected wording."]\n]\n}';
  const endpoint = await localReply(t, raw), prompt = taskPrompt('proofreading', units, 'zh-Hans', [], [], { reviewProtocol: true });
  const result = await sdkProvider({ ...prompt, ...endpoint, signal: AbortSignal.timeout(5000) });
  assert.equal(endpoint.requests.length, 1);
  assert.deepEqual(result.review.reviewedIds, [units[1].id]);
  assert.equal(result.responseRepair.code, 'INVALID_RESPONSE');
});
