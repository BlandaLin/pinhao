"""RGSS assistance injection checks, separate from actual engine runtime acceptance."""
from pathlib import Path
import tempfile
import unittest
import zlib
from unittest import mock

import worker
import assist_install_rgss
from ruby_marshal import Reader, structure
from test_worker import ruby_game


class AssistInstallTests(unittest.TestCase):
    def temporary(self):
        parent = worker.ROOT / 'local' / 'native-tests'
        parent.mkdir(parents=True, exist_ok=True)
        return tempfile.TemporaryDirectory(dir=parent)

    def test_native_script_slot_is_patched_once_for_all_rgss_versions(self):
        with self.temporary() as temporary:
            for engine, ext in [('XP', '.rxdata'), ('VX', '.rvdata'), ('VX Ace', '.rvdata2')]:
                root = ruby_game(Path(temporary) / engine, engine)
                scripts = root / 'Data' / ('Scripts' + ext)
                before = Reader(scripts.read_bytes())
                expected = zlib.decompress(before.root[0][2].raw)
                result = worker.assist_install({'outputDir': str(root)})
                self.assertEqual(result, {'supported': True, 'engine': engine, 'transport': 'file'})
                after = Reader(scripts.read_bytes())
                self.assertEqual(zlib.decompress(after.root[0][2].raw), worker.rgss_bootstrap('PinHaoAssist.rb') + expected)
                self.assertEqual(structure(before.root, {before.root[0][2].index: after.root[0][2].raw}), structure(after.root))
                installed = scripts.read_bytes()
                worker.assist_install({'outputDir': str(root)})
                self.assertEqual(installed, scripts.read_bytes())
                source = (root / 'PinHaoAssist.rb').read_text(encoding='utf-8')
                self.assertIn("'engine' => '" + engine + "'", source)
                self.assertIn('PinHaoAssist.poll', source)
                self.assertIn("params['gameSessionId'] == @game_session_id", source)
                self.assertNotIn('__PINHAO_ENGINE__', source)

    def test_non_rgss_directory_is_unchanged(self):
        with self.temporary() as temporary:
            result = worker.assist_install({'outputDir': temporary})
            self.assertFalse(result['supported'])
            self.assertEqual(result.get('modes', []), [])
            self.assertEqual(list(Path(temporary).iterdir()), [])

    def test_uninstall_restores_exact_scripts_and_allows_reinstall(self):
        with self.temporary() as temporary:
            root = ruby_game(Path(temporary) / 'game', 'XP')
            scripts = root / 'Data/Scripts.rxdata'
            original = scripts.read_bytes()
            worker.assist_install({'outputDir': str(root)})
            result = assist_install_rgss.uninstall({'outputDir': str(root)}, worker)
            self.assertTrue(result['restored'])
            self.assertEqual(scripts.read_bytes(), original)
            self.assertFalse((root / 'PinHaoAssist.rb').exists())
            self.assertTrue(assist_install_rgss.uninstall({'outputDir': str(root)}, worker)['removed'])
            worker.assist_install({'outputDir': str(root)})
            self.assertIn(worker.rgss_bootstrap('PinHaoAssist.rb'), zlib.decompress(Reader(scripts.read_bytes()).root[0][2].raw))

    def test_install_write_failure_restores_scripts_and_retries(self):
        with self.temporary() as temporary:
            root = ruby_game(Path(temporary) / 'game', 'VX')
            scripts = root / 'Data/Scripts.rvdata'
            original = scripts.read_bytes()
            real_write = assist_install_rgss.atomic_write
            failed = False
            def fail_once(path, raw):
                nonlocal failed
                if path == scripts and not failed:
                    failed = True
                    raise OSError('simulated interrupted write')
                return real_write(path, raw)
            with mock.patch.object(assist_install_rgss, 'atomic_write', side_effect=fail_once):
                result = worker.assist_install({'outputDir': str(root)})
                self.assertEqual(result['status'], 'install_failed')
                self.assertTrue(result['restored'])
            self.assertEqual(scripts.read_bytes(), original)
            self.assertFalse((root / 'PinHaoAssist.rb').exists())
            worker.assist_install({'outputDir': str(root)})
            self.assertTrue((root / 'PinHaoAssist.rb').is_file())

    def test_post_install_script_edits_are_preserved_on_conflict(self):
        with self.temporary() as temporary:
            root = ruby_game(Path(temporary) / 'game', 'VX Ace')
            scripts = root / 'Data/Scripts.rvdata2'
            worker.assist_install({'outputDir': str(root)})
            changed = scripts.read_bytes() + b'new mod'
            scripts.write_bytes(changed)
            with self.assertRaisesRegex(worker.WorkerError, 'changed after'):
                assist_install_rgss.uninstall({'outputDir': str(root)}, worker)
            self.assertEqual(scripts.read_bytes(), changed)
            with self.assertRaisesRegex(worker.WorkerError, 'changed after'):
                worker.assist_install({'outputDir': str(root)})


if __name__ == '__main__':
    unittest.main()
