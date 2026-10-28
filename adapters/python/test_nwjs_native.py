"""Container invariants supplement, not replace, real NW.js game acceptance."""
import hashlib
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest import mock
import zipfile

import worker
import nwjs_native
from test_worker import font_fixture


def fixture(directory):
    directory.mkdir()
    executable = directory / 'unrelated-title.exe'
    prefix = bytearray(4096)
    prefix[:2] = b'MZ'
    struct.pack_into('<I', prefix, 60, 128)
    prefix[128:132] = b'PE\0\0'
    executable.write_bytes(prefix)
    with zipfile.ZipFile(executable, 'a', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('package.json', json.dumps({'name': 'neutral', 'main': 'app://./index.html'}))
        archive.writestr('index.html', '<html><head></head><body></body></html>')
        archive.writestr('tyrano/tyrano.js', '/* neutral runtime marker */')
        archive.writestr('data/scenario/first.ks', '*start\nWelcome to the observatory.[p]\n')
        archive.writestr('data/bgimage/sky.png', b'neutral-media' * 10000)
        archive.writestr('node_modules/' * 30 + 'runtime.js', 'module.exports = {};')
    return executable


class NwjsNativeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.game = self.root / 'original'
        self.executable = fixture(self.game)
        self.before = self.executable.read_bytes()

    def tearDown(self):
        self.temporary.cleanup()

    def test_probe_requires_structure_not_game_filename(self):
        info = nwjs_native.probe(self.game)
        self.assertEqual(info['archiveFormat'], 'nwjs-zip')
        self.assertEqual(info['entryPoint'], 'index.html')
        self.assertEqual(worker.probe({'gameDir': str(self.game)})['engine'], 'TyranoScript')
        other = self.root / 'other'
        other.mkdir()
        (other / 'unrelated.exe').write_bytes(self.before[:4096])
        with zipfile.ZipFile(other / 'unrelated.exe', 'a') as archive:
            archive.writestr('package.json', '{"main":"index.html"}')
            archive.writestr('index.html', 'ordinary NW.js application')
        self.assertIsNone(nwjs_native.probe(other))

    def test_unpack_materializes_text_not_media(self):
        info = nwjs_native.probe(self.game)
        source = self.root / 'native-source'
        layout = nwjs_native.unpack(self.game, source, info, worker)
        self.assertTrue((source / 'data/scenario/first.ks').is_file())
        self.assertFalse((source / 'data/bgimage/sky.png').exists())
        self.assertFalse((source / 'node_modules').exists())
        self.assertTrue(any(row['file'] == 'data/bgimage/sky.png' for row in layout['members']))
        self.assertEqual(self.executable.read_bytes(), self.before)

    def test_repack_nochange_is_byte_identical(self):
        source = self.root / 'source'
        layout = nwjs_native.unpack(self.game, source, nwjs_native.probe(self.game), worker)
        output = self.root / 'unchanged.exe'
        result = nwjs_native.repack(self.executable, output, source, layout, worker)
        self.assertEqual(result['changedMembers'], 0)
        self.assertEqual(output.read_bytes(), self.before)

    def test_final_package_space_checked_before_copy(self):
        source = self.root / 'source'
        layout = nwjs_native.unpack(self.game, source, nwjs_native.probe(self.game), worker)
        output = self.root / 'not-created.exe'
        with mock.patch.object(worker, 'require_copy_space', side_effect=worker.WorkerError('DISK_SPACE', 'insufficient space')):
            with self.assertRaisesRegex(worker.WorkerError, 'insufficient space'):
                nwjs_native.repack(self.executable, output, source, layout, worker)
        self.assertFalse(output.exists())
        self.assertEqual(self.executable.read_bytes(), self.before)

    def test_repack_changes_only_selected_members_and_keeps_compressed_media(self):
        source = self.root / 'source'
        layout = nwjs_native.unpack(self.game, source, nwjs_native.probe(self.game), worker)
        (source / 'data/scenario/first.ks').write_text('*start\n你好。[p]\n', encoding='utf-8', newline='\n')
        (source / 'new.txt').write_text('new member', encoding='utf-8')
        output = self.root / 'modified.exe'
        result = nwjs_native.repack(self.executable, output, source, layout, worker)
        self.assertEqual(result['changedMembers'], 2)
        with zipfile.ZipFile(output) as archive:
            self.assertEqual(archive.read('data/scenario/first.ks').decode('utf-8'), '*start\n你好。[p]\n')
            self.assertEqual(archive.read('data/bgimage/sky.png'), b'neutral-media' * 10000)
            self.assertEqual(len(archive.namelist()), len(set(archive.namelist())))
            item = archive.getinfo('data/bgimage/sky.png')
        size = 30 + len(item.filename.encode('utf-8')) + len(item.extra) + item.compress_size
        self.assertEqual(output.read_bytes()[item.header_offset:item.header_offset + size],
                         self.before[item.header_offset:item.header_offset + size])
        self.assertEqual(output.read_bytes()[:layout['zipOffset']], self.before[:layout['zipOffset']])
        self.assertEqual(self.executable.read_bytes(), self.before)

    def test_full_worker_native_roundtrip_and_chinese_assembly(self):
        work, built, product = (self.root / name for name in ('workbench', 'built', 'product'))
        result = worker.extract({'gameDir': str(self.game), 'workspaceDir': str(work)})
        self.assertEqual(result['engine'], 'TyranoScript')
        check = worker.roundtrip({'workspaceDir': str(work)})
        self.assertTrue(check['byteIdentical'])
        manifest, sheets = worker.native.load_work(work)
        sheet = next(iter(sheets.values()))
        worker.build({'workspaceDir': str(work), 'outputDir': str(built),
                      'translations': [{'id': sheet['units'][0]['id'], 'translation':
                                        sheet['units'][0]['source'].replace('Welcome to the observatory.', '欢迎来到天文台。')}]})
        font = self.root / 'font.ttf'
        font_fixture(font)
        assembly = worker.assemble({'gameDir': str(self.game), 'workspaceDir': str(work), 'buildDir': str(built),
                                    'outputDir': str(product), 'fontPath': str(font), 'share': False})
        self.assertTrue(assembly['nwjsPackage']['prefixPreserved'])
        with zipfile.ZipFile(product / self.executable.name) as archive:
            self.assertIn('欢迎来到天文台。', archive.read('data/scenario/first.ks').decode('utf-8'))
            self.assertIn('pinhao-font.css', archive.read('index.html').decode('utf-8'))
            self.assertTrue(archive.read('data/others/PinHaoChinese.ttf'))
        self.assertEqual(hashlib.sha256(self.executable.read_bytes()).digest(), hashlib.sha256(self.before).digest())

    def test_unsafe_archive_member_rejected(self):
        with zipfile.ZipFile(self.executable, 'a') as archive:
            archive.writestr('../outside.ks', 'not allowed')
        with self.assertRaisesRegex(ValueError, 'Unsafe resource path'):
            nwjs_native.probe(self.game)


if __name__ == '__main__':
    unittest.main()
