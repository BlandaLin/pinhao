"""Neutral MV/MZ package fixtures; mobile device execution is a separate check."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import mobile_export
import worker
from test_rpgmaker import json_game


class MobileExportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='pinhao-mobile-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.game = self.root / 'original'

    def fixture(self, engine='MV', nested=False):
        runtime = json_game(self.game, engine, nested)
        (runtime / 'index.html').write_text('<html>neutral entry</html>', encoding='utf-8')
        for name, raw in {
            'Game.exe': b'neutral desktop runner', 'UnityPlayer.dll': b'neutral library',
            'resources.pak': b'neutral nw data', 'save/file1.rpgsave': b'private save',
            'logs/output.log': b'private log', 'fonts/PinHaoChinese.ttf': b'neutral font',
            'PinHao-build-report.json': b'{"privatePath":"local-only-fixture"}',
        }.items():
            path = self.game / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
        return runtime

    def snapshot(self):
        return {rel: worker.digest_file(path) for rel, path in worker.files_in(self.game)}

    def export(self, **args):
        return mobile_export.export({'sourceDir': str(self.game), 'filePath': str(self.root / 'mobile.rga'), **args}, worker)

    def test_flat_mv_and_nested_mz_preserve_entry_resources_and_font(self):
        for engine, nested in [('MV', False), ('MZ', True)]:
            with self.subTest(engine=engine):
                self.game = self.root / engine
                runtime = self.fixture(engine, nested)
                before = self.snapshot()
                output = self.root / (engine + '.rga')
                result = self.export(filePath=str(output), engine=engine, name='中性游戏', projectId='neutral-project')
                with zipfile.ZipFile(output) as archive:
                    names = archive.namelist()
                    self.assertEqual(len(names), len(set(names)))
                    entry = 'www/index.html' if nested else 'index.html'
                    self.assertIn('execFile=' + entry, archive.read('game.cfg').decode())
                    self.assertIn('type=html', archive.read('game.cfg').decode())
                    self.assertEqual(archive.read(entry), (runtime / 'index.html').read_bytes())
                    for rel in ('fonts/PinHaoChinese.ttf', 'www/data/Map001.json' if nested else 'data/Map001.json'):
                        self.assertEqual(archive.read(rel), (self.game / rel).read_bytes())
                    for rel in ('Game.exe', 'UnityPlayer.dll', 'resources.pak', 'save/file1.rpgsave', 'logs/output.log', 'PinHao-build-report.json'):
                        self.assertNotIn(rel, names)
                    report = json.loads(archive.read('PinHao-mobile-report.json'))
                    self.assertEqual(report['engine'], engine)
                    self.assertFalse(report['phoneRuntimeVerified'])
                    self.assertNotIn(str(self.game), json.dumps(report))
                    self.assertIsNone(archive.testzip())
                    self.assertEqual(result['files'], len(names))
                self.assertEqual(self.snapshot(), before)

    def test_desktop_api_warnings_only_scan_enabled_plugins(self):
        runtime = self.fixture()
        plugins = runtime / 'js/plugins'
        plugins.mkdir()
        for name in ('Active', 'Disabled', 'PinHaoRuntime'):
            (plugins / (name + '.js')).write_text('require("fs").readFileSync("neutral");', encoding='utf-8')
        (runtime / 'js/plugins.js').write_text('var $plugins = ' + json.dumps([
            {'name': 'Active', 'status': True}, {'name': 'Disabled', 'status': False},
            {'name': 'PinHaoRuntime', 'status': True},
        ]) + ';', encoding='utf-8')
        result = self.export()
        self.assertEqual(len(result['warnings']), 1)
        self.assertIn('Active.js', result['warnings'][0])
        with zipfile.ZipFile(result['filePath']) as archive:
            self.assertEqual(archive.read('js/plugins/Active.js'), (plugins / 'Active.js').read_bytes())

    def test_config_values_are_single_line_and_generated_members_replace_old_reports(self):
        self.fixture()
        (self.game / 'game.cfg').write_text('private old configuration', encoding='utf-8')
        (self.game / 'PinHao-mobile-report.json').write_text('old private report', encoding='utf-8')
        result = self.export(name='中性\ntype=bad\r\n\x00标题', projectId='a/b private identifier')
        with zipfile.ZipFile(result['filePath']) as archive:
            config = archive.read('game.cfg').decode()
            self.assertEqual(sum(line.startswith('type=') for line in config.splitlines()), 1)
            self.assertIn('type=html', config)
            self.assertNotIn('\x00', config)
            ident = next(line[3:] for line in config.splitlines() if line.startswith('id='))
            self.assertTrue(ident.isalnum())
            self.assertNotIn('private old', config)

    def test_existing_output_and_source_overlap_keep_existing_files(self):
        self.fixture()
        output = self.root / 'mobile.rga'
        output.write_bytes(b'existing result')
        with self.assertRaises(worker.WorkerError):
            self.export()
        self.assertEqual(output.read_bytes(), b'existing result')
        with self.assertRaises(worker.WorkerError):
            self.export(filePath=str(self.game / 'mobile.rga'))
        self.assertFalse((self.game / 'mobile.rga').exists())

    def test_wrong_engine_and_missing_entry_produce_no_archive(self):
        runtime = self.fixture()
        with self.assertRaisesRegex(worker.WorkerError, 'MV'):
            self.export(engine='MZ')
        (runtime / 'index.html').unlink()
        with self.assertRaisesRegex(worker.WorkerError, 'index.html'):
            self.export()
        self.assertFalse((self.root / 'mobile.rga').exists())

    def test_failed_archive_is_removed_and_original_stays_identical(self):
        self.fixture()
        before = self.snapshot()
        with patch.object(zipfile.ZipFile, 'write', side_effect=OSError('neutral write failure')):
            with self.assertRaisesRegex(OSError, 'neutral write failure'):
                self.export()
        self.assertFalse((self.root / 'mobile.rga').exists())
        self.assertEqual(self.snapshot(), before)


if __name__ == '__main__':
    unittest.main()
