import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readAdaptationState, runAdaptation } from './adaptation.mjs';
import { createEvidenceStore } from './adaptation/evidence.mjs';

const format = 'pinhao-adaptation-task-1';
async function temporary(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-checkpoint-'));
  try { await fn(directory, path.join(directory, 'progress.jsonl')); }
  finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); }
}
const options = (directory, statePath) => ({ statePath, gameDir: path.join(directory, 'game'), workspaceDir: path.join(directory, 'work'),
  project: { id: 'neutral-checkpoint', name: 'Checkpoint fixture', engine: 'Godot' }, lab: { tryRecipes: async () => null } });

test('legacy JSON and JSONL retain complete state and recover past an incomplete UTF-8 tail', () => temporary(async (_, statePath) => {
  const expected = { format, status: 'cancelled', candidateId: 'candidate-1', observations: [{ text: '中性证据'.repeat(20000) }],
    acceptedBatches: [{ recipeId: 'verified-1', unitCount: 12 }], conversation: [[{ role: 'user', content: 'Continue.' }]] };
  for (const text of [JSON.stringify(expected), JSON.stringify(expected, null, 2),
    `\n${JSON.stringify({ format, status: 'running' })}\n\n${JSON.stringify(expected)}\n{"format":"${format}","broken":`]) {
    await writeFile(statePath, text, 'utf8');
    assert.deepEqual(await readAdaptationState(statePath), expected);
  }
}));

test('recovery reads the journal tail rather than allocating its historical prefix', () => temporary(async (_, statePath) => {
  const expected = { format, status: 'cancelled', candidateId: 'kept' };
  const file = await open(statePath, 'w');
  try { await file.write(`\n${JSON.stringify(expected)}\n`, 128 * 1024 * 1024, 'utf8'); }
  finally { await file.close(); }
  assert.deepEqual(await readAdaptationState(statePath), expected);
}));

test('a missing or incomplete current checkpoint recovers the previous complete state, never pending data', () => temporary(async (_, statePath) => {
  const expected = { format, status: 'cancelled', candidateId: 'validated-candidate' };
  await writeFile(`${statePath}.previous`, JSON.stringify(expected), 'utf8');
  await writeFile(`${statePath}.pending`, JSON.stringify({ format, status: 'running' }), 'utf8');
  assert.deepEqual(await readAdaptationState(statePath), expected);
  await writeFile(statePath, `{"format":"${format}","candidateId":`, 'utf8');
  assert.deepEqual(await readAdaptationState(statePath), expected);
  await writeFile(`${statePath}.previous`, '{broken', 'utf8');
  await assert.rejects(readAdaptationState(statePath), /完整的状态记录/);
}));

test('repeated saves retain two full snapshots instead of append history', () => temporary(async (directory, statePath) => {
  const result = await runAdaptation({ ...options(directory, statePath), generate: async ({ onStepStart, onStepEnd }) => {
    for (let index = 0; index < 25; index++) {
      await onStepStart({ stepNumber: index });
      await onStepEnd({ finishReason: 'tool-calls', response: { messages: [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `call-${index}`, toolName: 'read_resource', input: { file: 'story.json' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: `call-${index}`, toolName: 'read_resource', output: { type: 'json', value: { content: 'neutral evidence '.repeat(300) } } }] },
      ] } });
    }
  } });
  const current = await readFile(statePath, 'utf8'), previous = await readFile(`${statePath}.previous`, 'utf8');
  assert.deepEqual(JSON.parse(current), JSON.parse(JSON.stringify(result.state)));
  assert.equal(JSON.parse(previous).format, format);
  assert.equal(current.trim().split('\n').length, 1);
  assert.equal(previous.trim().split('\n').length, 1);
  assert.equal((await readdir(directory)).some(file => file.endsWith('.pending')), false);
  assert.ok((await stat(statePath)).size + (await stat(`${statePath}.previous`)).size < Buffer.byteLength(current) * 2.1);
}));

test('the first resumed save compacts legacy history and preserves arbitrary saved evidence', () => temporary(async (directory, statePath) => {
  const args = options(directory, statePath);
  const first = await runAdaptation({ ...args, generate: async () => {} });
  const expected = { ...first.state, observations: [{ tool: 'fixture', input: { file: 'story.json' }, output: { complete: true } }], customEvidence: { ids: ['stable-1', 'stable-2'] } };
  await writeFile(statePath, `${JSON.stringify(expected)}\n`.repeat(200), 'utf8');
  const before = (await stat(statePath)).size;
  const resumed = await runAdaptation({ ...args, generate: async () => {} });
  assert.deepEqual(resumed.state.customEvidence, expected.customEvidence);
  assert.deepEqual(resumed.state.observations.map(({ tool, input, output }) => ({ tool, input, output })), expected.observations);
  const observation = resumed.state.observations[0], evidence = createEvidenceStore(path.join(directory, 'work'));
  assert.equal(observation.evidenceSource, 'archived-observation');
  assert.equal((await evidence.read({ evidenceId: observation.evidenceId, pointer: '/complete' })).value, true);
  assert.equal((await evidence.read({ evidenceId: observation.inputEvidenceId, pointer: '/file' })).content, 'story.json');
  assert.deepEqual(await readAdaptationState(statePath), JSON.parse(JSON.stringify(resumed.state)));
  assert.ok((await stat(statePath)).size + (await stat(`${statePath}.previous`)).size < before / 20);
  // Simulate interruption after moving the latest checkpoint but before installing the pending one.
  await rename(statePath, `${statePath}.previous`);
  const recovered = await runAdaptation({ ...args, generate: async () => {} });
  assert.deepEqual(recovered.state.customEvidence, expected.customEvidence);
  assert.equal((await readAdaptationState(statePath)).status, recovered.status);
}));

test('new and disabled checkpoint paths remain optional', () => temporary(async (_, statePath) => {
  assert.equal(await readAdaptationState(statePath), null);
  assert.equal(await readAdaptationState(undefined), null);
}));
