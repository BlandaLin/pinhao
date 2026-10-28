"""Native PGMM distribution paths and TTF/bitmap font migration."""
import base64
import hashlib
import json
from pathlib import Path
import tempfile
import struct
import unittest
from unittest import mock
import zlib

import worker
import pgmm_native
from test_worker import font_fixture


def setting(bitmap=False, size=22):
    return {'imageFontFlag': bitmap, 'imageId': 17, 'fontName': 'Original', 'ttfName': 'Original',
            'fontSize': size, 'fixedWidth': True, 'hankakuWidth': 1, 'zenkakuWidth': 2,
            'letterLayout': 'ABC', 'antialiasDisabled': False, 'aliasThreshold': 126}


def project():
    return {'gameInformation': {'title': 'Neutral game', 'mainLanguage': 'ja_JP'},
            'textList': [{'id': 31, 'name': 'greeting', 'folder': False,
                          'text': {'mainLanguage': 'Welcome', 'en_US': 'Welcome'}, 'fontId': 7}],
            'fontList': [{'id': 100, 'folder': True, 'name': 'Fonts', 'children': [
                {'id': 7, 'name': 'Dialogue', 'folder': False, **setting(),
                 'localeSettings': {'ja_JP': setting(size=24), 'en_US': setting(size=20)}},
                {'id': 8, 'name': 'Bitmap', 'folder': False, **setting(True, 10),
                 'localeSettings': {'zh_CN': setting(True, 12)}}]}],
            'sceneList': [], 'objectList': []}


def has_codec():
    try:
        pgmm_native.codec()
        return True
    except ValueError:
        return False


def png(color):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\0' + color)) + chunk(b'IEND', b'')


