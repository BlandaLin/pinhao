import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { translate, englishMessages } from '../../shared/ui-language.js';

test('English presentation keeps inserted game text and control sequences unchanged', () => {
  const original = 'ミナ\\N[1] {player} 原始文字';
  assert.equal(translate(['已接入 ', ' 条文字'], [original], 'en'), `${original} text entries integrated`);
  assert.equal(translate(['已接入 ', ' 条文字'], [original], 'zh'), `已接入 ${original} 条文字`);
  assert.equal(translate('unregistered-original-text', [], 'en'), 'unregistered-original-text');
});

test('catalogs agree on shared labels and preserve every interpolation parameter', async () => {
  const directory = new URL('../../shared/locales/', import.meta.url);
  const known = new Map();
  const indices = value => [...new Set([...value.matchAll(/\{(\d+)\}/g)].map(match => match[1]))].sort();
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.en.json')) continue;
    const entries = JSON.parse(await readFile(new URL(file, directory), 'utf8'));
    for (const [key, value] of Object.entries(entries)) {
      assert.equal(typeof value, 'string', `${file}: ${key}`);
      assert.ok(value.length, `${file}: empty translation for ${key}`);
      assert.deepEqual(indices(value), indices(key), `${file}: placeholder mismatch for ${key}`);
      if (known.has(key)) assert.equal(value, known.get(key), `Conflicting translation: ${key}`);
      known.set(key, value);
    }
  }
  assert.ok(known.size > 900);
  assert.equal(englishMessages['关闭'], 'Close');
});

test('English build separates Close, Off and Disabled and leaves original content alone', () => {
  const url = new URL('../../shared/ui-language.js', import.meta.url).href;
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const {tr,trc,uiMessage,uiLanguage,uiLocale}=await import(${JSON.stringify(url)});
    assert.equal(uiLanguage,'en'); assert.equal(uiLocale,'en-US');
    assert.equal(tr('关闭'),'Close');
    assert.equal(trc('switch','关闭'),'Off');
    assert.equal(trc('reasoning','关闭'),'Disabled');
    assert.equal(uiMessage('已保存技术成果 12 批'),'12 technical batches saved');
    assert.equal(uiMessage('原始对白、角色名称和玩家输入'), '原始对白、角色名称和玩家输入');
    console.log('ok');
  `], { env: { ...process.env, PINHAO_UI_LANGUAGE: 'en' }, encoding: 'utf8', windowsHide: true });
  assert.equal(result.trim(), 'ok');
});

test('default Chinese build retains its original labels', () => {
  const url = new URL('../../shared/ui-language.js', import.meta.url).href;
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const {tr,trc,uiLanguage}=await import(${JSON.stringify(url)});
    assert.equal(uiLanguage,'zh'); assert.equal(tr('关闭'),'关闭');
    assert.equal(trc('reasoning','关闭'),'关闭');
    console.log('ok');
  `], { env: { ...process.env, PINHAO_UI_LANGUAGE: 'zh' }, encoding: 'utf8', windowsHide: true });
  assert.equal(result.trim(), 'ok');
});
