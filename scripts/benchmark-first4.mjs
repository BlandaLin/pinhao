import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const usage = 'node scripts/benchmark-first4.mjs --source <source-root> --out <result.json> [--only scope,summary,query,dispatch,migration,paired-query] [--compare-source <baseline-root>]';
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  if (process.argv[index] === '--help') { console.log(usage); process.exit(0); }
  if (!['--source', '--out', '--only', '--compare-source'].includes(process.argv[index]) || !process.argv[index + 1]) throw new Error(usage);
  options[process.argv[index].slice(2)] = process.argv[index + 1];
}
if (!options.source || !options.out) throw new Error(usage);
const selected = new Set((options.only ?? 'scope,summary,query,dispatch').split(','));
for (const suite of selected) if (!['scope', 'summary', 'query', 'dispatch', 'migration', 'paired-query'].includes(suite)) throw new Error(`Unknown suite: ${suite}`);
if (selected.has('paired-query') && !options['compare-source']) throw new Error('paired-query requires --compare-source');
const sourceRoot = path.resolve(options.source);
const outputPath = path.resolve(options.out);
const hash = value => createHash('sha256').update(value).digest('hex');
const moduleAt = relative => import(pathToFileURL(path.join(sourceRoot, relative)).href);
const { createStore } = await moduleAt('packages/core/store.mjs');
const serviceModule = await moduleAt('packages/core/service.mjs');
const { createService, defaultSettings } = serviceModule;
const { GLOSSARY_VERSION, scanTerminology } = await moduleAt('packages/core/glossary.mjs');
const repeats = 5;
const warmups = 1;
const fixtureVersion = 'first4-neutral-1';
const sourceFiles = ['packages/core/service.mjs', 'packages/core/store.mjs', 'packages/core/request-batches.mjs', 'packages/core/task-index.mjs'];
const sources = Object.fromEntries(await Promise.all(sourceFiles.map(async relative => [relative, hash(await readFile(path.join(sourceRoot, relative)))])));
const result = {
  fixtureVersion, node: process.version, platform: process.platform, architecture: process.arch, cpu: os.cpus()[0]?.model,
  samples: repeats, warmups, sources, suites: {}, boundaries: [
    'Neutral generated fixtures; no user database, game files, installed application, network or paid model.',
    'Each suite runs sequentially. Timings exclude fixture creation and service initialization unless explicitly stated.',
    'Dispatch sets a prepared fixture running after service initialization and wakes the real pump via saveSettings; it is not startProject end-to-end latency.',
    'SQL counters are logical returned rows and UTF-8 JSON body bytes, not physical disk reads or Electron IPC measurements.',
  ],
};

// Observe the actual SQL statements without replacing production store behavior.
const originalPrepare = DatabaseSync.prototype.prepare;
let observation;
DatabaseSync.prototype.prepare = function (sql) {
  const statement = originalPrepare.call(this, sql);
  for (const method of ['all', 'get', 'run']) {
    const original = statement[method];
    statement[method] = function (...args) {
      const value = original.apply(this, args);
      if (observation) {
        const table = sql.match(/\b(?:FROM|INTO|UPDATE)\s+([a-z_]+)/i)?.[1]?.toLowerCase() ?? 'other';
        const counter = observation[table] ??= { calls: 0, returnedRows: 0, bodyBytes: 0, writes: 0 };
        counter.calls++;
        if (method === 'run') counter.writes++;
        else {
          const rows = method === 'all' ? value : value ? [value] : [];
          counter.returnedRows += rows.length;
          for (const row of rows) if (typeof row.body === 'string') counter.bodyBytes += Buffer.byteLength(row.body);
        }
      }
      return value;
    };
  }
  return statement;
};

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'pinhao-first4-'));
const summarize = samples => {
  const times = samples.map(sample => sample.ms).sort((a, b) => a - b);
  return { medianMs: times[Math.floor(times.length / 2)], maxMs: Math.max(...times), minMs: Math.min(...times), samples };
};
async function measure(operation) {
  for (let index = 0; index < warmups; index++) await operation();
  const samples = [];
  for (let index = 0; index < repeats; index++) {
    observation = {};
    const started = performance.now();
    let value;
    try { value = await operation(); }
    finally {
      const ms = performance.now() - started;
      samples.push({ ms, sql: observation, value });
      observation = undefined;
    }
  }
  return summarize(samples);
}
const neutralId = index => `data/Map001.json:events[1].pages[0].list[${String(index).padStart(6, '0')}]`;
const neutralUnit = (index, { pending = false, singleScene = false } = {}) => {
  const source = `Neutral line ${index}: ${index % 97 === 0 ? 'river' : 'garden'} path.`;
  const status = pending ? 'pending' : ['pending', 'translated', 'proofread', 'skipped'][index % 4];
  return { id: neutralId(index), source, sourceHash: hash(source), translation: status === 'pending' || status === 'skipped' ? source : `Reviewed ${source}`,
    notes: index % 101 === 0 ? 'neutral-note' : '', revision: 0, status, kind: 'message',
    context: { file: 'data/Map001.json', event: 1, page: 0, scene: singleScene ? index : Math.floor(index / 16) } };
};
const projectFor = (id, directory) => ({
  id, name: 'Neutral benchmark', engine: 'MV', gameDir: path.join(directory, 'game'),
  workspaceDir: path.join(directory, 'workspace'), workbenchDir: path.join(directory, 'workbench'),
  status: 'ready', stage: 'Ready', prepared: true, technicalPlan: {}, sampleValidation: { valid: true },
  targetLanguage: 'zh-Hans', sourceFingerprint: 'neutral-fixture', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  inventory: { capabilities: { assist: false, assistModes: [] } },
  nameGlossary: { version: GLOSSARY_VERSION, targetLanguage: 'zh-Hans', prepared: true, entries: [] },
});
const settingsFor = () => ({ ...defaultSettings(), id: 'global', proofreading: false,
  connection: { baseUrl: 'http://127.0.0.1:1/v1', model: 'neutral-hanging-provider', hasKey: false } });
