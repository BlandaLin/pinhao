import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import assist_transaction
import assist_managed
import worker


class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='pinhao-install-fixture-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def test_failure_restores_existing_and_removes_new_files(self):
        old = self.root / 'existing'
        old.write_bytes(b'original')
        def operation(transaction):
            transaction.write(old, b'new')
            transaction.write(self.root / 'nested/new', b'helper')
            raise OSError('neutral fault')
        result = assist_transaction.InstallTransaction(self.root, worker).run(operation)
        self.assertEqual(result['status'], 'install_failed')
        self.assertTrue(result['restored'])
        self.assertEqual(old.read_bytes(), b'original')
        self.assertFalse((self.root / 'nested').exists())
        self.assertEqual(len(result['recovery']['files']), 2)

    def test_rollback_directory_preparation_failure_has_no_game_writes(self):
        with mock.patch.object(assist_transaction.tempfile, 'mkdtemp', side_effect=OSError('neutral no space')):
            result = assist_transaction.InstallTransaction(self.root, worker).run(lambda tx: self.fail('must not start writes'))
        self.assertEqual(result['status'], 'install_failed')
        self.assertTrue(result['restored'])
        self.assertEqual(result['recovery']['files'], [])

    def test_managed_patch_preparation_failure_has_no_game_writes(self):
        report = {'supported': True, 'engine': 'Unity', 'assemblies': [
            {'file': 'Assembly-CSharp.dll', 'framework': 'net40', 'injected': False, 'hooks': ['Update']} ]}
        target = self.root / 'Assembly-CSharp.dll'
        target.write_bytes(b'original')
        with mock.patch.object(assist_managed, 'runtime', return_value=report), \
                mock.patch.object(assist_managed, '_run', side_effect=ValueError('neutral patch failed')):
            result = assist_managed.install({'gameDir': str(self.root)}, worker)
        self.assertEqual(result['status'], 'install_failed')
        self.assertTrue(result['restored'])
        self.assertEqual(result['recovery']['files'], [])
        self.assertEqual(target.read_bytes(), b'original')

    def test_external_edit_is_preserved_and_recovery_evidence_retained(self):
        old = self.root / 'existing'
        old.write_bytes(b'original')
        transaction = assist_transaction.InstallTransaction(self.root, worker)
        self.addCleanup(lambda: __import__('shutil').rmtree(transaction.directory, ignore_errors=True))
        def operation(current):
            current.write(old, b'new')
            old.write_bytes(b'external edit')
            raise OSError('neutral fault')
        with self.assertRaises(worker.WorkerError) as raised:
            transaction.run(operation)
        self.assertEqual(raised.exception.code, 'ASSIST_INSTALL_RECOVERY_REQUIRED')
        self.assertEqual(old.read_bytes(), b'external edit')
        self.assertEqual((transaction.directory / '0').read_bytes(), b'original')
        self.assertEqual(json.loads((transaction.directory / 'receipt.json').read_text())['state'], 'installing')

    def test_managed_second_copy_failure_restores_assembly_and_helper(self):
        target = self.root / 'Assembly-CSharp.dll'
        target.write_bytes(b'original assembly')
        helper = self.root / 'tools/net40/Pinhao.ManagedAssist.dll'
        helper.parent.mkdir(parents=True)
        helper.write_bytes(b'helper')
        report = {'supported': True, 'engine': 'Unity', 'assemblies': [
            {'file': target.name, 'framework': 'net40', 'injected': False, 'hooks': ['Update']} ]}
        def patch(arguments):
            if arguments[0] == 'patch':
                Path(arguments[-1]).write_bytes(b'patched assembly')
                return {}
            return {'injected': True, 'hooks': ['Update']}
        real_copy = assist_transaction.atomic_copy
        def fail_assembly(source, destination):
            if destination == target:
                raise OSError('neutral second copy')
            return real_copy(source, destination)
        with mock.patch.object(assist_managed, 'runtime', return_value=report), \
                mock.patch.object(assist_managed, 'tools', return_value=self.root / 'tools'), \
                mock.patch.object(assist_managed, '_run', side_effect=patch), \
                mock.patch.object(assist_transaction, 'atomic_copy', side_effect=fail_assembly):
            result = assist_managed.install({'gameDir': str(self.root)}, worker)
        self.assertEqual(result['status'], 'install_failed')
        self.assertTrue(result['restored'])
        self.assertEqual(target.read_bytes(), b'original assembly')
        self.assertFalse((self.root / 'Pinhao.ManagedAssist.dll').exists())

    def test_renpy_compiled_file_failure_restores_source_and_compiled_bytes(self):
        (self.root / 'game').mkdir()
        (self.root / 'renpy').mkdir()
        source = self.root / 'game/zz_pinhao_assist.rpy'
        compiled = source.with_suffix('.rpyc')
        source.write_bytes(b'previous source')
        compiled.write_bytes(b'previous compiled bytes')
        original_remove = assist_transaction.InstallTransaction.remove
        def fail_remove(transaction, target):
            original_remove(transaction, target)
            raise OSError('neutral failure after compiled removal')
        with mock.patch.object(assist_transaction.InstallTransaction, 'remove', fail_remove):
            result = worker.assist_install({'outputDir': str(self.root)})
        self.assertEqual(result['status'], 'install_failed')
        self.assertTrue(result['restored'])
        self.assertEqual(source.read_bytes(), b'previous source')
        self.assertEqual(compiled.read_bytes(), b'previous compiled bytes')

    def test_managed_safe_failure_survives_worker_dispatch(self):
        import assist_script
        failure = {'supported': False, 'status': 'install_failed', 'restored': True, 'detail': 'neutral recovered failure'}
        with mock.patch.object(worker, 'probe', return_value={'engine': 'Unity'}), \
                mock.patch.object(assist_managed, 'install', return_value=failure), \
                mock.patch.object(assist_script, 'install', side_effect=AssertionError('must not fall through after a managed install failure')):
            result = worker.assist_install({'outputDir': str(self.root)})
        self.assertEqual(result, failure)


