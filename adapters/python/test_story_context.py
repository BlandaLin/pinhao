"""Engine position and identity evidence, using generated neutral RPG Maker data."""
import json
from pathlib import Path
import tempfile
import unittest

import worker
from test_rpgmaker import json_game


class StoryContextTests(unittest.TestCase):
    def setUp(self):
        parent = worker.ROOT / 'local' / 'native-tests'
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_mz_static_calls_dynamic_transfer_and_explicit_names_keep_native_identity(self):
        game = self.root / 'game'
        json_game(game, 'MZ')
        data = game / 'data'
        command = lambda code, parameters, indent=0: {'code': code, 'parameters': parameters, 'indent': indent}
        entries = [command(101, ['Face', 0, 0, 2, 'Lin']), command(401, ['A complete opening.']),
                   command(117, [7]), command(111, [0, 1, 0]),
                   command(101, ['Face', 0, 0, 2, 'Lin'], 1), command(401, ['The switch is on.'], 1),
                   command(411, []), command(101, ['Face', 0, 0, 2, 'Other'], 1), command(401, ['The switch is off.'], 1),
                   command(412, []), command(201, [0, 2, 3, 4, 0, 0]), command(201, [1, 4, 5, 6, 0, 0]),
                   command(320, [1, 'New name']), command(0, [])]
        map_doc = {'displayName': 'Neutral map', 'events': [None, {'x': 0, 'y': 0, 'pages': [{'list': entries}]},
                    {'x': 1, 'y': 1, 'pages': [{'list': [command(117, [7]), command(101, ['Face', 0, 0, 2, 'Lin']),
                                                               command(401, ['Another event.']), command(0, [])]}]}]}
        (data / 'Map001.json').write_text(json.dumps(map_doc), encoding='utf-8')
        common = [None] * 8
        common[7] = {'list': [command(101, ['', 0, 0, 2, '']), command(401, ['One shared sentence.']), command(0, [])]}
        (data / 'CommonEvents.json').write_text(json.dumps(common), encoding='utf-8')
        before = {str(file.relative_to(game)): file.read_bytes() for file in game.rglob('*') if file.is_file()}
        work = self.root / 'work'
        extracted = worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
        rows = extracted['units']
        opening = next(row for row in rows if row['source'] == 'A complete opening.')
        self.assertEqual(opening['context']['speaker'], 'Lin')
        self.assertEqual(opening['context']['speaker_basis'], 'explicit-name-field')
        block_ref = opening['context']['storyBlockRef']
        anchors = [row for row in rows if row['context'].get('storyBlockRef') == block_ref
                   and 'storyLinks' in row['context']]
        self.assertEqual(len(anchors), 1)
        links = anchors[0]['context']['storyLinks']
        self.assertEqual(opening['context']['storyLinksHash'], anchors[0]['context']['storyLinksHash'])
        self.assertTrue(any(link['kind'] == 'common-event-call' and link['target'] == {'common_event': 7} for link in links))
        self.assertTrue(any(link['kind'] == 'map-transfer' and link['target'] == {'map': 'Map002'} for link in links))
        self.assertTrue(any(link['kind'] == 'map-transfer' and link['state'] == 'unknown' and link['target'] is None for link in links))
        then = next(row for row in rows if row['source'] == 'The switch is on.')
        otherwise = next(row for row in rows if row['source'] == 'The switch is off.')
        self.assertEqual(then['context']['branch_path'][0]['side'], 'then')
        self.assertEqual(otherwise['context']['branch_path'][0]['side'], 'else')
        self.assertEqual(len([row for row in rows if row['source'] == 'One shared sentence.']), 1)
        rename = next(row for row in rows if row['source'] == 'New name')
        self.assertEqual(rename['context']['actor_id'], 1)
        self.assertEqual(rename['context']['actor_attribute'], 'name')
        self.assertTrue(worker.roundtrip({'workspaceDir': str(work)})['byteIdentical'])
        self.assertEqual(before, {str(file.relative_to(game)): file.read_bytes() for file in game.rglob('*') if file.is_file()})

    def test_mv_face_stays_unknown_and_actor_database_records_have_explicit_ids(self):
        game = self.root / 'mv'; json_game(game, 'MV')
        extracted = worker.extract({'gameDir': str(game), 'workspaceDir': str(self.root / 'work')})
        dialogue = next(row for row in extracted['units'] if row['kind'] == 'dialogue')
        self.assertEqual(dialogue['context']['speaker'], 'unknown')
        self.assertEqual(dialogue['context']['speaker_basis'], 'unknown')
        actor = next(row for row in extracted['units'] if row['kind'] == 'database_name')
        self.assertEqual(actor['context']['actor_id'], actor['context']['record'])


if __name__ == '__main__':
    unittest.main()
