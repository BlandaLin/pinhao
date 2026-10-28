import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile, unlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequestArtifact, readRequestArtifact, resolveRequestMaterial, redactRequestMaterial } from './request-artifacts.mjs';
import { sdkProvider } from './provider.mjs';

test('default evidence retains the final answer once, without raw transport, reasoning or repeated request bodies', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinhao-request-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const secret = 'neutral-private-fixture-key'; let actualRequest;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    actualRequest = JSON.parse(body);
    response.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'neutral-real-response' });
    response.end(JSON.stringify({ choices: [{ message: { content: '{"records":[{"id":"u1","translation":"欢迎"}]}', reasoning_content: 'Neutral thought.' }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const request = { role: 'translation', system: 'Return records.', prompt: 'Neutral inn scene.' };
  const artifact = await createRequestArtifact({ directory: root, requestId: 'fixture-1', request: { ...request, connection: { apiKey: secret } }, secrets: [secret] });
  const result = await sdkProvider({ ...request, connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'neutral-fixture', apiKey: secret }, onTransport: artifact.observe });
  const reference = await artifact.finish(result);
  assert.equal(reference.finalBodyCaptured, true);
  assert.equal(reference.textCharacters, '{"records":[{"id":"u1","translation":"欢迎"}]}'.length);
  assert.equal(reference.reasoningCharacters, 'Neutral thought.'.length);
  assert.ok(reference.sentAt <= reference.responseAt); assert.ok(reference.responseAt <= reference.parsedAt);
  assert.equal(await readFile(path.join(reference.directory, 'final.txt'), 'utf8'), '{"records":[{"id":"u1","translation":"欢迎"}]}');
  const events = (await readFile(path.join(reference.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.find(event => event.type === 'send').body, undefined);
  const recordedCeiling = actualRequest.max_tokens ?? actualRequest.max_completion_tokens;
  assert.ok(Number.isInteger(recordedCeiling) && recordedCeiling > 0,
    `the actual HTTP body carries a positive output ceiling, got ${JSON.stringify({ max_tokens: actualRequest.max_tokens, max_completion_tokens: actualRequest.max_completion_tokens })}`);
  assert.deepEqual((await readdir(reference.directory)).sort(), ['events.jsonl', 'final.txt', 'request.json', 'result.json']);
  const stored = JSON.parse(await readFile(path.join(reference.directory, 'result.json'), 'utf8'));
  assert.equal(stored.parsedResult, undefined);
  assert.equal(stored.summary.records, 1);
  assert.equal(stored.finalBodyStatus, 'complete');
  assert.deepEqual(stored.files, reference.files);
  assert.equal(events.some(event => event.type.endsWith('-delta') || event.type === 'raw-chunk'), false);
  for (const file of await readdir(reference.directory)) assert.equal((await readFile(path.join(reference.directory, file), 'utf8')).includes(secret), false);
  assert.equal(JSON.stringify(reference).includes('欢迎'), false, 'database references contain metadata only');
});

test('split secrets and credential URLs are redacted before chunks are persisted', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinhao-redaction-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const secret = 'secret-with-neutral-suffix';
  const credentialUrl = new URL('https://host.invalid/');
  credentialUrl.username = 'user'; credentialUrl.password = 'password'; credentialUrl.searchParams.set('api_key', secret);
  const artifact = await createRequestArtifact({ directory: root, requestId: 'split', request: { prompt: credentialUrl.toString() }, secrets: [secret], diagnostics: true });
  for (const text of ['start ', 'secret-with-', 'neutral-suffix ', 'https://user:', 'pass@host.invalid/?token=opaque ', 'Bearer ', 'unknown-credential ']) {
    await artifact.observe({ type: 'raw-chunk', text, index: 1 });
  }
  const reference = await artifact.fail(Object.assign(new Error(`failed ${secret}`), { code: 'ETIMEDOUT', category: 'timeout' }));
  const combined = (await Promise.all((await readdir(reference.directory)).map(file => readFile(path.join(reference.directory, file), 'utf8')))).join('\n');
  for (const hidden of [secret, 'user:password', 'user:pass', 'opaque', 'unknown-credential']) assert.equal(combined.includes(hidden), false, hidden);
  assert.match(combined, /ETIMEDOUT/); assert.equal(reference.finalBodyCaptured, false);
  assert.equal(redactRequestMaterial({ authorization: 'Bearer neutral' }).authorization, '[REDACTED]');
});

test('injected providers retain metadata without falsely inventing a captured raw response', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinhao-parsed-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const artifact = await createRequestArtifact({ directory: root, requestId: 'parsed-only', request: { system: 'Neutral', prompt: 'Test' } });
  const reference = await artifact.finish({ records: [] });
  assert.equal(reference.finalBodyCaptured, false);
  assert.equal(reference.files.includes('final.txt'), false);
  assert.equal(reference.files.includes('transport-1.txt'), false);
  const result = JSON.parse(await readFile(path.join(reference.directory, 'result.json'), 'utf8'));
  assert.equal(result.summary.records, 0);
  assert.equal(result.finalBodyStatus, 'not-captured');
  assert.deepEqual(await artifact.finish({ records: [] }), reference, 'finalization is idempotent');
});

test('diagnostics explicitly preserves full transport and reasoning while result stays metadata only', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinhao-detailed-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const artifact = await createRequestArtifact({ directory: root, requestId: 'diagnostics', diagnostics: true, request: { prompt: 'Original request.' } });
  await artifact.observe({ type: 'send', body: { messages: [{ role: 'user', content: 'Original request.' }] } });
  await artifact.observe({ type: 'raw-chunk', text: 'raw transport\n' });
  await artifact.observe({ type: 'reasoning-delta', text: 'Reasoning recorded on request.\n' });
  await artifact.observe({ type: 'text-delta', text: '{"records":[]}' });
  const reference = await artifact.finish({ records: [], finishReason: 'stop', usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 } });
  assert.equal(await readFile(path.join(reference.directory, 'transport-1.txt'), 'utf8'), 'raw transport\n');
  assert.match(await readFile(path.join(reference.directory, 'reasoning.txt'), 'utf8'), /Reasoning recorded/);
  const result = JSON.parse(await readFile(path.join(reference.directory, 'result.json'), 'utf8'));
  assert.equal(result.parsedResult, undefined);
  assert.equal(result.summary.usage.totalTokens, 28);
  const events = (await readFile(path.join(reference.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal((await resolveRequestMaterial(events[0], reference)).body.messages[0].content, 'Original request.');
});

test('project request content is shared across jobs and diagnostics while exact redacted inputs remain readable', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinhao-request-content-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const contentDirectory = path.join(root, 'request-content'), clock = () => '2026-10-26T00:00:00.000Z';
  const messages = [{ role: 'system', content: 'Shared instructions.' }, { role: 'user', content: '文字 private-neutral-key' },
    { role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'read_resource', arguments: '{"file":"data/dialogue.json"}' } }] }];
  const tools = [{ type: 'function', function: { name: 'read_resource', parameters: { type: 'object', properties: { file: { type: 'string' } } } } }];
  const request = { url: 'https://neutral.invalid', body: { model: 'neutral', messages, tools, temperature: 0.2 } };
  const refs = [];
  for (let index = 0; index < 2; index++) {
    const artifact = await createRequestArtifact({ directory: path.join(root, `job-${index}`), contentDirectory, requestId: `request-${index}`, request,
      secrets: ['private-neutral-key'], diagnostics: true, clock });
    await artifact.observe({ type: 'send', body: request.body });
    await artifact.observe({ type: 'text-delta', text: 'Complete final reply.' });
    refs.push(await artifact.finish({ usage: { inputTokens: 10, outputTokens: 2 }, finishReason: 'stop' }));
  }
  assert.equal((await readdir(contentDirectory)).length, 4, 'three distinct messages plus one tool schema are stored only once');
  for (const ref of refs) {
    const manifest = JSON.parse(await readFile(path.join(ref.directory, 'request.json'), 'utf8'));
    assert.equal(manifest.body.messages, undefined); assert.equal(manifest.body.tools, undefined);
    assert.equal(manifest.requestContent.messages.length, 3);
    const restored = await readRequestArtifact(ref), expected = { schema: 'pinhao-request-artifact-1', capturedAt: clock(), ...redactRequestMaterial(request, ['private-neutral-key']) };
    assert.deepEqual(restored, expected); assert.equal(JSON.stringify(restored), JSON.stringify(expected), 'all request field ordering is preserved too');
    const event = JSON.parse((await readFile(path.join(ref.directory, 'events.jsonl'), 'utf8')).trim());
    assert.deepEqual((await resolveRequestMaterial(event, ref)).body, redactRequestMaterial(request.body, ['private-neutral-key']));
    assert.equal(await readFile(path.join(ref.directory, 'final.txt'), 'utf8'), 'Complete final reply.');
  }
  for (const file of await readdir(contentDirectory)) assert.doesNotMatch(await readFile(path.join(contentDirectory, file), 'utf8'), /private-neutral-key/);
  assert.equal(request.body.messages[1].content, '文字 private-neutral-key', 'capturing evidence does not alter the outgoing input');
});

