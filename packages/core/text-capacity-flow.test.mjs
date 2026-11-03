import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createService, defaultSettings } from './service.mjs';
import { sdkProvider } from './provider.mjs';
import { textRequestEstimate, textRequestLimits } from './text-capacity.mjs';
import { sha256 } from '../exchange/index.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { const result = await read(); if (result) return result; await delay(10); }
  throw new Error('Neutral capacity service flow did not finish');
}

async function fixture(t, mixed) {
  const parent = path.resolve('local/text-capacity-flow-tests'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'neutral-')), gameDir = path.join(root, 'original');
  await mkdir(gameDir); await writeFile(path.join(gameDir, 'original.txt'), 'immutable neutral source');
  const raw = Array.from({ length: 50 }, (_, index) => ({ id: `neutral:${index}`,
    source: `Neutral scene #${index}. Complete paragraph for verification. {{CTRL_0}}`,
    kind: 'dialogue', tokens: ['{{CTRL_0}}'], context: { file: 'neutral.json', event: 1, page: 0, speaker: 'Neutral' } }));
  const worker = async (command, args) => {
    if (command === 'probe') return { engine: 'MZ' };
    if (command === 'extract') { await mkdir(args.workspaceDir, { recursive: true }); return { units: raw, workspaceDir: args.workspaceDir, sourceFingerprint: sha256(raw) }; }
    if (['roundtrip', 'validate'].includes(command)) return { ok: true };
    if (command === 'build') { await mkdir(args.outputDir, { recursive: true }); return { buildDir: args.outputDir }; }
    if (command === 'assemble') { await mkdir(args.outputDir, { recursive: true }); await writeFile(path.join(args.outputDir, 'Game.exe'), 'neutral fixture'); return { outputDir: args.outputDir }; }
    throw new Error(`Unexpected neutral worker command: ${command}`);
  };
  const captures = [], bodies = [], serverErrors = [], normalized = [];
  let service, active, originalTranslations;
  const server = http.createServer(async (request, response) => {
    try {
      let rawBody = ''; for await (const chunk of request) rawBody += chunk;
      const body = JSON.parse(rawBody); bodies.push(body);
      assert.equal(body.max_tokens ?? body.max_completion_tokens, 1600);
      const current = active, wire = current.wire, first = wire.payload.units[0];
      const ref = wire.state.entries.find(([, id]) => id === first.id)[0];
      const number = /#(\d+)/.exec(first.source)[1];
      const kind = mixed && current.stage === 'scene' && current.page <= 3
        ? ['invalid', 'partial', 'missing-usage'][current.page - 1] : 'complete';
      current.kind = kind;
      const edit = `${mixed ? '局部' : '场景'}修订${number} {{CTRL_0}}`;
      current.explicitEdit = (kind === 'partial' || !mixed && current.page === 1) ? { id: first.id, translation: edit } : undefined;
      const output = kind === 'invalid' ? `[${ref}]\n错误新增 {{INVALID}}\n[完成]`
        : kind === 'partial' ? `[${ref}]\n${edit}\n`
          : current.explicitEdit ? `[${ref}]\n${edit}\n[完成]` : '[完成]';
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'neutral-capacity', choices: [{ index: 0, delta: { content: output }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: 'neutral-capacity', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        ...(kind === 'missing-usage' ? {} : { usage: { prompt_tokens: 100, completion_tokens: current.explicitEdit ? 30 : 8, total_tokens: current.explicitEdit ? 130 : 108 } }) })}\n\n`);
      response.end('data: [DONE]\n\n');
    } catch (error) { serverErrors.push(error); response.destroy(error); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await service?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.ok(root.startsWith(`${parent}${path.sep}`));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
    assert.deepEqual(serverErrors, []);
  });
  service = await createService({ dataDir: path.join(root, 'data'), worker, scriptTools: null,
    secrets: { encrypt: value => `neutral:${value}`, decrypt: value => value.slice(8) },
    technicalProvider: async () => ({ decision: 'native', summary: 'Neutral native route', selectedCandidateIds: [] }),
    provider: async args => {
      assert.equal(args.role, 'proofreading');
      const stage = args.wire.payload.reviewScope?.stage;
      const current = { wire: args.wire, projection: { system: args.system, prompt: args.prompt }, stage,
        page: stage === 'scene' ? captures.filter(item => item.stage === 'scene').length + 1 : undefined,
        ids: args.wire.payload.units.map(unit => unit.id) };
      captures.push(current); active = current;
      const formal = (await service.listText({ projectId: currentProject.id })).units;
      assert.deepEqual(formal.map(unit => unit.translation), originalTranslations, 'D2 does not commit scene edits before the whole round');
      const result = await sdkProvider(args);
      normalized.push({ kind: current.kind, finishReason: result.finishReason, outputTokens: result.usage?.outputTokens });
      return result;
    } });
  const settings = defaultSettings(); settings.concurrency = 1;
  settings.connection = { ...settings.connection, baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: 'neutral-capacity', apiKey: 'neutral-key', contextWindow: 32768, maxOutputTokens: 1600 };
  await service.saveSettings(settings);
  const currentProject = await service.createProject({ gameDir });
  const units = (await service.listText({ projectId: currentProject.id })).units;
  for (const unit of units) {
    const number = /#(\d+)/.exec(unit.source)[1];
    await service.saveText({ projectId: currentProject.id, unitId: unit.id, translation: `${'中性现译。'.repeat(18)}${number} {{CTRL_0}}`, expectedRevision: unit.revision });
  }
  originalTranslations = (await service.listText({ projectId: currentProject.id })).units.map(unit => unit.translation);
  return { service, currentProject, units, captures, normalized, bodies, originalTranslations, gameDir };
}

for (const mixed of [false, true]) test(`normal service retains stable complete-review capacity and actual SDK usage: ${mixed ? 'invalid-partial-missing outcomes' : 'complete outcomes'}`, async t => {
  const f = await fixture(t, mixed);
  await f.service.startProject({ projectId: f.currentProject.id, mode: 'proofreading' });
  const complete = await until(async () => {
    const current = await f.service.getProject({ projectId: f.currentProject.id });
    if (current.status === 'paused') throw new Error(current.lastError ?? current.stage);
    return current.status === 'completed' && current;
  });
  assert.equal(complete.reviewRound.stage, 'committed');
  const pages = f.captures.filter(item => item.stage === 'scene'), sizes = pages.map(item => item.ids.length);
  t.diagnostic(`Free localhost SDK scene page sizes: ${sizes.join(',')}; initial outcomes: ${mixed ? 'invalid,partial,missing-usage' : 'complete'}`);
  assert.ok(pages.length >= 10, 'Review covers all fifty complete current translations rather than an assumed short diff');
  assert.equal(new Set(sizes).size, 1, `Earlier billed output cannot grow or shrink the same complete-review workload: ${JSON.stringify(sizes)}`);
  if (mixed) {
    assert.deepEqual(pages.slice(0, 3).map(item => item.kind), ['invalid', 'partial', 'missing-usage']);
    assert.equal(sizes[3], sizes[0], `Invalid, partial and missing-usage outcomes must not change planning: ${JSON.stringify(sizes)}`);
    assert.equal(f.normalized.find(item => item.kind === 'missing-usage').outputTokens, undefined);
  }
  const limits = textRequestLimits({ contextWindow: 32768, maxOutputTokens: 1600 });
  for (const page of pages) {
    const targets = page.wire.payload.units.map(row => ({ ...row, translation: row.currentTranslation }));
    const estimate = textRequestEstimate(page.projection, targets, limits, { role: 'proofreading' });
    assert.equal(estimate.overLimit, false, 'Each sent review reserves complete revisions and current input context');
    assert.ok(estimate.estimatedOutputTokens + estimate.reasoningReserve <= limits.maxOutputTokens);
  }
  const requestDirectory = path.join(f.currentProject.workspaceDir, 'requests');
  const receipts = await Promise.all((await readdir(requestDirectory)).filter(name => /^[a-f0-9-]{36}$/.test(name))
    .map(async name => JSON.parse(await readFile(path.join(requestDirectory, name, 'result.json'), 'utf8'))));
  assert.equal(receipts.length, f.bodies.length, 'Every actual HTTP response retains its terminal artifact');
  assert.deepEqual(receipts.map(receipt => receipt.summary.usage?.completionTokens ?? null).sort((a, b) => (a ?? -1) - (b ?? -1)),
    f.normalized.map(result => result.outputTokens ?? null).sort((a, b) => (a ?? -1) - (b ?? -1)),
    'Local validation failure must not lose actual returned usage, and missing usage must remain unknown');
  const sent = new Set(pages.flatMap(item => item.ids));
  assert.deepEqual([...sent].sort(), f.units.map(unit => unit.id).sort(), 'Short markers retain every host target identity');
  const final = (await f.service.listText({ projectId: f.currentProject.id })).units;
  const edits = new Map(pages.filter(item => item.explicitEdit).map(item => [item.explicitEdit.id, item.explicitEdit.translation]));
  assert.equal(edits.size, 1);
  for (const [index, unit] of final.entries()) {
    assert.equal(unit.source, f.units[index].source);
    assert.equal(unit.translation, edits.get(unit.id) ?? f.originalTranslations[index]);
    assert.ok(unit.translation.includes(/#(\d+)/.exec(unit.source)[1]));
    assert.ok(unit.translation.endsWith('{{CTRL_0}}'));
    assert.equal(unit.status, 'proofread');
  }
  assert.ok(final.every(unit => !unit.translation.includes('{{INVALID}}')));
  assert.equal(await readFile(path.join(f.gameDir, 'original.txt'), 'utf8'), 'immutable neutral source');
  assert.ok(f.bodies.every(body => body.model === 'neutral-capacity'));
});
