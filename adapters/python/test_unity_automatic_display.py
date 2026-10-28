"""Use actual compiled consumer evidence during native import, not another paid approval."""
import os
from pathlib import Path
import tempfile
import unittest

import worker
import unity_native as unity
from test_native_review import review_game
from test_unity_semantics import COMPILER


@unittest.skipUnless(unity.available() and COMPILER.is_file(), 'UnityPy and Windows managed compiler are required')
class AutomaticDisplayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pinhao-automatic-display-')
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_known_consumers_import_without_model_and_keep_logic_identity_on_writeback(self):
        game, carrier = review_game(self.root)
        work = self.root / 'work'
        result = worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
        source = {row['source'] for row in result['units']}
        self.assertTrue({'A custom heading.', 'A complete first sentence.', 'A complete second sentence.',
                         'A traveler waves hello.'} <= source)
        self.assertNotIn('END_SCENE', source)
        self.assertNotIn('event_1', source)
        self.assertTrue(worker.roundtrip({'workspaceDir': str(work)})['byteIdentical'])
        row = next(row for row in result['units'] if row['source'] == 'A complete first sentence.')
        built = self.root / 'built'
        report = worker.build({'workspaceDir': str(work), 'outputDir': str(built),
                               'translations': [{'id': row['id'], 'translation': '一段完整中文。'}]})
        self.assertTrue(report['displayValidation'][0]['originalBusinessIlUnchanged'])
        self.assertTrue(report['displayValidation'][0]['sourceIdentifiersUnchanged'])
        _, asset = unity.load_carrier(built / carrier.relative_to(game))
        tree = unity.objects(asset)['@:9'].parse_as_dict()
        self.assertEqual(tree['chapters'][0]['lines'][0]['caption'], row['source'])
        self.assertEqual(tree['internalTarget'], 'END_SCENE')

    def test_equal_site_and_source_share_existing_joint_write_contract(self):
        game, carrier = review_game(self.root)
        _, asset = unity.load_carrier(carrier)
        obj = unity.objects(asset)['@:9']
        tree = obj.parse_as_dict()
        tree['chapters'][0]['lines'][1]['caption'] = tree['chapters'][0]['lines'][0]['caption']
        obj.save_typetree(tree)
        carrier.write_bytes(asset.save(packer='original'))
        work = self.root / 'work'
        result = worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
        rows = [row for row in result['units'] if row['source'] == 'A complete first sentence.']
        self.assertEqual(len(rows), 2)
        manifest, _ = worker.native.load_work(work)
        self.assertEqual(manifest['units'][rows[0]['id']]['sync_group'], manifest['units'][rows[1]['id']]['sync_group'])
        with self.assertRaisesRegex(ValueError, 'Shared display fields must match'):
            worker.build({'workspaceDir': str(work), 'outputDir': str(self.root / 'conflict'),
                          'translations': [{'id': rows[0]['id'], 'translation': '译法甲'},
                                           {'id': rows[1]['id'], 'translation': '译法乙'}]})


if __name__ == '__main__':
    unittest.main()
