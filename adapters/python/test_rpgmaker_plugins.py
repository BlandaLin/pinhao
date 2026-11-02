import json
from pathlib import Path
import unittest

from rpgmaker_plugins import PluginManifestError, inspect_plugins, register_plugin


FIXTURES = json.loads((Path(__file__).resolve().parents[2] / 'packages/runtime/fixtures/rpgmaker-plugin-manifests.json').read_text(encoding='utf-8'))
DESCRIPTOR = {'name': 'PinhaoAssist', 'status': True, 'description': 'neutral', 'parameters': {}}


class PluginManifestTests(unittest.TestCase):
    def test_shared_fixtures_preserve_other_plugins_and_unrelated_code(self):
        for fixture in FIXTURES:
            with self.subTest(fixture=fixture['name']):
                before = inspect_plugins(fixture['source'])
                self.assertEqual(before['unresolved'], [])
                self.assertEqual([row['name'] for row in before['plugins']], fixture['names'])
                output = register_plugin(fixture['source'], DESCRIPTOR)
                after = inspect_plugins(output)
                self.assertEqual(after['unresolved'], [])
                self.assertEqual([row for row in after['plugins'] if row['name'] != 'PinhaoAssist'],
                                 [row for row in before['plugins'] if row['name'] != 'PinhaoAssist'])
                self.assertEqual(after['plugins'][-1], DESCRIPTOR)
                self.assertTrue(output.endswith(fixture['tail']))
                self.assertEqual(register_plugin(output, DESCRIPTOR), output)
                self.assertEqual(output.startswith('\ufeff'), fixture['source'].startswith('\ufeff'))

    def test_identity_can_be_registered_before_original_plugins(self):
        identity = {**DESCRIPTOR, 'name': 'PinHaoNameIdentity'}
        source = FIXTURES[0]['source']
        output = register_plugin(source, identity, first=True)
        self.assertEqual(inspect_plugins(output)['plugins'][0], identity)
        self.assertEqual(register_plugin(output, identity, first=True), output)

    def test_unknown_dynamic_and_nonstandard_inputs_are_not_executed_or_rewritten(self):
        for source in ('var $plugins = makePlugins();', 'var $plugins = [{name:"Custom",status:true}];',
                       'var $plugins = [];\n$plugins.push({name:"Later",status:true});',
                       'var $plugins = [];\nconst dynamic = `${$plugins.pop()}`;',
                       'var $plugins = []; const re = /"/; $plugins.push({"name":"Later","status":true});',
                       'var $plugins = [{"name":"A","status":true,"parameters":{"bad":NaN}}];',
                       'var $plugins = [];\n// PinHao localization runtime\n$plugins = unknown();'):
            with self.subTest(source=source):
                self.assertTrue(inspect_plugins(source)['unresolved'])
                with self.assertRaises(PluginManifestError):
                    register_plugin(source, DESCRIPTOR)
        with self.assertRaises(PluginManifestError):
            register_plugin('var $plugins = [];', {**DESCRIPTOR, 'name': 'PinHaoThirdParty'})

    def test_legacy_looking_code_in_nested_or_conditional_scope_is_not_migrated(self):
        block = FIXTURES[1]['source'].split('// PinHao localization runtime', 1)[1].split('// PinHao optional assistance registration', 1)[0]
        for prefix, suffix in (('function later() {\n', '}'), ('if (false)\n', '')):
            source = 'var $plugins = [];\n' + prefix + '// PinHao localization runtime' + block + suffix
            self.assertTrue(inspect_plugins(source)['unresolved'])
            with self.assertRaises(PluginManifestError):
                register_plugin(source, DESCRIPTOR)


if __name__ == '__main__':
    unittest.main()
