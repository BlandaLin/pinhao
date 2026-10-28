import test from 'node:test';
import assert from 'node:assert/strict';
import { EVALUATION_SCHEMA, digest, summarizeAttempts, uniqueToolCalls } from './events.mjs';
import { gradeTechnicalRun } from './grade.mjs';
import { gradeFixtureRuntime } from './runtime-grader.mjs';

const artifact = record => { const text = JSON.stringify(record); return { path: 'fixture.json', text, sha256: digest(text) }; };
function sample() {
  const code = 'export const fixture = true;', codeHash = digest(code);
  const manifest = { schemaVersion: 1, id: 'example', scope: { files: ['data/Example.json'] } };
  const candidateId = `candidate-${digest({ manifest, codeHash }).slice(0, 40)}`;
  const unit = { id: 'example-body', source: 'Example body', locator: { file: 'data/Example.json', pointer: '/body' } };
  const candidate = { candidateId, code, codeHash, manifest };
  const resourceHashes = { 'data/Example.json': digest('source') };
  const validation = { candidateId, validationId: 'validation-example', codeHash, passed: true,
    checks: Object.fromEntries(['stableIds', 'roundtrip', 'sample', 'structure', 'display'].map(key => [key, 'passed'])),
    resourceHashes, runtime: { status: 'pending' }, extraction: { units: [unit] } };
  validation.displayReview = { status: 'passed', identity: { candidate: candidateId, code: codeHash,
    units: digest([[unit.id, unit.source, unit.locator]]) }, decisions: [{ id: unit.id, status: 'display-supported' }] };
  const recipeId = `recipe-${digest({ candidateId, scope: manifest.scope }).slice(0, 40)}`;
  const recipe = { candidateId, validationId: validation.validationId, recipeId, codeHash, manifest };
  const binding = { candidateId, validationId: validation.validationId, recipeId, codeHash, resourceHashes, units: [unit] };
  const evidence = {
    schema: EVALUATION_SCHEMA, runId: 'run', pairId: 'pair', caseId: 'example', evidenceTier: 'autonomy', answerIsolation: 'unisolated-development',
    route: { service: 'createService', worker: 'productWorker', defaultDisplayVerifier: true, injectedComponents: [], preseededRecipes: false, focused: false },
    freeze: { sourceBefore: { code: 'frozen' }, sourceAfter: { code: 'frozen' }, originalBefore: { game: 'original' }, originalAfter: { game: 'original' } },
    artifacts: { candidates: [artifact(candidate)], validations: [artifact(validation)], recipes: [artifact(recipe)], bindings: [artifact(binding)], resolutions: [] },
    freshness: { [validation.validationId]: { complete: true, displayFresh: true,
      files: [{ file: 'data/Example.json', expected: resourceHashes['data/Example.json'], actual: resourceHashes['data/Example.json'] }],
      roundtripFiles: [{ file: 'data/Example.json', expected: resourceHashes['data/Example.json'], actual: resourceHashes['data/Example.json'] }],
      sampleFiles: [{ file: 'data/Example.json', original: resourceHashes['data/Example.json'], actual: digest('changed-sample') }] } },
    database: { initialUnitIds: [], units: [{ ...unit, id: 'u-example', legacyId: unit.id }] },
    coverage: { remainingUnknown: 0 }, attempts: [], terminal: { status: 'paused' },
  };
  const expectations = { targets: [{ locator: unit.locator, sourceSha256: digest(unit.source) }], forbidden: [] };
  return { evidence, expectations, unit };
}

test('exact fresh host chain proves autonomy independently of terminal exit/status', () => {
  const { evidence, expectations } = sample();
  const grade = gradeTechnicalRun(evidence, { expectations });
  assert.equal(grade.autonomyStatus, 'passed');
  assert.equal(grade.integratedUnitCount, 1);
  assert.equal(grade.buildStatus, 'not-reached');
  assert.equal(grade.authenticGameRuntimeStatus, 'not-run');
});

test('stdout passed and exit zero with no artifacts never prove delivery', () => {
  const { evidence, expectations } = sample();
  evidence.artifacts = {}; evidence.database.units = [];
  evidence.stdout = 'passed=true'; evidence.exitCode = 0; evidence.terminal.status = 'completed';
  const grade = gradeTechnicalRun(evidence, { expectations });
  assert.equal(grade.autonomyStatus, 'not-achieved');
  assert.equal(grade.acceptedArtifactCount, 0);
});

