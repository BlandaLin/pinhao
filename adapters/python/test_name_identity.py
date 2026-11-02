import hashlib
import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest import mock

import worker
from rpgmaker_plugins import inspect_plugins
from test_rpgmaker import json_game, save


class CountedRecords(list):
    def __init__(self, values):
        super().__init__(values)
        self.scans = 0

    def __iter__(self):
        self.scans += 1
        return super().__iter__()


class NameIdentityWorkerTests(unittest.TestCase):
    def setUp(self):
        parent = worker.ROOT / 'local/native-tests'
        parent.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def fixture(self, duplicate=False):
        game, work, built = self.root / 'game', self.root / 'work', self.root / 'built'
        json_game(game)
        (game / 'Game.exe').write_bytes(b'neutral non-executable fixture')
        actors = [None, {'id': 17, 'name': 'ActorOriginal\\C[1]', 'nickname': 'AliasOriginal',
                         'profile': 'ProfileOriginal\ncontinued', 'note': ''},
                  {'id': 17 if duplicate else 41, 'name': 'SecondOriginal', 'nickname': '', 'profile': '', 'note': ''}]
        save(game / 'data/Actors.json', actors)
        save(game / 'data/Items.json', [None, {'id': 9, 'name': 'ItemOriginal', 'description': '', 'note': ''},
                                      {'id': 6, 'name': 'OtherItemOriginal', 'description': '', 'note': ''}])
        system = json.loads((game / 'data/System.json').read_text(encoding='utf-8'))
        system.update(elements=['', 'ElementOriginal'], skillTypes=['', 'SkillTypeOriginal'])
        save(game / 'data/System.json', system)
        plugins = [{'name': 'Alpha', 'status': True, 'parameters': {'keep': '\\V[1]', 'nested': '{"x":1}'}},
                   {'name': 'Disabled', 'status': False, 'parameters': {}}]
        (game / 'js/plugins.js').write_bytes(('\ufeff// neutral header\r\nvar $plugins = ' + json.dumps(plugins)
                                              + ';\r\nconst untouched = "keep";\r\n').encode('utf-8'))
        before = {file.relative_to(game).as_posix(): hashlib.sha256(file.read_bytes()).hexdigest() for file in game.rglob('*') if file.is_file()}
        extracted = worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
        words = ('Actor', 'Alias', 'Profile', 'Second', 'Item', 'OtherItem', 'Element', 'SkillType')
        translations = []
        for unit in extracted['units']:
            translated = unit['source']
            for word in words:
                translated = translated.replace(word + 'Original', word + 'Target')
            if translated != unit['source']:
                translations.append({'id': unit['id'], 'translation': translated})
        worker.build({'workspaceDir': str(work), 'outputDir': str(built), 'translations': translations})
        manifest, _ = worker.native.load_work(work)
        return game, work, built, manifest, plugins, before

    def test_native_identity_uses_record_ids_types_use_indices_and_documents_are_reused(self):
        game, work, built, manifest, _, before = self.fixture()
        documents, counted = {}, []
        parse_json = worker.native.parse_json

        def track(raw):
            value = parse_json(raw)
            if isinstance(value, list):
                value = CountedRecords(value)
                counted.append(value)
            return value

        with mock.patch.object(worker.native, 'parse_json', side_effect=track) as parse:
            display = worker.name_mappings(work, built, manifest, documents)
            identity = worker.js_name_identity(manifest, documents, built)
        self.assertEqual(parse.call_count, len(documents))
        self.assertTrue(counted)
        self.assertTrue(all(records.scans == 1 for records in counted))
        # Game_Actor.actorId() addresses the database array; dataName(record) uses record.id.
        self.assertIn('1', display)
        self.assertNotIn('17', display)
        self.assertEqual(display['1']['name']['source'], 'ActorOriginal\\C[1]')
        self.assertEqual(display['1']['profile']['source'], 'ProfileOriginal\ncontinued')
        self.assertEqual(identity['tables']['Actors']['17'], {'source': 'ActorOriginal\\C[1]', 'target': 'ActorTarget\\C[1]'})
        self.assertNotIn('1', identity['tables']['Actors'])
        self.assertEqual(set(identity['tables']['Items']), {'9', '6'})
        self.assertEqual(identity['types']['elements']['1'], {'source': 'ElementOriginal', 'target': 'ElementTarget'})
        self.assertFalse(identity['enemyNativeVerified'])
        self.assertEqual(identity['blockedTables'], [])
        self.assertEqual({file.relative_to(game).as_posix(): hashlib.sha256(file.read_bytes()).hexdigest()
                          for file in game.rglob('*') if file.is_file()}, before)

    def test_duplicate_record_ids_block_the_whole_identity_table(self):
        _, _, built, manifest, _, _ = self.fixture(duplicate=True)
        identity = worker.js_name_identity(manifest, {}, built)
        self.assertEqual(identity['blockedTables'], ['Actors'])
        self.assertNotIn('Actors', identity['tables'])
        self.assertEqual(set(identity['tables']['Items']), {'9', '6'})

    def test_assembly_registers_identity_first_and_preserves_plugin_parameters_and_source(self):
        game, work, built, _, original_plugins, before = self.fixture()
        output = self.root / 'output'
        result = worker.assemble({'gameDir': str(game), 'workspaceDir': str(work), 'buildDir': str(built), 'outputDir': str(output)})
        source = (output / 'js/plugins.js').read_bytes().decode('utf-8')
        manifest = inspect_plugins(source)
        self.assertEqual(manifest['unresolved'], [])
        self.assertEqual([row['name'] for row in manifest['plugins']], ['PinHaoNameIdentity', 'Alpha', 'Disabled', 'PinHaoLocalization'])
        self.assertEqual(manifest['plugins'][1:3], original_plugins)
        self.assertTrue(source.startswith('\ufeff// neutral header\r\n'))
        self.assertTrue(source.endswith('\r\nconst untouched = "keep";\r\n'))
        runtime = (output / 'js/plugins/PinHaoNameIdentity.js').read_text(encoding='utf-8')
        config = json.loads(re.search(r'var config = (.*);', runtime).group(1))
        self.assertEqual(config['schema'], 'pinhao-name-identity-1')
        self.assertEqual(config['tables']['Actors']['17']['source'], 'ActorOriginal\\C[1]')
        self.assertFalse(config['enemyNativeVerified'])
        self.assertEqual(result['nameIdentity']['blockedTables'], [])
        self.assertEqual({file.relative_to(game).as_posix(): hashlib.sha256(file.read_bytes()).hexdigest()
                          for file in game.rglob('*') if file.is_file()}, before)


if __name__ == '__main__':
    unittest.main()
