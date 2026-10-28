"""Neutral script bridge installation and optional real Godot/TJS runtime checks."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
from unittest import mock

import worker
import assist_script
import assist_transaction
import godot_native
import xp3_archive
from test_godot_native import simple_pack


def tagged(value):
    if value is None:
        return b'n'
    if type(value) is bool:
        return b't' if value else b'f'
    if type(value) in (int, float):
        return b'd' + str(value).encode() + b';'
    if isinstance(value, str):
        raw = value.encode('utf-8')
        return b's' + str(len(raw)).encode() + b':' + raw
    return b'o' + str(len(value)).encode() + b':' + b''.join(tagged(key) + tagged(item) for key, item in value.items())


class ScriptAssistTests(unittest.TestCase):
    def setUp(self):
        parent = Path(os.environ.get('PINHAO_TEST_TMP_ROOT') or worker.ROOT / 'local/native-tests')
        parent.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix='pinhao-script-assist-', dir=parent)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def write(self, root, relative, text):
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding='utf-8')
        return target

    def test_tyrano_standard_entry_installs_once_and_keeps_previous_scripts(self):
        game = self.root / 'game'
        self.write(game, 'index.html', '<html><body><script>original()</script></body></html>')
        self.write(game, 'tyrano/plugins/kag/kag.js', 'var neutral = true;')
        self.assertTrue(assist_script.capabilities(game)['supported'])
        for _ in range(2):
            self.assertEqual(assist_script.install({'outputDir': str(game)}, worker)['transport'], 'file')
        html = (game / 'index.html').read_text()
        self.assertEqual(html.count('data/others/PinHaoAssist.js'), 1)
        self.assertIn('original()', html)
        self.assertIn('saveSystemVariable', (game / 'data/others/PinHaoAssist.js').read_text())

    def test_second_install_file_failure_restores_original_bytes(self):
        game = self.root / 'rollback-game'
        entry = self.write(game, 'index.html', '<html><body>original</body></html>')
        self.write(game, 'tyrano/plugins/kag/kag.js', 'var neutral = true;')
        before = entry.read_bytes()
        real_copy = assist_transaction.atomic_copy
        def fail_entry(source, target):
            if target == entry:
                raise OSError('neutral second file failure')
            return real_copy(source, target)
        with mock.patch.object(assist_transaction, 'atomic_copy', side_effect=fail_entry):
            result = assist_script.install({'outputDir': str(game)}, worker)
        self.assertEqual(result['status'], 'install_failed')
        self.assertTrue(result['restored'])
        self.assertEqual(entry.read_bytes(), before)
        self.assertFalse((game / 'data/others/PinHaoAssist.js').exists())

    def test_kag_requires_actual_standard_startup_hook(self):
        game = self.root / 'kag'
        self.write(game, 'system/Initialize.tjs', 'KAGLoadScript("MainWindow.tjs");')
        self.assertFalse(assist_script.capabilities(game)['supported'])
        self.write(game, 'system/Initialize.tjs', 'KAGLoadScript(System.exePath + "AfterInit2.tjs");')
        self.write(game, 'AfterInit2.tjs', 'var original = 1;')
        for _ in range(2):
            self.assertTrue(assist_script.install({'outputDir': str(game)}, worker)['supported'])
        entry = (game / 'AfterInit2.tjs').read_text(encoding='utf-16')
        self.assertEqual(entry.count('PinHaoAssist.tjs'), 1)
        self.assertIn('var original = 1;', entry)

    def test_kag_restores_effective_compressed_embedded_and_loose_bootstrap(self):
        for embedded in (False, True):
            with self.subTest(embedded=embedded):
                game = self.root / ('kag-embedded' if embedded else 'kag-compressed')
                game.mkdir()
                original = self.write(self.root, 'sources/original.tjs', 'global.originalBootstrap = "preserved";')
                initialize = self.write(self.root, 'sources/Initialize.tjs', 'KAGLoadScript(System.exePath + "AfterInit2.tjs"); for(var i=2;;i++) { var name = "patch"+i+".xp3"; }')
                xp3_archive.pack(game / ('game.exe' if embedded else 'data.xp3'),
                                 [('system/Initialize.tjs', initialize), ('AfterInit2.tjs', original)],
                                 prefix=b'MZ' + b'\0' * 30 if embedded else b'', compress=True)
                patch = self.write(self.root, 'sources/patch.tjs', 'global.originalBootstrap = "patch2";')
                ignored = self.write(self.root, 'sources/ignored.tjs', 'global.originalBootstrap = "inactive patch4";')
                xp3_archive.pack(game / 'patch2.xp3', [('AfterInit2.tjs', patch)])
                xp3_archive.pack(game / 'patch4.xp3', [('AfterInit2.tjs', ignored)])
                self.assertTrue(assist_script.install({'outputDir': str(game)}, worker)['supported'])
                entry = (game / 'AfterInit2.tjs').read_text(encoding='utf-16')
                self.assertIn('global.originalBootstrap = "patch2";', entry)
                self.assertNotIn('inactive patch4', entry)
                self.assertLess(entry.index('patch2'), entry.index('PinHaoAssist.tjs'))
                self.assertEqual(assist_script.kag_scripts(game)['afterinit2.tjs'], entry)
        game = self.root / 'kag-data-loose'
        self.write(game, 'data/system/Initialize.tjs', 'KAGLoadScript(System.exePath + "AfterInit2.tjs");')
        self.write(game, 'data/AfterInit2.tjs', 'global.originalBootstrap = "data loose";')
        self.assertTrue(assist_script.install({'outputDir': str(game)}, worker)['supported'])
        self.assertIn('global.originalBootstrap = "data loose";', (game / 'AfterInit2.tjs').read_text(encoding='utf-16'))

    def test_pgmm_adds_native_plugin_and_nested_variable_definitions(self):
        game = self.root / 'pgmm'
        document = {'textList': [], 'gameInformation': {}, 'pluginList': [
            {'id': 41, 'folder': False, 'filename': 'plugins/previous.js', 'enabled': True}],
            'variableList': [{'id': 2, 'folder': True, 'children': [{'id': 7, 'name': 'Score', 'folder': False}]}],
            'switchList': [{'id': 3, 'name': 'Gate', 'folder': False}]}
        self.write(game, 'data/project.json', json.dumps(document))
        for _ in range(2):
            self.assertTrue(assist_script.install({'outputDir': str(game)}, worker)['supported'])
        result = json.loads((game / 'data/project.json').read_text())
        self.assertEqual(len(result['pluginList']), 2)
        self.assertEqual(result['pluginList'][0], document['pluginList'][0])
        self.assertEqual(result['pluginList'][1]['id'], 42)
        self.assertEqual(result['variableList'], document['variableList'])
        source = (game / 'data/plugins/PinHaoAssist.js').read_text()
        self.assertIn('"id": 7', source)
        self.assertIn('"store": "switches"', source)

    def test_godot_pack_preserves_payloads_and_registers_autoload(self):
        if godot_native.executable() is None:
            self.skipTest('Prepare GDRETools for native PCK checks')
        game = self.root / 'godot'
        game.mkdir()
        source = {'project.godot': b'config_version=5\n[application]\nconfig/name="Neutral"\n',
                  'main.gd': b'extends Node\nvar score = 4\n', 'asset.bin': b'unchanged asset'}
        simple_pack(game / 'game.pck', source)
        for _ in range(2):
            self.assertTrue(assist_script.install({'outputDir': str(game)}, worker)['supported'])
        unpacked = self.root / 'unpacked'
        godot_native.unpack(game / 'game.pck', unpacked, worker)
        self.assertEqual((unpacked / 'asset.bin').read_bytes(), source['asset.bin'])
        self.assertEqual((unpacked / 'main.gd').read_bytes(), source['main.gd'])
        self.assertEqual((unpacked / 'project.godot').read_text().count('PinHaoAssist='), 1)
        self.assertIn('FileAccess', (unpacked / '.pinhao/assist.gd').read_text())

    def state(self, directory):
        raw = (directory / 'state.json').read_bytes()
        return json.loads(raw.decode('utf-16') if raw.startswith(b'\xff\xfe') else raw.decode('utf-8-sig'))

    def wait_state(self, directory, predicate):
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            try:
                state = self.state(directory)
                if predicate(state):
                    return state
            except (OSError, ValueError, UnicodeError):
                pass
            time.sleep(0.1)
        logs = []
        for path in (*directory.parent.rglob('*.log'), *directory.parent.glob('native-error.txt')):
            raw = path.read_bytes()
            logs.append(raw.decode('utf-16') if raw.startswith(b'\xff\xfe') else raw.decode('utf-8', errors='replace')[-2500:])
        self.fail('Real engine did not produce the expected bridge state: ' + '\n'.join(logs))

    def command(self, directory, token, state, row, value, ident='neutral-update'):
        payload = {'value': value, 'params': {'scope': row['scope'], 'store': row['store'], 'name': row['name'], 'gameSessionId': state['state']['gameSessionId']}}
        (directory / 'commands.txt').write_text(token + '\n' + '\t'.join([ident, 'setNamedVariable', '', '', 'tagged', tagged(payload).hex()]), encoding='ascii')

    def test_real_godot_two_three_and_four_read_write_script_properties(self):
        for major, executable in ((2, worker.ROOT / 'local/dependencies/godot2/Godot_v2.1.6-stable_win64.exe'),
                                   (3, worker.ROOT / 'local/dependencies/godot3/Godot_v3.6.1-stable_win64.exe'),
                                   (4, worker.ROOT / 'local/dependencies/godot/Godot_v4.4.1-stable_win64_console.exe')):
            if not executable.is_file():
                continue
            with self.subTest(major=major):
                game = self.root / ('godot-' + str(major))
                directory = game / 'ipc'
                directory.mkdir(parents=True)
                token = 'neutral-token'
                (directory / 'commands.txt').write_text(token, encoding='ascii')
                self.write(game, 'project.godot', 'config_version=' + ('5' if major == 4 else '4') + '\n[application]\nrun/main_scene="res://main.tscn"\n[autoload]\nPinHaoAssist="*res://.pinhao/assist.gd"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n')
                if major == 2:
                    (game / 'project.godot').unlink()
                    self.write(game, 'engine.cfg', '[application]\nname="Neutral"\nmain_scene="res://main.tscn"\n[autoload]\nPinHaoAssist="*res://.pinhao/assist.gd"\n')
                self.write(game, '.pinhao/assist.gd', assist_script.godot_source(major))
                self.write(game, 'main.gd', 'extends Node\nvar score = 12.5\nvar nickname = "中性名字"\nvar opened = false\n')
                scene = '[gd_scene load_steps=2 format=2]\n[ext_resource path="res://main.gd" type="Script" id=1]\n[node name="Neutral" type="Node"]\nscript = ExtResource( 1 )\n'
                if major == 2:
                    scene = scene.replace('format=2', 'format=1').replace('script =', 'script/script =')
                self.write(game, 'main.tscn', scene)
                log = (game / 'runtime.log').open('wb')
                args = ['-nowindow', '-path', str(game)] if major == 2 else ['--headless' if major == 4 else '--no-window', '--path', str(game)]
                child = subprocess.Popen([str(executable), *args],
                                         stdout=log, stderr=subprocess.STDOUT, env={**os.environ, 'PINHAO_ASSIST_DIR': str(directory), 'PINHAO_ASSIST_TOKEN': token}, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                try:
                    state = self.wait_state(directory, lambda value: value['state']['ready'] and isinstance(value['state']['namedVariables'], list) and any(row['name'] == 'score' for row in value['state']['namedVariables']))
                    row = next(item for item in state['state']['namedVariables'] if item['name'] == 'score')
                    self.command(directory, token, state, row, 18.75)
                    result = self.wait_state(directory, lambda value: bool(value['results']))
                    self.assertNotIn('error', result['results'][0])
                    self.assertEqual(next(item['value'] for item in result['state']['namedVariables'] if item['name'] == 'score'), 18.75)
                finally:
                    child.terminate()
                    child.wait(timeout=8)
                    log.close()

    def test_real_tjs_dictionary_and_unicode_commands(self):
        runtime = worker.ROOT / 'local/assist-research/krkrz-runtime/krkrz_20171225/tvpwin64.exe'
        if not runtime.is_file():
            self.skipTest('Prepare official KiriKiriZ for native TJS checks')
        game = self.root / 'kag-runtime'
        directory = game / 'ipc'
        directory.mkdir(parents=True)
        executable = game / 'neutral.exe'
        shutil.copyfile(runtime, executable)
        token = 'neutral-token'
        (directory / 'commands.txt').write_text(token, encoding='ascii')
        self.write(game, 'PinHao-assist-session.json', json.dumps({'directory': str(directory), 'token': token}, ensure_ascii=False))
        bridge = (assist_script.TEMPLATES / 'assist_script.tjs').read_text()
        script = 'System.exitOnWindowClose = false;\nglobal.neutralWindow = new Window(); global.neutralWindow.caption = "PinHao neutral bridge test"; global.neutralWindow.visible = true;\nglobal.kag = %[flags:%[score:12.5, nickname:"中性名字", savedCalls:0], sflags:%[gallery:0], saveSystemVariables:function(){ global.kag.flags.savedCalls++; }];\n' + bridge
        (game / 'neutral-bridge.tjs').write_bytes(b'\xff\xfe' + script.encode('utf-16-le'))
        startup = 'try { global.logs = []; Debug.message = function(message) { global.logs.add(message); global.logs.save(System.exePath + "native-error.txt"); }; Scripts.execStorage(System.exePath + "neutral-bridge.tjs"); global.logs.add("bridge=" + typeof(global.PinhaoScriptAssist)); global.logs.save(System.exePath + "native-error.txt"); if(typeof global.PinhaoScriptAssist != "undefined") global.PinhaoScriptAssist.poll(); } catch(e) { [e.message, e.trace].save(System.exePath + "native-error.txt"); System.exit(); }'
        (game / 'data').mkdir()
        (game / 'data/startup.tjs').write_bytes(b'\xff\xfe' + startup.encode('utf-16-le'))
        child = subprocess.Popen([str(executable), '-nosplash', '-debugwin=no', '-console=no'], cwd=game,
                                 creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try:
            state = self.wait_state(directory, lambda value: value['state']['ready'])
            row = next(item for item in state['state']['namedVariables'] if item['name'] == 'nickname')
            self.command(directory, token, state, row, '桥接中文🌙')
            result = self.wait_state(directory, lambda value: bool(value['results']))
            self.assertNotIn('error', result['results'][0])
            self.assertEqual(next(item['value'] for item in result['state']['namedVariables'] if item['name'] == 'nickname'), '桥接中文🌙')
            row = next(item for item in result['state']['namedVariables'] if item['store'] == 'sf' and item['name'] == 'gallery')
            self.command(directory, token, result, row, 1, 'system-write')
            result = self.wait_state(directory, lambda value: any(item['id'] == 'system-write' for item in value['results']))
            self.assertNotIn('error', result['results'][0])
            self.assertEqual(next(item['value'] for item in result['state']['namedVariables'] if item['name'] == 'gallery'), 1)
            self.assertEqual(next(item['value'] for item in result['state']['namedVariables'] if item['name'] == 'savedCalls'), 1)
            time.sleep(0.85)
            self.assertEqual(next(item['value'] for item in self.state(directory)['state']['namedVariables'] if item['name'] == 'savedCalls'), 1)
            self.command(directory, token, result, row, 'wrong type', 'type-change')
            result = self.wait_state(directory, lambda value: any(item['id'] == 'type-change' for item in value['results']))
            self.assertIn('type', result['results'][0]['error'])
        finally:
            child.terminate()
            child.wait(timeout=8)


if __name__ == '__main__':
    unittest.main()
