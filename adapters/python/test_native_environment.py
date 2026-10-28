"""Neutral dependency faults, protocol fields and refreshable tool identities."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import worker
import native_environment as environment
import pgmm_native


class NativeEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pinhao-native-environment-')
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def game(self, name='game', encrypted=True):
        game = self.root / name
        game.mkdir()
        if encrypted:
            (game / 'project.json').write_bytes(b'enc\0' + bytes(16))
            (game / 'info.json').write_text(json.dumps({'key': 'EJHv9Lqr3H8ApHDwJ3UqGA=='}))
        else:
            (game / 'project.json').write_text(json.dumps({'gameInformation': {}, 'textList': []}))
        return game

    def test_missing_codec_is_dependency_not_unknown_format(self):
        game = self.game()
        with mock.patch.object(pgmm_native, 'codec', side_effect=pgmm_native.CodecError('missing', 'PGMM codec missing')):
            info = worker.probe({'gameDir': str(game)})
            self.assertFalse(info['capabilities']['extract'])
            self.assertEqual(info['diagnostic']['dependencyId'], 'pgmm-codec')
            with self.assertRaises(worker.WorkerError) as caught:
                worker.extract({'gameDir': str(game), 'workspaceDir': str(self.root / 'work')})
        self.assertEqual(caught.exception.code, 'NATIVE_DEPENDENCY_MISSING')
        self.assertEqual(caught.exception.diagnostic['state'], 'missing')
        self.assertFalse((self.root / 'work').exists())

    def test_invalid_abi_stays_distinct_from_missing_codec(self):
        package = self.root / 'codec' / 'pgmdec'
        package.mkdir(parents=True)
        (package / '__init__.py').write_text('raise ImportError("wrong native ABI")\n')
        with mock.patch.dict(sys.modules), mock.patch.object(pgmm_native, 'codec_root', return_value=package.parent):
            sys.modules.pop('_pinhao_pgmdec', None)
            with self.assertRaises(pgmm_native.CodecError) as caught:
                pgmm_native.codec()
            self.assertEqual(caught.exception.code, 'NATIVE_DEPENDENCY_INVALID')
            self.assertEqual(caught.exception.diagnostic['state'], 'invalid')
            self.assertIn('matching Python runtime', str(caught.exception))
            self.assertNotIn('_pinhao_pgmdec', sys.modules)

    def test_missing_package_has_structured_diagnostic(self):
        with mock.patch.dict(sys.modules), mock.patch.object(pgmm_native, 'codec_root', return_value=self.root / 'missing'):
            sys.modules.pop('_pinhao_pgmdec', None)
            health = pgmm_native.codec_health()
        self.assertEqual(health['state'], 'missing')
        self.assertTrue(all(item.get('missing') for item in health['identity']))

    def test_present_package_with_missing_api_is_invalid(self):
        package = self.root / 'codec' / 'pgmdec'
        package.mkdir(parents=True)
        (package / '__init__.py').write_text('value = "not a working codec"\n')
        with mock.patch.dict(sys.modules), mock.patch.object(pgmm_native, 'codec_root', return_value=package.parent):
            sys.modules.pop('_pinhao_pgmdec', None)
            health = pgmm_native.codec_health()
        self.assertEqual(health['state'], 'invalid')
        self.assertIn('required API', health['detail'])

    def test_plaintext_pgmm_does_not_require_encryption_codec(self):
        game = self.game(encrypted=False)
        with mock.patch.object(pgmm_native, 'codec', side_effect=AssertionError('Plaintext must not load codec')):
            info = worker.probe({'gameDir': str(game)})
        self.assertTrue(info['capabilities']['extract'])
        self.assertEqual(info['support'], pgmm_native.READY)
        self.assertNotIn('diagnostic', info)

    def test_invalid_game_key_is_format_not_dependency(self):
        game = self.game()
        (game / 'info.json').write_text('{"key":"invalid"}')
        with mock.patch.object(pgmm_native, 'codec', side_effect=AssertionError('Do not load codec for invalid game data')):
            with self.assertRaises(worker.WorkerError) as caught:
                worker.extract({'gameDir': str(game), 'workspaceDir': str(self.root / 'work')})
        self.assertEqual(caught.exception.code, 'ENGINE_ADAPTER_REQUIRED')
        self.assertEqual(caught.exception.diagnostic['category'], 'format')

    def test_missing_gdre_is_dependency_not_new_godot_format(self):
        game = self.root / 'godot'
        game.mkdir()
        (game / 'project.godot').write_text('[application]\nconfig/name="Neutral"\n')
        with mock.patch.object(worker.godot_native, 'executable', return_value=None):
            with self.assertRaises(worker.WorkerError) as caught:
                worker.extract({'gameDir': str(game), 'workspaceDir': str(self.root / 'work')})
        self.assertEqual(caught.exception.code, 'NATIVE_DEPENDENCY_MISSING')
        self.assertEqual(caught.exception.diagnostic['dependencyId'], 'gdre')

    def test_gdre_companion_missing_is_invalid_and_does_not_claim_extract(self):
        exe = self.root / 'gdre_tools.exe'
        exe.write_bytes(b'MZfixture')
        game = self.root / 'godot'
        game.mkdir()
        (game / 'project.godot').write_text('[application]\n')
        with mock.patch.object(worker.godot_native, 'executable', return_value=exe):
            info = worker.probe({'gameDir': str(game)})
        self.assertEqual(info['diagnostic']['state'], 'invalid')
        self.assertFalse(info['capabilities']['extract'])
        self.assertIn('gdre_tools.pck', info['diagnostic']['detail'])

    def test_encrypted_unknown_godot_format_still_needs_adapter(self):
        game = self.root / 'godot'
        game.mkdir()
        (game / 'data.pck').write_bytes(b'not a supported pack')
        with mock.patch.object(worker.godot_native, 'executable', return_value=None):
            with self.assertRaises(worker.WorkerError) as caught:
                worker.extract({'gameDir': str(game), 'workspaceDir': str(self.root / 'work')})
        self.assertEqual(caught.exception.code, 'ENGINE_ADAPTER_REQUIRED')
        self.assertIsNone(caught.exception.diagnostic)

    def test_explicit_health_refresh_changes_after_codec_repair_not_install_location(self):
        missing = {'dependencyId': 'pgmm-codec', 'state': 'missing', 'identity': [{'file': 'codec', 'missing': True}]}
        ready = {'dependencyId': 'pgmm-codec', 'state': 'ready', 'identity': [{'file': 'codec', 'sha256': 'a' * 64}]}
        with mock.patch.object(environment, 'godot_health', return_value={'dependencyId': 'gdre', 'state': 'missing'}), mock.patch.object(pgmm_native, 'codec_health', side_effect=[missing, ready, ready]):
            before, after, again = environment.catalog_health(), environment.catalog_health(), environment.catalog_health()
        self.assertNotEqual(before['fingerprint'], after['fingerprint'])
        self.assertEqual(after['fingerprint'], again['fingerprint'])
        self.assertNotIn(str(self.root), json.dumps(after))

    def test_file_identity_changes_when_same_size_codec_content_changes(self):
        path = self.root / 'codec.pyd'
        path.write_bytes(b'one')
        before = environment.files_identity([path])
        path.write_bytes(b'two')
        self.assertNotEqual(before, environment.files_identity([path]))

    def test_probe_does_not_hash_large_dependency_files(self):
        with mock.patch.object(environment, 'files_identity', side_effect=AssertionError('No dependency hash on probe')), mock.patch.object(worker.godot_native, 'executable', return_value=None):
            self.assertEqual(environment.godot_health()['state'], 'missing')

    def test_protocol_whitelists_diagnostics_and_attempt_artifacts(self):
        attempt = 'native-attempt-12345678-abcd'
        error = worker.WorkerError('NATIVE_DEPENDENCY_INVALID', 'fixture',
            diagnostic={'category': 'dependency', 'phase': 'extract', 'engine': 'Godot', 'state': 'invalid',
                        'dependencyId': 'gdre', 'secret': 'must-not-cross', 'detail': 'fixture'},
            attemptId=attempt, artifacts=[{'artifactId': attempt, 'kind': 'native-attempt',
                'relativePath': 'work-native-attempts/' + attempt, 'sha256': 'a' * 64, 'arbitrary': 'hidden'},
                {'relativePath': '../private'}, {'relativePath': 'C:/private'}])
        output = io.StringIO()
        with mock.patch.object(sys, 'argv', ['worker.py', 'probe']), mock.patch.object(sys, 'stdin', io.StringIO('{}')), mock.patch.dict(worker.COMMANDS, {'probe': mock.Mock(side_effect=error)}), contextlib.redirect_stdout(output):
            self.assertEqual(worker.main(), 2)
        record = json.loads(output.getvalue())['error']
        self.assertEqual(record['attemptId'], attempt)
        self.assertEqual(len(record['artifacts']), 1)
        self.assertEqual(record['diagnostic']['dependencyId'], 'gdre')
        self.assertNotIn('secret', record['diagnostic'])
        self.assertNotIn('arbitrary', record['artifacts'][0])

    def test_actual_worker_protocol_distinguishes_missing_and_abi_invalid_codec(self):
        game = self.game()
        baseline = (game / 'project.json').read_bytes()
        environment_vars = {key: value for key, value in os.environ.items()
                            if key.upper() in ('PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP')}
        environment_vars.update(PINHAO_TOOLKIT=worker.TOOLKIT, PYTHONIOENCODING='utf-8')
        for state in ('missing', 'invalid'):
            codec = self.root / state
            if state == 'invalid':
                (codec / 'pgmdec').mkdir(parents=True)
                (codec / 'pgmdec/__init__.py').write_text('raise ImportError("incompatible ABI fixture")\n')
            environment_vars['PINHAO_PGMM_CODEC'] = str(codec)
            result = subprocess.run([sys.executable, '-B', '-u', worker.__file__, 'extract'],
                input=json.dumps({'gameDir': str(game), 'workspaceDir': str(self.root / ('work-' + state))}),
                text=True, encoding='utf-8', capture_output=True, timeout=30, env=environment_vars,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            self.assertEqual(result.returncode, 2, result.stderr)
            record = json.loads(result.stdout)['error']
            self.assertEqual(record['code'], 'NATIVE_DEPENDENCY_' + state.upper())
            self.assertEqual(record['diagnostic']['state'], state)
            self.assertEqual(record['diagnostic']['dependencyId'], 'pgmm-codec')
            self.assertFalse((self.root / ('work-' + state)).exists())
        self.assertEqual((game / 'project.json').read_bytes(), baseline)


if __name__ == '__main__':
    unittest.main()
