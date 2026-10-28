import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { adaptationTools, runAdaptation } from './adaptation.mjs';

const groupId = `native-review-v1:${'a'.repeat(16)}:${'b'.repeat(24)}`;
const siteId = `display-site-v1:${'c'.repeat(64)}`;
const group = (version = 'd') => ({ id: groupId, groupId, evidenceHash: version.repeat(64), file: 'Neutral_Data/level1',
  fields: [{ path: ['Caption'], examples: [{ value: 'A complete neutral line.' }] }],
  fieldUses: { available: true, assemblySha256: 'e'.repeat(64), assemblyFile: 'Neutral_Data/Managed/Neutral.dll', fields: [
    { path: ['Caption'], uses: [{ siteId, displayOnly: true, method: 'System.Void Neutral::Show()', offset: 12, calls: ['UnityEngine.UI.Text::set_text'], receivers: ['Text Label'] }] },
  ] } });
async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-native-ref-'));
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); });
  return root;
}

test('observed group and site references round-trip only through their original canonical snapshot and field', async t => {
  const root = await temporary(t), state = { status: 'running', failures: {}, events: [] }, calls = [];
  let version = 'd';
  const make = saved => adaptationTools({ project: { id: 'neutral', engine: 'Unity' }, inventory: {}, state: saved,
    gameDir: root, workspaceDir: path.join(root, 'work'), assignment: { id: 'resource', files: ['Neutral_Data/level1'] },
    trustedToolNames: ['native_review', 'native_review_decide'], lab: { runTool: async input => {
      calls.push(input);
      if (input.tool === 'native_review') return { schema: 'pinhao-native-field-review-v1', groups: [group(version)], offset: 0, total: 1, nextOffset: null };
      throw Object.assign(new Error('Actual resource has changed; the observed hash is stale.'), { code: 'NATIVE_REVIEW_STALE' });
    } } });
  const session = make(state), first = await session.tools.native_review.execute({});
  assert.equal(first.groups[0].groupRef, 'g1');
  assert.equal(first.groups[0].id, undefined); assert.equal(first.groups[0].groupId, undefined); assert.equal(first.groups[0].evidenceHash, undefined);
  assert.equal(first.groups[0].fieldUses.assemblySha256, undefined);
  assert.deepEqual(first.groups[0].fieldUses.assemblyHashEvidence, { evidenceId: first.evidenceId, pointer: '/groups/0/fieldUses/assemblySha256' });
  assert.equal(first.groups[0].fieldUses.fields[0].uses[0].siteRef, 's1');
  assert.equal(first.groups[0].fieldUses.fields[0].uses[0].siteId, undefined);
  assert.equal(first.groups[0].fieldUses.fields[0].uses[0].calls, undefined);
  assert.deepEqual(first.groups[0].fieldUses.fields[0].uses[0].consumerEvidence, {
    evidenceId: first.evidenceId, pointer: '/groups/0/fieldUses/fields/0/uses/0', callCount: 1, readCount: 0,
    callsPointer: '/groups/0/fieldUses/fields/0/uses/0/calls',
  });
  assert.equal(first.groups[0].fields[0].examples[0].value, 'A complete neutral line.');
  const raw = JSON.parse(await readFile(path.join(root, 'work', 'evidence', `${first.evidenceId}.json`), 'utf8'));
  assert.deepEqual(raw.value.groups[0], group('d'));
  const full = await session.tools.read_evidence.execute({ evidenceId: first.evidenceId,
    pointer: '/groups/0/fieldUses/fields/0/uses/0/calls', length: 2000 });
  assert.match(JSON.stringify(full), /UnityEngine.UI.Text::set_text/);
  version = 'f';
  const second = await session.tools.native_review.execute({});
  assert.equal(second.groups[0].groupRef, 'g2');
  const decision = { groupRef: 'g1', disposition: 'display', reason: 'Use only the observed display consumer.', fields: [{ path: ['Caption'], kind: 'ui_text', displaySites: ['s1'] }] };
  const stale = await session.tools.native_review_decide.execute({ decisions: [decision] });
  assert.equal(stale.error.code, 'NATIVE_REVIEW_PROTOCOL');
  assert.equal(stale.error.evidence.cause.code, 'NATIVE_REVIEW_STALE');
  assert.deepEqual(JSON.parse(calls[2].args[0]), [{ groupId, evidenceHash: 'd'.repeat(64), disposition: decision.disposition, reason: decision.reason,
    fields: [{ path: ['Caption'], kind: 'ui_text', displaySites: [siteId] }] }]);
  assert.equal(calls.length, 3, 'a stale decision never rereads the current hash and silently upgrades its evidence');
  const wrongField = await session.tools.native_review_decide.execute({ decisions: [{ ...decision, fields: [{ path: ['Identity'], displaySites: ['s1'] }] }] });
  assert.equal(wrongField.error.code, 'NATIVE_REVIEW_PROTOCOL'); assert.equal(calls.length, 3);
  await session.close(); await session.flush();
  const resumed = make(structuredClone(state));
  await resumed.tools.native_review_decide.execute({ decisions: [decision] });
  assert.equal(JSON.parse(calls[3].args[0])[0].evidenceHash, 'd'.repeat(64), 'saved references retain the same observed hash after a new session');
  const unknown = await resumed.tools.native_review_decide.execute({ decisions: [{ ...decision, groupRef: 'g99' }] });
  assert.equal(unknown.error.code, 'NATIVE_REVIEW_PROTOCOL'); assert.equal(calls.length, 4);
  await resumed.close(); await resumed.flush();
});

