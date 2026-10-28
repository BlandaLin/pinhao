import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const option = name => process.argv[process.argv.indexOf(name) + 1];
const root = process.cwd(), before = path.resolve(option('--before')), after = path.resolve(option('--after'));
const output = path.resolve(option('--out')), samples = 5;
const parent = path.join(path.dirname(output), 'startup-profiles');
await mkdir(parent, { recursive: true });
const results = { before: [], after: [] };
for (let index = 0; index < samples; index++) for (const [label, source] of [['before', before], ['after', after]]) {
  const { createServiceClient } = await import(pathToFileURL(path.join(source, 'apps/desktop/electron/service-client.mjs')));
  const dataDir = await mkdtemp(path.join(parent, `${label}-`));
  let client;
  try {
    const start = performance.now();
    client = await createServiceClient({ dataDir,
      workerUrl: pathToFileURL(path.join(source, 'apps/desktop/electron/service-worker.mjs')),
      workerOptions: {
        pythonPath: path.join(root, 'local/runtime/python/python.exe'),
        workerPath: path.join(source, 'adapters/python/worker.py'),
        toolkitPath: path.join(source, 'kits/workbench-tutorial/toolkit'),
        dependencyDir: path.join(root, 'local/dependencies'),
        toolVersionsPath: path.join(root, 'local/runtime/tool-versions.json'),
      },
      secrets: { encrypt: text => text, decrypt: text => text },
    });
    await client.snapshot();
    const snapshotMs = performance.now() - start;
    await assert.rejects(client.startProject({ projectId: 'missing-neutral-project' }), /重新选择项目/);
    const productionReadyMs = performance.now() - start;
    const snapshot = await client.snapshot();
    assert.ok(snapshot.engines.some(engine => engine.id === 'unity'), 'The real catalog must finish, not silently use the seven-engine fallback');
    results[label].push({ snapshotMs, productionReadyMs, engines: snapshot.engines.length });
  } finally {
    await client?.close();
    assert.equal(path.dirname(dataDir), parent);
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
  }
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summary = Object.fromEntries(Object.entries(results).map(([label, values]) => [label, {
  snapshotMs: median(values.map(value => value.snapshotMs)),
  productionReadyMs: median(values.map(value => value.productionReadyMs)),
}]));
await writeFile(output, JSON.stringify({ samples,
  limitation: 'Real service worker, Python catalog and native revision hashing, fresh empty profiles. Measures first usable service snapshot, not GUI first paint or total application launch.',
  summary, results }, null, 2));
console.log(JSON.stringify(summary));
