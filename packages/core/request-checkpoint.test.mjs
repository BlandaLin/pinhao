import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordCheckpoint } from './request-checkpoint.mjs';

function checkpoint(source = 'Alice arrives.') {
  const candidates = new Map();
  const value = createRecordCheckpoint({ pending: [{ id: 'line', source }], candidates,
    validate: (_unit, translation) => assert.equal(typeof translation, 'string'), onChange() {} });
  return { value, candidates };
}

test('final text attaches explicit choices without another request or losing streamed text', () => {
  const { value, candidates } = checkpoint();
  value.append([{ id: 'line', translation: '爱丽丝到了。' }]);
  value.finish([{ id: 'line', translation: '爱丽丝到了。', termChoices: [
    { source: 'Alice', translation: '爱丽丝' }, { source: 'Alice', translation: '爱丽丝' },
  ] }]);
  assert.deepEqual(candidates.get('line').termChoices, [{ source: 'Alice', translation: '爱丽丝' }]);
  assert.deepEqual(value.errors, []);
});

test('missing or malformed choices never invalidate accepted text', () => {
  for (const termChoices of [undefined, 'bad', [null, {}, { source: 'Bob', translation: '鲍勃' }]]) {
    const { value, candidates } = checkpoint();
    value.finish([{ id: 'line', translation: '爱丽丝到了。', termChoices }]);
    assert.equal(candidates.get('line').translation, '爱丽丝到了。');
    assert.equal(candidates.get('line').termChoices, undefined);
    assert.deepEqual(value.errors, []);
  }
});

test('choice matching cannot use protected content or join across a protected token', () => {
  const { value, candidates } = checkpoint('AL{{P1}}ICE arrives.');
  value.finish([{ id: 'line', translation: '{{P1}}到了。', termChoices: [
    { source: 'ALICE', translation: '到了' }, { source: 'P1', translation: 'P1' },
    { source: 'AL', translation: '{{P1}}' },
  ] }]);
  assert.equal(candidates.get('line').termChoices, undefined);
  assert.deepEqual(value.errors, []);
});

test('choice metadata does not open arbitrary engine field writes', () => {
  const { value, candidates } = checkpoint();
  value.finish([{ id: 'line', translation: '爱丽丝到了。', locator: 'not-editable' }]);
  assert.equal(candidates.size, 0);
  assert.equal(value.errors.length, 1);
});