test('historical native calls are projected to observed references without rewriting raw artifacts or duplicate full evidence', async t => {
  const root = await temporary(t), state = { status: 'running', failures: {}, events: [] };
  const session = adaptationTools({ project: { id: 'neutral', engine: 'Unity' }, inventory: {}, state, gameDir: root,
    workspaceDir: path.join(root, 'work'), trustedToolNames: ['native_review'], lab: {} });
  const value = { schema: 'pinhao-native-field-review-v1', groups: [group()], offset: 0, total: 1, nextOffset: null };
  const history = [
    { role: 'assistant', content: [{ type: 'tool-call', toolName: 'native_review', toolCallId: 'one', input: { groupId } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolName: 'native_review', toolCallId: 'one', output: { type: 'json', value } }] },
  ];
  const before = JSON.stringify(history);
  await session.prepareModelContext(history); await session.prepareModelContext(history);
  const projected = session.modelMessages(history);
  assert.deepEqual(projected[0].content[0].input, { groupRef: 'g1' });
  assert.equal(projected[1].content[0].output.value.groups[0].groupRef, 'g1');
  assert.equal(JSON.stringify(history), before);
  assert.equal((await readdir(path.join(root, 'work', 'evidence'))).length, 1, 'the identical complete result is content-addressed and retained once');
  await session.close(); await session.flush();
});

test('the actual SDK wire sends short native references and only one full copy of an identical tool result', async t => {
  const root = await temporary(t), requests = [], calls = [];
  const server = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    const step = requests.length;
    const toolName = step < 3 ? 'native_review' : 'native_review_decide';
    const input = step < 3 ? {} : { decisions: [{ groupRef: 'g1', disposition: 'display', reason: 'The observed field reaches only this UI consumer.',
      fields: [{ path: ['Caption'], kind: 'ui_text', displaySites: ['s1'] }] }] };
    const message = step < 4 ? { role: 'assistant', content: null, tool_calls: [{ id: `ref-${step}`, type: 'function',
      function: { name: toolName, arguments: JSON.stringify(input) } }] } : { role: 'assistant', content: 'The original evidence remains available.' };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `reference-wire-${step}`, object: 'chat.completion', created: 1, model: 'fixture',
      choices: [{ index: 0, message, finish_reason: step < 4 ? 'tool_calls' : 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await runAdaptation({ project: { id: 'neutral-wire', engine: 'Unity' }, inventory: {}, gameDir: root,
      workspaceDir: path.join(root, 'work'), assignment: { id: 'resource', files: ['Neutral_Data/level1'] },
      lab: { tryRecipes: async () => null, listTools: async () => ['native_review', 'native_review_decide'].map(name => ({ name })),
        runTool: async input => { calls.push(input); return input.tool === 'native_review'
          ? { schema: 'pinhao-native-field-review-v1', groups: [{ ...group(), script: { className: 'NeutralCaption' } }], offset: 0, total: 1, nextOffset: null }
          : { status: 'accepted', decisions: 1 }; } },
      connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture' } });
    assert.equal(requests.length, 4);
    const history = requests[2].messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
    assert.equal(history.length, 2);
    assert.equal(history[0].groups[0].groupRef, 'g1');
    assert.equal(history[0].groups[0].fieldUses.fields[0].uses[0].siteRef, 's1');
    assert.equal(history[1].resultRepeated, true);
    assert.match(history[0].receiptId, /^receipt-[a-f0-9]{64}$/);
    assert.match(history[1].receiptId, /^receipt-[a-f0-9]{64}$/);
    assert.notEqual(history[0].receiptId, history[1].receiptId, 'same result content retains both unique host occurrences on the real SDK wire');
    assert.equal(history[1].readResult.input.evidenceId, history[0].evidenceId);
    const receiptRoot = path.join(root, 'work', 'evidence-receipts'), receiptFiles = await readdir(receiptRoot), operations = [];
    for (const value of history) {
      const file = receiptFiles.find(name => name.endsWith(`-${value.receiptId}.json`));
      assert.ok(file, 'every model-visible occurrence still resolves to its immutable host record');
      const receipt = JSON.parse(await readFile(path.join(receiptRoot, file), 'utf8'));
      assert.equal(receipt.phase, 'completed');
      assert.equal(receipt.outputEvidenceId, value.evidenceId);
      operations.push(receipt.operationId);
    }
    assert.equal(new Set(operations).size, 2, 'deduplicating content never collapses the two actual host operations');
    assert.equal(JSON.stringify(requests[2]).includes(groupId), false);
    assert.equal(JSON.stringify(requests[2]).includes(siteId), false);
    assert.equal(JSON.stringify(requests[2]).includes('d'.repeat(64)), false);
    assert.equal(calls.length, 3, 'both requested reads and the single decision still execute through the original host path');
    const canonical = JSON.parse(calls[2].args[0])[0];
    assert.equal(canonical.groupId, groupId); assert.equal(canonical.evidenceHash, 'd'.repeat(64));
    assert.deepEqual(canonical.fields[0].displaySites, [siteId]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
