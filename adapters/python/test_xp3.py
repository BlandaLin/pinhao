"""Standard XP3 reconstruction uses neutral payloads, including PE overlays."""
from pathlib import Path
import os
import struct
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zlib

import worker
import xp3_archive as xp3
import asset_overlay
import kirikiri_native as kag
from test_worker import font_fixture
from test_support import cleanup_temporary


class Xp3Tests(unittest.TestCase):
    def setUp(self):
        parent = worker.ROOT / 'local' / 'native-tests'
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.root = Path(self.temp.name)

    def tearDown(self):
        cleanup_temporary(self.temp)

    def test_unmaterializable_members_are_retained_without_blocking_kag_text(self):
        game = self.root / 'game'
        game.mkdir()
        script = self.root / 'script'
        script.write_text('*start\n[iscript]\nvar key = "Do not translate";\n[endscript]\nHello[p]\n', encoding='utf-16')
        opaque = self.root / 'opaque'
        opaque.write_bytes(b'original archive metadata')
        long_name = 'metadata/' + 'x' * 300 + '.txt'
        xp3.pack(game / 'data.xp3', [('scenario/first.ks', script), (long_name, opaque), ('image/desktop.ini', opaque)])
        work, built, output = self.root / 'work', self.root / 'built', self.root / 'output'
        extraction = worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
        self.assertEqual([row['source'] for row in extraction['units']], ['Hello{{CTRL0001}}'])
        row = extraction['units'][0]
        worker.build({'workspaceDir': str(work), 'outputDir': str(built), 'translations': [{'id': row['id'], 'translation': '你好，欢迎{{CTRL0001}}'}]})
        worker.assemble({'gameDir': str(game), 'workspaceDir': str(work), 'buildDir': str(built), 'outputDir': str(output)})
        _, before = xp3.index(game / 'data.xp3')
        _, after = xp3.index(output / 'data.xp3')
        self.assertEqual({item.name for item in before}, {item.name for item in after})
        original = next(item for item in before if item.name == long_name)
        rebuilt = next(item for item in after if item.name == long_name)
        self.assertEqual((original.size, original.checksum), (rebuilt.size, rebuilt.checksum))
        selected = self.root / 'selected'
        xp3.unpack(output / 'data.xp3', selected, worker, names=['scenario/first.ks'])
        translated = (selected / 'scenario/first.ks').read_text(encoding='utf-16')
        self.assertIn('你好，欢迎[p]', translated)
        self.assertIn('var key = "Do not translate";', translated)

    def test_repack_without_changes_retains_exact_archive_bytes(self):
        original, output = self.root / 'original.xp3', self.root / 'repacked.xp3'
        source = self.root / 'payload'
        source.write_bytes(b'unchanged payload')
        xp3.pack(original, [('payload.txt', source)], prefix=b'MZ' + bytes(30))
        xp3.repack(original, output, {})
        self.assertEqual(original.read_bytes(), output.read_bytes())

    def test_pack_compressed_raw_unicode_empty_multisegment_and_exe(self):
        resources = {'scenario/first.ks': '你好世界'.encode('utf-16'), 'image/raw.bin': bytes(range(256)) * 9000,
                     'empty': b'', '人物/\U0001f600.txt': b'readable'}
        entries = []
        for i, (name, raw) in enumerate(resources.items()):
            path = self.root / str(i)
            path.write_bytes(raw)
            entries.append((name, path))
        for compressed, prefix in ((False, b''), (True, b''), (True, b'MZ' + b'PE-fixture' * 17)):
            archive = self.root / ('data-%s-%d.xp3' % (compressed, len(prefix)))
            result = xp3.pack(archive, entries, prefix, compressed)
            self.assertEqual(result['base'] % 16, 0)
            output = self.root / (archive.stem + '-out')
            xp3.unpack(archive, output, worker)
            self.assertEqual({p.relative_to(output).as_posix(): p.read_bytes() for p in output.rglob('*') if p.is_file()}, resources)

    def test_checksum_corruption_and_member_collision(self):
        source = self.root / 'source'
        source.write_bytes(b'plaintext')
        archive = self.root / 'data.xp3'
        xp3.pack(archive, [('first.ks', source)], compress=False)
        raw = bytearray(archive.read_bytes())
        raw[19] ^= 1
        archive.write_bytes(raw)
        with self.assertRaises(xp3.Xp3Error) as error:
            xp3.unpack(archive, self.root / 'out', worker)
        self.assertEqual(error.exception.code, 'XP3_EXTRACTION_FILTER')
        for entries in ([('../bad.ks', source)], [('first.ks', source), ('FIRST.KS', source)]):
            with self.assertRaises(ValueError):
                xp3.pack(self.root / 'bad.xp3', entries)
        collision = self.root / 'collision.xp3'
        with self.assertRaisesRegex(ValueError, 'file/directory'):
            xp3.pack(collision, [('folder', source), ('folder/child', source)])
        self.assertFalse(collision.exists())
        for index, name in enumerate(('CON.txt', 'folder/bad\0name')):
            unsafe = self.root / ('unsafe-%d.xp3' % index)
            xp3.pack(unsafe, [(name, source)])
            output = self.root / ('unsafe-%d-output' % index)
            with self.assertRaises(ValueError):
                xp3.unpack(unsafe, output, worker)
            self.assertFalse(output.exists())

    def test_empty_native_stream_has_a_zero_length_segment_and_empty_archive(self):
        source = self.root / 'empty'
        source.write_bytes(b'')
        archive = self.root / 'empty-resource.xp3'
        xp3.pack(archive, [('empty.txt', source)])
        _, entries = xp3.index(archive)
        self.assertEqual(len(entries[0].segments), 1)
        self.assertEqual(entries[0].segments[0][2:], (0, 0))
        empty_archive = self.root / 'empty-archive.xp3'
        xp3.pack(empty_archive, [])
        self.assertEqual(xp3.index(empty_archive)[1], [])
        xp3.unpack(empty_archive, self.root / 'empty-output', worker)

    def test_standard_patch_gap_does_not_override_active_resources(self):
        game = self.root / 'game'
        game.mkdir()
        data = self.root / 'base'
        data.write_bytes(b'base')
        init = self.root / 'init'
        init.write_text('for(var i = 2; ; i++) { if(Storages.isExistentStorage(System.exePath + "patch" + i + ".xp3")) use(); else break; }', encoding='utf-8')
        override = self.root / 'override'
        override.write_bytes(b'override')
        xp3.pack(game / 'data.xp3', [('resource.bin', data), ('system/Initialize.tjs', init)])
        xp3.pack(game / 'patch3.xp3', [('resource.bin', override)])
        xp3.pack(game / 'patch1.xp3', [('resource.bin', override)])
        info = {'archives': ['data.xp3', 'patch3.xp3', 'patch1.xp3']}
        staged = self.root / 'staged'
        layouts = kag.prepare(game, staged, info, worker)
        self.assertEqual((staged / 'resource.bin').read_bytes(), b'base')
        self.assertFalse(next(item for item in layouts if item['file'] == 'patch3.xp3')['active'])
        self.assertFalse(next(item for item in layouts if item['file'] == 'patch1.xp3')['active'])
        xp3.pack(game / 'patch2.xp3', [('resource.bin', override)])
        second = self.root / 'staged2'
        layouts = kag.prepare(game, second, {'archives': ['data.xp3', 'patch2.xp3', 'patch3.xp3']}, worker)
        self.assertEqual((second / 'resource.bin').read_bytes(), b'override')
        self.assertTrue(all(item['active'] for item in layouts))
        self.assertLess(kag.priority('scenario.xp3'), kag.priority('image.xp3'))
        self.assertLess(kag.priority('sound.xp3'), kag.priority('bgm.xp3'))

    def test_font_plugin_matches_runtime_machine_and_existing_dll_is_copied(self):
        def pe(path, bits):
            path.parent.mkdir(parents=True, exist_ok=True)
            raw = bytearray(128)
            raw[:2] = b'MZ'
            struct.pack_into('<I', raw, 60, 64)
            raw[64:68] = b'PE\0\0'
            struct.pack_into('<H', raw, 68, 0x14c if bits == 32 else 0x8664)
            path.write_bytes(raw)

        game, staged = self.root / 'game', self.root / 'staged'
        staged.mkdir()
        pe(game / 'Game.exe', 64)
        dependencies = self.root / 'dependencies'
        pe(dependencies / 'local/dependencies/kirikiri/addFont.dll', 32)
        helpers = SimpleNamespace(ROOT=dependencies, font_family=worker.font_family, digest_file=worker.digest_file)
        font = self.root / 'font.ttf'
        font_fixture(font)
        inventory = {'warnings': []}
        with patch.dict(os.environ, {'PINHAO_KAG_ADDFONT': '', 'PINHAO_KAG_ADDFONT64': ''}):
            kag.install_font(staged, font, inventory, helpers, runtime_root=game)
            self.assertNotIn('font', inventory)
            self.assertFalse((staged / 'AfterInit2.tjs').exists())
            self.assertIn('64-bit', inventory['warnings'][0])
            pe(game / 'plugins/addFont.dll', 64)
            second_inventory = {'warnings': []}
            kag.install_font(staged, font, second_inventory, helpers, runtime_root=game)
            kag.install_font(staged, font, {'warnings': []}, helpers, runtime_root=game)
        self.assertEqual(kag.pe_bits(staged / 'pinhao-localization/addFont.dll'), 64)
        self.assertIn('font', second_inventory)
        self.assertIn('pinhao-localization/addFont.dll', (staged / 'AfterInit2.tjs').read_text(encoding='utf-16'))

    def test_dormant_patch_is_rebuilt_from_its_own_resources_and_private_members_removed(self):
        game = self.root / 'game'
        game.mkdir()
        (game / 'Game.exe').write_bytes(b'neutral executable fixture')
        base = self.root / 'base.ks'
        base.write_text('*start\nActive scene[p]\n', encoding='utf-8')
        dormant = self.root / 'dormant.ks'
        dormant.write_text('*unused\nDormant scene[p]\n', encoding='utf-8')
        init = self.root / 'init'
        init.write_text('for(var i = 2; ; i++) { var name = "patch" + i + ".xp3"; }', encoding='utf-8')
        xp3.pack(game / 'data.xp3', [('scenario/first.ks', base), ('system/Initialize.tjs', init)])
        for name in ('patch3.xp3', 'patch4.xp3'):
            xp3.pack(game / name, [('scenario/first.ks', dormant), ('save/file1.sav', dormant)])
        work, built, output = self.root / 'work', self.root / 'built', self.root / 'output'
        extracted = worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
        self.assertIn('Active scene{{CTRL0001}}', [row['source'] for row in extracted['units']])
        self.assertNotIn('Dormant scene{{CTRL0001}}', [row['source'] for row in extracted['units']])
        row = next(row for row in extracted['units'] if row['source'].startswith('Active'))
        worker.build({'workspaceDir': str(work), 'outputDir': str(built), 'translations': [
            {'id': row['id'], 'translation': 'Updated scene{{CTRL0001}}'}]})
        worker.assemble({'gameDir': str(game), 'workspaceDir': str(work), 'buildDir': str(built), 'outputDir': str(output)})
        for index, name in enumerate(('patch3.xp3', 'patch4.xp3')):
            readback = self.root / ('readback-%d' % index)
            xp3.unpack(output / name, readback, worker)
            self.assertEqual((readback / 'scenario/first.ks').read_text(encoding='utf-8'), dormant.read_text(encoding='utf-8'))
            self.assertFalse((readback / 'save').exists())

    def test_kag_archive_pipeline_unicode_without_changing_original(self):
        game = self.root / 'game'
        game.mkdir()
        source = self.root / 'first.ks'
        source.write_bytes('*start\nようこそ[p]\n'.encode('cp932'))
        xp3.pack(game / 'data.xp3', [('scenario/first.ks', source)])
        (game / 'Game.exe').write_bytes(b'neutral runtime marker')
        before = worker.digest_file(game / 'data.xp3')
        work = self.root / 'work'
        report = worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
        row = report['units'][0]
        self.assertTrue(worker.roundtrip({'workspaceDir': str(work)})['byteIdentical'])
        built = self.root / 'built'
        worker.build({'workspaceDir': str(work), 'outputDir': str(built), 'translations': [
            {'id': row['id'], 'translation': '欢迎{{CTRL0001}}'}]})
        output = self.root / 'output'
        result = worker.assemble({'gameDir': str(game), 'workspaceDir': str(work), 'buildDir': str(built), 'outputDir': str(output)})
        self.assertEqual(result['rebuiltArchives'], 1)
        resources = self.root / 'readback'
        xp3.unpack(output / 'data.xp3', resources, worker)
        self.assertIn('欢迎[p]', (resources / 'scenario/first.ks').read_text(encoding='utf-16'))
        self.assertEqual(worker.digest_file(game / 'data.xp3'), before)
        self.assertFalse((output / 'scenario/first.ks').exists())

    def test_image_overlay_is_written_inside_native_archive(self):
        game = self.root / 'game'
        game.mkdir()
        scene, image = self.root / 'first.ks', self.root / 'Menu.png'
        scene.write_text('*start\nWelcome[p]\n', encoding='utf-8')
        image.write_bytes(b'\x89PNG\r\n\x1a\nneutral baseline image payload')
        xp3.pack(game / 'data.xp3', [('first.ks', scene), ('image/Menu.png', image)])
        (game / 'Game.exe').write_bytes(b'neutral executable')
        work, built, output = [self.root / name for name in ('work', 'built', 'output')]
        worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
        worker.build({'workspaceDir': str(work), 'outputDir': str(built)})
        overlay = self.root / 'image-overlay'
        (overlay / 'image').mkdir(parents=True)
        replacement = overlay / 'image/Menu.png'
        replacement.write_bytes(b'\x89PNG\r\n\x1a\nneutral translated image payload')
        text_overlay = self.root / 'text-overlay'
        text_overlay.mkdir()
        text = text_overlay / 'first.ks'
        text.write_text('*start\nSupplemental scene[p]\n', encoding='utf-8')
        sealed = worker.digest_file(built / 'first.ks')
        worker.assemble({'gameDir': str(game), 'workspaceDir': str(work), 'buildDir': str(built), 'outputDir': str(output),
                         'adapterOverlayDir': str(text_overlay),
                         'adapterOverlayFiles': [{'file': 'first.ks', 'sha256': worker.digest_file(text), 'sourceHash': sealed}],
                         'assetOverlayDir': str(overlay), 'assetOverlayFiles': [{'file': 'image/Menu.png', 'sha256': worker.digest_file(replacement)}]})
        resources = self.root / 'readback'
        xp3.unpack(output / 'data.xp3', resources, worker)
        self.assertEqual((resources / 'image/Menu.png').read_bytes(), replacement.read_bytes())
        self.assertEqual((resources / 'first.ks').read_bytes(), text.read_bytes())
        self.assertEqual(worker.digest_file(built / 'first.ks'), sealed)
        self.assertFalse((output / 'image/Menu.png').exists())
        with self.assertRaises(ValueError):
            asset_overlay.entries({'assetOverlayDir': str(overlay), 'assetOverlayFiles': [{'file': '../Menu.png', 'sha256': 'x'}]}, worker)


if __name__ == '__main__':
    unittest.main()
