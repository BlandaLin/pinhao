import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { inspectPlugins, registerPlugin } from './rpgmaker-plugins.mjs';

const fixtures = JSON.parse(await readFile(new URL('./fixtures/rpgmaker-plugin-manifests.json', import.meta.url), 'utf8'));
const descriptor = { name: 'PinhaoAssist', status: true, description: 'neutral', parameters: {} };

test('shared manifests preserve original rows, unrelated code and repeat bytes', () => {
  for (const fixture of fixtures) {
    const before = inspectPlugins(fixture.source);
    assert.deepEqual(before.unresolved, [], fixture.name);
    assert.deepEqual(before.plugins.map(row => row.name), fixture.names);
    const output = registerPlugin(fixture.source, descriptor), after = inspectPlugins(output);
    assert.deepEqual(after.unresolved, []);
    assert.deepEqual(after.plugins.filter(row => row.name !== descriptor.name), before.plugins.filter(row => row.name !== descriptor.name));
    assert.deepEqual(after.plugins.at(-1), descriptor);
    assert.ok(output.endsWith(fixture.tail));
    assert.equal(registerPlugin(output, descriptor), output);
    assert.equal(output.startsWith('\ufeff'), fixture.source.startsWith('\ufeff'));
    const scope = {};
    vm.runInNewContext(output, scope);
    assert.deepEqual(JSON.parse(JSON.stringify(scope.$plugins)), after.plugins);
  }
});

test('identity registration supports early execution without reordering third parties', () => {
  const identity = { ...descriptor, name: 'PinHaoNameIdentity' };
  const output = registerPlugin(fixtures[0].source, identity, { first: true });
  assert.deepEqual(inspectPlugins(output).plugins[0], identity);
  assert.deepEqual(inspectPlugins(output).plugins.slice(1).map(row => row.name), fixtures[0].names);
  assert.equal(registerPlugin(output, identity, { first: true }), output);
});

test('unknown dynamic configurations and non-owned names remain explicitly unsupported', () => {
  for (const source of ['var $plugins = makePlugins();', 'var $plugins = [{name:"Custom",status:true}];',
    'var $plugins = [];\n$plugins.push({name:"Later",status:true});', 'var $plugins = [];\nconst dynamic = `${$plugins.pop()}`;',
    'var $plugins = []; const re = /"/; $plugins.push({"name":"Later","status":true});',
    'var $plugins = [{"name":"A","status":true,"parameters":{"bad":NaN}}];',
    'var $plugins = [];\n// PinHao localization runtime\n$plugins = unknown();']) {
    assert.ok(inspectPlugins(source).unresolved.length);
    assert.throws(() => registerPlugin(source, descriptor), { code: 'PLUGIN_MANIFEST' });
  }
  assert.throws(() => registerPlugin('var $plugins = [];', { ...descriptor, name: 'PinHaoThirdParty' }), /explicitly owned/);
});

test('legacy-looking blocks in conditional or nested scope are not migrated', () => {
  const block = '// PinHao localization runtime' + fixtures[1].source.split('// PinHao localization runtime')[1].split('// PinHao optional assistance registration')[0];
  for (const [prefix, suffix] of [['function later() {\n', '}'], ['if (false)\n', '']]) {
    const source = 'var $plugins = [];\n' + prefix + block + suffix;
    assert.ok(inspectPlugins(source).unresolved.length);
    assert.throws(() => registerPlugin(source, descriptor), { code: 'PLUGIN_MANIFEST' });
  }
});
