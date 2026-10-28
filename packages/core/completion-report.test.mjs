import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCompletionReport, completionReportText } from './completion-report.mjs';

test('complete extracted text does not imply a publishable or runtime-verified game', () => {
  const report = buildCompletionReport([{ id: 'line', source: 'The gate is open.', translation: '大门已打开。', status: 'proofread' }],
    { builds: [{ id: 'build', runtimeVerified: false, outputModified: true,
      checks: [{ name: '资源文字覆盖', status: 'pending', detail: '还有候选保留原文' }] }] });
  const text = completionReportText(report);
  assert.doesNotMatch(text, /可发布|可以发布/);
  assert.match(text, /已提取的文字条目检查完成/);
  assert.match(text, /成品文件已有变动/);
  assert.match(text, /实机游玩验证：待完成/);
  assert.match(text, /还有候选保留原文/);
});

test('completion uses the same missing-translation rule as accepted text rather than raw equality', () => {
  const report = buildCompletionReport([
    { id: 'name', kind: 'speaker_name', source: '悠真', translation: '悠真', status: 'proofread' },
    { id: 'label', source: 'ATK', translation: 'ATK', status: 'translated' },
    { id: 'sentence', source: 'The door is still locked.', translation: 'The door is still locked.', status: 'translated' },
  ]);
  const missing = report.blockers.find(blocker => blocker.kind === 'identical');
  assert.equal(missing.count, 1);
  assert.deepEqual(missing.samples.map(sample => sample.id), ['sentence']);
});