test('missing evidence, all skipped and unstarted test are not success', () => {
  for (const evidence of [undefined, {}, { schema: EVALUATION_SCHEMA, skipped: 100, exitCode: 0 }]) {
    assert.equal(gradeTechnicalRun(evidence).eligible, false);
  }
});

test('contract substitute can verify behavior but cannot become autonomy', () => {
  const { evidence, expectations } = sample(); evidence.evidenceTier = 'contract';
  const grade = gradeTechnicalRun(evidence, { expectations });
  assert.equal(grade.autonomyStatus, 'evidence-incomplete');
  assert.equal(grade.acceptedArtifactCount, 0);
});

test('route substitution and focus disqualify real-model headline', () => {
  for (const mutation of [route => { route.focused = true; }, route => { route.defaultDisplayVerifier = false; },
    route => { route.injectedComponents = ['adaptationProvider']; }, route => { route.preseededRecipes = true; }]) {
    const { evidence } = sample(); mutation(evidence.route);
    assert.equal(gradeTechnicalRun(evidence).eligible, false);
  }
});

test('old source, changed dependencies and tampered artifacts reject success', () => {
  for (const mutation of [evidence => { evidence.freeze.sourceAfter.code = 'changed'; },
    evidence => { evidence.freeze.originalAfter.game = 'changed'; },
    evidence => { evidence.artifacts.candidates[0].text += 'tampered'; }]) {
    const { evidence, expectations } = sample(); mutation(evidence);
    assert.notEqual(gradeTechnicalRun(evidence, { expectations }).autonomyStatus, 'passed');
  }
});

test('stale proof and incomplete freshness cannot accept a recipe', () => {
  for (const mutation of [check => { check.files[0].actual = 'changed'; }, check => { check.complete = false; }, check => { check.files = []; }]) {
    const { evidence, expectations } = sample(); mutation(evidence.freshness['validation-example']);
    const grade = gradeTechnicalRun(evidence, { expectations });
    assert.equal(grade.acceptedArtifactCount, 0); assert.equal(grade.integratedUnitCount, 0);
  }
});

test('gates from different failed candidate versions cannot be combined', () => {
  const { evidence } = sample();
  const validation = JSON.parse(evidence.artifacts.validations[0].text);
  evidence.artifacts.validations = ['display', 'roundtrip'].map(gate => artifact({ ...validation, validationId: `failed-${gate}`, passed: false,
    checks: { ...validation.checks, [gate]: 'failed' } }));
  assert.equal(gradeTechnicalRun(evidence).validatedArtifactCount, 0);
});

test('gate booleans without actual roundtrip/sample files and current display identity do not prove validation', () => {
  for (const mutation of [evidence => { evidence.freshness['validation-example'].roundtripFiles = []; },
    evidence => { evidence.freshness['validation-example'].sampleFiles[0].actual = evidence.freshness['validation-example'].sampleFiles[0].original; },
    evidence => { const validation = JSON.parse(evidence.artifacts.validations[0].text); validation.displayReview.identity.code = 'old'; evidence.artifacts.validations = [artifact(validation)]; }]) {
    const { evidence } = sample(); mutation(evidence);
    assert.equal(gradeTechnicalRun(evidence).validatedArtifactCount, 0);
  }
});

test('duplicate recipe captures do not multiply accepted artifacts', () => {
  const { evidence } = sample(); evidence.artifacts.recipes.push(evidence.artifacts.recipes[0]);
  assert.equal(gradeTechnicalRun(evidence).acceptedArtifactCount, 1);
});

test('unrelated matching hashes cannot stand in for the validated resource files', () => {
  const { evidence } = sample(); evidence.freshness['validation-example'].files[0].file = 'other.json';
  assert.equal(gradeTechnicalRun(evidence).validatedArtifactCount, 0);
});

test('additional accepted locations require independent purpose review before complete success', () => {
  const { evidence, expectations } = sample(); expectations.targets = [{ locator: { file: 'other.json', pointer: '/body' }, sourceSha256: digest('other') }];
  const grade = gradeTechnicalRun(evidence, { expectations });
  assert.equal(grade.unreviewedAddedCount, 1); assert.notEqual(grade.autonomyStatus, 'passed');
});

