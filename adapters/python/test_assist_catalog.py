"""Synthetic read-only event catalogue tests for the five native RPG routes."""
import json
from pathlib import Path
import tempfile
import unittest
import zlib

import worker
import assist_catalog
from ruby_marshal import Reader, RObject
from test_rpgmaker import archive_v3, json_game, marshal
from test_worker import ruby_game, ruby_value


def obj(class_name, **values):
    return RObject(class_name, {'@' + key: value for key, value in values.items()})


class AssistCatalogueTests(unittest.TestCase):
    def test_control_flow_survives_catalogue_filtering(self):
        codes = [102, 111, 112, 113, 115, 117, 118, 119, 355, 402, 403, 404, 411, 412, 413]
        rows = assist_catalog.commands([{'code': code, 'indent': 0, 'parameters': []} for code in codes])
        self.assertEqual([row['code'] for row in rows], codes)

    def temporary(self):
        parent = worker.ROOT / 'local' / 'native-tests'
        parent.mkdir(parents=True, exist_ok=True)
        return tempfile.TemporaryDirectory(dir=parent)

    def test_json_commands_are_catalogued_without_exporting_dialogue(self):
        with self.temporary() as temporary:
            for engine in ('MV', 'MZ'):
                root = Path(temporary) / engine
                game = json_game(root, engine, engine == 'MZ')
                source = game / 'data' / 'Map001.json'
                value = json.loads(source.read_text(encoding='utf-8'))
                value['events'][1]['pages'][0]['list'] += [
                    {'code': 111, 'indent': 0, 'parameters': [0, 1, 0]},
                    {'code': 231, 'indent': 1, 'parameters': [1, 'CG_neutral']},
                    {'code': 117, 'indent': 0, 'parameters': [2]}]
                source.write_text(json.dumps(value), encoding='utf-8')
                before = source.read_bytes()
                result = assist_catalog.scan({'gameDir': str(root), 'engine': engine}, worker)
                commands = result['maps'][0]['events'][0]['pages'][0]['commands']
                self.assertEqual(result['engine'], engine)
                self.assertIn(111, [row['code'] for row in commands])
                self.assertIn(231, [row['code'] for row in commands])
                self.assertNotIn(401, [row['code'] for row in commands])
                self.assertEqual(commands[-1]['parameters'], [2])
                self.assertEqual(source.read_bytes(), before)

    def test_rgss_fields_map_info_and_shared_events_are_normalized(self):
        with self.temporary() as temporary:
            for engine, extension in [('XP', '.rxdata'), ('VX', '.rvdata'), ('VX Ace', '.rvdata2')]:
                root = ruby_game(Path(temporary) / engine, engine)
                data = root / 'Data'
                save = lambda name, value: (data / (name + extension)).write_bytes(b'\x04\x08' + marshal(value))
                save('System', obj('RPG::System', switches=['', 'CG available'], variables=['', 'Gallery count']))
                save('MapInfos', {1: obj('RPG::MapInfo', name='Recollection Room')})
                condition = obj('RPG::Event::Page::Condition', switch1_valid=True, switch1_id=1, self_switch_valid=True, self_switch_ch='A', variable_valid=True, variable_id=1, variable_value=3)
                event = obj('RPG::Event', id=2, name='CG Booth', x=1, y=2,
                            pages=[obj('RPG::Event::Page', condition=condition, trigger=0, list=[obj('RPG::EventCommand', code=117, indent=0, parameters=[1])])])
                save('Map001', obj('RPG::Map', width=12, height=8, events={2: event}))
                save('CommonEvents', [None, obj('RPG::CommonEvent', id=1, name='CG Display', trigger=0, switch_id=0,
                                                list=[obj('RPG::EventCommand', code=231, indent=0, parameters=[1, 'CG_neutral'])])])
                result = assist_catalog.scan({'gameDir': str(root), 'engine': engine}, worker)
                self.assertEqual(result['maps'][0]['name'], 'Recollection Room')
                self.assertEqual(result['maps'][0]['width'], 12)
                page = result['maps'][0]['events'][0]['pages'][0]
                self.assertTrue(page['conditions']['switch1Valid'])
                self.assertEqual(page['conditions']['selfSwitchCh'], 'A')
                self.assertEqual(page['conditions']['variableValue'], 3)
                self.assertEqual(result['commonEvents'][0]['commands'][0]['parameters'], [1, 'CG_neutral'])

    def test_fingerprint_script_identity_ignores_only_owned_bootstraps(self):
        with self.temporary() as temporary:
            root = ruby_game(Path(temporary) / 'game', 'VX Ace')
            scripts = root / 'Data' / 'Scripts.rvdata2'
            before = assist_catalog.scan({'gameDir': str(root)}, worker)
            original = zlib.decompress(Reader(scripts.read_bytes()).root[0][2].raw)
            injected = worker.rgss_bootstrap('PinHaoAssist.rb') + worker.rgss_bootstrap('PinHaoLocalization.rb') + original
            scripts.write_bytes(b'\x04\x08' + ruby_value([[1, 'Main', zlib.compress(injected)]]))
            after = assist_catalog.scan({'gameDir': str(root)}, worker)
            self.assertEqual(before['files'], after['files'])
            self.assertEqual(before['scripts'], after['scripts'])
            scripts.write_bytes(b'\x04\x08' + ruby_value([[1, 'Main', zlib.compress(injected + b"p 'actual update'\n")]]))
            self.assertNotEqual(before['files'], assist_catalog.scan({'gameDir': str(root)}, worker)['files'])

    def test_packed_rgss_catalogue_reads_archive_without_unpacking(self):
        with self.temporary() as temporary:
            root = Path(temporary) / 'packed'
            root.mkdir()
            value = b'\x04\x08' + marshal(obj('RPG::System', switches=['', 'CG'], variables=['']))
            archive = root / 'Game.rgss3a'
            archive_v3(archive, [('Data/System.rvdata2', value)])
            before = archive.read_bytes()
            result = assist_catalog.scan({'gameDir': str(root), 'engine': 'VX Ace'}, worker)
            self.assertEqual(result['switches'], ['', 'CG'])
            self.assertEqual(archive.read_bytes(), before)
            self.assertEqual([file.name for file in root.iterdir()], ['Game.rgss3a'])


if __name__ == '__main__':
    unittest.main()
