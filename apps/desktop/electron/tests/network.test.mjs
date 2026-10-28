import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const networkModule = new URL('../network.mjs', import.meta.url).href;

async function isolated(source) {
  const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', source], {
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return JSON.parse(stdout.trim());
}

async function findOpenSSL() {
  const candidates = ['openssl'];
  if (process.platform === 'win32') {
    const programs = process.env.ProgramW6432 || process.env.ProgramFiles || 'C:/Program Files';
    candidates.push(path.join(programs, 'Git/mingw64/bin/openssl.exe'));
    candidates.push(path.join(programs, 'Git/usr/bin/openssl.exe'));
  }
  for (const candidate of candidates) {
    try {
      await execute(candidate, ['version'], { timeout: 5_000, windowsHide: true });
      return candidate;
    } catch {
      // The TLS rejection check runs when a local certificate generator is available.
    }
  }
  return null;
}

test('system trust retains existing roots, merges OS roots, and remains idempotent', async () => {
  const result = await isolated(`
    import assert from 'node:assert/strict';
    import * as tls from 'node:tls';
    import { X509Certificate } from 'node:crypto';
    import { configureSystemTrust } from ${JSON.stringify(networkModule)};
    const before = tls.getCACertificates('default');
    const system = tls.getCACertificates('system');
    const identities = certificates => [...new Set(certificates.map(
      certificate => new X509Certificate(certificate).fingerprint256,
    ))].sort();
    const expected = identities([...before, ...system]);
    const environmentBefore = JSON.stringify(process.env);
    await configureSystemTrust();
    const first = tls.getCACertificates('default');
    assert.deepEqual(identities(first), expected);
    assert.equal(first.length, expected.length);
    await configureSystemTrust();
    const second = tls.getCACertificates('default');
    assert.deepEqual(identities(second), identities(first));
    assert.equal(second.length, first.length);
    assert.equal(JSON.stringify(process.env), environmentBefore);
    console.log(JSON.stringify({ existing: identities(before).length, system: system.length, total: first.length }));
  `);
  assert.ok(result.existing > 0);
  assert.ok(result.total >= result.existing);
});

test('system trust continues to reject an unknown self-signed HTTPS certificate', async t => {
  const openssl = await findOpenSSL();
  if (!openssl) return t.skip('Local OpenSSL is unavailable; CA merge assertions run independently.');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pinhao-tls-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await execute(openssl, [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
    '-keyout', 'server.key', '-out', 'server.crt',
    '-subj', '/CN=pinhao-local-test.invalid',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { cwd: dir, timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 });
  const result = await isolated(`
    import assert from 'node:assert/strict';
    import https from 'node:https';
    import { readFile } from 'node:fs/promises';
    import { once } from 'node:events';
    import { configureSystemTrust } from ${JSON.stringify(networkModule)};
    const directory = ${JSON.stringify(dir)};
    let received = 0;
    const server = https.createServer({
      key: await readFile(directory + '/server.key'),
      cert: await readFile(directory + '/server.crt'),
    }, (_, response) => { received += 1; response.end('unexpected'); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      await configureSystemTrust();
      const code = await new Promise(resolve => {
        const request = https.get({
          host: '127.0.0.1', port: server.address().port, path: '/',
        }, response => { response.resume(); resolve('UNEXPECTED_SUCCESS'); });
        request.setTimeout(5_000, () => request.destroy(new Error('TLS test timed out')));
        request.on('error', error => resolve(error.code || error.message));
      });
      assert.equal(code, 'DEPTH_ZERO_SELF_SIGNED_CERT');
      assert.equal(received, 0);
      console.log(JSON.stringify({ code, received }));
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  `);
  assert.equal(result.code, 'DEPTH_ZERO_SELF_SIGNED_CERT');
  assert.equal(result.received, 0);
});
