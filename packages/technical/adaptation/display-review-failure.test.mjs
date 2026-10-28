import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAdapterLab } from './adapter-lab.mjs';

async function fixture(t, verifier) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-review-failure-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const gameDir = path.join(root, 'source'); await mkdir(gameDir); await writeFile(path.join(gameDir, 'story.txt'), 'Hello');
  verifier.isFresh = async () => true;
  const lab = await createAdapterLab({ dataDir: path.join(root, 'lab'), displayVerifier: verifier });
  const candidate = await lab.writeAdapter({ manifest: { schemaVersion: 1, id: 'review-test', version: '1.0.0', engine: 'Neutral', license: 'MIT', scope: { files: ['story.txt'] } },
    code: `({detect(){return true},extract(host){return {units:[{id:'caption',source:host.readText('story.txt'),locator:{file:'story.txt',byteStart:0,byteEnd:5}}]}},validate(){return true},roundtrip(host){host.writeBytes('story.txt',host.readBytes('story.txt'));return {}},build(host,input){host.writeText('story.txt',input.translations.caption??host.readText('story.txt'));return {}},assemble(){return {}}})` });
  return { lab, candidate, gameDir };
}

test('reviewer outage preserves cause metadata and can retry the same candidate without declaring it rejected', async t => {
  let available = false;
  const f = await fixture(t, async () => { if (!available) throw Object.assign(new Error('neutral outage'), { code: 'SERVICE_UNAVAILABLE', statusCode: 503, category: 'provider_capacity', retryAfterMs: 1234 }); return { status: 'passed' }; });
  const failed = await f.lab.validateAdapter({ ...f.candidate, gameDir: f.gameDir });
  assert.equal(failed.passed, false);
  assert.equal(failed.error.code, 'DISPLAY_REVIEW_UNAVAILABLE');
  assert.equal(failed.error.category, 'reviewer_unavailable');
  assert.equal(failed.error.statusCode, 503); assert.equal(failed.error.retryAfterMs, 1234);
  assert.equal(failed.reviewFailure.kind, 'reviewer-unavailable'); assert.equal(failed.reviewFailure.candidateId, f.candidate.candidateId);
  assert.deepEqual(failed.reviewFailure.cause, { name: 'Error', message: 'neutral outage', code: 'SERVICE_UNAVAILABLE', statusCode: 503, category: 'provider_capacity', retryAfterMs: 1234 });
  assert.equal(failed.checks.display, 'unavailable'); assert.equal(failed.blockedNeeds, undefined);
  available = true;
  const passed = await f.lab.validateAdapter({ ...f.candidate, gameDir: f.gameDir });
  assert.equal(passed.passed, true, passed.error?.message); assert.equal(passed.candidateId, failed.candidateId);
});

test('actual reviewer rejection and cancellation remain distinct from service outage', async t => {
  const rejected = await fixture(t, async () => ({ status: 'failed', decisions: [] }));
  const negative = await rejected.lab.validateAdapter({ ...rejected.candidate, gameDir: rejected.gameDir });
  assert.equal(negative.error.code, 'ADAPTER_DISPLAY_REVIEW_FAILED');
  assert.equal(negative.reviewFailure.kind, 'candidate-rejected');
  const cancelled = await fixture(t, async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); });
  const paused = await cancelled.lab.validateAdapter({ ...cancelled.candidate, gameDir: cancelled.gameDir });
  assert.equal(paused.error.code, 'ADAPTER_CANCELLED'); assert.equal(paused.reviewFailure.kind, 'cancelled');
});
