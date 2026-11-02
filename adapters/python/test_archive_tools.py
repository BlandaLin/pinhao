from pathlib import Path
import json
import shutil
import struct
import tempfile
import unittest
from unittest import mock
import zipfile

import worker
import archive_tools
import godot_native
import xp3_archive
from native_attempt import filesystem_path
from test_godot_native import simple_pack
from test_source_worker import asar
from test_rpgmaker import archive_v3


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
        shutil.rmtree(filesystem_path(self.root))
        self.temp.cleanup()

    def deep_root(self):
        root = self.root / 'project-jobs'
        while len(str(root)) < 290:
            root /= 'workspace-segment-' * 3
        filesystem_path(root).mkdir(parents=True)
        return root

    def test_deep_archive_roundtrip_preserves_hashes_receipts_and_cleanup(self):
        root = self.deep_root()
        source = root / 'source'
        shutil.copytree(filesystem_path(self.source), filesystem_path(source))
        baseline = archive_tools.inventory(self.source, worker)
        for kind in ('zip', 'xp3', 'rgss'):
            with self.subTest(kind=kind):
                archive = root / 'repacked' / ('game.' + ('rgssad' if kind == 'rgss' else kind))
                args = {'inputDir': str(source), 'outputFile': str(archive), 'format': kind}
                packed = archive_tools.repack(args, worker)
                self.assertEqual(packed['outputFile'], str(archive))
                self.assertEqual(packed['members'], baseline)
                self.assertTrue(packed['memberReadback'])
                self.assertTrue(archive_tools.repack(args, worker)['reused'])
                output = root / 'native-archives' / (kind + '-members')
                unpack_args = {'archive': str(archive), 'outputDir': str(output)}
                unpacked = archive_tools.unpack(unpack_args, worker)
                self.assertEqual(unpacked['outputDir'], str(output))
                self.assertEqual(unpacked['members'], baseline)
                self.assertTrue(archive_tools.unpack(unpack_args, worker)['reused'])
                selected = root / 'native-archives' / (kind + '-selected')
                chosen = archive_tools.unpack({'archive': str(archive), 'outputDir': str(selected),
                                                'files': ['Data/text.json']}, worker)
                self.assertEqual(chosen['members'], [row for row in baseline if row['path'] == 'Data/text.json'])
                receipt = json.loads(filesystem_path(archive_tools.receipt_path(output)).read_text(encoding='utf-8'))
                self.assertEqual(receipt['result']['outputDir'], str(output))
                filesystem_path(output / 'Data/text.json').write_bytes(b'tampered')
                with self.assertRaisesRegex(worker.WorkerError, 'output changed'):
                    archive_tools.unpack(unpack_args, worker)
        self.assertEqual(archive_tools.inventory(source, worker), baseline)
        for parent in (root / 'repacked', root / 'native-archives'):
            self.assertFalse(any(path.name.startswith('.pinhao-') for path in filesystem_path(parent).iterdir()))

    def test_deep_overlay_repack_retains_original_members(self):
        root = self.deep_root()
        overlay = root / 'overlay'
        filesystem_path(overlay / 'Data').mkdir(parents=True)
        filesystem_path(overlay / 'Data/text.json').write_bytes(b'{"text":"Changed caption"}')
        for kind in ('zip', 'xp3', 'rgss'):
            with self.subTest(kind=kind):
                original = self.root / ('original.' + kind)
                archive_tools.repack({'inputDir': str(self.source), 'outputFile': str(original), 'format': kind}, worker)
                before = worker.digest_file(original)
                archive = root / 'packages' / ('changed.' + kind)
                result = archive_tools.repack({'inputDir': str(overlay), 'outputFile': str(archive),
                                                'originalArchive': str(original), 'format': kind}, worker)
                expected = {row['path']: row for row in archive_tools.inventory(self.source, worker)}
                expected.update({row['path']: row for row in archive_tools.inventory(overlay, worker)})
                self.assertEqual({row['path']: row for row in result['members']}, expected)
                output = root / 'native-archives' / kind
                unpacked = archive_tools.unpack({'archive': str(archive), 'outputDir': str(output), 'format': kind}, worker)
                self.assertEqual({row['path']: row for row in unpacked['members']}, expected)
                self.assertEqual(worker.digest_file(original), before)

    def test_deep_pck_and_asar_selected_unpack(self):
        root = self.deep_root()
        resources = {'data/story.json': b'{"text":"Caption"}', 'media.bin': b'untouched'}
        for kind, pack in (('pck', simple_pack), ('asar', asar)):
            with self.subTest(kind=kind):
                archive = root / ('original.' + kind)
                pack(filesystem_path(archive), resources)
                output = root / ('selected-' + kind)
                result = archive_tools.unpack({'archive': str(archive), 'outputDir': str(output),
                                                'files': ['data/story.json']}, worker)
                self.assertEqual(result['outputDir'], str(output))
                self.assertEqual([row['path'] for row in result['members']], ['data/story.json'])
                self.assertEqual(filesystem_path(output / 'data/story.json').read_bytes(), resources['data/story.json'])
                self.assertFalse(filesystem_path(output / 'media.bin').exists())

    def test_deep_worker_zip_and_unzip_preserve_members_and_conflicts(self):
        root = self.deep_root()
        source = root / 'source'
        shutil.copytree(filesystem_path(self.source), filesystem_path(source))
        with self.assertRaises(worker.WorkerError) as error:
            worker.zip_command({'sourceDir': str(source), 'filePath': str(source / 'nested.zip')})
        self.assertEqual(error.exception.code, 'OUTPUT_OVERLAP')
        with self.assertRaises(worker.WorkerError) as error:
            archive_tools.repack({'inputDir': str(source), 'outputFile': str(source / 'nested.zip')}, worker)
        self.assertEqual(error.exception.code, 'OUTPUT_OVERLAP')
        archive = root / 'packages' / 'game.zip'
        packed = worker.zip_command({'sourceDir': str(source), 'filePath': str(archive)})
        self.assertEqual(packed['filePath'], str(archive))
        self.assertEqual(packed['sha256'], worker.digest_file(archive))
        output = root / 'unpacked' / 'members'
        result = worker.unzip_command({'filePath': str(archive), 'outputDir': str(output)})
        self.assertEqual(result['outputDir'], str(output))
        self.assertEqual(archive_tools.inventory(source, worker), archive_tools.inventory(output, worker))
        with self.assertRaises(worker.WorkerError):
            worker.zip_command({'sourceDir': str(source), 'filePath': str(archive)})
        with self.assertRaises(worker.WorkerError):
            worker.unzip_command({'filePath': str(archive), 'outputDir': str(output)})

    def test_deep_unpack_failure_retains_safety_and_removes_temporary_root(self):
        root = self.deep_root()
        archive = self.root / 'unsafe-deep.zip'
        with zipfile.ZipFile(archive, 'w') as stream:
            stream.writestr('../escape', 'bad')
        output = root / 'members'
        with self.assertRaises(ValueError):
            archive_tools.unpack({'archive': str(archive), 'outputDir': str(output)}, worker)
        self.assertFalse(filesystem_path(output).exists())
        self.assertFalse(filesystem_path(root / 'escape').exists())
        self.assertEqual(list(filesystem_path(root).iterdir()), [])
        with self.assertRaises(worker.WorkerError):
            archive_tools.repack({'inputDir': str(self.source), 'outputFile': str(root / 'rejected.unknown')}, worker)
        self.assertEqual(list(filesystem_path(root).iterdir()), [])

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

    def test_index_only_reports_directory_and_real_capabilities_without_extracting(self):
        for kind in ('zip', 'xp3', 'rgss', 'pck', 'asar'):
            with self.subTest(kind=kind):
                archive = self.root / ('index.' + ('rgssad' if kind == 'rgss' else kind))
                if kind == 'pck':
                    simple_pack(archive, {'Data/text.json': b'caption', 'media.bin': b'media'})
                elif kind == 'asar':
                    asar(archive, {'Data/text.json': b'caption', 'media.bin': b'media'})
                else:
                    archive_tools.repack({'inputDir': str(self.source), 'outputFile': str(archive), 'format': kind}, worker)
                before = worker.digest_file(archive)
                with mock.patch.object(archive_tools, 'unpack_to', side_effect=AssertionError('index expanded payloads')):
                    result = archive_tools.unpack({'archive': str(archive), 'indexOnly': True}, worker)
                self.assertEqual(result['archiveHash'], before)
                self.assertEqual(result['archiveMembers'], 2)
                self.assertEqual(result['filesMaterialized'], 0)
                self.assertFalse(result['memberPayloadsDecoded'])
                self.assertNotIn('outputDir', result)
                self.assertEqual(result['capabilities']['repack'], kind != 'asar')
                self.assertEqual(result['capabilities']['outputMode'], 'members-only' if kind == 'asar' else 'archive')
                self.assertEqual(worker.digest_file(archive), before)

    def test_partial_view_requires_matching_original_and_retains_every_unselected_member(self):
        for kind in ('zip', 'xp3', 'rgss'):
            with self.subTest(kind=kind):
                original = self.root / ('partial.' + ('rgssad' if kind == 'rgss' else kind))
                archive_tools.repack({'inputDir': str(self.source), 'outputFile': str(original), 'format': kind}, worker)
                output = self.root / ('view-' + kind)
                view = archive_tools.unpack({'archive': str(original), 'outputDir': str(output), 'files': ['Data/text.json']}, worker)
                self.assertFalse(view['completeFilesystemView'])
                self.assertEqual(view['unselectedMembers'], 1)
                self.assertEqual(view['selectedFiles'], ['Data/text.json'])
                (output / 'Data/text.json').write_text('{"text":"A changed caption"}', encoding='utf-8')
                args = {'inputDir': str(output), 'outputFile': str(self.root / ('output.' + kind)), 'format': kind}
                with self.assertRaises(worker.WorkerError) as error:
                    archive_tools.repack(args, worker)
                self.assertEqual(error.exception.code, 'REPACK_REFERENCE')
                unrelated = self.root / ('unrelated.' + kind)
                unrelated.write_bytes(b'not the original')
                with self.assertRaises(worker.WorkerError) as error:
                    archive_tools.repack({**args, 'originalArchive': str(unrelated)}, worker)
                self.assertEqual(error.exception.code, 'SOURCE_CHANGED')
                packed = archive_tools.repack({**args, 'originalArchive': str(original)}, worker)
                self.assertTrue(packed['memberReadback'])
                self.assertEqual(packed['files'], 2)
                final = self.root / ('final-' + kind)
                archive_tools.unpack({'archive': args['outputFile'], 'outputDir': str(final), 'format': kind}, worker)
                self.assertEqual((final / 'texture.bin').read_bytes(), (self.source / 'texture.bin').read_bytes())
                self.assertIn('changed caption', (final / 'Data/text.json').read_text(encoding='utf-8'))

    def test_same_output_cannot_reuse_a_different_selection(self):
        archive = self.root / 'choice.zip'
        archive_tools.repack({'inputDir': str(self.source), 'outputFile': str(archive)}, worker)
        args = {'archive': str(archive), 'outputDir': str(self.root / 'choice'), 'files': ['Data/text.json']}
        archive_tools.unpack(args, worker)
        with self.assertRaises(worker.WorkerError) as error:
            archive_tools.unpack({**args, 'files': ['texture.bin']}, worker)
        self.assertEqual(error.exception.code, 'ARTIFACT_CONFLICT')

    def test_asar_index_and_selected_read_ignore_missing_unselected_sidecar(self):
        archive = self.root / 'sidecar.asar'
        body = b'A complete caption.'
        tree = {'files': {'story.txt': {'size': len(body), 'offset': '0'},
                          'outside.bin': {'size': 100, 'unpacked': True}}}
        raw = json.dumps(tree).encode('utf-8')
        padded = raw + b'\0' * (-len(raw) % 4)
        header = struct.pack('<II', len(padded) + 4, len(raw)) + padded
        archive.write_bytes(struct.pack('<II', 4, len(header)) + header + body)
        directory = archive_tools.unpack({'archive': str(archive), 'indexOnly': True}, worker)
        self.assertEqual(directory['archiveMembers'], 2)
        self.assertTrue(next(row for row in directory['members'] if row['path'] == 'outside.bin')['unpacked'])
        output = self.root / 'sidecar-choice'
        selected = archive_tools.unpack({'archive': str(archive), 'outputDir': str(output), 'files': ['story.txt']}, worker)
        self.assertEqual((output / 'story.txt').read_bytes(), body)
        self.assertFalse(selected['completeFilesystemView'])
        with self.assertRaises((OSError, ValueError)):
            archive_tools.unpack({'archive': str(archive), 'outputDir': str(self.root / 'missing-sidecar'), 'files': ['outside.bin']}, worker)

    def test_index_preserves_opaque_member_identity_and_asar_repack_is_explicitly_unsupported(self):
        archive = self.root / 'opaque-index.xp3'
        long_name = 'folder/' + 'x' * 260 + '.txt'
        xp3_archive.pack(archive, [('story.txt', self.source / 'Data/text.json'), (long_name, self.source / 'texture.bin')])
        directory = archive_tools.unpack({'archive': str(archive), 'indexOnly': True}, worker)
        opaque = next(row for row in directory['members'] if row['path'] == long_name)
        self.assertFalse(opaque['materializable'])
        self.assertEqual(opaque['disposition'], 'retained-in-original-archive')
        with self.assertRaises(worker.WorkerError) as error:
            archive_tools.repack({'inputDir': str(self.source), 'outputFile': str(self.root / 'bad.asar')}, worker)
        self.assertEqual(error.exception.code, 'REPACK_UNSUPPORTED')

    def test_rgss3_directory_does_not_claim_original_format_repacking(self):
        archive = self.root / 'Game.rgss3a'
        archive_v3(archive, [('Data/story.txt', b'A complete caption')])
        result = archive_tools.unpack({'archive': str(archive), 'indexOnly': True}, worker)
        self.assertEqual(result['archiveVersion'], 3)
        self.assertTrue(result['capabilities']['select'])
        self.assertFalse(result['capabilities']['repack'])

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
