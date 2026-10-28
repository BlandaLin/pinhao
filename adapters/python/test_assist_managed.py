"""Real CLR frame injection and file-protocol tests using a neutral managed game."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

import worker
import assist_managed as managed


def encode(value):
    if value is None:
        return 'n'
    if value is True:
        return 't'
    if value is False:
        return 'f'
    if isinstance(value, (int, float)):
        return 'd' + str(value) + ';'
    if isinstance(value, str):
        return 's' + str(len(value.encode())) + ':' + value
    return 'o' + str(len(value)) + ':' + ''.join(encode(key) + encode(item) for key, item in value.items())


@unittest.skipUnless(managed.available(), 'Prepare the fixed managed bridge and Mono.Cecil tools')
class ManagedTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pinhao-managed-')
        self.root = Path(self.temp.name)
        self.game = self.root / 'game'
        self.game.mkdir()
        self.compiler = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        self.source = Path(__file__).resolve().parents[2] / 'packages/runtime/managed/Fixture.cs'

    def tearDown(self):
        self.temp.cleanup()

    def compile(self, file, legacy=False):
        file.parent.mkdir(parents=True, exist_ok=True)
        references = []
        if legacy:
            framework = self.compiler.parents[2] / 'Framework/v2.0.50727'
            references = ['/noconfig', '/nostdlib+', '/reference:' + str(framework / 'mscorlib.dll'), '/reference:' + str(framework / 'System.dll')]
        process = subprocess.run([str(self.compiler), '/nologo', '/optimize+', '/target:exe', '/out:' + str(file), *references, str(self.source)], capture_output=True)
        self.assertEqual(process.returncode, 0, process.stdout)

    def wait(self, predicate, timeout=8):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            result = predicate()
            if result:
                return result
            time.sleep(0.08)
        self.fail('Managed frame bridge did not answer')

    def run_engine(self, engine, legacy=False):
        relative = 'Fixture_Data/Managed/Assembly-CSharp.dll' if engine == 'Unity' else 'sgb_rpgplayer.exe' if engine == 'SMILE GAME BUILDER' else 'data/bakinengine.dll'
        target = self.game / relative
        self.compile(target, legacy)
        if engine == 'Unity':
            (self.game / 'UnityPlayer.dll').write_bytes(b'neutral marker')
        before = target.read_bytes()
        result = managed.install({'gameDir': str(self.game), 'engine': engine}, worker)
        self.assertTrue(result['supported'])
        self.assertEqual(result['transport'], 'file')
        self.assertEqual(result['assemblies'][0]['framework'], 'net20' if legacy else 'net40')
        self.assertNotEqual(before, target.read_bytes())
        patched = target.read_bytes()
        self.assertTrue(managed.install({'gameDir': str(self.game), 'engine': engine}, worker)['supported'])
        self.assertEqual(patched, target.read_bytes())
        session = self.root / '会话'
        session.mkdir()
        backups = self.root / 'backups'
        token = 'a' * 64
        (session / 'commands.txt').write_text(token, encoding='ascii')
        environment = {**os.environ, 'PINHAO_ASSIST_DIR': str(session), 'PINHAO_ASSIST_TOKEN': token, 'PINHAO_ASSIST_BACKUP_DIR': str(backups)}
        stop, finish = self.root / 'stop', self.root / 'finished.txt'
        process = subprocess.Popen([str(target), 'Unity' if engine == 'Unity' else 'Yukar', str(stop), str(finish)], env=environment,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        def state():
            try:
                return json.loads((session / 'state.json').read_text(encoding='utf-8'))
            except (FileNotFoundError, json.JSONDecodeError):
                return None
        try:
            initial = self.wait(state)
            self.assertTrue(initial['state']['ready'])
            self.assertEqual(initial['state']['engine'], engine)
            names = {row['label']: row for row in initial['state']['namedVariables']}
            self.assertTrue(any(name.endswith('.Coins') for name in names))
            self.assertFalse(any('Dangerous' in name for name in names))
            self.assertTrue(any(name.endswith('.StaticScore') for name in names))
            commands = []
            for index, (suffix, value) in enumerate([('.Coins', 150), ('.Name', '向导\n你好'), ('.Cleared', True), ('.Items[0]', 7)]):
                row = next(row for row in names.values() if row['label'].endswith(suffix))
                params = {'scope': 'store', 'store': row['store'], 'name': row['name'], 'gameSessionId': initial['state']['gameSessionId']}
                payload = encode({'value': value, 'params': params}).encode().hex()
                commands.append('\t'.join([str(index), 'setNamedVariable', '', '', 'tagged', payload]))
            (session / 'commands.txt').write_text(token + '\n' + '\n'.join(commands), encoding='ascii')
            updated = self.wait(lambda: (snapshot if snapshot and len(snapshot['results']) == 4 else None) if (snapshot := state()) else None)
            self.assertFalse(any('error' in row for row in updated['results']), updated['results'])
            actual = {row['label']: row['value'] for row in updated['state']['namedVariables']}
            self.assertEqual(next(value for name, value in actual.items() if name.endswith('.Coins')), 150)
            self.assertEqual(next(value for name, value in actual.items() if name.endswith('.Name')), '向导\n你好')
            self.assertEqual(len(list(backups.glob('*.json'))), 4)
            originals = [json.loads(path.read_text(encoding='utf-8')) for path in backups.glob('*.json')]
            self.assertEqual(next(row['before'] for row in originals if row['label'].endswith('.Coins')), 5)
            # Replayed command IDs acknowledge the same result without another write/backup.
            time.sleep(0.45)
            self.assertEqual(len(list(backups.glob('*.json'))), 4)
            row = next(row for row in names.values() if row['label'].endswith('.Coins'))
            params = {'scope': 'store', 'store': row['store'], 'name': row['name'], 'gameSessionId': 'stale'}
            payload = encode({'value': 1, 'params': params}).encode().hex()
            (session / 'commands.txt').write_text(token + '\n' + '\t'.join(['stale', 'setNamedVariable', '', '', 'tagged', payload]), encoding='ascii')
            rejected = self.wait(lambda: (snapshot if snapshot and snapshot['results'] and snapshot['results'][0]['id'] == 'stale' else None) if (snapshot := state()) else None)
            self.assertIn('error', rejected['results'][0])
            for ident, value in [('wrong-type', 'one'), ('fractional-int', 3.5), ('overflow', 4294967295)]:
                params['gameSessionId'] = initial['state']['gameSessionId']
                payload = encode({'value': value, 'params': params}).encode().hex()
                (session / 'commands.txt').write_text(token + '\n' + '\t'.join([ident, 'setNamedVariable', '', '', 'tagged', payload]), encoding='ascii')
                rejected = self.wait(lambda: (snapshot if snapshot and snapshot['results'] and snapshot['results'][0]['id'] == ident else None) if (snapshot := state()) else None)
                self.assertIn('error', rejected['results'][0])
            self.assertEqual(len(list(backups.glob('*.json'))), 4)
        finally:
            stop.write_text('stop')
            try:
                stdout, stderr = process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                stdout, stderr = process.communicate()
            self.assertEqual(process.returncode, 0, stderr)
        self.assertEqual(finish.read_text(encoding='utf-8'), '150,向导\n你好,True,7,0')

    def test_unity_mono_real_clr_state_reads_writes_and_backup(self):
        self.run_engine('Unity')

    def test_sgb_real_clr_state_reads_writes_and_backup(self):
        self.run_engine('SMILE GAME BUILDER')

    def test_bakin_real_clr_state_reads_writes_and_backup(self):
        self.run_engine('RPG Developer Bakin')

    def test_unity_legacy_framework_bridge(self):
        self.run_engine('Unity', legacy=True)

    def test_large_reference_only_graph_has_a_bounded_frame_scan(self):
        source = self.root / 'Scan.cs'
        source.write_text('''using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using Pinhao.ManagedAssist;
class EmptyNode { public List<EmptyNode> Children = new List<EmptyNode>(); }
class ScanRoot { public List<EmptyNode> Nodes = new List<EmptyNode>(); }
class Program {
    static void Main(string[] args) {
        var root = new ScanRoot();
        for (int i = 0; i < 200; i++) {
            var parent = new EmptyNode();
            for (int n = 0; n < 200; n++) parent.Children.Add(new EmptyNode());
            root.Nodes.Add(parent);
        }
        var timer = Stopwatch.StartNew();
        Bridge.Tick(root, "Unity");
        timer.Stop();
        Console.WriteLine(timer.ElapsedMilliseconds);
        typeof(Bridge).GetField("Last", BindingFlags.Static | BindingFlags.NonPublic).SetValue(null, DateTime.UtcNow.AddMinutes(1).Ticks);
        for (int i = 0; i < 4096; i++) Bridge.Tick(new object(), "Unity");
        var roots = (System.Collections.IDictionary)typeof(Bridge).GetField("Roots", BindingFlags.Static | BindingFlags.NonPublic).GetValue(null);
        Console.WriteLine(roots.Count);
    }
}''', encoding='utf-8')
        bridge = worker.ROOT / 'packages/runtime/managed/Bridge.cs'
        target = self.root / 'Scan.exe'
        result = subprocess.run([str(self.compiler), '/nologo', '/optimize+', '/target:exe', '/out:' + str(target), str(source), str(bridge)], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout)
        session = self.root / 'scan-session'
        session.mkdir()
        token = 'a' * 64
        (session / 'commands.txt').write_text(token, encoding='ascii')
        environment = {**os.environ, 'PINHAO_ASSIST_DIR': str(session), 'PINHAO_ASSIST_TOKEN': token}
        result = subprocess.run([str(target)], env=environment, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        elapsed, roots = map(int, result.stdout.strip().splitlines())
        self.assertLess(elapsed, 1000, 'A reference-only graph must fit a bounded frame scan')
        self.assertLessEqual(roots, 1024, 'Retain a bounded number of observed frame roots')
        self.assertTrue(json.loads((session / 'state.json').read_text())['state']['ready'])

    def test_il2cpp_and_missing_frame_are_reported(self):
        (self.game / 'Fixture_Data').mkdir()
        (self.game / 'GameAssembly.dll').write_bytes(b'native IL2CPP marker')
        report = managed.capabilities(self.game)
        self.assertFalse(report['supported'])
        self.assertIn('IL2CPP', report['detail'])
        self.assertEqual(report['modes'], [])
        self.assertFalse(managed.runtime(self.game, 'SMILE GAME BUILDER')['supported'])


if __name__ == '__main__':
    unittest.main()
