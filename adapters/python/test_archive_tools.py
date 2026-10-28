from pathlib import Path
import tempfile
import unittest
import zipfile

import worker
import archive_tools
import godot_native
import xp3_archive
from test_godot_native import simple_pack
from test_source_worker import asar


class ArchiveToolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        (self.source / 'Data').mkdir()
        (self.source / 'Data/text.json').write_text('{"text":"A bright morning"}', encoding='utf-8')
        (self.source / 'texture.bin').write_bytes(bytes(range(256)) * 1025)

    def tearDown(self):
        self.temp.cleanup()

    def test_complete_member_roundtrip_and_idempotent_retries(self):
        for kind in ('zip', 'xp3', 'rgss'):
            with self.subTest(kind=kind):
                archive = self.root / ('game.' + ('rgssad' if kind == 'rgss' else kind))
                args = {'inputDir': str(self.source), 'outputFile': str(archive), 'format': kind}
                packed = archive_tools.repack(args, worker)
                self.assertTrue(packed['memberReadback'])
                self.assertTrue(archive_tools.repack(args, worker)['reused'])
                output = self.root / (kind + '-members')
                unpacked = archive_tools.unpack({'archive': str(archive), 'outputDir': str(output)}, worker)
                self.assertEqual(unpacked['members'], archive_tools.inventory(self.source, worker))
                self.assertTrue(archive_tools.unpack({'archive': str(archive), 'outputDir': str(output)}, worker)['reused'])
                (output / 'Data/text.json').write_text('tampered', encoding='utf-8')
                with self.assertRaisesRegex(worker.WorkerError, 'output changed'):
                    archive_tools.unpack({'archive': str(archive), 'outputDir': str(output)}, worker)

    def test_overlay_repack_preserves_absent_original_members(self):
        original = self.root / 'original.zip'
        archive_tools.repack({'inputDir': str(self.source), 'outputFile': str(original)}, worker)
        overlay = self.root / 'overlay'
        (overlay / 'Data').mkdir(parents=True)
        (overlay / 'Data/text.json').write_text('{"text":"崭新的清晨"}', encoding='utf-8')
        output = self.root / 'translated.zip'
        result = archive_tools.repack({'inputDir': str(overlay), 'outputFile': str(output), 'originalArchive': str(original)}, worker)
        self.assertEqual(len(result['members']), 2)
        with zipfile.ZipFile(output) as archive:
            self.assertEqual(archive.read('texture.bin'), (self.source / 'texture.bin').read_bytes())
            self.assertIn('崭新的清晨', archive.read('Data/text.json').decode('utf-8'))

    def test_pck_unpack_preserves_raw_members(self):
        archive = self.root / 'original.pck'
        resources = {'content/dialogue.json': b'{"text":"Welcome"}', 'asset.bin': b'opaque'}
        simple_pack(archive, resources)
        result = archive_tools.unpack({'archive': str(archive), 'outputDir': str(self.root / 'pck')}, worker)
        self.assertEqual(result['files'], 2)
        self.assertEqual({row['path'] for row in result['members']}, set(resources))

    def test_xp3_preserves_non_materializable_members_and_verifies_every_payload(self):
        original = self.root / 'opaque.xp3'
        long_name = 'notes/' + 'x' * 260 + '.txt'
        source_text = self.source / 'Data/text.json'
        xp3_archive.pack(original, [('Data/text.json', source_text),
                                    ('image/desktop.ini', self.source / 'texture.bin'),
                                    (long_name, self.source / 'texture.bin')])
        output = self.root / 'opaque-members'
        args = {'archive': str(original), 'outputDir': str(output)}
        result = archive_tools.unpack(args, worker)
        self.assertEqual(result['files'], 2)
        self.assertEqual(result['archiveMembers'], 3)
        self.assertFalse(result['completeFilesystemView'])
        self.assertEqual([row['path'] for row in result['opaqueMembers']], [long_name])
        self.assertTrue(archive_tools.unpack(args, worker)['reused'])
        empty = self.root / 'empty'
        empty.mkdir()
        no_op = self.root / 'no-op.xp3'
        archive_tools.repack({'inputDir': str(empty), 'outputFile': str(no_op), 'originalArchive': str(original)}, worker)
        self.assertEqual(no_op.read_bytes(), original.read_bytes())
        # An overlay may add a new member without dropping original opaque payloads.
        overlay = self.root / 'xp3-overlay'
        (overlay / 'Data').mkdir(parents=True)
        (overlay / 'Data/text.json').write_text('{"text":"一段更长的中文对白"}', encoding='utf-8')
        (overlay / 'new.txt').write_text('added', encoding='utf-8')
        rebuilt = self.root / 'opaque-built.xp3'
        result = archive_tools.repack({'inputDir': str(overlay), 'outputFile': str(rebuilt), 'originalArchive': str(original)}, worker)
        self.assertTrue(result['memberReadback'])
        before = {row['path']: row for row in xp3_archive.member_inventory(original)}
        after = {row['path']: row for row in xp3_archive.member_inventory(rebuilt)}
        self.assertEqual(set(after), {*before, 'new.txt'})
        self.assertEqual(after[long_name], before[long_name])
        self.assertEqual(after['image/desktop.ini'], before['image/desktop.ini'])
        self.assertNotEqual(after['Data/text.json'], before['Data/text.json'])

    def test_selected_members_do_not_expand_unrelated_media(self):
        for kind in ('zip', 'xp3', 'rgss', 'pck'):
            with self.subTest(kind=kind):
                archive = self.root / ('selected.' + ('rgssad' if kind == 'rgss' else kind))
                if kind == 'pck':
                    simple_pack(archive, {'Data/text.json': b'{"text":"Caption"}', 'media.bin': b'not selected'})
                else:
                    archive_tools.repack({'inputDir': str(self.source), 'outputFile': str(archive), 'format': kind}, worker)
                output = self.root / ('selected-' + kind)
                args = {'archive': str(archive), 'outputDir': str(output), 'format': kind, 'files': ['Data/text.json']}
                result = archive_tools.unpack(args, worker)
                self.assertEqual(result['files'], 1)
                self.assertEqual([row['path'] for row in result['members']], ['Data/text.json'])
                self.assertFalse((output / 'texture.bin').exists())
                self.assertFalse((output / 'media.bin').exists())
                self.assertTrue(archive_tools.unpack(args, worker)['reused'])
                with self.assertRaises((ValueError, worker.WorkerError)):
                    archive_tools.unpack({**args, 'outputDir': str(self.root / ('missing-' + kind)), 'files': ['missing.txt']}, worker)

    def test_asar_selected_members_use_actual_index_without_expanding_media(self):
        archive = self.root / 'app.asar'
        asar(archive, {'data/story.json': b'{"text":"Actual caption"}', 'media.bin': b'not selected'})
        output = self.root / 'selected-asar'
        args = {'archive': str(archive), 'outputDir': str(output), 'format': 'asar', 'files': ['data/story.json']}
        result = archive_tools.unpack(args, worker)
        self.assertEqual(result['files'], 1)
        self.assertFalse((output / 'media.bin').exists())
        self.assertTrue(archive_tools.unpack(args, worker)['reused'])

    def test_pck_repack_uses_fixed_native_codec_and_complete_readback(self):
        if godot_native.executable(worker.ROOT) is None:
            self.skipTest('Prepare the fixed Godot codec')
        original = self.root / 'reference.pck'
        simple_pack(original, {'content/first.json': b'{"text":"Hello"}', 'asset.bin': b'preserved asset'})
        overlay = self.root / 'pck-overlay'
        (overlay / 'content').mkdir(parents=True)
        (overlay / 'content/first.json').write_text('{"text":"一段更长的中文文字"}', encoding='utf-8')
        result = archive_tools.repack({'inputDir': str(overlay), 'outputFile': str(self.root / 'built.pck'),
                                       'originalArchive': str(original)}, worker)
        self.assertEqual({row['path'] for row in result['members']}, {'content/first.json', 'asset.bin'})
        self.assertTrue(result['memberReadback'])

    def test_unsafe_archive_fails_before_output_publication(self):
        archive = self.root / 'invalid.zip'
        with zipfile.ZipFile(archive, 'w') as stream:
            stream.writestr('../escape', 'bad')
        output = self.root / 'unsafe'
        with self.assertRaises(ValueError):
            archive_tools.unpack({'archive': str(archive), 'outputDir': str(output)}, worker)
        self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
