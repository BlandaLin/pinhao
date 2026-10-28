import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scanCoverage } from './coverage.mjs';
import { adaptationTools, runAdaptation } from './adaptation.mjs';
import { scopeAdaptationCoverage } from './adaptation-pool.mjs';
import { createTextAdapter } from './adaptation/text-adapter.mjs';
import { createAdapterLab } from './adaptation/adapter-lab.mjs';
import { createDisplayVerifier } from './adaptation/display-review.mjs';
import { hasCoverageDecisionProof, displayCandidateIdentity } from './coverage-decisions.mjs';

async function fixture(t, verdict = 'non-display') {
  const parent = path.resolve('local/precise-disposition-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'review-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const gameDir = path.join(root, 'game'); await mkdir(path.join(gameDir, 'js'), { recursive: true });
  const file = 'js/plugin.js', source = 'load', code = 'const command = "load";\n';
  await writeFile(path.join(gameDir, file), code);
  await writeFile(path.join(gameDir, 'js/plugins.js'), 'var activePlugins = [];\n');
  const start = code.indexOf('"load"');
  const inventory = { dynamicCandidates: [{ file, source, target: { render: 'quoted', start, end: start + 6 } }] };
  const units = [{ id: 'known', source: 'A scene already extracted.', kind: 'dialogue', tokens: [], context: { file: 'scene.txt' } }];
  const scan = decisions => scanCoverage({ rootDir: gameDir, inventory, units, decisions, scanCache: false });
  let reviews = 0;
  const displayVerifier = createDisplayVerifier({ connectionFor: () => ({ baseUrl: 'https://invalid.local', model: 'replay' }),
    generate: async ({ tools, prompt }) => {
      reviews++;
      const sourceRead = await tools.read_resource.execute({ file });
      const consumerRead = await tools.read_resource.execute({ file: 'js/plugins.js' });
      await tools.finish_review.execute({ decisions: JSON.parse(prompt).units.map(row => ({ ref: row.ref, status: verdict,
        reason: 'Actual source and loading configuration independently inspected.', evidenceIds: [sourceRead.evidenceId], consumerEvidenceIds: [consumerRead.evidenceId] })) });
    } });
  const lab = await createAdapterLab({ dataDir: path.join(root, 'lab'), displayVerifier });
  const run = async () => runAdaptation({ project: { id: 'neutral-precise', engine: 'MV' }, inventory, gameDir, lab,
    coverage: await scan(), workspaceDir: path.join(root, 'work'), statePath: path.join(root, 'work/state.json'),
    verifyCoverage: ({ coverageDecisions }) => scan(coverageDecisions), generate: async ({ tools }) => {
      const candidate = (await tools.inspect_coverage.execute({})).dynamicCandidates[0];
      assert.ok(candidate.evidenceHash); assert.equal(candidate.sourceIndex, 0);
      await tools.read_resource.execute({ file });
      const result = await tools.record_coverage_decisions.execute({ decisions: [{ id: candidate.id, evidenceHash: candidate.evidenceHash,
        disposition: 'non-display', reason: 'This literal is an interpreter command identity, not visible prose.' }] });
      if (verdict === 'non-display') assert.equal(result.accepted, true, JSON.stringify(result));
      else assert.equal(result.error.code, verdict === 'unresolved' ? 'DISPLAY_DISPOSITION_PENDING' : 'DISPLAY_DISPOSITION_REJECTED');
    } });
  return { root, gameDir, file, units, lab, scan, run, reviews: () => reviews };
}

test('precise non-display candidates close only through independent proof and reopen on consumer change', async t => {
  const f = await fixture(t);
  const before = await f.scan(); assert.equal(before.dynamicCandidates.length, 1);
  const result = await f.run(); assert.equal(result.status, 'verified', JSON.stringify(result.error));
  assert.equal(result.units.length, 0); assert.equal(f.reviews(), 1);
  const saved = await f.lab.listCoverageDecisions();
  assert.equal(saved.length, 1); assert.equal(saved[0].kind, 'display-candidate');
  assert.equal(saved[0].id, displayCandidateIdentity(before.dynamicCandidates[0]));
  assert.equal(hasCoverageDecisionProof(saved[0]), true);
  assert.equal(hasCoverageDecisionProof({ ...saved[0], independentReview: undefined }), false);
  assert.equal((await f.scan(saved)).needsAdaptation, false);
  const reopened = await createAdapterLab({ dataDir: path.join(f.root, 'lab') });
  assert.equal((await f.scan(await reopened.listCoverageDecisions())).dynamicCandidates.length, 0);
  assert.equal(f.reviews(), 1, 'reopening does not buy a new independent judgement');
  await writeFile(path.join(f.gameDir, 'js/plugins.js'), 'var activePlugins = ["plugin"];\n');
  assert.equal((await f.scan(saved)).dynamicCandidates.length, 1, 'new loading evidence reopens the source');
  const original = await readFile(path.join(f.gameDir, f.file), 'utf8');
  await writeFile(path.join(f.gameDir, f.file), original.replace('load', 'show'));
  assert.equal((await f.scan(saved)).coverageDecisions.length, 0);
});

test('a display-supported independent verdict cannot be converted to an author non-display decision', async t => {
  const f = await fixture(t, 'display-supported');
  const result = await f.run();
  assert.notEqual(result.status, 'verified');
  assert.equal((await f.lab.listCoverageDecisions()).length, 0);
  assert.equal((await f.scan()).dynamicCandidates.length, 1);
});

test('an unresolved independent verdict leaves the exact source open', async t => {
  const f = await fixture(t, 'unresolved');
  assert.notEqual((await f.run()).status, 'verified');
  assert.equal((await f.lab.listCoverageDecisions()).length, 0);
  assert.equal((await f.scan()).dynamicCandidates.length, 1);
});

test('negative display review requires actual source and consumer reads, not an empty author-like verdict', async t => {
  const f = await fixture(t);
  const verifier = createDisplayVerifier({ connectionFor: () => ({ model: 'no-evidence', baseUrl: 'https://invalid.local' }),
    generate: async ({ tools }) => {
      await assert.rejects(tools.finish_review.execute({ decisions: [{ ref: '1', status: 'non-display', reason: 'The author says no prose.', evidenceIds: [], consumerEvidenceIds: [] }] }), /实际读取来源/);
    } });
  const lab = await createAdapterLab({ dataDir: path.join(f.root, 'no-evidence-lab'), displayVerifier: verifier });
  const candidate = (await f.scan()).dynamicCandidates[0];
  await assert.rejects(lab.reviewDisplayCandidates({ candidates: [{ ...candidate, id: displayCandidateIdentity(candidate) }], gameDir: f.gameDir, workspaceDir: path.join(f.root, 'empty-review') }), error => error.code === 'DISPLAY_DISPOSITION_PENDING');
});

test('same-path exact candidates retain their origin and cannot close through another source read', async t => {
  const f = await fixture(t), shadow = path.join(f.root, 'shadow'), file = 'data/labels.json';
  await mkdir(path.join(f.gameDir, 'data')); await mkdir(path.join(shadow, 'data'), { recursive: true });
  for (const directory of [f.gameDir, shadow]) await writeFile(path.join(directory, file), '{"text":"Internal command label"}');
  const scan = decisions => scanCoverage({ rootDir: f.gameDir, sourceRoots: [shadow], units: f.units, decisions, scanCache: false });
  const before = await scan(), candidates = before.dynamicCandidates.filter(item => item.file === file);
  assert.equal(candidates.length, 2); assert.deepEqual(candidates.map(item => item.sourceIndex).sort(), [0, 1]);
  assert.equal(new Set(candidates.map(displayCandidateIdentity)).size, 2);
  const verifier = createDisplayVerifier({ connectionFor: () => ({ baseUrl: 'https://invalid.local', model: 'origin-review' }), readRootsFor: () => [shadow],
    generate: async ({ tools, prompt }) => {
      const decisions = [];
      for (const row of JSON.parse(prompt).units) {
        const source = await tools.read_resource.execute({ file: row.file, sourceIndex: row.sourceIndex });
        const consumer = await tools.read_resource.execute({ file: 'js/plugins.js', sourceIndex: 0 });
        decisions.push({ ref: row.ref, status: 'non-display', reason: 'Read the selected origin and its actual loading configuration.',
          evidenceIds: [source.evidenceId], consumerEvidenceIds: [consumer.evidenceId] });
      }
      await tools.finish_review.execute({ decisions });
    } });
  const lab = await createAdapterLab({ dataDir: path.join(f.root, 'origin-lab'), displayVerifier: verifier });
  await runAdaptation({ project: { id: 'two-origins', engine: 'MV' }, inventory: { existingUnits: f.units }, gameDir: f.gameDir, readRoots: [shadow], lab,
    assignment: { id: 'labels', files: [file] }, coverage: scopeAdaptationCoverage(before, [file]), workspaceDir: path.join(f.root, 'origin-work'),
    verifyCoverage: async ({ coverageDecisions }) => scopeAdaptationCoverage(await scan(coverageDecisions), [file]), generate: async ({ tools }) => {
      const candidate = (await tools.inspect_coverage.execute({})).dynamicCandidates.find(item => item.sourceIndex === 1);
      const input = { decisions: [{ id: candidate.id, evidenceHash: candidate.evidenceHash, disposition: 'non-display', reason: 'Only this selected origin was reviewed.' }] };
      await tools.read_resource.execute({ file, sourceIndex: 0 });
      assert.match((await tools.record_coverage_decisions.execute(input)).error.message, /sourceIndex/);
      await tools.read_resource.execute({ file, sourceIndex: 1 });
      const submitted = await tools.record_coverage_decisions.execute(input);
      assert.equal(submitted.accepted, true, JSON.stringify(submitted)); assert.equal(submitted.taskComplete, false);
    } });
  const saved = await lab.listCoverageDecisions(), after = await scan(saved);
  assert.equal(saved.length, 1); assert.equal(saved[0].sourceIndex, 1);
  assert.deepEqual(after.dynamicCandidates.filter(item => item.file === file).map(item => item.sourceIndex), [0]);
});

test('upstream prose cannot be dismissed as a non-linguistic display expression', async t => {
  const f = await fixture(t), file = 'js/display.js';
  await writeFile(path.join(f.gameDir, file), 'function showMessage(message) { caption.text = message; }');
  const scan = decisions => scanCoverage({ rootDir: f.gameDir, units: f.units, decisions, scanCache: false });
  const verifier = createDisplayVerifier({ connectionFor: () => ({ baseUrl: 'https://invalid.local', model: 'upstream-review' }),
    generate: async ({ tools, prompt, instructions }) => {
      assert.match(instructions, /其他来源/);
      const source = await tools.read_resource.execute({ file });
      await tools.finish_review.execute({ decisions: JSON.parse(prompt).units.map(row => ({ ref: row.ref, status: 'unresolved',
        reason: 'This is a language-bearing display consumer; its upstream prose is not located yet.', evidenceIds: [source.evidenceId], consumerEvidenceIds: [source.evidenceId] })) });
    } });
  const lab = await createAdapterLab({ dataDir: path.join(f.root, 'upstream-lab'), displayVerifier: verifier });
  await runAdaptation({ project: { id: 'upstream', engine: 'MV' }, inventory: { existingUnits: f.units }, gameDir: f.gameDir, lab,
    assignment: { id: 'display', files: [file] }, coverage: scopeAdaptationCoverage(await scan(), [file]), workspaceDir: path.join(f.root, 'upstream-work'),
    verifyCoverage: async ({ coverageDecisions }) => scopeAdaptationCoverage(await scan(coverageDecisions), [file]), generate: async ({ tools }) => {
      const expression = (await tools.inspect_coverage.execute({})).expressionCandidates[0];
      await tools.read_resource.execute({ file });
      const noUnit = await tools.record_coverage_decisions.execute({ decisions: [{ id: expression.id, evidenceHash: expression.evidenceHash,
        disposition: 'bound-reference', unitIds: ['not-extracted'], reason: 'The body is elsewhere.' }] });
      assert.match(noUnit.error.message, /unitIds/);
      const rejected = await tools.record_coverage_decisions.execute({ decisions: [{ id: expression.id, evidenceHash: expression.evidenceHash,
        disposition: 'non-linguistic', reason: 'The body is elsewhere, not this expression.' }] });
      assert.equal(rejected.error.code, 'DISPLAY_DISPOSITION_PENDING');
    } });
  assert.equal((await lab.listCoverageDecisions()).length, 0);
  assert.equal((await scan()).summary.unresolvedExpressions, 1);
});

test('complete negative adapter validation is reused without promotion and expires on consumer edits', async t => {
  const f = await fixture(t), file = 'data/dialogue.json'; await mkdir(path.join(f.gameDir, 'data'));
  await writeFile(path.join(f.gameDir, file), '{"lines":["An editor-only sample."]}');
  let reviews = 0;
  const verifier = createDisplayVerifier({ connectionFor: () => ({ baseUrl: 'https://invalid.local', model: 'negative-validation' }),
    generate: async ({ tools, prompt }) => {
      reviews++;
      const source = await tools.read_resource.execute({ file });
      const consumer = await tools.read_resource.execute({ file: 'js/plugins.js' });
      await tools.finish_review.execute({ decisions: JSON.parse(prompt).units.map(row => ({ ref: row.ref, status: 'non-display',
        reason: 'The actual loader keeps this resource as editor metadata.', evidenceIds: [source.evidenceId], consumerEvidenceIds: [consumer.evidenceId] })) });
    } });
  const dataDir = path.join(f.root, 'negative-lab'), lab = await createAdapterLab({ dataDir, displayVerifier: verifier });
  const adapter = await createTextAdapter({ candidates: [{ file, source: 'An editor-only sample.', locator: { file, pointer: '/lines/0' } }], gameDir: f.gameDir, engine: 'MV' });
  const candidate = await lab.writeAdapter(adapter), args = { ...candidate, gameDir: f.gameDir, workspaceDir: path.join(f.root, 'negative-work') };
  const first = await lab.validateAdapter(args);
  assert.equal(first.passed, false); assert.equal(first.error.code, 'ADAPTER_DISPLAY_REVIEW_FAILED');
  assert.ok(['stableIds', 'roundtrip', 'sample', 'structure'].every(key => first.checks[key] === 'passed'));
  const second = await lab.validateAdapter(args);
  assert.equal(second.reused, true); assert.equal(second.validationId, first.validationId); assert.equal(second.passed, false); assert.equal(reviews, 1);
  assert.equal((await readdir(path.join(dataDir, 'validations'))).length, 1);
  await assert.rejects(lab.submitRecipe({ ...candidate, validationId: second.validationId }), /配方晋升/);
  const reopened = await createAdapterLab({ dataDir, displayVerifier: verifier });
  assert.equal((await reopened.validateAdapter(args)).validationId, first.validationId);
  await writeFile(path.join(f.gameDir, 'js/plugins.js'), 'var activePlugins = ["new-consumer"];');
  const changed = await reopened.validateAdapter(args);
  assert.notEqual(changed.validationId, first.validationId); assert.equal(changed.passed, false); assert.equal(reviews, 2);
});

test('embedded command tool preserves the command and enforces source assignment before saving', async t => {
  const f = await fixture(t), file = 'data/CommonEvents.json'; await mkdir(path.join(f.gameDir, 'data'));
  await writeFile(path.join(f.gameDir, file), JSON.stringify([null, { list: [{ code: 356, parameters: ['D_TEXT Welcome to the harbor 32'] }] }]));
  const state = { status: 'running', events: [], failures: {}, attempts: 0 };
  const session = adaptationTools({ project: { id: 'embedded-tool', engine: 'MV' }, inventory: {}, gameDir: f.gameDir, lab: f.lab, state,
    workspaceDir: path.join(f.root, 'embedded-work'), assignment: { id: 'commands', files: [file] } });
  try {
    const tool = session.tools.write_embedded_text_adapter;
    assert.equal(tool.inputSchema.jsonSchema.properties.selections.minItems, 1);
    assert.equal(tool.inputSchema.jsonSchema.properties.selections.maxItems, 2000);
    const selection = { file, pointer: '/1/list/0/parameters/0', text: 'Welcome to the harbor', reason: 'Consumer draws the command body; the trailing value is font size.' };
    assert.ok((await tool.execute({ selections: [{ ...selection, file: 'data/Other.json' }] })).error);
    assert.ok((await tool.execute({ selections: [{ ...selection, text: 'D_TEXT Welcome to the harbor 32' }] })).error);
    const saved = await tool.execute({ selections: [selection] });
    assert.ok(saved.candidateId, JSON.stringify(saved)); assert.equal(saved.nextAction, 'validate_adapter');
    const context = { projectId: 'embedded-tool', workDir: path.join(f.root, 'embedded-work') };
    const inspected = await f.lab.inspectAdapter({ ...context, candidateId: saved.candidateId });
    assert.deepEqual(inspected.manifest.scope.files, [file]);
    const extracted = await f.lab.previewAdapter({ ...context, candidateId: saved.candidateId, gameDir: f.gameDir });
    assert.equal(extracted.result.units[0].source, selection.text);
    assert.deepEqual(extracted.result.units[0].locator.segment, { syntax: 'rpgmaker-plugin-command', prefix: 'D_TEXT ', suffix: ' 32' });
  } finally { session.close(); await session.flush(); }
});

test('all newly submitted embedded units stay inspectable without declaring remaining plugin coverage complete', async t => {
  const f = await fixture(t), file = 'data/CommonEvents.json', consumerFile = 'js/plugins/Consumer.js';
  await mkdir(path.join(f.gameDir, 'data'));
  const selections = Array.from({ length: 12 }, (_, index) => ({ file, pointer: `/1/list/${index}/parameters/0`,
    text: `Welcome traveler ${index}`, reason: 'The command consumer forwards this complete body to its caption display.' }));
  await writeFile(path.join(f.gameDir, file), JSON.stringify([null, { list: selections.map(item => ({ code: 356, parameters: [`D_TEXT ${item.text} 32`] })) }]));
  await mkdir(path.dirname(path.join(f.gameDir, consumerFile)), { recursive: true });
  await writeFile(path.join(f.gameDir, consumerFile), `Game_Interpreter.prototype.pluginCommand=function(command,args){if(command==='D_TEXT')caption.text=args.slice(0,-1).join(' ');};`);
  await writeFile(path.join(f.gameDir, 'js/rpg_objects.js'), `Game_Interpreter.prototype.command356=function(){var args=this._params[0].split(' ');var command=args.shift();this.pluginCommand(command,args);return true;};`);
  await writeFile(path.join(f.gameDir, 'js/plugins.js'), `var $plugins=[{name:'Consumer',status:true}];`);
  let canonical = f.units;
  const inventory = { existingUnits: canonical };
  const scan = (decisions = [], incoming = []) => scanCoverage({ rootDir: f.gameDir, units: [...canonical, ...incoming], decisions, scanCache: false });
  const verifier = createDisplayVerifier({ connectionFor: () => ({ baseUrl: 'https://invalid.local', model: 'accepted-unit-display-review' }),
    generate: async ({ tools, prompt }) => {
      const source = await tools.read_resource.execute({ file });
      const consumer = await tools.read_resource.execute({ file: consumerFile });
      await tools.finish_review.execute({ decisions: JSON.parse(prompt).units.map(row => ({ ref: row.ref, status: 'display-supported',
        reason: 'The fixture command body is forwarded to its inline caption consumer.', evidenceIds: [source.evidenceId], consumerEvidenceIds: [consumer.evidenceId] })) });
    } });
  const lab = await createAdapterLab({ dataDir: path.join(f.root, 'accepted-unit-lab'), displayVerifier: verifier });
  const result = await runAdaptation({ project: { id: 'accepted-unit-view', engine: 'RPG Maker MV' }, inventory, getExistingUnits: () => canonical,
    gameDir: f.gameDir, lab, coverage: scopeAdaptationCoverage(await scan(), [file, consumerFile]),
    assignment: { id: 'accepted-unit-command', files: [file, consumerFile] }, workspaceDir: path.join(f.root, 'accepted-unit-work'),
    verifyCoverage: async ({ coverageDecisions, units = [] }) => scopeAdaptationCoverage(await scan(coverageDecisions, units), [file, consumerFile]),
    generate: async ({ tools }) => {
      const saved = await tools.write_embedded_text_adapter.execute({ selections });
      assert.ok(saved.candidateId, JSON.stringify(saved));
      const validation = await tools.validate_adapter.execute({ candidateId: saved.candidateId });
      assert.equal(validation.passed, true, JSON.stringify(validation));
      assert.equal(validation.extraction.unitCount, 12);
      assert.ok(validation.extraction.sampleUnits.length <= 8, 'bounded tool output previews at most eight units, not all twelve IDs');
      const submitted = await tools.submit_recipe.execute({ candidateId: saved.candidateId, validationId: validation.validationId, metadata: {} });
      assert.equal(submitted.accepted, true, JSON.stringify(submitted)); assert.equal(submitted.taskComplete, false);
      const first = await tools.inspect_units.execute({ file, limit: 8 });
      assert.equal(first.total, 12, 'accepted units are the discoverable stable-ID source, not only the eight preview units');
      assert.equal(first.nextOffset, 8);
      const last = await tools.inspect_units.execute({ file, offset: first.nextOffset, limit: 8 });
      assert.equal(last.units.length, 4); assert.equal(last.nextOffset, null);
      const entries = [...first.units, ...last.units];
      assert.equal(new Set(entries.map(unit => unit.id)).size, 12);
      canonical = [...f.units, { id: 'u-persisted-canonical', legacyId: entries[0].id, source: entries[0].source,
        context: { ...entries[0].context, canonical: true, adaptationLocator: entries[0].locator } },
      { id: 'canonical-other-binding', source: entries[0].source, context: { file, adaptationLocator: entries[0].locator } }];
      const refreshed = await tools.inspect_units.execute({ file, limit: 100 });
      assert.equal(refreshed.total, 13, 'different stable IDs at one position retain both discoverable bindings');
      assert.equal(refreshed.units.find(unit => unit.id === entries[0].id).context.canonical, true, 'the persisted canonical view wins an equal stable ID');
      assert.ok(refreshed.units.some(unit => unit.id === 'canonical-other-binding'));
      assert.ok((await tools.write_embedded_text_adapter.execute({ selections: [selections[1]] })).error, 'already accepted positions cannot be adapted again');
      let current = await tools.inspect_coverage.execute({}), expressions = [...current.expressionCandidates];
      while (current.nextOffset !== null && current.nextOffset !== undefined) {
        const offset = current.nextPage?.input.offset ?? current.nextOffset;
        assert.ok(offset > (current.offset ?? 0), 'coverage continuation must advance beyond the delivered page');
        current = await tools.inspect_coverage.execute(current.nextPage?.input ?? { offset });
        expressions.push(...current.expressionCandidates);
      }
      await tools.read_resource.execute({ file });
      await tools.read_resource.execute({ file: consumerFile });
      const closed = await tools.record_coverage_decisions.execute({ decisions: expressions.map(expression => ({
        id: expression.id, evidenceHash: expression.evidenceHash, disposition: 'bound-reference',
        unitIds: entries.filter(unit => expression.file === consumerFile || unit.locator.pointer === expression.locator.pointer).map(unit => unit.id),
        reason: 'All twelve source bodies were submitted and their stable IDs were read through inspect_units.' })) });
      assert.equal(closed.accepted, true, JSON.stringify(closed));
      const resource = (await tools.inspect_coverage.execute({})).records.find(item => item.file === file && item.reviewKind === 'resource-file');
      if (resource) {
        assert.equal(resource.boundReferenceAllowed, true, JSON.stringify({ resource, expressionCount: expressions.length, remaining: closed.remainingCoverage?.summary }));
        const completed = await tools.record_coverage_decisions.execute({ decisions: [{ id: resource.id, evidenceHash: resource.evidenceHash,
          disposition: 'bound-reference', reason: 'The complete source was read and all twelve command bodies and display consumers now have accepted references.' }] });
        assert.equal(completed.taskComplete, false, 'the newly loaded plugin still has independent resource coverage to investigate');
      } else assert.equal(closed.taskComplete, false);
    } });
  assert.equal(result.status, 'needs-review', JSON.stringify(result.error));
  assert.equal(result.partialExtractions.flatMap(item => item.units).length, 12);
  assert.ok(!result.state.coverageDecisions.some(item => item.file === consumerFile && item.kind === 'resource-file'), 'source-use qualification does not silently close full plugin coverage');
});
