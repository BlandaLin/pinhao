import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTextBlocks, textBlockScanner } from './text-blocks.mjs';

const parse = (raw, options = {}) => parseTextBlocks(raw, { finishReason: 'stop', ...options });
const done = '[\u5b8c\u6210]', aux = '[\u9644\u52a0\u4fe1\u606f]';

test('plain blocks preserve multiline text, whitespace, empty strings and engine controls', () => {
  const body = '  \u7b2c\u4e00\u884c "quotes" \\n {{CTRL}}\u0000\t\n\nsecond line  \n';
  assert.deepEqual(parse(`[u1]\n${body}\n[u2]\n\n${done}`), { text: [['u1', body], ['u2', '']] });
  assert.deepEqual(parse('[u1]\ntrailing\n\n'), { text: [['u1', 'trailing\n']] });
  assert.deepEqual(parse('[u1]\r\n  one\r\n\r\n[u3]\r\ntwo\r\n' + done), { text: [['u1', '  one\r\n'], ['u3', 'two']] });
});

test('clean EOF removes exactly one terminal framing EOL, never spaces or additional EOLs', () => {
  for (const ending of ['\n', '\r\n']) {
    assert.deepEqual(parse('[u1]\ntext' + ending), { text: [['u1', 'text']] });
    assert.deepEqual(parse('[u1]\ntext  \t' + ending), { text: [['u1', 'text  \t']] });
    assert.deepEqual(parse('[u1]\ntext' + ending.repeat(3)), { text: [['u1', 'text' + ending.repeat(2)]] });
    const scan = textBlockScanner();
    assert.deepEqual(scan('[u1]\ntext' + ending.repeat(2)), []);
    assert.deepEqual(scan.final({ finishReason: 'stop' }), [['u1', 'text' + ending]]);
  }
  assert.deepEqual(parse('[u1]\ntext  \t'), { text: [['u1', 'text  \t']] });
  assert.deepEqual(parse('[u1]\nline one\n\nline two\n'), { text: [['u1', 'line one\n\nline two']] });
});

test('streaming closes blocks only at a complete next marker and never guesses IDs', () => {
  const scan = textBlockScanner();
  assert.deepEqual(scan('[u7]\nfirst\n[u'), []);
  assert.deepEqual(scan('19]'), []);
  assert.deepEqual(scan('\nsecond'), [['u7', 'first']]);
  assert.deepEqual(scan.final({ finishReason: 'stop' }), [['u19', 'second']]);
  assert.throws(() => scan('more'), { code: 'INVALID_RESPONSE' });
  assert.deepEqual(parse('[u7]\nfirst'), { text: [['u7', 'first']] });
});

test('streaming is invariant over every split, including CRLF, Unicode and wrapper delimiters', () => {
  const bodies = [['u1', '\u5b57\u7b26\ud83c\udf19\r\n\r\n{{name}} \\n'], ['u2', '  \nend ']];
  const raw = `\uFEFF\x60\x60\x60text\r\n[u1]\r\n${bodies[0][1]}\r\n[u2]\n${bodies[1][1]}\n\x60\x60\x60\r\n`;
  for (let offset = 0; offset <= raw.length; offset++) {
    const scan = textBlockScanner();
    const rows = [...scan(raw.slice(0, offset)), ...scan(raw.slice(offset)), ...scan.final({ finishReason: 'stop' })];
    assert.deepEqual(rows, bodies, `split ${offset}`);
  }
  const scan = textBlockScanner(), rows = [];
  for (const char of raw) rows.push(...scan(char));
  assert.deepEqual([...rows, ...scan.final({ finishReason: 'stop' })], bodies);
  assert.deepEqual(parse(raw), { text: bodies });
});

test('normal EOF alone closes the tail; truncation, abort, tool output and missing finish do not', () => {
  for (const finishReason of ['length', 'error', 'content-filter', 'tool-calls', 'other', undefined]) {
    const scan = textBlockScanner();
    assert.deepEqual(scan('[u1]\ncomplete\n[u2]\npartial'), [['u1', 'complete']]);
    assert.deepEqual(scan.final({ finishReason }), []);
    const parsed = parseTextBlocks('[u1]\ncomplete\n[u2]\npartial', { finishReason });
    assert.deepEqual(parsed.text, [['u1', 'complete']]);
    assert.equal(parsed.responseRepair.code, 'INVALID_RESPONSE');
  }
  const scan = textBlockScanner();
  assert.deepEqual(scan('[u1]\ncomplete\n[u2]'), []);
  assert.deepEqual(scan.final({ finishReason: 'length' }), [['u1', 'complete']]);
});

test('review only acknowledges explicit completion and emits only changed blocks', () => {
  assert.deepEqual(parse(done, { review: true }), { complete: true, changes: [], questions: [] });
  assert.deepEqual(parse('[u2]\nnew text\n' + done, { review: true }), { complete: true, changes: [['u2', 'new text']], questions: [] });
  for (const raw of ['', '\n ', '[u2]\nnew text', `${aux}\n{}`, `${aux}\n{"notes":""}`]) {
    const result = parse(raw, { review: true });
    assert.equal(result.complete, false);
    assert.equal(result.responseRepair.code, 'INVALID_RESPONSE');
  }
  assert.equal(parse(done, { review: true, finishReason: 'length' }).complete, false);
});

