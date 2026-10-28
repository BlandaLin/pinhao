import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { serviceMethods } from '../host.mjs';

test('project execution permission crosses the existing desktop bridge without a parallel channel', async () => {
  const preload = await readFile(new URL('../preload.mjs', import.meta.url), 'utf8');
  const contract = await readFile(new URL('../../../../packages/contracts/index.ts', import.meta.url), 'utf8');
  assert.ok(serviceMethods.has('setWorkspaceExecution'));
  assert.match(preload, /'setWorkspaceExecution'/);
  assert.match(contract, /setWorkspaceExecution\(input: \{ projectId: string; granted: boolean \}\)/);
  assert.match(contract, /workspaceExecution\?: \{ granted: boolean; mode: 'current-user'/);
});

test('settled Unity projects expose an explicit omission check through the existing retry action', async () => {
  const source = await readFile(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  assert.match(source, /function canCheckOmissions\(project[^]*?project\?\.engine === "Unity"[^]*?project\.canContinueAvailableText[^]*?!project\.adaptationAvailable/);
  assert.equal((source.match(/canCheckOmissions\(project\)/g) ?? []).length, 4);
  assert.equal((source.match(/"检查遗漏文字"/g) ?? []).length, 2);
  assert.equal((source.match(/api\.retryAdaptation\(\{ projectId: project\.id \}\)/g) ?? []).length, 2);
});