test('actual build file binding is required and pending gameplay is not a fabricated failure', () => {
  const { evidence, expectations } = sample(), file = { path: 'Game.data', sha256: digest('product') };
  evidence.build = { artifact: artifact({ outputManifest: { hash: 'manifest', files: [file] },
    checks: [{ name: '结构与保护标记', status: 'passed' }, { name: '成品内容核验', status: 'passed' }, { name: '实机游玩验收', status: 'pending' }] }),
    outputFiles: [{ file: file.path, expected: file.sha256, actual: file.sha256 }], reachedThroughService: true, partial: false };
  assert.equal(gradeTechnicalRun(evidence, { expectations }).buildStatus, 'passed');
  assert.equal(gradeTechnicalRun(evidence, { expectations }).authenticGameRuntimeStatus, 'not-run');
  evidence.build.outputFiles[0].file = 'unrelated';
  assert.equal(gradeTechnicalRun(evidence, { expectations }).buildStatus, 'not-proven');
  evidence.build.outputFiles[0].file = file.path; evidence.build.partial = true;
  assert.equal(gradeTechnicalRun(evidence, { expectations }).buildStatus, 'not-proven');
});

test('accepted before integration is not misreported as a database addition', () => {
  const { evidence } = sample(); evidence.database.units = [];
  const grade = gradeTechnicalRun(evidence);
  assert.equal(grade.autonomyStatus, 'accepted-partial'); assert.equal(grade.integratedUnitCount, 0);
});

test('accepted recipe without binding still requires semantic review and is not integrated', () => {
  const { evidence, expectations } = sample(); evidence.artifacts.bindings = [];
  const grade = gradeTechnicalRun(evidence, { expectations });
  assert.equal(grade.acceptedArtifactCount, 1); assert.equal(grade.integratedUnitCount, 0);
  assert.equal(grade.autonomyStatus, 'accepted-partial');
});

test('uncollected native handoff is evidence incomplete rather than a false model failure', () => {
  const { evidence } = sample(); evidence.artifacts = {};
  const grade = gradeTechnicalRun(evidence);
  assert.equal(grade.observedDatabaseAdditions, 1); assert.equal(grade.unscoredIntegrationCount, 1);
  assert.equal(grade.autonomyStatus, 'evidence-incomplete');
});

test('partial easy-point delivery does not close remaining unknown', () => {
  const { evidence, expectations } = sample(); evidence.coverage.remainingUnknown = 1;
  const grade = gradeTechnicalRun(evidence, { expectations });
  assert.equal(grade.targetRecall, 1); assert.equal(grade.autonomyStatus, 'accepted-partial');
  assert.equal(grade.productIntegrationStatus, 'integrated-partial');
});

test('forbidden logic locations negate complete recall', () => {
  const { evidence, expectations, unit } = sample(); expectations.forbidden.push({ locator: unit.locator });
  const grade = gradeTechnicalRun(evidence, { expectations });
  assert.equal(grade.falsePositiveCount, 1); assert.notEqual(grade.autonomyStatus, 'passed');
});

test('zero added requires actual default-reviewed fresh closure receipts', () => {
  const { evidence } = sample(); evidence.artifacts = {}; evidence.database.units = [];
  const resolution = { id: 'display-example', disposition: 'non-display', independentReview: { status: 'non-display' } };
  const record = artifact(resolution); evidence.artifacts.resolutions = [record];
  const expectations = { allowZeroAdded: true, minResolutions: 1 };
  assert.equal(gradeTechnicalRun(evidence, { expectations }).autonomyStatus, 'not-achieved');
  evidence.resolutionFreshness = { [resolution.id]: { artifactSha256: record.sha256, protocolVerified: true, fresh: true } };
  assert.equal(gradeTechnicalRun(evidence, { expectations }).autonomyStatus, 'passed');
  evidence.resolutionFreshness[resolution.id].fresh = false;
  assert.equal(gradeTechnicalRun(evidence, { expectations }).autonomyStatus, 'not-achieved');
});

