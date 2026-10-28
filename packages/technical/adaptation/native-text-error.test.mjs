import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeWorkerError } from './native-failure.mjs';

test('native text rejection envelope retains only bounded identity and reason', () => {
  const error = nativeWorkerError({ code: 'NATIVE_TEXT_REJECTED', message: 'Rejected submitted text',
    rejectedTranslations: [{ legacyId: 'scene:1', reason: 'Native syntax is not permitted', translation: 'not copied' },
      { legacyId: 'foreign:2', reason: 'Identity remains available for caller validation' },
      { legacyId: '', reason: 'invalid' }, { legacyId: 'x'.repeat(2049), reason: 'invalid' },
      { legacyId: 'scene:3', reason: 'x'.repeat(2000) }], arbitrary: 'not copied' });
  assert.deepEqual(error.rejectedTranslations.slice(0, 2), [
    { legacyId: 'scene:1', reason: 'Native syntax is not permitted' },
    { legacyId: 'foreign:2', reason: 'Identity remains available for caller validation' }]);
  assert.equal(error.rejectedTranslations.length, 3);
  assert.equal(error.rejectedTranslations[2].reason.length, 1024);
  assert.equal(error.arbitrary, undefined);
  assert.equal(error.hostFailure, undefined);
  assert.equal(nativeWorkerError({ code: 'NATIVE_WORKER_ERROR', rejectedTranslations: [{ legacyId: 'a', reason: 'b' }] }).rejectedTranslations, undefined);
  assert.equal(nativeWorkerError({ code: 'NATIVE_TEXT_REJECTED', rejectedTranslations: Array.from({ length: 300 }, () => ({ legacyId: 'a', reason: 'b' })) }).rejectedTranslations.length, 256);
});
