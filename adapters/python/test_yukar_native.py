"""Synthetic container/codec integration tests; no game resources are distributed."""
from __future__ import annotations

import base64
import hashlib
import io
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest import mock
from test_worker import font_fixture
import uuid
import zipfile

import worker
import yukar_archive as archive
import yukar_native as adapter


def string(value):
    raw = value.encode('utf-8')
    length, prefix = len(raw), bytearray()
    while length >= 128:
        prefix.append((length & 127) | 128)
        length >>= 7
    return bytes(prefix) + bytes((length,)) + raw


def resource(kind, ident, name, tail=b''):
    body = uuid.UUID(ident).bytes_le + string(name) + tail
    opaque_data = b'unknown-layout-order-data!'
    opaque = struct.pack('<Ih', len(opaque_data), 99) + opaque_data
    return b'YUKAR\x06\0\0\0\x01\0\x07\0\x06\0\0\0' + struct.pack('<Ih', len(body), kind) + body + opaque


class ContainerTests(unittest.TestCase):
    def test_sgb_both_containers_and_offsets(self):
        entries = [('Hero.sgr', 'visible text'.encode(), None), ('res/icon.png', bytes(range(256)) * 4, None)]
        for kind, header in (('YUKARPKG', b'YUKARPKG'), ('SGBDAT', b'SGBDAT\0\x01')):
            layout = {'kind': kind, 'header': header}
            raw = archive.sgb_write(layout, entries)
            actual_layout, actual = archive.sgb_read(raw)
            self.assertEqual(actual_layout, layout)
            self.assertEqual([(n, b) for n, b, _ in actual], [(n, b) for n, b, _ in entries])
        for key in (archive.KEY1, archive.KEY2):
            for offset in (0, 7, 8, 99):
                raw = bytes(range(256)) * 2
                self.assertEqual(archive.crypt(archive.crypt(raw, key, offset, True), key, offset), raw)

    def test_bakin_zip_and_resource_sections(self):
        entries = [('GameSettings.rbr', b'catalog record', None), ('res/icon.png', bytes(range(256)) * 12, None)]
        for modern in (False, True):
            layout = {'kind': 'BKNPAK', 'modern': modern, 'title': 'Loading...', 'zipped': ['GameSettings.rbr']}
            raw = archive.bakin_write(layout, entries)
            actual_layout, actual = archive.bakin_read(raw)
            self.assertEqual(layout, actual_layout)
            self.assertEqual([(n, b) for n, b, _ in entries], [(n, b) for n, b, _ in actual])
        corrupt = bytearray(raw)
        corrupt[30] ^= 1
        with self.assertRaises(ValueError):
            archive.bakin_read(corrupt)

    def test_container_paths_and_duplicate_records(self):
        for name in ('../game.exe', 'C:/game.exe', '/root/game.exe'):
            with self.assertRaises(ValueError):
                archive.valid_name(name)
        payload = io.BytesIO()
        with zipfile.ZipFile(payload, 'w') as zipfile_out:
            zipfile_out.writestr('Name.txt', b'a')
            zipfile_out.writestr('name.txt', b'b')
        with self.assertRaises(ValueError):
            archive.zip_read(payload.getvalue())


