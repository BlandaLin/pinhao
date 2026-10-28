import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

for (const mode of ['fetch-reject', 'abort-during-fetch', 'pause-before-headers', 'pause-during-body']) {
  test(`actual SDK technical ${mode} settles without an unhandled rejection`, async () => {
    const program = `
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { runAdaptation } from ${JSON.stringify(new URL('./adaptation.mjs', import.meta.url).href)};
const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-sdk-abort-'));
const controller = new AbortController(), mode = ${JSON.stringify(mode)};
const reason = new DOMException('Local acceptance pause', 'AbortError');
let calls = 0;
globalThis.fetch = async (_url, input) => {
  calls++;
  if (mode === 'fetch-reject') throw reason;
  if (mode === 'abort-during-fetch') { controller.abort(reason); throw reason; }
  if (mode === 'pause-before-headers') return new Promise((resolve, reject) => {
    input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
    setTimeout(() => controller.abort(reason), 15);
  });
  const body = new ReadableStream({ start(stream) {
    stream.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\\n\\n'));
    input.signal.addEventListener('abort', () => stream.error(input.signal.reason), { once: true });
    setTimeout(() => controller.abort(reason), 15);
  } });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
};
try {
  const gameDir = path.join(root, 'game'), workspaceDir = path.join(root, 'work');
  await mkdir(gameDir);
  const result = await runAdaptation({ project: { id: 'sdk-abort', engine: 'Fixture' }, gameDir, workspaceDir,
    statePath: path.join(workspaceDir, 'progress.json'), signal: controller.signal,
    connection: { baseUrl: 'https://local-test.invalid/v1', model: 'local-sdk-fixture' },
    lab: { tryRecipes: async () => null, listRecipes: async () => [], listTools: () => [] },
    requestTimeoutMs: 1000, maxSteps: 2 });
  await delay(150);
  process.stdout.write(JSON.stringify({ status: result.status, calls, artifacts: result.state.requestArtifacts?.length }));
} finally {
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('pinhao-sdk-abort-')) throw new Error('Unexpected temporary test root');
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
}
`;
    const { stdout, stderr } = await execute(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', program],
      { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
    assert.equal(stderr, '');
    const result = JSON.parse(stdout);
    assert.equal(result.calls, 1);
    assert.equal(result.status, mode === 'fetch-reject' ? 'failed' : 'cancelled');
    assert.equal(result.artifacts, 1, 'the interrupted request was settled before returning');
  });
}
