import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { collectPublicSourceFiles, isPublicSourcePath, sourcePrivacyFindings, validatePublicSourceFiles } from '../../../../scripts/public-source.mjs';

test('source collection follows the actual Git working tree without restoring deleted tracked code', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-source-working-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => promisify(execFile)('git', args, { cwd: root, windowsHide: true });
  await git('init', '-q');
  await mkdir(path.join(root, 'packages/core'), { recursive: true });
  await writeFile(path.join(root, 'packages/core/current.mjs'), 'export const current = true;');
  await writeFile(path.join(root, 'packages/core/removed.mjs'), 'export const removed = true;');
  await git('add', 'packages');
  await unlink(path.join(root, 'packages/core/removed.mjs'));
  await writeFile(path.join(root, 'packages/core/new.mjs'), 'export const added = true;');
  assert.deepEqual((await collectPublicSourceFiles(root)).files, ['packages/core/current.mjs', 'packages/core/new.mjs']);
  await assert.rejects(validatePublicSourceFiles(root, ['packages/core/removed.mjs']), { code: 'ENOENT' });
  const secret = 'sk-' + 'z'.repeat(24);
  await writeFile(path.join(root, 'packages/core/new.mjs'), secret);
  await assert.rejects(collectPublicSourceFiles(root), error => error.message.includes('credential-token') && !error.message.includes(secret));
});

test('public source selects maintained code, neutral fixtures and licenses even with tracked private candidates', () => {
  assert.equal(isPublicSourcePath('cases/README.md'), false);
  assert.equal(isPublicSourcePath('apps/desktop/.env.production.json'), false);
  assert.equal(isPublicSourcePath('README.en.md'), true);
  assert.equal(isPublicSourcePath('.github/media/overview.jpg'), true);
  assert.equal(isPublicSourcePath('.github/media/overview.jpeg'), true);
  assert.equal(isPublicSourcePath('local/screenshots/private.jpg'), false);
  for (const file of ['README.md', 'LICENSE', 'COPYING', 'adapters/vendor/wolftl/LICENSE', 'adapters/fixtures/lcf-neutral.edb', 'adapters/python/templates/localization.rb', 'apps/desktop/public/pinhao-app-icon.ico', '.github/workflows/test.yml', 'kits/workbench-tutorial/examples/rpgmaker/source/data/Actors.json']) assert.equal(isPublicSourcePath(file), true, file);
  for (const file of ['CONTEXT.md', 'AGENTS.md', 'research/mtool/README.md', 'cases/catalog.json', 'docs/product/FEEDBACK.md', 'scripts/consolidate_legacy.py', 'scripts/index_cases.py', 'scripts/verify_project.py', 'local/reports/README.md', 'packages/core/node_modules/cache.json', 'apps/desktop/dist/main.js', 'apps/desktop/.env', 'adapters/vendor/tool.exe', 'adapters/python/__pycache__/worker.pyc', 'docs/../../local/report.md', 'docs\\report.md', '/README.md', 'notes.md']) assert.equal(isPublicSourcePath(file), false, file);
});

test('public source scans UTF-8 and both UTF-16 byte orders without exposing matching secret values', () => {
  const secret = 'sk-' + 'a'.repeat(24);
  const profile = ['C:', 'Users', 'private-fixture', 'Documents', 'file.txt'].join('\\');
  for (const encoding of ['utf8', 'utf16le']) {
    assert.deepEqual(sourcePrivacyFindings(Buffer.from(secret, encoding)), ['credential-token']);
    assert.deepEqual(sourcePrivacyFindings(Buffer.from(profile, encoding)), ['personal-profile-path']);
  }
  for (const [text, category] of [[secret, 'credential-token'], [profile, 'personal-profile-path']]) {
    const bigEndian = Buffer.from(text, 'utf16le').swap16();
    for (const prefix of [Buffer.alloc(0), Buffer.from([0xfe, 0xff])]) {
      assert.deepEqual(sourcePrivacyFindings(Buffer.concat([prefix, bigEndian])), [category]);
      assert.deepEqual(sourcePrivacyFindings(Buffer.concat([prefix, bigEndian, Buffer.from([0])])), [category]);
    }
  }
  assert.deepEqual(sourcePrivacyFindings(Buffer.from('https://example.com/docs; apiKey: "neutral-test-key"; C:\\Games\\Example')), []);
  assert.deepEqual(sourcePrivacyFindings(Buffer.from(['https://sample', 'secret@example.com/v1'].join(':'))), ['credential-url']);
});

test('public source audit fails before packaging secrets or linked files and preserves license entries', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-public-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'packages/core'), { recursive: true });
  await writeFile(path.join(root, 'LICENSE'), 'Neutral license fixture');
  await writeFile(path.join(root, 'packages/core/neutral.mjs'), 'export const neutral = true;');
  const candidates = ['LICENSE', 'packages/core/neutral.mjs', 'local/private.json', 'CONTEXT.md'];
  assert.deepEqual(await validatePublicSourceFiles(root, candidates), { files: ['LICENSE', 'packages/core/neutral.mjs'], excluded: ['CONTEXT.md', 'local/private.json'] });
  const secret = 'sk-' + 'b'.repeat(24);
  await writeFile(path.join(root, 'packages/core/neutral.mjs'), secret);
  await assert.rejects(validatePublicSourceFiles(root, candidates), error => error.message.includes('credential-token') && !error.message.includes(secret));
  await writeFile(path.join(root, 'packages/core/neutral.mjs'), 'neutral');
  await symlink(path.join(root, 'packages'), path.join(root, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(validatePublicSourceFiles(root, ['docs/core/neutral.mjs']), /ordinary files and directories/);
});
