import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runAdaptation } from './adaptation.mjs';
import { createAdapterLab } from './adaptation/adapter-lab.mjs';
import { scanCoverage } from './coverage.mjs';
import { scopeAdaptationCoverage } from './adaptation-pool.mjs';
import { createDisplayVerifier } from './adaptation/display-review.mjs';

async function fixture(t, { extension = '.js', unknown = false } = {}) {
  const parent = path.resolve('local/expression-review-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'review-')), gameDir = path.join(root, 'game');
  await mkdir(gameDir);
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const file = `interface${extension}`, caller = `caller${extension}`;
  const script = extension === '.gd'
    ? 'extends Control\nfunc show_message(message):\n\t$Caption.text = message\nfunc update_points(points: int):\n\t$Counter.text = str(points)\n'
    : 'function showMessage(message) { caption.text = message; }\nfunction updatePoints(points) { points = Number(points); counter.text = String(points); }\n';
  await writeFile(path.join(gameDir, file), script + (unknown ? '\ncaption.text = "A still unlocated complete sentence.";\n' : ''));
  await writeFile(path.join(gameDir, caller), extension === '.gd'
    ? 'func opening():\n\tshow_message("Welcome to the harbor.")\n'
    : 'showMessage("Welcome to the harbor.");\n');
  const units = [{ id: 'opening-caption', source: 'Welcome to the harbor.', kind: 'message', tokens: [], context: { file: caller } }];
  const scan = (decisions = [], currentUnits = units) => scanCoverage({ rootDir: gameDir, units: currentUnits, decisions });
  const displayVerifier = createDisplayVerifier({ connectionFor: () => ({ model: 'independent-counter', baseUrl: 'https://invalid.local' }), readRootsFor: () => [gameDir],
    generate: async ({ tools, prompt }) => {
      const decisions = [];
      for (const row of JSON.parse(prompt).units) {
        const source = await tools.read_resource.execute({ file: row.file, sourceIndex: row.sourceIndex });
        assert.match(source.content, /Number\(points\)|points: int/);
        decisions.push({ ref: row.ref, status: /^(?:String|str)\(points\)$/.test(row.source) ? 'non-display' : 'unresolved',
          reason: 'Read the numeric coercion/type and the inline numeric counter consumer.', evidenceIds: [source.evidenceId], consumerEvidenceIds: [source.evidenceId] });
      }
      await tools.finish_review.execute({ decisions });
    } });
  const labDir = path.join(root, 'lab'), lab = await createAdapterLab({ dataDir: labDir, displayVerifier });
  const coverage = await scan();
  const args = { project: { id: 'display-expression', engine: extension === '.gd' ? 'Godot' : 'RPG Maker MZ' },
    inventory: { existingUnits: units }, gameDir, lab, connection: { model: 'mechanics-only' },
    workspaceDir: path.join(root, 'work'), statePath: path.join(root, 'work/state.json'),
    assignment: { id: 'interface', files: [file] }, coverage: scopeAdaptationCoverage(coverage, [file]),
    verifyCoverage: async ({ coverageDecisions }) => scopeAdaptationCoverage(await scan(coverageDecisions), [file]) };
  const decide = async tools => {
    const current = await tools.inspect_coverage.execute({}), expressions = current.expressionCandidates;
    assert.equal(expressions.length, 2);
    const input = await tools.read_resource.execute({ file });
    assert.ok(input.content.includes(extension === '.gd' ? '$Caption.text = message' : 'caption.text = message'));
    await tools.read_resource.execute({ file: caller });
    const known = await tools.inspect_units.execute({ file: caller });
    assert.equal(known.units[0].id, units[0].id, 'related units remain readable outside this job write scope');
    return tools.record_coverage_decisions.execute({ decisions: expressions.map(item => ({ id: item.id, evidenceHash: item.evidenceHash,
      disposition: item.source === 'message' ? 'bound-reference' : 'non-linguistic',
      ...(item.source === 'message' ? { unitIds: [known.units[0].id] } : {}),
      reason: item.source === 'message' ? 'The inspected caller supplies this already extracted sentence.' : 'The inspected expression formats the numeric points counter.' })) });
  };
  return { root, gameDir, file, caller, units, scan, labDir, lab, coverage, args, decide };
}

test('display-expression reviews close through source references or non-linguistic evidence without adapters', async t => {
  const f = await fixture(t);
  assert.equal(f.coverage.summary.unresolvedExpressions, 2);
  assert.equal(f.coverage.needsAdaptation, true);
  assert.ok(f.coverage.triggers.includes('unresolved-display-expressions'));
  const before = await readFile(path.join(f.gameDir, f.file));
  const result = await runAdaptation({ ...f.args, generate: async ({ tools }) => {
    const submitted = await f.decide(tools);
    assert.equal(submitted.taskComplete, true, JSON.stringify(submitted));
  } });
  assert.equal(result.status, 'verified', JSON.stringify(result.error));
  assert.equal(result.units.length, 0, 'reviewing existing sources invents no extra translation units');
  const checked = await f.scan(result.coverageDecisions);
  assert.equal(checked.summary.unresolvedExpressions, 0);
  assert.equal(checked.summary.resolvedExpressions, 2);
  assert.equal(checked.summary.nonDisplayCandidates, 0, 'visible references and counters are not non-display');
  assert.deepEqual(checked.displaySites.map(item => item.status).sort(), ['bound-reference', 'non-linguistic']);
  assert.equal(checked.needsAdaptation, false);
  assert.deepEqual(await readFile(path.join(f.gameDir, f.file)), before);
  const reopened = await createAdapterLab({ dataDir: f.labDir });
  const saved = await reopened.listCoverageDecisions();
  assert.deepEqual(saved.find(item => item.disposition === 'bound-reference').unitIds, [f.units[0].id]);
  const reused = await runAdaptation({ ...f.args, lab: reopened, workspaceDir: path.join(f.root, 'reuse'), statePath: path.join(f.root, 'reuse/state.json'),
    generate: async () => assert.fail('same source and bindings must reuse validated decisions without another request') });
  assert.equal(reused.status, 'verified');
  assert.equal(reused.reused, true);
  assert.equal((await f.scan(saved, [])).summary.unresolvedExpressions, 1, 'a removed existing unit reopens its reference');
  const source = await readFile(path.join(f.gameDir, f.caller), 'utf8');
  await writeFile(path.join(f.gameDir, f.caller), source.replace('harbor', 'forest'));
  assert.equal((await f.scan(saved)).summary.unresolvedExpressions, 2, 'same-size caller changes invalidate the review');
});

test('an expression decision requires the actual current source read and cannot dismiss an unlocated literal', async t => {
  const f = await fixture(t, { extension: '.gd', unknown: true });
  await runAdaptation({ ...f.args, generate: async ({ tools }) => {
    const expression = (await tools.inspect_coverage.execute({})).expressionCandidates[0];
    const noRead = await tools.record_coverage_decisions.execute({ decisions: [{ id: expression.id, evidenceHash: expression.evidenceHash,
      disposition: 'non-linguistic', reason: 'Unsupported assertion without reading.' }] });
    assert.match(noRead.error.message, /read_resource/);
    await tools.read_resource.execute({ file: f.file, offset: 0, length: 8 });
    const partialRead = await tools.record_coverage_decisions.execute({ decisions: [{ id: expression.id, evidenceHash: expression.evidenceHash,
      disposition: 'non-linguistic', reason: 'Reading a different part of the file is not source evidence.' }] });
    assert.match(partialRead.error.message, /read_resource/);
    await tools.read_resource.execute({ file: f.file });
    const wrongKind = await tools.record_coverage_decisions.execute({ decisions: [{ id: expression.id, evidenceHash: expression.evidenceHash,
      disposition: 'non-display', reason: 'A display sink must not be called non-display.' }] });
    assert.ok(wrongKind.error);
    const unknownBinding = await tools.record_coverage_decisions.execute({ decisions: [{ id: expression.id, evidenceHash: expression.evidenceHash,
      disposition: 'bound-reference', unitIds: ['not-extracted'], reason: 'No real existing unit.' }] });
    assert.match(unknownBinding.error.message, /unitIds/);
    const submitted = await f.decide(tools);
    assert.equal(submitted.accepted, true);
    assert.equal(submitted.taskComplete, false, 'real unlocated prose remains pending');
    assert.ok(submitted.remainingCoverage.dynamicCandidates.some(item => item.source === 'A still unlocated complete sentence.'));
  } });
  const saved = await f.lab.listCoverageDecisions();
  const checked = await f.scan(saved);
  assert.equal(checked.summary.unresolvedExpressions, 0);
  assert.equal(checked.needsAdaptation, true);
  assert.ok(checked.dynamicCandidates.some(item => item.source === 'A still unlocated complete sentence.'));
});

test('paused expression investigation resumes its real reads and keeps the original write scope', async t => {
  const f = await fixture(t, { extension: '.gd' }), controller = new AbortController();
  const paused = await runAdaptation({ ...f.args, signal: controller.signal, generate: async ({ tools }) => {
    await tools.read_resource.execute({ file: f.file });
    await tools.read_resource.execute({ file: f.caller });
    controller.abort();
  } });
  assert.equal(paused.status, 'cancelled');
  const resumed = await runAdaptation({ ...f.args, retry: true, generate: async ({ tools }) => {
    const current = await tools.inspect_coverage.execute({});
    const submitted = await tools.record_coverage_decisions.execute({ decisions: current.expressionCandidates.map(item => ({
      id: item.id, evidenceHash: item.evidenceHash, disposition: item.source === 'message' ? 'bound-reference' : 'non-linguistic',
      ...(item.source === 'message' ? { unitIds: [f.units[0].id] } : {}), reason: 'The previous interrupted window already read both source files.' })) });
    assert.equal(submitted.taskComplete, true, JSON.stringify(submitted));
  } });
  assert.equal(resumed.status, 'verified', JSON.stringify(resumed.error));
  assert.ok(resumed.coverageDecisions.every(item => item.reads.some(read => read.file === f.file)));
});

test('same-path resources retain distinct expression identities and require the matching origin read', async t => {
  const f = await fixture(t), shadow = path.join(f.root, 'shadow');
  await mkdir(shadow);
  await writeFile(path.join(shadow, f.file), await readFile(path.join(f.gameDir, f.file)));
  const scan = decisions => scanCoverage({ rootDir: shadow, sourceRoots: [f.gameDir], units: f.units, decisions });
  const coverage = await scan([]), candidates = coverage.classifiedCandidates.filter(item => item.kind === 'script_display_expression_candidate');
  assert.equal(candidates.length, 4);
  assert.equal(new Set(candidates.map(item => item.id)).size, 4);
  const source = candidates.find(item => item.sourceIndex === 1 && item.source === 'String(points)');
  const decision = { id: source.id, evidenceHash: source.evidenceHash, disposition: 'non-linguistic', reason: 'Only the inspected numeric counter at this origin is resolved.' };
  await runAdaptation({ ...f.args, gameDir: shadow, readDir: shadow, readRoots: [f.gameDir], coverage,
    verifyCoverage: ({ coverageDecisions }) => scan(coverageDecisions), generate: async ({ tools }) => {
      await tools.read_resource.execute({ file: f.file, sourceIndex: 0 });
      assert.match((await tools.record_coverage_decisions.execute({ decisions: [decision] })).error.message, /sourceIndex/);
      await tools.read_resource.execute({ file: f.file, sourceIndex: 1 });
      const submitted = await tools.record_coverage_decisions.execute({ decisions: [decision] });
      assert.equal(submitted.accepted, true, JSON.stringify(submitted));
      assert.equal(submitted.taskComplete, false);
    } });
  const checked = await scan(await f.lab.listCoverageDecisions());
  assert.equal(checked.summary.resolvedExpressions, 1);
  assert.equal(checked.summary.unresolvedExpressions, 3);
});
