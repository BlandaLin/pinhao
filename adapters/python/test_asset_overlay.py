"""Native image overlays retain OCR baselines through packed resource assembly."""
import hashlib
from pathlib import Path
import tempfile
import unittest

import worker
import asset_overlay


class AssetOverlayTests(unittest.TestCase):
    def setUp(self):
        parent = worker.ROOT / 'local' / 'native-tests'
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.root = Path(self.temp.name)
        self.original = b'\x89PNG\r\n\x1a\noriginal'
        self.updated = b'\x89PNG\r\n\x1a\nupdated'
        self.target = self.root / 'game'
        self.overlay = self.root / 'overlay'
        self.target.mkdir()
        self.overlay.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def row(self, name):
        (self.target / name).parent.mkdir(parents=True, exist_ok=True)
        (self.overlay / name).parent.mkdir(parents=True, exist_ok=True)
        (self.target / name).write_bytes(self.original)
        (self.overlay / name).write_bytes(self.updated)
        return {'file': name, 'sha256': hashlib.sha256(self.updated).hexdigest(),
                'sourceHash': hashlib.sha256(self.original).hexdigest()}

    def args(self, rows):
        return {'assetOverlayDir': str(self.overlay), 'assetOverlayFiles': rows}

    def test_checked_overlay_applies_to_original_baseline(self):
        inventory = {}
        asset_overlay.apply(self.target, self.args([self.row('img/menu.png')]), worker, inventory)
        self.assertEqual((self.target / 'img/menu.png').read_bytes(), self.updated)
        self.assertEqual(inventory['imageFiles'], 1)

    def test_all_baselines_checked_before_any_image_is_overwritten(self):
        first, second = self.row('img/first.png'), self.row('img/second.png')
        (self.target / second['file']).write_bytes(b'changed since OCR')
        with self.assertRaisesRegex(worker.WorkerError, 'changed since OCR'):
            asset_overlay.apply(self.target, self.args([first, second]), worker, {})
        self.assertEqual((self.target / first['file']).read_bytes(), self.original)
        self.assertEqual((self.target / second['file']).read_bytes(), b'changed since OCR')

    def test_missing_target_does_not_partially_write_earlier_images(self):
        first, second = self.row('img/first.png'), self.row('img/second.png')
        (self.target / second['file']).unlink()
        with self.assertRaisesRegex(worker.WorkerError, 'missing'):
            asset_overlay.apply(self.target, self.args([first, second]), worker, {})
        self.assertEqual((self.target / first['file']).read_bytes(), self.original)

    def test_invalid_baseline_hash_is_rejected(self):
        row = self.row('img/menu.png')
        row['sourceHash'] = 'invalid'
        with self.assertRaisesRegex(worker.WorkerError, 'invalid source baseline'):
            asset_overlay.entries(self.args([row]), worker)

    def test_resource_root_shift_keeps_original_baseline(self):
        row = self.row('data/img/menu.png')
        args = asset_overlay.for_resource_root(self.args([row]), 'data', worker)
        self.assertEqual(args['assetOverlayFiles'][0]['sourceHash'], row['sourceHash'])
        self.assertEqual(args['assetOverlayFiles'][0]['file'], 'img/menu.png')
        asset_overlay.apply(self.target / 'data', args, worker, {})
        self.assertEqual((self.target / row['file']).read_bytes(), self.updated)


if __name__ == '__main__':
    unittest.main()