test('concurrent request captures publish complete shared blobs and reject missing, escaping or corrupted contents', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinhao-request-content-race-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const contentDirectory = path.join(root, 'content'), request = { body: { messages: [{ role: 'user', content: 'shared '.repeat(4000) }], tools: [] } };
  const refs = await Promise.all(Array.from({ length: 12 }, async (_, index) => (await createRequestArtifact({ directory: root, contentDirectory,
    requestId: `r${index}`, request })).finish({})));
  assert.deepEqual((await readRequestArtifact(refs[0])).body, request.body);
  assert.equal((await readdir(contentDirectory)).length, 2);
  const record = JSON.parse(await readFile(path.join(refs[0].directory, 'request.json'), 'utf8'));
  await assert.rejects(resolveRequestMaterial({ ...record, requestContent: { ...record.requestContent, messages: ['../outside'] } }, { contentDirectory }), /引用无效/);
  await assert.rejects(resolveRequestMaterial(record), /内容目录/);
  const file = path.join(contentDirectory, `${record.requestContent.messages[0]}.json`);
  await writeFile(file, '{}');
  await assert.rejects(readRequestArtifact(refs[0]), /内容已改变/);
  await assert.rejects(createRequestArtifact({ directory: root, contentDirectory, requestId: 'corrupted', request }), /内容已改变/);
  await unlink(file);
  await assert.rejects(readRequestArtifact(refs[0]), { code: 'ENOENT' });
});

