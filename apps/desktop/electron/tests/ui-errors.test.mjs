import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { pinhao: {} };
const { errorMessage } = await import('../../src/api.ts');
const { translate } = await import('../../shared/ui-language.js');

test('text reply failures are not described as network failures or shown as long ID inventories', () => {
  const noMarkers = errorMessage(new Error('没有找到合法文字协议区。'));
  assert.match(noMarkers, /没有按文字标记交稿.*原回包已保留/);
  const id = 'u-012345678901234567890123';
  const missing = errorMessage(`本批还需补齐 44 个 ID：${Array(44).fill(id).join('、')}。待修正条目：${id}`);
  assert.match(missing, /44 条文字未通过检查.*现有成果已保留/);
  assert.doesNotMatch(missing, /u-012345|API|网络|账户/);
  assert.ok(missing.length < 100);
  const controls = errorMessage(new Error(`请使用已有保护标记表示换行或引擎控制符：${id}`));
  assert.match(controls, /保留原文的保护标记及顺序/);
  const structured = errorMessage({ code: 'INVALID_RESPONSE', category: 'response_structure', message: 'reply mismatch' });
  assert.match(structured, /文字交稿检查.*反馈请求记录/);
  for (const message of [noMarkers, missing, controls, structured])
    assert.doesNotMatch(message, /检查网络|更换模型|接口暂未恢复/);
  for (const message of [noMarkers, controls, structured])
    assert.doesNotMatch(translate(message, [], 'en'), /[\u3400-\u9fff]/u);
  assert.match(translate('本批仍有 {0} 条文字未通过检查。现有成果已保留，请继续处理未完成文字。', ['44'], 'en'), /^44 entries/);
  assert.match(errorMessage({ statusCode: 401, category: 'response_structure', message: '没有找到合法文字协议区。' }), /密钥验证失败/);
});

test('connection and key failures give a readable cause and a concrete recovery action', () => {
  assert.match(errorMessage(new Error('Error while decrypting ciphertext provided to safeStorage.decryptStringAsync.')), /重新填写并保存密钥/);
  assert.match(errorMessage(new Error('Cannot connect to API: self signed certificate in certificate chain')), /安全证书.*系统时间、代理和网络/);
  assert.match(errorMessage(new Error('HTTP 401')), /接口地址和密钥.*保存后重新测试连接/);
  assert.match(errorMessage({ message: 'fetch failed' }), /检查网络和 API 接口地址/);
});

test('provider limits point to the matching account, concurrency or model setting', () => {
  assert.match(errorMessage(new Error('insufficient_quota')), /服务商页面查看账户状态/);
  assert.match(errorMessage(new Error('Too Many Requests (HTTP 429)')), /降低同时处理任务数/);
  assert.match(errorMessage(new Error('maximum context length exceeded')), /能处理更长文本的模型/);
});

test('specific domain errors and diagnostic file locations retain their actual meaning', () => {
  const message = 'data/menu.json 的文字位置已改变，请重新提取这份文件。';
  assert.equal(errorMessage(new Error(message)), message);
  assert.equal(errorMessage({ message }), message);
  assert.equal(errorMessage('请先选择游戏存档'), '请先选择游戏存档');
  assert.equal(errorMessage(new Error('ENOENT: data/menu.json')), 'ENOENT: data/menu.json');
});

test('native component failures request local tool recovery rather than a different paid model', () => {
  for (const code of ['NATIVE_DEPENDENCY_MISSING', 'NATIVE_DEPENDENCY_INVALID']) {
    const message = errorMessage(Object.assign(new Error('Codec import failed'), { code }));
    assert.match(message, /原生工具缺失或不完整/);
    assert.match(message, /修复工具文件或重新完整解压程序/);
    assert.match(message, /已有成果会保留，不需要更换模型/);
  }
});

test('native text rejection explains retained evidence and a content correction rather than a component repair', () => {
  for (const failure of [
    Object.assign(new Error('A native field rejected the candidate'), { code: 'NATIVE_TEXT_REJECTED' }),
    'New engine syntax is not permitted',
    'Submitted translations failed native text validation',
    new Error('New RenPy tag/interpolation delimiter'),
  ]) {
    const message = errorMessage(failure);
    assert.match(message, /译文未通过游戏文字规则检查.*尚未写入游戏/);
    assert.match(message, /原回包和其他有效成果已保留/);
    assert.match(message, /继续制作.*修正被拒绝的文字/);
    assert.doesNotMatch(message, /重新完整解压|更换模型|New engine/);
  }
  assert.equal(errorMessage(new Error('Native codec unavailable')), 'Native codec unavailable');
});
