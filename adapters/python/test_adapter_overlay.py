"""Supplemental text overlays retain native build hashes and image boundaries."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import worker
import adapter_overlay
import asset_overlay
from test_rpgmaker import json_game
from test_worker import snapshot


class AdapterOverlayTests(unittest.TestCase):
    def setUp(self):
        parent = worker.ROOT / 'local/native-tests'
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.root = Path(self.temp.name)
        self.stage, self.overlay, self.built = [self.root / name for name in ('stage', 'overlay', 'built')]
        for path in (self.stage, self.overlay, self.built):
            path.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def row(self, name, before=b'{"title":"Before"}', after=b'{"title":"After"}'):
        for directory, data in ((self.stage, before), (self.built, before), (self.overlay, after)):
            path = directory / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        return {'file': name, 'sha256': hashlib.sha256(after).hexdigest(),
                'sourceHash': hashlib.sha256(before).hexdigest()}

    def args(self, rows):
        return {'adapterOverlayDir': str(self.overlay), 'adapterOverlayFiles': rows}

    def test_current_native_build_baseline_and_sealed_build_remain_independent(self):
        row = self.row('content/story.json')
        sealed = snapshot(self.built)
        inventory = {}
        changed = adapter_overlay.apply(self.stage, self.args([row]), worker, inventory, baseline_root=self.built)
        self.assertEqual(changed, ['content/story.json'])
        self.assertEqual((self.stage / row['file']).read_bytes(), b'{"title":"After"}')
        self.assertEqual(snapshot(self.built), sealed)
        self.assertEqual(inventory['adapterFiles'], 1)
        with self.assertRaisesRegex(worker.WorkerError, 'independent native assembly'):
            adapter_overlay.apply(self.built, self.args([row]), worker, {}, baseline_root=self.built)

    def test_all_current_baselines_are_checked_before_writes(self):
        first, second = self.row('first.json'), self.row('second.json')
        (self.stage / 'second.json').write_bytes(b'{"title":"Changed"}')
        with self.assertRaisesRegex(worker.WorkerError, 'changed before adapter overlay'):
            adapter_overlay.apply(self.stage, self.args([first, second]), worker, {}, baseline_root=self.built)
        self.assertEqual((self.stage / 'first.json').read_bytes(), b'{"title":"Before"}')
        second['sourceHash'] = '0' * 64
        with self.assertRaisesRegex(worker.WorkerError, 'differs from the adapter baseline'):
            adapter_overlay.apply(self.stage, self.args([first, second]), worker, {}, baseline_root=self.built)
        self.assertEqual((self.stage / 'first.json').read_bytes(), b'{"title":"Before"}')

    def test_recovered_gd_can_replace_compiled_carrier_without_changing_build(self):
        row = self.row('scripts/story.gd', b'extends Node\nvar text = "Before"\n',
                       b'extends Node\nvar text = "After"\n')
        (self.stage / row['file']).unlink()
        with self.assertRaisesRegex(worker.WorkerError, 'missing'):
            adapter_overlay.apply(self.stage, self.args([row]), worker, {}, baseline_root=self.built)
        adapter_overlay.apply(self.stage, self.args([row]), worker, {}, baseline_root=self.built, allow_recovered_source=True)
        self.assertEqual((self.stage / row['file']).read_bytes(), (self.overlay / row['file']).read_bytes())
        self.assertIn(b'Before', (self.built / row['file']).read_bytes())

    def test_text_source_hash_schema_paths_and_binary_are_checked(self):
        row = self.row('story.json')
        for value in (['story.json'], [{**row, 'sourceHash': None}], [{**row, 'sha256': 'bad'}],
                      [{**row, 'file': '../story.json'}], [row, row]):
            with self.assertRaises((ValueError, worker.WorkerError)):
                adapter_overlay.entries(self.args(value), worker)
        for name, contents in (('image.png', b'\x89PNG\r\n\x1a\nimage'), ('fake.gd', b'\x00binary'),
                               ('bad.json', b'{bad'), ('app.exe', b'MZbinary')):
            invalid = self.row(name, after=contents)
            with self.assertRaises(worker.WorkerError):
                adapter_overlay.entries(self.args([invalid]), worker)
        # The old image route continues to accept PNG records and reject text resources.
        image = self.row('image.png', b'\x89PNG\r\n\x1a\nold', b'\x89PNG\r\n\x1a\nnew')
        self.assertEqual(len(asset_overlay.entries({'assetOverlayDir':str(self.overlay), 'assetOverlayFiles':[image]}, worker)), 1)
        with self.assertRaises(worker.WorkerError):
            asset_overlay.entries({'assetOverlayDir':str(self.overlay), 'assetOverlayFiles':[row]}, worker)

    def test_loose_resource_without_native_text_binding_uses_current_stage_baseline(self):
        row = self.row('plugins/extras.js', b'const caption = "Before";', b'const caption = "After";')
        (self.built / row['file']).unlink()
        adapter_overlay.apply(self.stage, self.args([row]), worker, {}, baseline_root=self.built)
        self.assertIn(b'After', (self.stage / row['file']).read_bytes())

    def test_mz_native_translation_and_supplemental_text_share_one_resource(self):
        game = self.root / 'game'
        json_game(game, 'MZ', nested=False)
        (game / 'Game.exe').write_bytes(b'neutral fixture, never executed')
        system = game / 'data/System.json'
        original = json.loads(system.read_text(encoding='utf-8'))
        original['customCaption'] = 'Unbound caption'
        system.write_text(json.dumps(original), encoding='utf-8')
        work, built, output = [self.root / name for name in ('work', 'native-build', 'output')]
        extracted = worker.extract({'gameDir':str(game), 'workspaceDir':str(work)})
        title = next(row for row in extracted['units'] if row['kind'] == 'system_text'
                     and row['context'].get('field') == 'gameTitle')
        worker.build({'workspaceDir':str(work), 'outputDir':str(built),
                      'translations':[{'id':title['id'], 'translation':'Native title'}]})
        baseline = (built / 'data/System.json').read_bytes()
        merged = json.loads(baseline)
        merged['customCaption'] = 'Supplemental caption'
        target = self.overlay / 'data/System.json'
        target.parent.mkdir(parents=True)
        target.write_text(json.dumps(merged), encoding='utf-8')
        row = {'file':'data/System.json', 'sourceHash':hashlib.sha256(baseline).hexdigest(),
               'sha256':worker.digest_file(target)}
        sealed = snapshot(built)
        worker.assemble({'gameDir':str(game), 'workspaceDir':str(work), 'buildDir':str(built),
                         'outputDir':str(output), 'share':False, **self.args([row])})
        current = json.loads((output / 'data/System.json').read_text(encoding='utf-8'))
        self.assertEqual(current['gameTitle'], 'Native title')
        self.assertEqual(current['customCaption'], 'Supplemental caption')
        self.assertEqual(snapshot(built), sealed)
        self.assertEqual(json.loads(system.read_text(encoding='utf-8')), original)


if __name__ == '__main__':
    unittest.main()
