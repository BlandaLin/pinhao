import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyTextStructure } from './adaptation/literal-structure.mjs';

function fixture(file, before, rawSource, translation) {
  const original = Buffer.from(before, 'utf8');
  const byteStart = original.indexOf(Buffer.from(rawSource, 'utf8'));
  assert.notEqual(byteStart, -1);
  const byteEnd = byteStart + Buffer.byteLength(rawSource, 'utf8');
  return { file, before: original,
    after: Buffer.concat([original.subarray(0, byteStart), Buffer.from(translation, 'utf8'), original.subarray(byteEnd)]),
    units: [{ id: 'text:1', rawSource, locator: { file, byteStart, byteEnd } }], translations: { 'text:1': translation } };
}

test('JS AST permits only bound string literal values with Unicode and escaped quotes', () => {
  const input = fixture('main.js', 'const count = 7; drawText("Safe text"); next("keep-id");', 'Safe text', '中文 \\"引号\\"');
  assert.deepEqual(verifyTextStructure(input), { valid: true, format: 'javascript-ast' });
});

test('parseable JS injection cannot close a literal and add a call', () => {
  const input = fixture('main.js', 'drawText("Safe text")', 'Safe text', '");global.someCode();drawText("Injected');
  assert.throws(() => verifyTextStructure(input), /代码结构|字符串边界/);
});

test('JS checks multiple byte locators after an earlier Unicode length change', () => {
  const before = 'const count = 7; drawText("First"); next(\'Second\');';
  const unit = (id, value) => {
    const byteStart = Buffer.from(before).indexOf(Buffer.from(value));
    return { id, rawSource:value, locator:{file:'main.js', byteStart, byteEnd:byteStart + Buffer.byteLength(value)} };
  };
  const result = verifyTextStructure({file:'main.js', before, after:before.replace('First', '第一句').replace('Second', '第二句'),
    units:[unit('a', 'First'), unit('b', 'Second')], translations:{a:'第一句', b:'第二句'}});
  assert.equal(result.valid, true);
});

test('JS modules keep unrelated syntax, calls, identifiers and number literals', () => {
  const input = fixture('main.mjs', 'export const amount = 7; export const label = "Safe text";', 'Safe text', '安全文本');
  assert.equal(verifyTextStructure(input).valid, true);
  assert.throws(() => verifyTextStructure({...input, after:Buffer.from(input.after.toString().replace('amount = 7', 'amount = 8'))}), /代码结构|字符串边界/);
});

test('JS directives and template-expression bodies use a structural adapter', () => {
  assert.throws(() => verifyTextStructure(fixture('main.js', '"use strict"; drawText("text");', 'use strict', '普通文字')), /代码结构|字符串边界/);
  assert.throws(() => verifyTextStructure(fixture('main.js', 'drawText(`Safe text`);', 'Safe text', '${danger()}')), /代码结构|字符串边界/);
});

test('GD single quoted bodies preserve escapes and never escape their original delimiter', () => {
  const input = fixture('main.gd', 'extends Node\nfunc ready():\n\tlabel.text = "Safe text"\n', 'Safe text', '中文 \\"引号\\"');
  assert.deepEqual(verifyTextStructure(input), {valid:true, format:'quoted-literal'});
  assert.throws(() => verifyTextStructure(fixture('main.gd', 'label.text = "Safe text"\n', 'Safe text', '"); danger(); label.text = "Other')), /代码结构|字符串边界/);
  assert.throws(() => verifyTextStructure(fixture('main.gd', 'label.text = "Safe text"\n', 'Safe text', 'First\nSecond')), /代码结构|字符串边界/);
});

test('GD and Python triple quoted bodies permit multiline text but reject a new closing delimiter', () => {
  for (const file of ['main.gd', 'main.py', 'main.rpy']) {
    assert.equal(verifyTextStructure(fixture(file, 'text = """Safe text"""\n', 'Safe text', '第一行\n第二行 "引号"。')).valid, true);
    assert.throws(() => verifyTextStructure(fixture(file, 'text = """Safe text"""\n', 'Safe text', '"""\ndanger()\ntext = """')), /代码结构|字符串边界/);
  }
});

test('comment text is not a code literal binding', () => {
  assert.throws(() => verifyTextStructure(fixture('main.gd', '# "Safe text"\nvar count = 1\n', 'Safe text', '中文')), /代码结构|字符串边界/);
  assert.throws(() => verifyTextStructure(fixture('main.js', '// "Safe text"\nconst count = 1;\n', 'Safe text', '中文')), /代码结构|字符串边界/);
});

