"""Supplemental native script container invariants; real games are audited separately."""
import hashlib
from pathlib import Path
import tempfile
import unittest
import zlib

import worker
from ruby_marshal import Reader
from test_worker import ruby_game, ruby_value


class RgssScriptTests(unittest.TestCase):
    def test_native_views_and_verified_overlay_keep_other_slots_and_original(self):
        for engine, extension in (('VX', 'rvdata'), ('VX Ace', 'rvdata2'), ('XP', 'rxdata')):
            with self.subTest(engine=engine), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                game = ruby_game(root / 'game', engine)
                carrier = game / 'Data' / ('Scripts.' + extension)
                original = b'\x04\x08' + ruby_value([[1, 'Vocab', zlib.compress(b'module Vocab\n  Buy = "Buy goods"\nend\n')],
                                                    [2, 'Main', zlib.compress(b'run_game()\n')]])
                carrier.write_bytes(original)
                work, built, product = root / 'work', root / 'built', root / 'product'
                extracted = worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
                metadata = worker.native.read(work / 'technical/product-source.json')
                layout = metadata['rgssScriptSources']
                view = Path(layout['root'])
                self.assertFalse(metadata['packed'])
                self.assertIsNone(metadata['nativeSource'])
                self.assertEqual(extracted['additionalSourceRoots'], [str(view)])
                self.assertFalse((view / 'Data').exists())
                selected = layout['scripts'][0]
                original_view = (view / selected['file']).read_bytes()
                overlay = root / 'overlay'
                target = overlay / selected['file']
                target.parent.mkdir(parents=True)
                changed = original_view.replace(b'Buy goods', '购买物品'.encode('utf-8'))
                target.write_bytes(changed)
                worker.build({'workspaceDir': str(work), 'outputDir': str(built)})
                assembled = worker.assemble({'gameDir': str(game), 'workspaceDir': str(work), 'buildDir': str(built),
                    'outputDir': str(product), 'share': False, 'adapterOverlayDir': str(overlay),
                    'adapterOverlayFiles': [{'file': selected['file'], 'sha256': hashlib.sha256(changed).hexdigest(),
                                             'sourceHash': selected['viewSha256']}]})
                rewritten = Reader((product / 'Data' / carrier.name).read_bytes())
                self.assertEqual(zlib.decompress(rewritten.root[0][2].raw), changed)
                self.assertEqual(rewritten.root[1][2].raw, Reader(original).root[1][2].raw)
                self.assertEqual(carrier.read_bytes(), original)
                self.assertEqual((view / selected['file']).read_bytes(), original_view)
                self.assertFalse((product / '__pinhao_rgss__').exists())
                self.assertEqual(assembled['rgssScriptFiles'], 1)

    def test_changed_view_baseline_is_rejected_before_script_write(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            game = ruby_game(root / 'game', 'VX Ace')
            work, built = root / 'work', root / 'built'
            worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
            layout = worker.native.read(work / 'technical/product-source.json')['rgssScriptSources']
            row = layout['scripts'][0]
            original = (Path(layout['root']) / row['file']).read_bytes()
            overlay = root / 'overlay'
            target = overlay / row['file']
            target.parent.mkdir(parents=True)
            target.write_bytes(original)
            (Path(layout['root']) / row['file']).write_bytes(original + b'\n# changed baseline')
            worker.build({'workspaceDir': str(work), 'outputDir': str(built)})
            with self.assertRaisesRegex(worker.WorkerError, 'baseline changed'):
                worker.assemble({'gameDir': str(game), 'workspaceDir': str(work), 'buildDir': str(built),
                    'outputDir': str(root / 'product'), 'share': False, 'adapterOverlayDir': str(overlay),
                    'adapterOverlayFiles': [{'file': row['file'], 'sha256': hashlib.sha256(original).hexdigest(),
                                             'sourceHash': row['viewSha256']}]})


if __name__ == '__main__':
    unittest.main()