class PgmmNativeTests(unittest.TestCase):
    def setUp(self):
        parent = worker.ROOT / 'local' / 'native-tests'
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def write(self, root, document=None):
        root.mkdir(parents=True, exist_ok=True)
        worker.json_write(root / 'project.json', document or project())

    def test_default_published_and_source_project_layouts(self):
        for index, relative in enumerate(('.', 'data', 'Resources/data')):
            game = self.root / str(index)
            self.write(game / relative)
            result = pgmm_native.probe(game)
            self.assertEqual(result['engine'], 'Pixel Game Maker MV')
            self.assertEqual(result['root'], relative)
            self.assertEqual(result['support'], pgmm_native.READY)
        game = self.root / 'both'
        self.write(game)
        self.write(game / 'data')
        self.assertEqual(pgmm_native.probe(game)['root'], 'data')

    def test_encrypted_project_requires_real_codec(self):
        game = self.root / 'game'
        (game / 'data').mkdir(parents=True)
        worker.json_write(game / 'data/info.json', {'key': 'EJHv9Lqr3H8ApHDwJ3UqGA=='})
        (game / 'data/project.json').write_bytes(b'enc\0opaque encrypted resource')
        with mock.patch.object(pgmm_native, 'codec', side_effect=pgmm_native.CodecError('missing', 'PGMM Twofish codec is required')):
            result = pgmm_native.probe(game)
        self.assertEqual(result['engine'], 'Pixel Game Maker MV')
        self.assertEqual(result['support'], 'pgmm_encrypted_project_codec_required')
        self.assertNotEqual(result['support'], pgmm_native.READY)
        self.assertEqual(result['diagnostic']['state'], 'missing')

    def test_native_ttf_and_bitmap_settings_preserve_ids_sizes_and_layout(self):
        data = self.root / 'data'
        original = project()
        self.write(data, original)
        font = self.root / 'font.ttf'
        font_fixture(font)
        inventory = {'warnings': []}
        pgmm_native.install_font(data, font, inventory, worker)
        result = worker.native.read(data / 'project.json')
        self.assertEqual(result['textList'], original['textList'])
        self.assertEqual(result['gameInformation'], original['gameInformation'])
        for before, after in zip(original['fontList'][0]['children'], result['fontList'][0]['children']):
            for field in ('id', 'fontSize', 'imageId', 'letterLayout', 'fixedWidth', 'hankakuWidth', 'zenkakuWidth'):
                self.assertEqual(before[field], after[field])
            self.assertFalse(after['imageFontFlag'])
            self.assertTrue(after['fontName'].startswith('PinHao-'))
            self.assertEqual(after['fontName'], after['ttfName'])
            self.assertTrue((data / 'fonts' / (after['fontName'] + '.ttf')).is_file())
            for locale in before['localeSettings']:
                self.assertEqual(before['localeSettings'][locale]['fontSize'], after['localeSettings'][locale]['fontSize'])
                self.assertFalse(after['localeSettings'][locale]['imageFontFlag'])
        self.assertEqual(inventory['font']['settings'], 5)
        self.assertEqual(inventory['font']['bitmapSettingsConverted'], 2)
        self.assertEqual((data / inventory['font']['file']).read_bytes(), font.read_bytes())

    def test_invalid_font_tree_does_not_mutate_project(self):
        bad = project()
        bad['fontList'][0]['children'][0]['localeSettings'] = []
        self.write(self.root, bad)
        before = (self.root / 'project.json').read_bytes()
        font = self.root / 'font.ttf'
        font_fixture(font)
        with self.assertRaisesRegex(ValueError, 'localeSettings'):
            pgmm_native.install_font(self.root, font, {'warnings': []}, worker)
        self.assertEqual((self.root / 'project.json').read_bytes(), before)

    def test_full_worker_data_layout_roundtrip_and_font(self):
        game = self.root / 'game'
        self.write(game / 'data')
        (game / 'Game.exe').write_bytes(b'neutral launcher fixture')
        before = (game / 'data/project.json').read_bytes()
        work, built, output = self.root / 'work', self.root / 'built', self.root / 'output'
        extracted = worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
        self.assertEqual(extracted['engine'], pgmm_native.ENGINE)
        self.assertTrue(worker.roundtrip({'workspaceDir': str(work)})['byteIdentical'])
        row = next(row for row in extracted['units'] if row['source'] == 'Welcome')
        worker.build({'workspaceDir': str(work), 'outputDir': str(built), 'translations': [
            {'id': row['id'], 'translation': 'Hello'}]})
        font = self.root / 'font.ttf'
        font_fixture(font)
        assembled = worker.assemble({'gameDir': str(game), 'workspaceDir': str(work), 'buildDir': str(built),
                                     'outputDir': str(output), 'fontPath': str(font)})
        result = worker.native.read(output / 'data/project.json')
        self.assertIn('Hello', result['textList'][0]['text'].values())
        self.assertFalse(result['fontList'][0]['children'][1]['imageFontFlag'])
        self.assertEqual(assembled['launchPath'], str(output / 'Game.exe'))
        self.assertEqual((game / 'data/project.json').read_bytes(), before)

    @unittest.skipUnless(has_codec(), 'Optional matching PGMM codec is not installed')
    def test_public_twofish_and_resource_key_vectors(self):
        import importlib
        native = importlib.import_module('_pinhao_pgmdec._minicrypto')
        self.assertEqual(native.Twofish(bytes(16)).encrypt(bytes(16)).hex(), '9f589f5cf6122c32b6bfec2f2ae8c35a')
        encrypted_key = base64.b64decode('EJHv9Lqr3H8ApHDwJ3UqGA==')
        key = pgmm_native.codec().decrypt_key(encrypted_key)
        self.assertEqual(key, b'PGMMV TEST KEY\0\0')
        for key in (key, b'', b'short'):
            for size in (0, 1, 15, 16, 17, 257):
                raw = bytes(range(256)) * (size // 256) + bytes(range(size % 256))
                self.assertEqual(pgmm_native.decrypt_resource(pgmm_native.encrypt_resource(raw, key), key), raw)
        for bad in (b'enc', b'enc\x20' + bytes(32), b'enc\x01bad'):
            with self.assertRaisesRegex(ValueError, 'header or block length'):
                pgmm_native.decrypt_resource(bad, key)

    @unittest.skipUnless(has_codec(), 'Optional matching PGMM codec is not installed')
    def test_encrypted_project_full_worker_font_and_image_overlay(self):
        game = self.root / 'encrypted-game'
        data = game / 'data'
        (data / 'img').mkdir(parents=True)
        info = {'title': 'Neutral game', 'key': 'EJHv9Lqr3H8ApHDwJ3UqGA=='}
        worker.json_write(data / 'info.json', info)
        key = pgmm_native.resource_key(data)
        raw = worker.native.serialized(project())
        (data / 'project.json').write_bytes(pgmm_native.encrypt_resource(raw, key))
        image, replacement = png(b'\x00\x00\x00\xff'), png(b'\xff\x00\x00\xff')
        (data / 'img/panel.png').write_bytes(pgmm_native.encrypt_resource(image, key))
        (data / 'words.txt').write_bytes(pgmm_native.encrypt_resource(b'encounter plaintext asset', key))
        (game / 'Game.exe').write_bytes(b'neutral launcher fixture')
        original = {path.relative_to(game).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                    for path in game.rglob('*') if path.is_file()}
        detected = worker.probe({'gameDir': str(game)})
        self.assertEqual(detected['support'], pgmm_native.READY)
        work, built, output = self.root / 'work', self.root / 'built', self.root / 'output'
        extracted = worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
        self.assertTrue(worker.roundtrip({'workspaceDir': str(work)})['byteIdentical'])
        rows = [row for row in extracted['units'] if row['source'] == 'Welcome']
        worker.build({'workspaceDir': str(work), 'outputDir': str(built), 'translations': [
            {'id': row['id'], 'translation': '\u6b22\u8fce'} for row in rows]})
        font = self.root / 'font.ttf'
        font_fixture(font)
        overlays = self.root / 'overlays'
        (overlays / 'data/img').mkdir(parents=True)
        (overlays / 'data/img/panel.png').write_bytes(replacement)
        assembled = worker.assemble({'gameDir': str(game), 'workspaceDir': str(work), 'buildDir': str(built),
                                     'outputDir': str(output), 'fontPath': str(font),
                                     'assetOverlayDir': str(overlays),
                                     'assetOverlayFiles': [{'file': 'data/img/panel.png',
                                                            'sha256': hashlib.sha256(replacement).hexdigest(),
                                                            'sourceHash': hashlib.sha256(image).hexdigest()}]})
        result = core_json = json.loads(pgmm_native.decrypt_resource((output / 'data/project.json').read_bytes(), key))
        self.assertEqual(set(result['textList'][0]['text'].values()), {'\u6b22\u8fce'})
        self.assertFalse(result['fontList'][0]['children'][1]['imageFontFlag'])
        self.assertEqual(pgmm_native.decrypt_resource((output / 'data/img/panel.png').read_bytes(), key), replacement)
        self.assertEqual(pgmm_native.decrypt_resource((output / 'data/words.txt').read_bytes(), key), b'encounter plaintext asset')
        self.assertEqual(assembled['encryptedResources'], 3)
        self.assertEqual(assembled['imageFiles'], 1)
        self.assertTrue((output / 'data/pinhao-localization/pgmm-codec-LICENSE.txt').is_file())
        self.assertFalse(any(output.rglob('*.pyd')))
        after = {path.relative_to(game).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                 for path in game.rglob('*') if path.is_file()}
        self.assertEqual(original, after)


if __name__ == '__main__':
    unittest.main()