test('Ruby quoted display bodies preserve code and interpolation without executing Ruby', () => {
  assert.equal(verifyTextStructure(fixture('Vocab.rb', 'module Vocab\n  Buy = "Buy goods"\nend\n', 'Buy goods', '购买物品')).valid, true);
  assert.equal(verifyTextStructure(fixture('Window.rb', 'draw_text(0,0,100,24,"Hello #{actor.name}")\n', 'Hello #{actor.name}', '你好 #{actor.name}')).valid, true);
  assert.throws(() => verifyTextStructure(fixture('Window.rb', 'draw_text(0,0,100,24,"Hello #{actor.name}")\n', 'Hello #{actor.name}', '你好 #{other.name}')), /代码结构|字符串边界/);
  assert.throws(() => verifyTextStructure(fixture('Window.rb', 'draw_text(0,0,100,24,"Hello")\n', 'Hello', '你好 #{danger()}')), /代码结构|字符串边界/);
  assert.equal(verifyTextStructure(fixture('Window.rb', 'draw_text(0,0,100,24,"Hello #@@名前 #$!")\n', 'Hello #@@名前 #$!', '你好 #@@名前 #$!')).valid, true);
  assert.throws(() => verifyTextStructure(fixture('Window.rb', 'draw_text(0,0,100,24,"Hello #$!")\n', 'Hello #$!', '你好 #$?')), /代码结构|字符串边界/);
  assert.throws(() => verifyTextStructure(fixture('Window.rb', 'draw_text(0,0,100,24,"Hello")\n', 'Hello', '"); danger(); draw_text("new')), /代码结构|字符串边界/);
  assert.throws(() => verifyTextStructure(fixture('Window.rb', '# "Hello"\ndraw_text(0,0,100,24,text)\n', 'Hello', '你好')), /代码结构|字符串边界/);
  for (const before of ['value = %q{"Hello"}\n', 'value = /"Hello"/\n', 'value = `echo "Hello"`\n', '=begin\n"Hello"\n=end\n', 'value = <<TEXT\n"Hello"\nTEXT\n']) {
    assert.throws(() => verifyTextStructure(fixture('Window.rb', before, 'Hello', '你好')), /代码结构|字符串边界/);
  }
});

test('Python f-strings and bytes require a trusted codec', () => {
  for (const prefix of ['f', 'fr', 'b', 't']) {
    assert.throws(() => verifyTextStructure(fixture('main.rpy', `text = ${prefix}"Safe text"\n`, 'Safe text', '中文')), /可信格式校验器/);
  }
});

test('RenPy interpolation and tag expressions remain intact', () => {
  assert.equal(verifyTextStructure(fixture('main.rpy', 'guide "Hello [name] {b}friend{/b}"\n', 'Hello [name] {b}friend{/b}', '你好 [name] {b}朋友{/b}')).valid, true);
  for (const text of ['你好 [danger()]', '你好 \\u005bdanger()\\u005d', '你好 \\x5bdanger()\\x5d', '你好 \\133danger()\\135']) {
    assert.throws(() => verifyTextStructure(fixture('main.rpy', 'guide "Safe text"\n', 'Safe text', text)), /可信格式校验器/);
  }
  assert.throws(() => verifyTextStructure(fixture('main.rpy', 'guide "Hello \\u005bname\\u005d"\n', 'Hello \\u005bname\\u005d', '你好 \\u005bdanger()\\u005d')), /可信格式校验器/);
});

test('plain TXT and CSV spans preserve every byte outside explicit text targets', () => {
  for (const file of ['dialogue.txt', 'dialogue.csv']) {
    assert.deepEqual(verifyTextStructure(fixture(file, 'id,Safe text\n', 'Safe text', '中文')), {valid:true, format:'plain-span'});
  }
});

test('unimplemented code formats require a trusted structure checker', () => {
  for (const file of ['script.tjs', 'script.ks', 'script.rb', 'script.ts', 'page.html', 'data.bin']) {
    assert.throws(() => verifyTextStructure(fixture(file, 'Safe text', 'Safe text', '中文')), /可信格式校验器/);
  }
});

test('JSON uses pointers and keeps logic fields intact', () => {
  const input = {file:'data.json', before:'{"text":"Safe text","id":"keep"}', after:'{"text":"中文","id":"keep"}',
    units:[{id:'a', rawSource:'Safe text', locator:{file:'data.json', pointer:'/text'}}], translations:{a:'中文'}};
  assert.deepEqual(verifyTextStructure(input), {valid:true, format:'json-pointer'});
  assert.throws(() => verifyTextStructure({...input, after:'{"text":"中文","id":"changed"}'}), /代码结构|字符串边界/);
  assert.throws(() => verifyTextStructure(fixture('data.json', '{"text":"Safe text"}', 'Safe text', '中文')), /可信格式校验器/);
});