test('auxiliary JSON stays optional and never replaces main text or completion', () => {
  const auxiliary = { read: [{ text: 'reference', limit: 16 }], notes: 'evidence u7', decisions: [], terms: [['u1', 'Guild', '\u516c\u4f1a']] };
  assert.deepEqual(parse(`[u1]\n\u516c\u4f1a\n${aux}\n${JSON.stringify(auxiliary)}`), { text: [['u1', '\u516c\u4f1a']], ...auxiliary });
  assert.deepEqual(parse(`${aux}\n{"read":[{"text":"more"}]}`), { text: [], read: [{ text: 'more' }] });
  for (const extra of ['', '{', 'null', '[]', '{"notes":8}', '{"read":{}}', '{"text":[["u2","fake"]],"complete":true}']) {
    const result = parse(`[u1]\nvalid\n${aux}\n${extra}`);
    assert.deepEqual(result.text, [['u1', 'valid']]);
    assert.equal(result.responseRepair.code, 'INVALID_RESPONSE');
  }
});

test('malformed auxiliary questions cannot silently acknowledge all reviewed targets', () => {
  const questions = [['u3', 'needs_evidence', 'Who speaks?'], ['u4', 'source_ambiguity', 'Retain ambiguity.']];
  for (const raw of [`${done}\n${aux}\n${JSON.stringify({ questions })}`, `${aux}\n${JSON.stringify({ questions })}\n${done}`]) {
    assert.deepEqual(parse(raw, { review: true }), { complete: true, changes: [], questions });
  }
  for (const rawAux of ['{', '{"questions":{}}', '{"questions":[null]}', '{"questions":[["u1","other","bad"]]}', '{"questions":[["u1","needs_evidence",""]]}']) {
    const result = parse(`[u1]\nvalid\n${done}\n${aux}\n${rawAux}`, { review: true });
    assert.equal(result.complete, false);
    assert.deepEqual(result.changes, [['u1', 'valid']]);
    assert.equal(result.responseRepair.code, 'INVALID_RESPONSE');
  }
});

test('bracket depth protects literal source markers without stripping them from bodies', () => {
  const raw = '[[u1]]\n[u2]\n[\u5b8c\u6210]\n[[u7]]\n[unknown]\n[[\u5b8c\u6210]]';
  assert.deepEqual(parse(raw, { markerDepth: 2 }), { text: [['u1', '[u2]\n[\u5b8c\u6210]'], ['u7', '[unknown]']] });
  for (const markerDepth of [0, -1, 1.5, NaN, 33, '2']) assert.throws(() => textBlockScanner({ markerDepth }), { code: 'INVALID_RESPONSE' });
});

test('duplicate sections, prose, unknown sections and mixed JSON/text never become translations', () => {
  const invalid = ['explanation\n[u1]\ntext', '{"text":[["u1","old"]]}', '[u1]\none\n[u1]\ntwo',
    '[u1]\none\n[unknown]\nextra', '[u0]\ntext', '[u01]\ntext', `${done}\n${done}`, `${aux}\n{}\n${aux}\n{}`,
    `${done}\n[u1]\nlate`, `${aux}\n{}\n[u1]\nlate`, `${done}\nexplanation`,
    '\x60\x60\x60text\n[u1]\ntext', '\x60\x60\x60text\n[u1]\ntext\n\x60\x60\x60\nextra',
    '\x60\x60\x60json\n{"text":[["u1","old"]]}\n\x60\x60\x60'];
  for (const raw of invalid) assert.throws(() => parse(raw), { code: 'INVALID_RESPONSE' }, raw);
});

test('duplicate headers invalidate their prior checkpoint but retain independent rows at every split', () => {
  for (const suffix of ['', '\nignored duplicate body']) {
    const raw = '[u1]\nambiguous\n[u2]\nindependent\n[u3]\nother independent\n[u1]' + suffix;
    const independent = [['u2', 'independent'], ['u3', 'other independent']];
    assert.throws(() => parse(raw), error => {
      assert.equal(error.code, 'INVALID_RESPONSE');
      assert.deepEqual(error.invalidatedRefs, ['u1']);
      assert.deepEqual(error.completedRows, independent);
      return true;
    });
    for (let offset = 0; offset <= raw.length; offset++) {
      const scan = textBlockScanner(), rows = [];
      let failure;
      try {
        rows.push(...scan(raw.slice(0, offset)));
        rows.push(...scan(raw.slice(offset)));
        rows.push(...scan.final({ finishReason: 'stop' }));
      } catch (error) { failure = error; }
      assert.equal(failure?.code, 'INVALID_RESPONSE', `split ${offset}`);
      assert.deepEqual(failure.invalidatedRefs, ['u1']);
      assert.deepEqual([...rows, ...failure.completedRows].filter(row => !failure.invalidatedRefs.includes(row[0])), independent, `split ${offset}`);
    }
  }
});

test('framing errors expose earlier complete rows without accepting their open tail', () => {
  for (const ending of ['[unknown]', '[unknown]\n', '[\u5b8c\u6210]\nprose']) {
    const expected = ending.startsWith('[unknown]') ? [['u1', 'safe']] : [['u1', 'safe'], ['u2', 'tail']];
    assert.throws(() => parse('[u1]\nsafe\n[u2]\ntail\n' + ending), error => {
      assert.equal(error.code, 'INVALID_RESPONSE');
      assert.deepEqual(error.completedRows, expected);
      return true;
    });
  }
});