test('legacy cluster classifications follow the actual host proof contract without invented reviewer gates', () => {
  const { evidence } = sample(); evidence.artifacts = {}; evidence.database.units = []; evidence.coverage.remainingUnknown = 1;
  const resolution = { id: 'cluster-example', disposition: 'non-display' }, record = artifact(resolution);
  evidence.artifacts.resolutions = [record];
  evidence.resolutionFreshness = { [resolution.id]: { artifactSha256: record.sha256, protocolVerified: true, fresh: true } };
  const grade = gradeTechnicalRun(evidence, { expectations: { allowZeroAdded: true } });
  assert.equal(grade.legalResolutionCount, 1); assert.equal(grade.resolutionCountsByKind['legacy-cluster'], 1);
  assert.equal(grade.autonomyStatus, 'accepted-partial', 'classification is real progress, not complete coverage while unknown work remains');
  for (const field of ['fresh', 'protocolVerified']) {
    const invalid = structuredClone(evidence); invalid.resolutionFreshness[resolution.id][field] = false;
    assert.equal(gradeTechnicalRun(invalid).legalResolutionCount, 0);
  }
});

test('precise non-display and non-linguistic sites still require independent negative review', () => {
  for (const [kind, disposition] of [['display-candidate', 'non-display'], ['display-expression', 'non-linguistic']]) {
    const { evidence } = sample(); evidence.artifacts = {}; evidence.database.units = [];
    const resolution = { id: 'precise-example', kind, disposition }, record = artifact(resolution);
    evidence.artifacts.resolutions = [record];
    evidence.resolutionFreshness = { [resolution.id]: { artifactSha256: record.sha256, protocolVerified: true, fresh: true } };
    assert.equal(gradeTechnicalRun(evidence).legalResolutionCount, 0, 'a model claim never substitutes for the independent proof required by the host contract');
  }
});

test('runtime rejects empty, stale product, duplicate, skipped or failed processes', () => {
  const target = { id: 'body', text: 'Translated', fontSize: 22, resource: 'resource-id' };
  const stdout = `PINHAO_EVAL_DISPLAY=${JSON.stringify(target)}\nPINHAO_EVAL_RUNTIME_COMPLETE={"count":1}\n`;
  const expected = { productManifestSha256: 'built-product', observations: [target] };
  const valid = { kind: 'fixture-consumer', exitCode: 0, stdout, stdoutSha256: digest(stdout), productManifestSha256: 'built-product' };
  assert.equal(gradeFixtureRuntime(valid, expected).status, 'passed');
  assert.equal(gradeFixtureRuntime(undefined, expected).status, 'not-run');
  for (const extra of [{ exitCode: 1 }, { stdout: 'passed=true', stdoutSha256: digest('passed=true') }, { productManifestSha256: 'old' }, { signal: 'SIGTERM' }]) {
    assert.equal(gradeFixtureRuntime({ ...valid, ...extra }, expected).status, 'failed');
  }
  assert.equal(gradeFixtureRuntime(valid, { ...expected, observations: [] }).status, 'failed');
  const changed = { ...target, fontSize: 12 };
  assert.equal(gradeFixtureRuntime(valid, { ...expected, observations: [changed] }).status, 'failed');
});

test('cost counts all sent/uncertain attempts but not known pre-send failures', () => {
  const attempts = [{ id: 'a', fetchStartedAt: 'now', settledAt: 'later', usage: { cost: 0.1, completionTokens: 10, reasoningTokens: 3 } },
    { id: 'b', sendUncertain: true }, { id: 'c', notSentAt: 'now', settledAt: 'now' }];
  const cost = summarizeAttempts(attempts);
  assert.equal(cost.actualOrUncertainHttpAttempts, 2); assert.equal(cost.knownCostTotal, 0.1);
  assert.equal(cost.unknownCostRequests, 1); assert.equal(cost.inflightReservations, 1);
  assert.equal(cost.knownTokenSubtotals.completionTokens, 10);
  assert.throws(() => summarizeAttempts([attempts[0], attempts[0]]), /unique/);
});

test('retained request history and final checkpoint actions are deduplicated by toolCallId', () => {
  const call = { type: 'tool-call', toolCallId: 'one', toolName: 'read_resource', input: {} };
  const calls = uniqueToolCalls([{ content: [call] }, { messages: [{ content: [call] }] }], [{ content: [{ ...call, toolCallId: 'last', toolName: 'submit_recipe' }] }]);
  assert.deepEqual(calls.map(item => item.id), ['one', 'last']);
});
