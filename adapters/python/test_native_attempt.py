"""Free neutral native-failure evidence and recovery contracts."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zlib
from unittest import mock

import worker
import godot_native
import renpy_native
import source_native
import unity_native
from native_attempt import NativeAttempt, filesystem_path, recovered_script
from test_godot_native import simple_pack
from test_renpy_native import compiled_fixture
from test_source_worker import rpa


class NativeAttemptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pinhao-native-attempt-')
        self.root = Path(self.temp.name)
        self.temp.name = str(filesystem_path(self.temp.name))

    def tearDown(self):
        self.temp.cleanup()

    def evidence(self, work, result):
        artifact = result['artifacts'][0]
        directory = work.parent / artifact['relativePath']
        self.assertTrue(directory.is_relative_to(work.parent))
        raw = filesystem_path(directory / 'attempt.json').read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), artifact['sha256'])
        document = json.loads(raw)
        self.assertEqual(document['attemptId'], artifact['artifactId'])
        self.assertEqual(document['protocol'], 'pinhao-native-attempt-1')
        return directory, document

    def test_renpy_partial_decode_is_readable_and_shared_cache_survives_retry(self):
        game = self.root / 'original'
        (game / 'game').mkdir(parents=True)
        good = compiled_fixture()
        archive = game / 'game' / 'scripts.rpa'
        rpa(archive, {'good.rpyc': good, 'bad.rpyc': b'invalid compiled script'})
        original = archive.read_bytes()
        work = self.root / 'first' / 'workbench'
        info = {'engine': "Ren'Py", 'root': '.', 'packed': True, 'archives': ['game/scripts.rpa']}
        args = {'nativeRecoveryCacheDir': str(self.root / 'stable-cache')}
        with mock.patch.object(renpy_native, 'decompile', wraps=renpy_native.decompile) as decoder:
            with self.assertRaises((ValueError, zlib.error)) as caught:
                source_native.extract(game, work, info, worker, args)
            directory, document = self.evidence(work, vars(caught.exception))
            self.assertEqual(document['status'], 'partial', json.dumps(document, ensure_ascii=False))
            self.assertEqual(document['loadingOrderStatus'], 'unproven')
            records = document['resources']
            failed = [row for row in records if row.get('status') == 'failed']
            self.assertEqual(failed[0]['file'], 'game/bad.rpyc')
            self.assertEqual(failed[0]['origin'], 'game/scripts.rpa')
            done = [row for row in records if row.get('material')]
            self.assertEqual(len(done), 1)
            self.assertIn('Welcome [player_name].', filesystem_path(directory / done[0]['material']['file']).read_text(encoding='utf-8'))
            self.assertFalse((work / 'manifest.json').exists())
            first_calls = decoder.call_count
            fixed = self.root / 'fixed'
            (fixed / 'game').mkdir(parents=True)
            rpa(fixed / 'game' / 'scripts.rpa', {'good.rpyc': good})
            retry_work = self.root / 'retry' / 'workbench'
            result = source_native.extract(fixed, retry_work, info, worker, args)
            self.assertEqual(decoder.call_count, first_calls, 'unchanged successful AST must be reused, including load-order analysis')
            self.assertGreater(len(result['units']), 0)
            _, retried = self.evidence(retry_work, result['nativeAttempt'])
            self.assertTrue(any(row.get('reused') for row in retried['resources']))
        self.assertEqual(archive.read_bytes(), original)

    def godot_fixture(self):
        game = self.root / 'godot'
        game.mkdir()
        pack = game / 'fixture.pck'
        simple_pack(pack, {'res://project.godot': b'config_version=5\n',
                           'res://scene.tscn': b'neutral scene', 'res://hidden.gdc': b'compiled'})
        info = {'engine': 'Godot', 'packed': True, 'archives': ['fixture.pck']}
        return game, pack, info

    def godot_recover(self, returncode=0):
        def execute(argv, **kwargs):
            source = Path(next(item.split('=', 1)[1] for item in argv if item.startswith('--output=')))
            source.mkdir(parents=True)
            (source / 'project.godot').write_text('config_version=5\n[application]\nconfig/name="Neutral"\n', encoding='utf-8')
            (source / 'scene.tscn').write_text('[gd_scene format=3]\n[node name="Label" type="Label"]\ntext = "Neutral dialogue"\n', encoding='utf-8')
            (source / 'gdre_export.log').write_text('hidden.gdc: unsupported neutral opcode\n', encoding='utf-8')
            return subprocess.CompletedProcess(argv, returncode, b'Failed conversions: 3\nScripts not decompiled: 7\n', b'neutral stderr\n')
        return execute

    def test_godot_partial_success_preserves_logs_original_members_and_text(self):
        game, pack, info = self.godot_fixture()
        original = pack.read_bytes()
        work = self.root / 'godot-attempt' / 'workbench'
        with mock.patch.object(godot_native, 'executable', return_value=Path('neutral-gdre.exe')), \
                mock.patch.object(godot_native.subprocess, 'run', side_effect=self.godot_recover()):
            result = godot_native.extract(game, work, info, worker, {'allowEmpty': True})
        directory, document = self.evidence(work, result['nativeAttempt'])
        self.assertEqual(document['status'], 'partial', json.dumps(document, ensure_ascii=False))
        self.assertIn('unsupported neutral opcode', (directory / 'gdre_export.log').read_text())
        self.assertEqual((directory / 'gdre-stderr.log').read_bytes(), b'neutral stderr\n')
        hidden = next(row for row in result['coverage']['resources'] if row['file'] == 'hidden.gdc')
        self.assertEqual(hidden['recoveryStatus'], 'not_recovered')
        self.assertEqual(result['coverage']['structuralRecoveryWarnings'], 2, 'this legacy field counts warning categories, not failed files')
        self.assertEqual(result['coverage']['recoverySummaryCounts'], {'failedConversions': 3, 'scriptsNotDecompiled': 7})
        self.assertTrue(any('Neutral dialogue' in row['source'] for row in result['units']))
        self.assertEqual(pack.read_bytes(), original)

    def test_godot_nonzero_recovery_keeps_full_output_and_completed_text(self):
        game, _, info = self.godot_fixture()
        work = self.root / 'godot-failed' / 'workbench'
        with mock.patch.object(godot_native, 'executable', return_value=Path('neutral-gdre.exe')), \
                mock.patch.object(godot_native.subprocess, 'run', side_effect=self.godot_recover(2)):
            with self.assertRaises(ValueError) as caught:
                godot_native.extract(game, work, info, worker, {})
        directory, document = self.evidence(work, vars(caught.exception))
        self.assertEqual(document['status'], 'partial')
        self.assertIn('Neutral dialogue', (directory / 'recovered' / 'scene.tscn').read_text())
        self.assertIn('Scripts not decompiled: 7', (directory / 'gdre-stdout.log').read_text())
        self.assertFalse((work / 'manifest.json').exists())

    def test_unity_all_unreadable_keeps_each_carrier_reason_before_early_failure(self):
        game = self.root / 'unity'
        game.mkdir()
        for name in ('first.assets', 'second.assets'):
            (game / name).write_bytes(name.encode())
        work = self.root / 'unity-attempt' / 'workbench'
        info = {'carriers': ['first.assets', 'second.assets']}
        with mock.patch.object(unity_native, 'load_carrier', side_effect=[ValueError('first invalid header'), ValueError('second unsupported metadata')]):
            with self.assertRaises(worker.WorkerError) as caught:
                unity_native.extract(game, work, info, worker, {'allowEmpty': True})
        self.assertEqual(caught.exception.code, 'NATIVE_TEXT_UNAVAILABLE')
        _, document = self.evidence(work, vars(caught.exception))
        self.assertEqual([row['error']['message'] for row in document['resources']],
                         ['first invalid header', 'second unsupported metadata'])
        self.assertEqual(document['status'], 'failed')
        self.assertFalse((work / 'manifest.json').exists())

    def test_deep_attempt_paths_keep_logical_artifacts_and_reusable_cache(self):
        work = self.root / ('scope-' + 'a' * 72) / ('job-' + 'b' * 72) / 'workbench'
        attempt = NativeAttempt(work, "Ren'Py", worker, {'name': 'neutral decoder'})
        material = attempt.material('neutral-script', 'Neutral recovered text')
        attempt.resource('neutral-script', status='extracted_unverified', material=material)
        directory, document = self.evidence(work, attempt.finish('partial'))
        output = directory / material['file']
        self.assertGreater(len(str(output)), 260)
        self.assertFalse(document['resources'][0]['material']['file'].startswith('\\\\?\\'))
        self.assertEqual(filesystem_path(output).read_text(encoding='utf-8'), 'Neutral recovered text')
        source = self.root / 'neutral.rpyc'
        source.write_bytes(b'neutral compiled input')
        cache = work.parent / 'native-recovery-cache'
        decoder = mock.Mock(return_value=('Neutral recovered text', {'version': 1}, []))
        first = recovered_script(source, cache, decoder, 'neutral-decoder-v1')
        second = recovered_script(source, cache, decoder, 'neutral-decoder-v1')
        self.assertFalse(first[3])
        self.assertTrue(second[3])
        decoder.assert_called_once()

    def run_worker(self, game, work):
        result = subprocess.run([sys.executable, '-B', str(Path(worker.__file__)), 'extract'],
                                input=json.dumps({'gameDir': str(game), 'workspaceDir': str(work), 'allowEmpty': True}).encode(),
                                capture_output=True, env={**os.environ, 'PYTHONIOENCODING': 'utf-8'}, timeout=30)
        self.assertEqual(result.returncode, 2, result.stderr.decode('utf-8', errors='replace'))
        envelope = json.loads(result.stdout)
        self.assertFalse(envelope['ok'])
        return envelope['error']

    def test_actual_worker_renpy_error_keeps_structured_attempt_and_material(self):
        game = self.root / 'worker-renpy'
        (game / 'game').mkdir(parents=True)
        rpa(game / 'game' / 'scripts.rpa', {'good.rpyc': compiled_fixture(), 'bad.rpyc': b'bad'})
        work = self.root / 'worker-renpy-result' / 'workbench'
        error = self.run_worker(game, work)
        self.assertEqual(error['diagnostic']['category'], 'native')
        self.assertEqual(error['diagnostic']['engine'], "Ren'Py")
        directory, document = self.evidence(work, error)
        self.assertEqual(document['status'], 'partial', json.dumps(document, ensure_ascii=False))
        material = next(row['material'] for row in document['resources'] if row.get('material'))
        self.assertIn('Welcome [player_name].', filesystem_path(directory / material['file']).read_text(encoding='utf-8'))

    @unittest.skipUnless(unity_native.available(), 'Prepare UnityPy 1.23.0 before the actual Unity worker test')
    def test_actual_worker_unity_error_keeps_two_carrier_failures(self):
        game = self.root / 'worker-unity'
        data = game / 'Fixture_Data'
        data.mkdir(parents=True)
        (game / 'UnityPlayer.dll').write_bytes(b'neutral signature marker, never executed')
        (data / 'first.bundle').write_bytes(b'UnityFS\0invalid-first')
        (data / 'second.bundle').write_bytes(b'UnityFS\0invalid-second')
        work = self.root / 'worker-unity-result' / 'workbench'
        error = self.run_worker(game, work)
        self.assertEqual(error['code'], 'NATIVE_TEXT_UNAVAILABLE')
        _, document = self.evidence(work, error)
        self.assertEqual(len(document['resources']), 2)
        self.assertEqual({row['file'] for row in document['resources']},
                         {'Fixture_Data/first.bundle', 'Fixture_Data/second.bundle'})
        self.assertTrue(all(row['status'] == 'failed' and row['error']['message'] for row in document['resources']))


if __name__ == '__main__':
    unittest.main()
