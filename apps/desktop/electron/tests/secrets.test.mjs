import test from 'node:test';
import assert from 'node:assert/strict';
import { createSecrets } from '../secrets.mjs';

const neutral = 'neutral-fixture-key';
const cipher = Buffer.from('authenticated-fixture');

test('async secret storage verifies the encrypted key before accepting it', async () => {
  const calls = [];
  const secrets = createSecrets({
    encryptStringAsync: async value => { assert.equal(value, neutral); calls.push('encrypt'); return cipher; },
    decryptStringAsync: async value => { assert.deepEqual(value, cipher); calls.push('decrypt'); return { result: neutral }; },
  });
  const encoded = await secrets.encrypt(neutral);
  assert.deepEqual(calls, ['encrypt', 'decrypt']);
  assert.equal(await secrets.decrypt(encoded), neutral);
});

test('older synchronous secret storage retains the same verification contract', async () => {
  const secrets = createSecrets({
    isEncryptionAvailable: () => true,
    encryptString: value => { assert.equal(value, neutral); return cipher; },
    decryptString: value => { assert.deepEqual(value, cipher); return neutral; },
  });
  assert.equal(await secrets.decrypt(await secrets.encrypt(neutral)), neutral);
});

test('an unreadable existing key gives a recovery action without exposing native errors', async () => {
  const secrets = createSecrets({ decryptStringAsync: async () => { throw new Error(`native error ${neutral}`); } });
  await assert.rejects(secrets.decrypt(cipher.toString('base64')), error => {
    assert.equal(error.code, 'API_KEY_UNREADABLE');
    assert.match(error.message, /设置.*API 密钥.*保存/);
    assert.ok(!error.message.includes(neutral));
    assert.ok(!error.message.includes('safeStorage'));
    return true;
  });
});

test('encryption mismatches and unavailable storage fail before saving a key', async () => {
  for (const storage of [
    { encryptStringAsync: async () => cipher, decryptStringAsync: async () => ({ result: 'different' }) },
    { encryptStringAsync: async () => cipher, decryptStringAsync: async () => { throw new Error('Unreadable'); } },
    { isEncryptionAvailable: () => false },
  ]) {
    await assert.rejects(createSecrets(storage).encrypt(neutral), error => {
      assert.equal(error.code, 'API_KEY_SAVE_FAILED');
      assert.ok(!error.message.includes(neutral));
      return true;
    });
  }
});