test('request content references never follow a substituted symlink', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinhao-request-content-link-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const artifact = await createRequestArtifact({ directory: root, requestId: 'link', request: { body: { messages: [{ role: 'user', content: 'original' }] } } });
  const ref = await artifact.finish({}), manifest = JSON.parse(await readFile(path.join(ref.directory, 'request.json'), 'utf8'));
  const file = path.join(ref.contentDirectory, `${manifest.requestContent.messages[0]}.json`), outside = path.join(root, 'outside.json');
  await writeFile(outside, await readFile(file)); await unlink(file);
  try { await symlink(outside, file, 'file'); } catch (error) { if (error.code !== 'EPERM') throw error; t.skip('host does not permit isolated symlink fixture'); return; }
  await assert.rejects(readRequestArtifact(ref), /普通内容文件/);
});

test('local validation failures retain the already returned provider usage without becoming successful', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinhao-request-billing-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const artifact = await createRequestArtifact({ directory: root, requestId: 'billing', request: {} });
  await artifact.observe({ type: 'text-delta', text: 'Complete reply.' });
  await artifact.observe({ type: 'body-end' });
  const ref = await artifact.fail(Object.assign(new Error('Local validation rejected the target'), { code: 'INVALID_REVIEW' }),
    { usage: { inputTokens: 30, outputTokens: 10 }, rawUsage: { cost: 0.012 }, requestId: 'provider-1', transportRequests: 1, finishReason: 'stop' });
  const result = JSON.parse(await readFile(path.join(ref.directory, 'result.json'), 'utf8'));
  assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'INVALID_REVIEW');
  assert.equal(result.summary.usage.totalTokens, 40); assert.equal(result.summary.usage.cost, 0.012);
  assert.equal(result.summary.transportRequests, 1); assert.equal(result.finalBodyStatus, 'complete');
});

