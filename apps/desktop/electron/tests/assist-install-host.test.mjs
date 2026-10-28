import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { productWorker, makeWorker } from '../host.mjs';

function options(result, extra = {}) {
  return { pythonPath: 'fixture', workerPath: 'fixture.py', toolkitPath: '.', ...extra,
    spawnProcess() {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      queueMicrotask(() => { child.stdout.write(JSON.stringify(result)); child.emit('close', 0); });
      return child;
    } };
}

test('disabled assist does not invoke the installer after successful assembly', async () => {
  let calls = 0;
  const worker = productWorker(options({ ok: true, result: { outputDir: 'neutral-output' } }, { assistInstaller: async () => { calls++; throw new Error('must not run'); } }));
  const result = await worker('assemble', { assistEnabled: false });
  assert.equal(calls, 0); assert.equal(result.assist.status, 'disabled');
});

test('only verified restored assist failures can continue as a normal assembled game', async () => {
  const worker = productWorker(options({ ok: true, result: { outputDir: 'neutral-output' } }, {
    assistInstaller: async () => ({ supported: false, status: 'install_failed', restored: true, detail: 'restored' }),
  }));
  const result = await worker('assemble', {});
  assert.equal(result.outputDir, 'neutral-output'); assert.equal(result.assist.restored, true);
  const unsafe = productWorker(options({ ok: true, result: { outputDir: 'neutral-output' } }, {
    assistInstaller: async () => ({ supported: false, status: 'install_failed' }),
  }));
  await assert.rejects(unsafe('assemble', {}), { code: 'ASSIST_INSTALL_RECOVERY_REQUIRED', hostFailure: true });
});

test('unrecoverable installation errors are host failures, not native build repair work', async () => {
  const worker = productWorker(options({ ok: true, result: { outputDir: 'neutral-output' } }, {
    assistInstaller: async () => { throw Object.assign(new Error('restore conflict'), { code: 'ASSIST_INSTALL_RECOVERY_REQUIRED' }); },
  }));
  await assert.rejects(worker('assemble', {}), { code: 'ASSIST_INSTALL_RECOVERY_REQUIRED', hostFailure: true });
});

test('native worker finite dependency diagnostics survive host decoding without arbitrary fields', async () => {
  const diagnostic = { category: 'dependency', phase: 'extract', engine: 'Godot', dependencyId: 'gdre', state: 'missing' };
  const worker = makeWorker(options({ ok: false, error: { code: 'NATIVE_DEPENDENCY_MISSING', message: 'missing', diagnostic,
    arbitrarySecret: 'not forwarded' } }));
  await assert.rejects(worker('extract', {}), error => {
    assert.deepEqual(error.diagnostic, diagnostic); assert.equal(error.hostFailure, true);
    assert.equal(error.arbitrarySecret, undefined); return true;
  });
});

test('only Python spawn failures become component diagnostics, not worker internal ENOENT', async () => {
  const invalid = makeWorker({ pythonPath: 'fixture-python', workerPath: 'worker.py', spawnProcess() {
    throw Object.assign(new Error('invalid interpreter'), { code: 'ENOEXEC', syscall: 'spawn fixture-python', path: 'fixture-python' });
  } });
  await assert.rejects(invalid('probe', {}), { code: 'NATIVE_DEPENDENCY_INVALID', hostFailure: true });
  const internal = makeWorker(options({ ok: false, error: { code: 'ENOENT', message: 'resource inside game is missing' } }));
  await assert.rejects(internal('extract', {}), error => { assert.equal(error.code, 'ENOENT'); assert.equal(error.diagnostic, undefined); return true; });
});