class ManagedMetadataTests(unittest.TestCase):
    def test_compiled_bridge_reports_actual_catalog_limits_and_unknown_persistence(self):
        compiler = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        if not compiler.is_file():
            self.skipTest('Windows framework compiler unavailable')
        with tempfile.TemporaryDirectory(prefix='pinhao-metadata-fixture-') as temporary:
            root = Path(temporary)
            source, target = root / 'Metadata.cs', root / 'Metadata.exe'
            source.write_text('''using System;
using System.Collections.Generic;
using Pinhao.ManagedAssist;
class FixtureRoot { public List<int> Values = new List<int>(); }
class Program {
    static void Main(string[] args) {
        Environment.SetEnvironmentVariable("PINHAO_ASSIST_DIR", args[0]);
        Environment.SetEnvironmentVariable("PINHAO_ASSIST_TOKEN", new string('a', 64));
        var root = new FixtureRoot();
        for (int i = 0; i < Int32.Parse(args[1]); i++) root.Values.Add(i);
        Bridge.Tick(root, "Unity");
    }
}''', encoding='utf-8')
            bridge = worker.ROOT / 'packages/runtime/managed/Bridge.cs'
            compiled = subprocess.run([str(compiler), '/nologo', '/target:exe', '/out:' + str(target), str(source), str(bridge)], capture_output=True,
                                      creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            self.assertEqual(compiled.returncode, 0, compiled.stdout)
            framework = compiler.parents[2] / 'Framework/v2.0.50727'
            legacy = subprocess.run([str(compiler), '/nologo', '/target:library', '/noconfig', '/nostdlib+',
                                     '/reference:' + str(framework / 'mscorlib.dll'), '/reference:' + str(framework / 'System.dll'),
                                     '/out:' + str(root / 'Bridge.net20.dll'), str(bridge)], capture_output=True,
                                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            self.assertEqual(legacy.returncode, 0, legacy.stdout)
            for size, truncated in [(2, False), (1100, True)]:
                directory = root / str(size)
                directory.mkdir()
                process = subprocess.run([str(target), str(directory), str(size)], capture_output=True, timeout=10,
                                         creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                self.assertEqual(process.returncode, 0, process.stderr)
                state = json.loads((directory / 'state.json').read_text())['state']
                self.assertEqual(state['truncated'], truncated)
                self.assertEqual(state['catalogComplete'], not truncated)
                self.assertEqual(len(state['namedVariables']), min(size, 1000))
                self.assertTrue(all(row['persistence'] == 'unknown' for row in state['namedVariables']))
                self.assertEqual('collection-items' in state['limitReason'], truncated)