@unittest.skipUnless(os.name == 'nt', 'Native catalog codec uses Windows .NET Framework')
class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pinhao-yukar-')
        self.root = Path(self.temp.name)
        self.game = self.root / 'game'
        self.game.mkdir()
        self.compiler = Path(os.environ.get('WINDIR', r'C:\Windows')) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        if not self.compiler.is_file():
            self.skipTest('Framework compiler unavailable')
        source = Path(__file__).parent / 'fixtures' / 'YukarCatalogFixture.cs'
        result = subprocess.run([str(self.compiler), '/nologo', '/target:library', '/out:' + str(self.game / 'common.dll'), str(source)], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout)

    def tearDown(self):
        self.temp.cleanup()

    def make_game(self, engine):
        suffix = '.sgr' if engine == adapter.ENGINES[0] else '.rbr'
        settings = resource(3, '11111111-1111-1111-1111-111111111111', 'Fixture', string('{0} attacks!'))
        hero = resource(1, '22222222-2222-2222-2222-222222222222', 'Guide', string('A friendly guide.') + struct.pack('<I', 77))
        script = resource(2, '33333333-3333-3333-3333-333333333333', 'INTERNAL_SCRIPT',
                          struct.pack('<II', 2, 0) + string(r'Welcome {0}! \c[1]') + struct.pack('<I', 1) + string('INTERNAL_TARGET'))
        native_layout = resource(4, '44444444-4444-4444-4444-444444444444', 'LayoutTest',
                                 string('Choose a path.') + struct.pack('<f', 420.0))
        png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6/EkAAAAASUVORK5CYII=')
        entries = [('GameSettings' + suffix, settings, None), ('Hero' + suffix, hero, None),
                   ('Layout' + suffix, native_layout, None), ('map/Start' + suffix, script, None), ('res/icon.png', png, None)]
        if engine == adapter.ENGINES[0]:
            layout = {'kind': 'SGBDAT', 'header': b'SGBDAT\0\x01'}
            name = 'data.sgbpack'
            (self.game / 'sgb_rpgplayer.exe').write_bytes(b'MZ-fixture')
        else:
            layout = {'kind': 'BKNPAK', 'modern': True, 'title': 'Loading...', 'zipped': [entry[0] for entry in entries[:-1]]}
            name = 'data.rbpack'
            (self.game / 'Fixture.exe').write_bytes(b'MZ-fixture')
        (self.game / name).write_bytes(adapter.write_archive(layout, entries, engine))
        (self.game / 'save01.sav').write_bytes(b'PRIVATE SAVE')
        return name, entries

    def run_native(self, engine):
        archive_name, original_entries = self.make_game(engine)
        layout, _ = adapter.read_archive((self.game / archive_name).read_bytes(), engine)
        original_text = b'{"text":"Original extra text"}'
        original_entries.insert(-1, ('extra/dialogue.json', original_text, None))
        original_entries[0:0] = [('save/private.json', b'{"personal":"private save"}', None),
                                 ('PinHao-assist-session.json', b'{"token":"neutral-private-session"}', None),
                                 ('img/save/template.bin', b'authored static resource', None),
                                 ('cache/story.bin', b'authored static cache', None)]
        (self.game / archive_name).write_bytes(adapter.write_archive(layout, original_entries, engine))
        original_files = {path.name: path.read_bytes() for path in self.game.iterdir()}
        work = self.root / 'work'
        result = adapter.extract(self.game, work, adapter.probe(self.game), worker, {})
        self.assertTrue(result['units'])
        self.assertTrue(any(unit['source'] == 'A friendly guide.' for unit in result['units']))
        self.assertFalse(any(unit['source'] in ('R_itemhook', '#cam_default', 'a.hp + b.hp') for unit in result['units']))
        self.assertEqual(len(result['images']), 1)
        self.assertFalse(any('INTERNAL' in unit['source'] for unit in result['units']))
        manifest, sheets = worker.native.load_work(work)
        for name, sheet in sheets.items():
            for unit in sheet['units']:
                if unit['source'] == 'Guide':
                    unit['translation'] = '向导'
            worker.json_write(work / 'editable' / name, sheet)
        built = self.root / 'built'
        adapter.build(work, work / 'editable', built, worker)
        overlay = self.root / 'image-overlays'
        overlay_file = overlay / 'res/icon.png'
        overlay_file.parent.mkdir(parents=True)
        overlay_file.write_bytes(original_entries[-1][1] + b'PNG-metadata')
        text_overlay = self.root / 'text-overlays'
        text_file = text_overlay / 'extra/dialogue.json'
        text_file.parent.mkdir(parents=True)
        text_file.write_bytes(b'{"text":"Supplemental extra text"}')
        args = {'gameDir': str(self.game), 'workspaceDir': str(work), 'buildDir': str(built),
                'outputDir': str(self.root / 'output'), 'assetOverlayDir': str(overlay),
                'adapterOverlayDir': str(text_overlay),
                'adapterOverlayFiles': [{'file':'extra/dialogue.json', 'sha256':worker.digest_file(text_file),
                                         'sourceHash':hashlib.sha256(original_text).hexdigest()}],
                'assetOverlayFiles': [{'file': 'res/icon.png', 'sha256': worker.digest_file(overlay_file),
                                       'sourceHash': hashlib.sha256(original_entries[-1][1]).hexdigest()}]}
        report = adapter.assemble(args, worker)
        self.assertEqual(report['imageFiles'], 1)
        self.assertEqual(report['adapterFiles'], 1)
        self.assertFalse((self.root / 'output/save01.sav').exists())
        _, entries = adapter.read_archive((self.root / 'output' / archive_name).read_bytes(), engine)
        payloads = dict((name, value) for name, value, _ in entries)
        hero_name = 'Hero.sgr' if engine == adapter.ENGINES[0] else 'Hero.rbr'
        self.assertIn('向导'.encode('utf-8'), payloads[hero_name])
        self.assertIn(b'unknown-layout-order-data!', payloads[hero_name])
        self.assertEqual(payloads['res/icon.png'], overlay_file.read_bytes())
        self.assertEqual(payloads['extra/dialogue.json'], text_file.read_bytes())
        self.assertNotIn('save/private.json', payloads)
        self.assertNotIn('PinHao-assist-session.json', payloads)
        self.assertEqual(payloads['img/save/template.bin'], b'authored static resource')
        self.assertEqual(payloads['cache/story.bin'], b'authored static cache')
        for name, value, _ in original_entries:
            if name not in (hero_name, 'res/icon.png', 'extra/dialogue.json', 'save/private.json', 'PinHao-assist-session.json'):
                self.assertEqual(payloads[name], value)
        self.assertEqual(original_files, {path.name: path.read_bytes() for path in self.game.iterdir()})
        bad_overlay = {**args, 'outputDir': str(self.root / 'wrong-image-output'),
                       'assetOverlayFiles': [{**args['assetOverlayFiles'][0], 'sourceHash': '0' * 64}]}
        with self.assertRaises(worker.WorkerError):
            adapter.assemble(bad_overlay, worker)
        protected = next(unit for unit in manifest['units'].values() if unit['source'].startswith('Welcome'))
        self.assertEqual(len(protected['tokens']), 2)
        # Engine formatting and interpolation remain protected during text delivery.
        name, sheet = next((name, sheet) for name, sheet in sheets.items() if any(unit['id'] == protected['id'] for unit in sheet['units']))
        next(unit for unit in sheet['units'] if unit['id'] == protected['id'])['translation'] = 'Welcome!'
        worker.json_write(work / 'editable' / name, sheet)
        with self.assertRaises(ValueError):
            worker.native.validate(work, work / 'editable')

    def test_sgb_native_game_pipeline(self):
        self.run_native(adapter.ENGINES[0])

    def test_bakin_native_game_pipeline(self):
        self.run_native(adapter.ENGINES[1])

    def test_authored_layout_uses_lossless_loader_and_preserves_geometry(self):
        self.make_game(adapter.ENGINES[1])
        work, built = self.root / 'work', self.root / 'built'
        extracted = adapter.extract(self.game, work, adapter.probe(self.game), worker, {})
        row = next(unit for unit in extracted['units'] if unit['source'] == 'Choose a path.')
        manifest, sheets = worker.native.load_work(work)
        for name, sheet in sheets.items():
            for unit in sheet['units']:
                if unit['id'] == row['id']:
                    unit['translation'] = '\u9009\u62e9\u9053\u8def'
            worker.json_write(work / 'editable' / name, sheet)
        adapter.build(work, work / 'editable', built, worker)
        raw = (built / 'Layout.rbr').read_bytes()
        layout_length = struct.unpack_from('<I', raw, 17)[0]
        record = raw[23:23 + layout_length]
        self.assertIn('\u9009\u62e9\u9053\u8def'.encode('utf-8'), record)
        self.assertEqual(struct.unpack_from('<f', record, len(record) - 4)[0], 420.0)
        self.assertIn(b'unknown-layout-order-data!', raw)

    def test_catalog_process_discovers_formats_beside_its_native_codec(self):
        original = subprocess.run
        with mock.patch.object(adapter.subprocess, 'run', wraps=original) as run:
            self.assertEqual(adapter.catalog_job(self.root / 'tools', self.game / 'common.dll', []), [])
        calls = [call for call in run.call_args_list if Path(call.args[0][0]).name.startswith('YukarResources-')]
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].kwargs['cwd'], self.game)

    def test_nonroundtrippable_record_is_preserved_and_excluded_not_whole_resource(self):
        archive_name, entries = self.make_game(adapter.ENGINES[1])
        layout, _ = adapter.read_archive((self.game / archive_name).read_bytes(), adapter.ENGINES[1])
        unsafe_id = '66666666-6666-6666-6666-666666666666'
        unsafe = resource(1, unsafe_id, 'Unreadable legacy name',
                          string('Legacy record display.') + struct.pack('<I', 99) + b'UNMODELED-RECORD-DATA')
        entries = [(name, raw + unsafe[17:] if name == 'Hero.rbr' else raw, info) for name, raw, info in entries]
        (self.game / archive_name).write_bytes(adapter.write_archive(layout, entries, adapter.ENGINES[1]))
        originals = {name: raw for name, raw, _ in entries}
        work = self.root / 'work'
        result = adapter.extract(self.game, work, adapter.probe(self.game), worker, {})
        pending = result['reviewItems']
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]['object'], unsafe_id)
        self.assertEqual(pending[0]['file'], 'Hero.rbr')
        self.assertEqual(pending[0]['category'], 'extraction-failure')
        self.assertEqual(pending[0]['candidateCount'], 2)
        self.assertTrue(pending[0]['originalPreserved'])
        self.assertIn('no-change serialization differs', pending[0]['detail'])
        self.assertTrue(any(row['source'] == 'Guide' for row in result['units']))
        self.assertFalse(any('Legacy' in row['source'] or 'legacy' in row['source'] for row in result['units']))
        unchanged = self.root / 'unchanged'
        adapter.build(work, work / 'editable', unchanged, worker)
        self.assertEqual((unchanged / 'Hero.rbr').read_bytes(), originals['Hero.rbr'])
        _, sheets = worker.native.load_work(work)
        for name, sheet in sheets.items():
            for unit in sheet['units']:
                if unit['source'] == 'Guide':
                    unit['translation'] = '\u5411\u5bfc'
            worker.json_write(work / 'editable' / name, sheet)
        translated = self.root / 'translated'
        adapter.build(work, work / 'editable', translated, worker)
        raw = (translated / 'Hero.rbr').read_bytes()
        self.assertIn('\u5411\u5bfc'.encode('utf-8'), raw)
        unsafe_length = struct.unpack_from('<I', unsafe, 17)[0]
        self.assertIn(unsafe[23:23 + unsafe_length], raw)
        metadata = worker.native.read(work / 'technical/product-source.json')
        with self.assertRaisesRegex(ValueError, 'Unknown native display binding'):
            adapter.catalog_job(Path(metadata['cache']), Path(metadata['nativeSource']) / metadata['assembly'],
                                [{'name': 'Hero.rbr', 'file': str(Path(metadata['nativeSource']) / 'Hero.rbr'),
                                  'output': str(self.root / 'invalid.rbr'),
                                  'updates': {unsafe_id + '/name': 'Must not be written'}}])

    def test_bakin_loose_fonts_keep_native_paths(self):
        archive_name, entries = self.make_game(adapter.ENGINES[1])
        data = self.game / 'data'
        data.mkdir()
        (self.game / 'common.dll').replace(data / 'common.dll')
        for name, value, _ in entries:
            target = data / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(value)
        (self.game / archive_name).unlink()
        font = self.root / 'chosen.ttf'
        font_fixture(font)
        old_font = data / 'res/font/font.ttf'
        old_font.parent.mkdir(parents=True)
        old_font.write_bytes(b'original native font')
        work, built, output = self.root / 'work', self.root / 'built', self.root / 'output'
        adapter.extract(self.game, work, adapter.probe(self.game), worker, {})
        adapter.build(work, work / 'editable', built, worker)
        result = adapter.assemble({'gameDir': str(self.game), 'workspaceDir': str(work), 'buildDir': str(built),
                                  'outputDir': str(output), 'fontPath': str(font)}, worker)
        self.assertEqual(result['font']['files'], ['data/res/font/font.ttf'])
        self.assertEqual((output / 'data/res/font/font.ttf').read_bytes(), font.read_bytes())
        self.assertFalse((output / 'font.ttf').exists())
        self.assertEqual(old_font.read_bytes(), b'original native font')


if __name__ == '__main__':
    unittest.main()