function seedHistory(store, projectId, count) {
  store.transaction(() => {
    for (let index = 0; index < count; index++) {
      const unitIds = Array.from({ length: 16 }, (_, offset) => `history/${neutralId(index * 16 + offset)}`);
      store.putTask(projectId, { id: `history-${String(index).padStart(6, '0')}`, projectId, fingerprint: `history-fingerprint-${index}`,
        role: 'translation', status: 'succeeded', unitIds, input: unitIds.map(id => ({ id, revision: 0, sourceHash: hash(id) })),
        attempts: 1, targetLanguage: 'zh-Hans', promptVersion: 'neutral-history',
        requestHistory: [{ id: `request-${index}`, status: 'succeeded', requested: 16, returned: 16, receivedCharacters: 1024 }],
        createdAt: '2026-01-01T00:00:00Z' });
    }
  });
}
const worker = async command => {
  if (command === 'catalog') return { engines: [] };
  throw new Error(`Unexpected native worker call in benchmark: ${command}`);
};

try {
  if (selected.has('scope')) {
    const source = await readFile(path.join(sourceRoot, 'packages/core/service.mjs'), 'utf8');
    let makePredicate, sourceSnippet;
    if (typeof serviceModule.createRunScope === 'function') {
      makePredicate = serviceModule.createRunScope;
      sourceSnippet = String(makePredicate);
    } else {
      const match = source.match(/const inRun = ([^\r\n]+);/);
      assert.ok(match, 'Baseline must contain the production inRun function; do not substitute a handwritten implementation');
      sourceSnippet = match[1];
      const inRun = new Function(`return (${sourceSnippet});`)();
      makePredicate = ids => {
        const project = { runConfig: { scopeUnitIds: ids } };
        return unit => inRun(project, unit);
      };
    }
    result.suites.scope = { boundary: 'Production scope predicate only; includes constructing the optimized scope Set once per pass, then filtering all units.',
      sourceSnippet, sourceSnippetSha256: hash(sourceSnippet), cases: [] };
    for (const count of [10000, 30000]) {
      const units = Array.from({ length: count }, (_, index) => ({ id: neutralId(index) }));
      const ids = units.map(unit => unit.id);
      const data = await measure(() => {
        const scoped = units.filter(makePredicate(ids));
        assert.equal(scoped.length, count);
        return { matched: scoped.length };
      });
      result.suites.scope.cases.push({ count, idsSha256: hash(ids.join('\n')), ...data });
    }
  }
  if (selected.has('summary')) {
    result.suites.summary = { boundary: 'Real getProject(summaryOnly) plus JSON serialization; all history retained in SQLite.', cases: [] };
    for (const taskCount of [8192, 16384]) {
      const directory = path.join(temporaryRoot, `summary-${taskCount}`);
      const fixture = createStore(directory);
      const project = projectFor('summary', directory);
      fixture.put('projects', project);
      fixture.put('settings', settingsFor());
      fixture.transaction(() => { for (let index = 0; index < 16; index++) fixture.putUnit(project.id, neutralUnit(index), index); });
      seedHistory(fixture, project.id, taskCount);
      fixture.put('builds', { id: 'neutral-build', path: path.join(directory, 'output'), checks: [], assistance: { supported: false, modes: [] },
        outputManifest: { hash: 'neutral-manifest', files: Array.from({ length: 1024 }, (_, index) => ({ path: `data/resource-${index}.json`, size: 128, sha256: hash(String(index)) })) } }, project.id);
      fixture.close();
      const service = await createService({ dataDir: directory, worker });
      try {
        const data = await measure(async () => {
          const detail = await service.getProject({ projectId: project.id, summaryOnly: true });
          const serialized = JSON.stringify(detail);
          const recentIds = detail.tasks.slice(-8).map(task => task.id);
          assert.deepEqual(recentIds, Array.from({ length: 8 }, (_, offset) => `history-${String(taskCount - 8 + offset).padStart(6, '0')}`));
          assert.equal(detail.taskTotal ?? detail.tasks.length, taskCount);
          return { taskCount, returnedTasks: detail.tasks.length, payloadBytes: Buffer.byteLength(serialized), recentIds };
        });
        result.suites.summary.cases.push({ taskCount, ...data });
      } finally { await service.close(); }
    }
  }
  if (selected.has('query')) {
    const directory = path.join(temporaryRoot, 'query');
    const store = createStore(directory);
    const count = 131609;
    store.transaction(() => { for (let index = 0; index < count; index++) store.putUnit('query', neutralUnit(index), index); });
    // Summary is already warm in the desktop poll path; make the same condition explicit here.
    store.counts('query');
    result.suites.query = { count, boundary: 'Production store.page, offset 0, limit 40, warmed project statistics. Search is substring matching, not FTS.', cases: [] };
    try {
      for (const query of [
        { name: 'all', filter: 'all', search: '' },
        { name: 'pending', filter: 'pending', search: '' },
        { name: 'translated', filter: 'translated', search: '' },
        { name: 'untranslated', filter: 'untranslated', search: '' },
        { name: 'changed', filter: 'changed', search: '' },
        { name: 'search-hit', filter: 'all', search: 'river' },
        { name: 'search-miss', filter: 'all', search: 'not-present-neutral-token' },
      ]) {
        const data = await measure(() => {
          const page = store.page('query', { offset: 0, limit: 40, filter: query.filter, search: query.search });
          const expectedTotal = query.name === 'all' ? count
            : query.name === 'pending' ? Math.ceil(count / 4)
              : query.name === 'translated' ? Math.floor((count + 2) / 4)
                : query.name === 'untranslated' ? Math.floor((count + 3) / 4) + Math.floor(count / 4)
                  : query.name === 'changed' ? Math.floor((count + 2) / 4) + Math.floor((count + 1) / 4)
                    : query.name === 'search-hit' ? Math.ceil(count / 97) : 0;
          assert.equal(page.total, expectedTotal);
          return { total: page.total, returned: page.units.length, idsSha256: hash(page.units.map(unit => unit.id).join('\n')) };
        });
        result.suites.query.cases.push({ query, ...data });
      }
    } finally { store.close(); }
  }
  if (selected.has('dispatch')) {
    result.suites.dispatch = { units: 320, configuredConcurrency: 3, holdAfterFirstRequestMs: 50, boundary: result.boundaries[2], cases: [] };
    for (const taskCount of [0, 16384]) {
      const directory = path.join(temporaryRoot, `dispatch-${taskCount}`);
      const initial = createStore(directory);
      const units = Array.from({ length: 320 }, (_, index) => neutralUnit(index, { pending: true, singleScene: true }));
      const project = { ...projectFor('dispatch', directory), nameGlossary: scanTerminology(units, undefined, 'zh-Hans') };
      initial.put('projects', project); initial.put('settings', settingsFor());
      initial.transaction(() => { for (let index = 0; index < units.length; index++) initial.putUnit(project.id, units[index], index); });
      seedHistory(initial, project.id, taskCount);
      initial.close();
      const samples = [];
      for (let iteration = -warmups; iteration < repeats; iteration++) {
        const reset = createStore(directory);
        reset.db.prepare("DELETE FROM tasks WHERE id NOT LIKE 'history-%'").run();
        reset.put('projects', project);
        reset.close();
        let firstRequest, started;
        const arrived = new Promise(resolve => { firstRequest = resolve; });
        const requests = [];
        const provider = async ({ signal }) => {
          requests.push({ arrivedMs: performance.now() - started });
          firstRequest();
          return new Promise((resolve, reject) => {
            const aborted = () => reject(signal.reason ?? new Error('Benchmark stopped'));
            signal.addEventListener('abort', aborted, { once: true });
            if (signal.aborted) aborted();
          });
        };
        const service = await createService({ dataDir: directory, worker, provider });
        const external = createStore(directory);
        external.put('projects', { ...project, status: 'running' });
        external.close();
        try {
          observation = {};
          started = performance.now();
          await service.saveSettings(settingsFor());
          let timeout;
          try {
            await Promise.race([arrived, new Promise((resolve, reject) => { timeout = setTimeout(() => reject(new Error('No dispatch within 30 seconds')), 30000); })]);
          } finally { clearTimeout(timeout); }
          await new Promise(resolve => setTimeout(resolve, 50));
          const sample = { ms: requests[0].arrivedMs, sql: observation, value: { dispatched: requests.length, arrivalMs: requests.map(request => request.arrivedMs) } };
          observation = undefined;
          const inspect = createStore(directory);
          const newTasks = inspect.all('tasks', project.id).filter(task => !task.id.startsWith('history-'));
          const ids = newTasks.flatMap(task => task.unitIds);
          assert.equal(new Set(ids).size, ids.length);
          assert.ok(newTasks.length <= 16, 'Queue must remain bounded by the request window');
          assert.ok(requests.length >= 1 && requests.length <= 3);
          sample.value.queuedAndRunningTasks = newTasks.length;
          sample.value.scheduledUnits = ids.length;
          sample.value.uniqueScheduledIds = new Set(ids).size;
          inspect.close();
          if (iteration >= 0) samples.push(sample);
        } finally { observation = undefined; await service.close(); }
      }
      result.suites.dispatch.cases.push({ taskCount, ...summarize(samples) });
    }
  }
  if (selected.has('migration')) {
    const taskCount = 16384;
    const templatePath = path.join(temporaryRoot, 'legacy.sqlite');
    const legacy = new DatabaseSync(templatePath);
    // This fixed 0.5.1 schema is deliberately independent of the source under test.
    legacy.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE projects (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE units (project_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(project_id,id));
      CREATE INDEX units_project_position ON units(project_id,position);
      CREATE TABLE revisions (project_id TEXT NOT NULL, unit_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(project_id,unit_id,revision));
      CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, fingerprint TEXT NOT NULL, body TEXT NOT NULL);
      CREATE UNIQUE INDEX tasks_fingerprint ON tasks(project_id,fingerprint);
      CREATE TABLE issues (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE builds (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE settings (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE imports (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT NOT NULL);`);
    const insert = legacy.prepare('INSERT INTO tasks(id,project_id,fingerprint,body) VALUES(?,?,?,?)');
    try {
      seedHistory({
        transaction(fn) {
          legacy.exec('BEGIN IMMEDIATE');
          try { fn(); legacy.exec('COMMIT'); }
          catch (error) { legacy.exec('ROLLBACK'); throw error; }
        },
        putTask(projectId, task) { insert.run(task.id, projectId, task.fingerprint, JSON.stringify(task)); },
      }, 'migration', taskCount);
    } finally { legacy.close(); }
    const taskEvidence = file => {
      const db = new DatabaseSync(file, { readOnly: true });
      const bodies = createHash('sha256'), rowids = createHash('sha256');
      let count = 0, firstRowid, lastRowid;
      try {
        for (const row of db.prepare('SELECT rowid,id,project_id,fingerprint,body FROM tasks ORDER BY rowid').iterate()) {
          bodies.update(`${JSON.stringify([row.id, row.project_id, row.fingerprint, row.body])}\n`);
          rowids.update(`${JSON.stringify([row.id, row.rowid])}\n`);
          firstRowid ??= row.rowid; lastRowid = row.rowid; count++;
        }
        return { count, firstRowid, lastRowid, bodiesSha256: bodies.digest('hex'), rowidsSha256: rowids.digest('hex') };
      } finally { db.close(); }
    };
    const expected = taskEvidence(templatePath);
    assert.equal(expected.count, taskCount);
    const templateBytes = (await stat(templatePath)).size;
    const templateSha256 = hash(await readFile(templatePath));
    const samples = [];
    for (let iteration = -warmups; iteration < repeats; iteration++) {
      const directory = path.join(temporaryRoot, `migration-${iteration + warmups}`);
      await mkdir(directory);
      const target = path.join(directory, 'pinhao.sqlite');
      await copyFile(templatePath, target);
      assert.equal(hash(await readFile(target)), templateSha256, 'Every first open must use a byte-identical legacy database');
      observation = {};
      const started = performance.now();
      try { createStore(directory).close(); }
      finally {
        const ms = performance.now() - started;
        const sql = observation;
        observation = undefined;
        const evidence = taskEvidence(target);
        assert.deepEqual(evidence, expected, 'Migration must preserve task bodies, count and original rowids');
        const value = { beforeBytes: templateBytes, afterBytes: (await stat(target)).size, unchangedTaskEvidence: evidence };
        if (iteration >= 0) samples.push({ ms, sql, value });
      }
    }
    result.suites.migration = {
      boundary: 'First createStore through close on a fresh byte-identical 0.5.1 database copy per sample; includes index creation and close/checkpoint, excludes copy and validation. Process and filesystem cache are warm, not cold Windows startup.',
      templateSha256, templateBytes, expectedTaskEvidence: expected,
      cases: [{ taskCount, ...summarize(samples) }],
    };
  }
  if (selected.has('paired-query')) {
    const comparisonRoot = path.resolve(options['compare-source']);
    const comparisonModule = await import(pathToFileURL(path.join(comparisonRoot, 'packages/core/store.mjs')).href);
    const directory = path.join(temporaryRoot, 'paired-query');
    const count = 131609;
    const seed = createStore(directory);
    seed.transaction(() => { for (let index = 0; index < count; index++) seed.putUnit('paired-query', neutralUnit(index), index); });
    seed.close();
    const stores = { source: createStore(directory), comparison: comparisonModule.createStore(directory) };
    const comparisonSources = Object.fromEntries(await Promise.all(sourceFiles.map(async relative =>
      [relative, hash(await readFile(path.join(comparisonRoot, relative)))])));
    result.suites['paired-query'] = {
      count, comparisonSources,
      boundary: 'Control measurement, not a new optimization: both source versions query the same SQLite database in one process; project counts are warm, each pair alternates which version runs first. Timings cover store.page only, not result hashing or assertions.',
      cases: [],
    };
    try {
      for (const store of Object.values(stores)) store.counts('paired-query');
      for (const query of [
        { name: 'all', filter: 'all', search: '' },
        { name: 'pending', filter: 'pending', search: '' },
        { name: 'changed', filter: 'changed', search: '' },
        { name: 'search-hit', filter: 'all', search: 'river' },
        { name: 'search-miss', filter: 'all', search: 'not-present-neutral-token' },
      ]) {
        const pairs = [], samples = { source: [], comparison: [] };
        for (let iteration = -warmups; iteration < repeats; iteration++) {
          const order = iteration % 2 === 0 ? ['source', 'comparison'] : ['comparison', 'source'];
          const measured = {};
          for (const label of order) {
            observation = {};
            const started = performance.now();
            let page, ms, sql;
            try {
              page = stores[label].page('paired-query', { offset: 0, limit: 40, filter: query.filter, search: query.search });
              ms = performance.now() - started;
            } finally { sql = observation; observation = undefined; }
            const ids = page.units.map(unit => unit.id);
            measured[label] = { ms, sql, ids, value: { total: page.total, returned: ids.length, idsSha256: hash(ids.join('\n')) } };
          }
          assert.equal(measured.source.value.total, measured.comparison.value.total, `${query.name}: total differs`);
          assert.deepEqual(measured.source.ids, measured.comparison.ids, `${query.name}: ordered IDs differ`);
          if (iteration >= 0) {
            const pair = { order };
            for (const label of ['source', 'comparison']) {
              const { ids, ...sample } = measured[label];
              samples[label].push(sample); pair[label] = sample;
            }
            pairs.push(pair);
          }
        }
        result.suites['paired-query'].cases.push({
          query, sourceMeasurements: summarize(samples.source), comparisonMeasurements: summarize(samples.comparison), pairs,
        });
      }
    } finally {
      observation = undefined;
      for (const store of Object.values(stores)) store.close();
    }
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ output: outputPath, suites: Object.fromEntries(Object.entries(result.suites).map(([name, suite]) =>
    [name, suite.cases.map(({ count, taskCount, query, medianMs, maxMs, samples, sourceMeasurements, comparisonMeasurements }) => ({
      count, taskCount, query: query?.name, medianMs, maxMs, value: samples?.[0]?.value,
      ...(sourceMeasurements ? { sourceMedianMs: sourceMeasurements.medianMs, comparisonMedianMs: comparisonMeasurements.medianMs } : {}),
    }))])) }, null, 2));
} finally {
  observation = undefined;
  DatabaseSync.prototype.prepare = originalPrepare;
  assert.equal(path.dirname(temporaryRoot), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporaryRoot).startsWith('pinhao-first4-'));
  await rm(temporaryRoot, { recursive: true, force: true });
}
