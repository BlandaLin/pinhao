import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';

test('connection tests retain safe HTTP classification and retry guidance without leaking credentials', async t => {
  const parent = path.resolve('local', 'connection-test-fixtures');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'structured-'));
  let failure;
  const service = await createService({ dataDir: directory,
    worker: async () => ({ engines: [] }),
    secrets: { encrypt: key => `fixture:${key}`, decrypt: value => value.slice(8) },
    provider: async () => { throw failure; },
  });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); });
  const settings = defaultSettings(), key = 'neutral-private-connection-fixture';
  settings.connection = { baseUrl: 'http://127.0.0.1:1', model: 'fixture', apiKey: key };
  await service.saveSettings(settings);
  failure = Object.assign(new Error('User not found. ' + key), { statusCode: 401, category: 'authentication' });
  const auth = await service.testConnection();
  assert.equal(auth.statusCode, 401); assert.equal(auth.category, 'authentication');
  assert.ok(!JSON.stringify(auth).includes(key));
  failure = Object.assign(new Error('Please wait.'), { statusCode: 429, category: 'rate_limit', retryAfterMs: 2100 });
  const limited = await service.testConnection();
  assert.equal(limited.retryAfterMs, 2100); assert.equal(limited.category, 'rate_limit');
  failure = new DOMException('The operation timed out.', 'TimeoutError');
  assert.equal((await service.testConnection()).category, 'timeout');
});

test('testing the shared connection uses its own settings when translation has a separate provider', async t => {
  const parent = path.resolve('local', 'connection-test-fixtures');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'case-'));
  const requests = [];
  const service = await createService({ dataDir: directory,
    worker: async command => { assert.equal(command, 'catalog'); return { engines: [] }; },
    secrets: { encrypt: key => `fixture:${key}`, decrypt: value => value.slice(8) },
    provider: async input => { requests.push(input); return { records: [] }; },
  });
  t.after(async () => {
    await service.close();
    assert.equal(path.dirname(directory), parent);
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  const settings = defaultSettings();
  settings.connection = { baseUrl: 'http://127.0.0.1:1/shared', model: 'shared-fixture', apiKey: 'shared-fixture-key' };
  settings.roles.translation = { useShared: false, connection: { baseUrl: 'http://127.0.0.1:1/translation', model: 'translation-fixture', apiKey: 'translation-fixture-key' } };
  await service.saveSettings(settings);
  assert.equal((await service.testConnection({ role: 'shared' })).ok, true);
  assert.equal((await service.testConnection({ role: 'translation' })).ok, true);
  assert.deepEqual(requests.map(request => [request.connection.baseUrl, request.connection.model, request.connection.apiKey]), [
    ['http://127.0.0.1:1/shared', 'shared-fixture', 'shared-fixture-key'],
    ['http://127.0.0.1:1/translation', 'translation-fixture', 'translation-fixture-key'],
  ]);
  assert.ok(requests.every(request => request.role === 'translation'), 'Transport receives a valid task role for either connection');
});

test('reasoning choices persist across restart, follow shared roles and remain independent of saved keys', async t => {
  const parent = path.resolve('local', 'connection-test-fixtures');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'reasoning-')), requests = [];
  const options = { dataDir: directory, worker: async () => ({ engines: [] }),
    secrets: { encrypt: key => `fixture:${key}`, decrypt: value => value.slice(8) },
    provider: async input => { requests.push(input); return { records: [] }; } };
  let service = await createService(options);
  t.after(async () => { await service.close(); assert.equal(path.dirname(directory), parent); await rm(directory, { recursive: true, force: true }); });
  const settings = defaultSettings();
  settings.connection = { baseUrl: 'https://openrouter.ai/api/v1', model: 'neutral-shared', reasoning: 'disabled', apiKey: 'neutral-private-key' };
  settings.roles.technical = { useShared: false, connection: { baseUrl: 'https://api.deepseek.com/v1', model: 'neutral-technical', reasoning: 'enabled' } };
  const saved = await service.saveSettings(settings);
  assert.equal(saved.connection.reasoning, 'disabled'); assert.equal(saved.connection.apiKey, undefined); assert.equal(saved.connection.hasKey, true);
  await service.close(); service = await createService(options);
  const restored = (await service.snapshot()).settings;
  assert.equal(restored.connection.reasoning, 'disabled'); assert.equal(restored.roles.technical.connection.reasoning, 'enabled');
  for (const role of ['shared', 'translation', 'proofreading', 'technical']) assert.equal((await service.testConnection({ role })).ok, true);
  assert.deepEqual(requests.map(input => input.connection.reasoning), ['disabled', 'disabled', 'disabled', 'enabled']);
  assert.deepEqual(requests.map(input => input.connection.model), ['neutral-shared', 'neutral-shared', 'neutral-shared', 'neutral-technical']);
  assert.equal(requests[0].connection.apiKey, 'neutral-private-key');
  await assert.rejects(service.saveSettings({ ...restored, connection: { ...restored.connection, baseUrl: 'http://127.0.0.1/v1' } }), { code: 'MODEL_REASONING_UNSUPPORTED' });
  assert.equal((await service.snapshot()).settings.connection.baseUrl, restored.connection.baseUrl, 'Invalid overrides must not partly replace saved settings');
  const automatic = await service.saveSettings({ ...restored, connection: { ...restored.connection, reasoning: 'auto' } });
  assert.equal(automatic.connection.reasoning, undefined); assert.equal(automatic.connection.hasKey, true);
});

test('model capacity persists through settings and reaches the selected technical connection', async t => {
  const parent = path.resolve('local', 'connection-test-fixtures');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'capacity-')), requests = [];
  const options = { dataDir: directory, worker: async () => ({ engines: [] }),
    provider: async input => { requests.push(input.connection); return { records: [] }; } };
  let service = await createService(options);
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); });
  const settings = defaultSettings();
  settings.connection = { baseUrl: 'http://127.0.0.1:1/v1', model: 'shared', contextWindow: 65536, maxOutputTokens: 8192 };
  settings.roles.technical = { useShared: false, connection: { baseUrl: 'http://127.0.0.1:1/v1', model: 'technical', contextWindow: 32768, maxOutputTokens: 2048 } };
  await service.saveSettings(settings); await service.close(); service = await createService(options);
  const restored = (await service.snapshot()).settings;
  assert.equal(restored.connection.contextWindow, 65536);
  assert.equal((await service.testConnection({ role: 'shared' })).ok, true);
  assert.equal((await service.testConnection({ role: 'technical' })).ok, true);
  assert.deepEqual(requests.map(c => [c.contextWindow, c.maxOutputTokens]), [[65536, 8192], [32768, 2048]]);
  await assert.rejects(service.saveSettings({ ...restored, connection: { ...restored.connection, contextWindow: -1 } }), /正整数/);
  const cleared = await service.saveSettings({ ...restored, connection: { ...restored.connection, contextWindow: undefined, maxOutputTokens: undefined } });
  assert.equal(cleared.connection.contextWindow, undefined); assert.equal(cleared.connection.maxOutputTokens, undefined);
});