test('failed reasoning-only streams retain counters, usage and timings but not repeated provider payloads', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinhao-reasoning-only-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const artifact = await createRequestArtifact({ directory: root, requestId: 'timeout', request: { prompt: 'Original request.' } });
  await artifact.observe({ type: 'send', at: '2026-10-24T00:00:00.000Z', body: { large: 'Duplicate material.' } });
  for (let index = 0; index < 100; index++) {
    await artifact.observe({ type: 'raw-chunk', text: 'data: repeated wire material\n\n' });
    await artifact.observe({ type: 'reasoning-delta', at: '2026-10-24T00:00:01.000Z', text: 'thinking ' });
  }
  await artifact.observe({ type: 'failure', code: 'ETIMEDOUT', category: 'timeout', providerMetadata: { unbounded: 'ignored' }, rawUsage: { prompt_tokens: 30, completion_tokens: 100, cost: 0.01 } });
  const reference = await artifact.fail(Object.assign(new Error('Response timed out'), { code: 'ETIMEDOUT', category: 'timeout', usage: { inputTokens: 30, outputTokens: 100 } }));
  assert.equal(reference.reasoningCharacters, 900);
  assert.equal(reference.firstOutputAt, '2026-10-24T00:00:01.000Z');
  assert.equal(reference.sentAt, '2026-10-24T00:00:00.000Z');
  assert.deepEqual((await readdir(reference.directory)).sort(), ['events.jsonl', 'request.json', 'result.json']);
  const eventsText = await readFile(path.join(reference.directory, 'events.jsonl'), 'utf8');
  assert.equal(eventsText.trim().split('\n').length, 2);
  assert.doesNotMatch(eventsText, /Duplicate material|providerMetadata|unbounded|thinking/);
  const failureEvent = JSON.parse(eventsText.trim().split('\n')[1]);
  assert.equal(failureEvent.usage.cost, 0.01);
  const result = JSON.parse(await readFile(path.join(reference.directory, 'result.json'), 'utf8'));
  assert.equal(result.summary.usage.totalTokens, 130);
  assert.equal(result.error.code, 'ETIMEDOUT');
  assert.equal(result.finalBodyStatus, 'not-captured');
});

test('interrupted final text is preserved once and labelled partial, with split credentials removed', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinhao-partial-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const secret = 'private-split-test-credential';
  const artifact = await createRequestArtifact({ directory: root, requestId: 'partial', request: {}, secrets: [secret] });
  for (const text of ['answer ', 'private-split-', 'test-credential ', 'Bearer ', 'another-credential ', 'unfinished']) await artifact.observe({ type: 'text-delta', text });
  const reference = await artifact.fail(Object.assign(new Error(`${'x'.repeat(4090)}${secret}`), { code: 'ECONNRESET', category: 'transport' }));
  assert.equal(reference.finalBodyStatus, 'partial');
  const final = await readFile(path.join(reference.directory, 'final.txt'), 'utf8');
  assert.equal(final, 'answer [REDACTED] Bearer [REDACTED] unfinished');
  const result = await readFile(path.join(reference.directory, 'result.json'), 'utf8');
  assert.doesNotMatch(result, /unfinished|privat|another-credential/);
});
