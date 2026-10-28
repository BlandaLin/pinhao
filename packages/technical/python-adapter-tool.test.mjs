import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { adaptationTools } from './adaptation.mjs';

test('explicit Python tool supplies module protocol while JavaScript rejects execution metadata', async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'pinhao-python-tool-'));
  let session;
  try {
    const writes = [];
    session = adaptationTools({ project: { id: 'tool-contract', engine: 'Godot' }, inventory: {},
      gameDir: workspaceDir, workspaceDir, assignment: { id: 'story', files: ['story.json'] },
      state: { events: [], attempts: 0, failures: {} },
      lab: { writeAdapter: async input => { writes.push(input); return { candidateId: 'module', codeHash: 'hash' }; } } });
    const { tools } = session;
    const manifest = { id: 'story-python', version: '1.0.0', engine: 'Godot', license: 'GPL-3.0-or-later', scope: { files: ['story.json'] } };
    const code = 'def detect(host,input): return True';
    const output = await tools.write_python_adapter.execute({ manifest, code, readFiles: ['roles.txt'] });
    assert.equal(output.candidateId, 'module');
    assert.deepEqual(writes[0].manifest.execution, { runtime: 'python', protocol: 'python-module-v1', wheels: [], readFiles: ['roles.txt'] });
    assert.equal(writes[0].code, code);
    assert.equal(manifest.execution, undefined);
    const rejected = await tools.write_adapter.execute({ manifest: { ...manifest, execution: { runtime: 'python' } }, code });
    assert.equal(rejected.error.code, 'ADAPTER_PROTOCOL_MISMATCH');
    assert.match(rejected.error.message, /write_python_adapter/);
    const outside = await tools.write_python_adapter.execute({ manifest: { ...manifest, scope: { files: ['other.json'] } }, code });
    assert.match(outside.error.message, /assignment.files/);
    assert.equal(writes.length, 1);
  } finally { await session?.close(); await rm(workspaceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); }
});
