import test from 'node:test';
import assert from 'node:assert/strict';
import cases from '../../adapters/python/fixtures/private-path-cases.json' with { type: 'json' };
import { isPrivateGamePath } from './private-paths.mjs';

test('native and generated assembly share privacy rules while retaining authored resource folders', () => {
  for (const row of cases) assert.equal(isPrivateGamePath(row.path), row.excluded, row.path);
  assert.equal(isPrivateGamePath('www/save', { directory: true }), true);
  assert.equal(isPrivateGamePath('img/save', { directory: true }), false);
});
