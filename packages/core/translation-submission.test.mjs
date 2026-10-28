import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateTranslation, writePackage, readPackage, sha256 } from '../exchange/index.mjs';
import { contentFault, translationQuality } from '../exchange/quality.mjs';

const unit = (id, source, extra = {}) => ({ id, source, translation: source, kind: 'dialogue', sourceHash: sha256(source),
  tokens: [], revision: 0, notes: '', status: 'pending', context: {}, ...extra });

test('explicit submission catches an unchanged pending seed while baseline validation remains structural', () => {
  const row = unit('line', 'This complete neutral sentence requires a Chinese translation.');
  assert.doesNotThrow(() => validateTranslation(row, row.source));
  assert.throws(() => validateTranslation(row, row.source, { submitted: true, targetLanguage: 'zh-Hans' }), /漏译/);
  assert.doesNotThrow(() => validateTranslation(row, row.source, { submitted: true, allowUnchanged: true }));
});

test('retained names, existing Chinese, short labels and protected machinery are not blanket missing translations', () => {
  for (const row of [unit('name', 'Alexandria', { kind: 'character_name' }), unit('chinese', '这里已经是完整的中文。'),
    unit('label', 'ATK'), unit('control', '{{CTRL001}}', { tokens: ['{{CTRL001}}'] })]) {
    assert.doesNotThrow(() => validateTranslation(row, row.source, { submitted: true, targetLanguage: 'zh-Hans' }));
  }
  const kana = unit('kana', 'アレクサンドリア', { kind: 'character_name' });
  assert.throws(() => validateTranslation(kana, kana.source, { submitted: true, targetLanguage: 'zh-Hans' }), /漏译/);
  const russian = unit('russian', 'Полное предложение для перевода.');
  assert.throws(() => validateTranslation(russian, russian.source, { submitted: true, targetLanguage: 'zh-Hans' }), /漏译/);
});

test('length ratios are report evidence, not proof that an intact concise translation was truncated', () => {
  const row = unit('concise', 'That is absolutely correct.');
  assert.doesNotThrow(() => validateTranslation(row, '对。', { submitted: true, targetLanguage: 'zh-Hans' }));
  const quality = translationQuality([{ ...row, translation: '对。', status: 'translated' }]);
  assert.equal(quality.hardIssues.length, 0);
  assert.equal(quality.suspicious[0].kind, 'ratio-low');
  assert.equal(contentFault(row, '对。', { submitted: true, truncated: true }).kind, 'truncated');
  assert.throws(() => validateTranslation(row, '', { submitted: true }), /需要文字/);
  assert.throws(() => validateTranslation(unit('protected', '{{P1}}正文', { tokens: ['{{P1}}'] }), '正文', { submitted: true }), /保护标记/);
});

test('numeric engine tags and Chinese labels with uppercase codes are valid retained text', () => {
  for (const source of ['<window:9>', '<position:-2, 3>', '最大ＨＰ', 'BGM 音量']) {
    const row = unit('retained', source);
    assert.doesNotThrow(() => validateTranslation(row, source, { submitted: true, targetLanguage: 'zh-Hans' }));
  }
  for (const source of ['<window:9> The gate remains locked.', 'Change 音量', 'もう休みますか？']) {
    assert.throws(() => validateTranslation(unit('missing', source), source, { submitted: true, targetLanguage: 'zh-Hans' }), /漏译/);
  }
});

test('compact numeric values with short uppercase units remain intact without allowing untranslated sentences', () => {
  for (const source of ['99999999GP', `${'9'.repeat(64)}HP`, '+1,234,567.50ATK', '-123456789.25MP', '９９９９９９９９ＨＰ']) {
    const row = unit('numeric-label', source);
    assert.doesNotThrow(() => validateTranslation(row, source, { submitted: true, targetLanguage: 'zh-Hans' }));
    assert.equal(contentFault(row, '', { submitted: true }).kind, 'empty');
    assert.equal(contentFault(row, source, { submitted: true, truncated: true }).kind, 'truncated');
  }
  for (const source of ['Recover 99999999 HP now.', '99999999GP remaining', '99999999ATTACK', '99999999gp']) {
    assert.throws(() => validateTranslation(unit('missing', source), source, { submitted: true, targetLanguage: 'zh-Hans' }), /漏译/);
  }
});

test('a complete exported target set merges after the project gains additional units', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-package-targets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = { id: 'neutral-project', sourceFingerprint: 'neutral-source', targetLanguage: 'zh-Hans' };
  const first = unit('first', 'A complete first sentence.');
  await writePackage(directory, { project, units: [first], profile: 'json' });
  const editable = path.join(directory, 'editable/units.json');
  const records = JSON.parse(await readFile(editable, 'utf8'));
  records[0].translation = '第一句完整译文。';
  await writeFile(editable, JSON.stringify(records));
  const prepared = await readPackage(directory, { project, units: [first, unit('later', 'Additional discovered text.')] });
  assert.equal(prepared.prepared.length, 1);
  assert.equal(prepared.prepared[0].returned, '第一句完整译文。');
  await assert.rejects(readPackage(directory, { project, units: [unit('other', 'Unknown replacement.')] }), /未知或缺失/);
});
