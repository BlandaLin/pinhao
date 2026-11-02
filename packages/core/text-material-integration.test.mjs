import test from 'node:test';
import assert from 'node:assert/strict';
import { taskPrompt } from './provider.mjs';
import { decodeTextResponse } from './text-wire.mjs';
import { parseTextBlocks } from './text-blocks.mjs';
import { resolveEvidenceRequests } from './semantic-tools.mjs';
import { createReadReceipt, createQueryReceipt, createSemanticContext } from './semantic-state.mjs';

const unit = { id: 'stable-unit', source: 'Name', translation: 'Name', revision: 1, context: { speaker: 'person', condition: { switch: 3 },
  references: Array.from({ length: 74 }, (_, index) => ({ path: `scripts/scene-${index}.txt`, index, command: 'display',
    evidence: { path: 'carrier.bin', index, description: 'extraction provenance' } })) } };

test('initial language projection and exact paged evidence share normal wire and preserve local originals', () => {
  const original = JSON.stringify(unit), first = taskPrompt('translation', [unit], 'zh-Hans');
  assert.ok(!first.prompt.includes('scene-73.txt'));
  assert.ok(first.prompt.includes('evidenceAccess'));
  assert.ok(first.prompt.includes('person'));
  const ref = first.wire.state.entries.find(([, id]) => id === unit.id)[0];
  const parsed = parseTextBlocks(`[附加信息]\n${JSON.stringify({ read: [{ evidence: { unitId: ref, section: 'references' }, offset: 64, limit: 16 }] })}`, { finishReason: 'stop' });
  const response = decodeTextResponse(parsed, first.wire);
  const result = resolveEvidenceRequests(response.evidenceRequests, [unit]);
  assert.equal(result.answers[0].rawEvidence.length, 10);
  assert.equal(result.answers[0].nextOffset, null);
  const next = taskPrompt('translation', [unit], 'zh-Hans', [], [], { evidenceResults: result.answers });
  assert.ok(next.prompt.includes('scripts/scene-73.txt'));
  assert.ok(next.prompt.includes('extraction provenance'));
  assert.equal(JSON.stringify(unit), original);
  assert.ok(createSemanticContext([unit]).receiptFresh(result.receipts[0]));
  assert.ok(!createSemanticContext([{ ...unit, context: { ...unit.context, references: [] } }]).receiptFresh(result.receipts[0]));
});

test('old unit and query receipts stay fresh without clearing paid candidate dependencies', () => {
  const context = createSemanticContext([unit]);
  const old = createReadReceipt(unit, { projection: 'semantic-context-1' });
  const oldQuery = createQueryReceipt([unit], { ids: [unit.id] }, { projection: 'semantic-context-1' });
  assert.equal(oldQuery.projection, undefined);
  assert.ok(context.receiptFresh(old));
  assert.ok(context.receiptFresh(oldQuery));
  assert.ok(context.receiptFresh(createReadReceipt(unit)));
  assert.ok(context.receiptFresh(createQueryReceipt([unit], { ids: [unit.id] })));
});
