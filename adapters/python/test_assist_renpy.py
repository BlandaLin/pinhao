"""Ren'Py bridge logic, run with a neutral engine API double."""
import json
import os
from pathlib import Path
import sys
import tempfile
import textwrap
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from test_support import cleanup_temporary


class Default:
    def __init__(self, name, store='store', filename='game/script.rpy'):
        self.varname, self.store, self.filename = name, store, filename


class Python:
    def __init__(self, source, store='store', filename='game/script.rpy'):
        self.code, self.store, self.filename, self.hide = SimpleNamespace(source=source), store, filename, False


def tagged(value):
    if value is None:
        return b'n'
    if isinstance(value, bool):
        return b't' if value else b'f'
    if isinstance(value, (int, float)):
        return ('d' + str(value) + ';').encode()
    if isinstance(value, str):
        raw = value.encode('utf-8')
        return b's' + str(len(raw)).encode() + b':' + raw
    if isinstance(value, dict):
        return b'o' + str(len(value)).encode() + b':' + b''.join(tagged(key) + tagged(item) for key, item in value.items())
    if isinstance(value, list):
        return b'a' + str(len(value)).encode() + b':' + b''.join(tagged(item) for item in value)
    raise ValueError('Unsupported test value')


class RenPyAssistTests(unittest.TestCase):
    def setUp(self):
        parent = Path(__file__).resolve().parents[2] / 'local' / 'native-tests'
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.root = Path(self.temp.name)
        self.saved = 0
        self.restarted = 0
        self.retained = 0
        self.config = SimpleNamespace(periodic_callbacks=[], after_default_callbacks=[], after_load_callbacks=[], start_callbacks=[])
        self.values = {'coins': 10, 'enabled': True, 'player': '玩家', 'container': [], '_private': 2, 'nan': float('nan'), 'huge': 10 ** 999}
        self.persistent = SimpleNamespace(unlocked=False, counter=3, _internal=True)
        nodes = [Default(name) for name in self.values]
        nodes.extend([Default('bonus', 'store.stats'), Default('fixed', 'store.constants'),
                      Default('unlocked', 'store.persistent'), Default('counter', 'store.persistent'),
                      Default('engine_secret', filename='renpy/common/00test.rpy'), Default('internal', 'store.gui'),
                      Python('assigned = 4\npersistent.extra = True\ndef fn():\n    local_only = 0')])
        self.values.update(assigned=4, local_only=8, engine_secret=5)
        self.persistent.extra = True
        self.renpy = SimpleNamespace(config=self.config, store=SimpleNamespace(main_menu=False, persistent=self.persistent),
            ast=SimpleNamespace(Default=Default, Python=Python), game=SimpleNamespace(script=SimpleNamespace(all_stmts=nodes)),
            python=SimpleNamespace(store_dicts={'store': self.values, 'store.stats': {'bonus': 1.5},
                'store.constants': {'_constant': True, 'fixed': 2}, 'store.gui': {'internal': 3}}),
            exports=SimpleNamespace(list_files=lambda: ['script.rpyc'], save_persistent=self.save, restart_interaction=self.restart, retain_after_load=self.retain))
        self.code = textwrap.dedent((Path(__file__).parent / 'templates' / 'assist.rpy').read_text(encoding='utf-8').split('init 999 python hide:\n', 1)[1])
        self.module_patch = patch.dict(sys.modules, {'renpy': self.renpy})
        self.module_patch.start()

    def tearDown(self):
        self.module_patch.stop()
        cleanup_temporary(self.temp)

    def save(self):
        self.saved += 1

    def restart(self):
        self.restarted += 1

    def retain(self):
        self.retained += 1

    def install(self, enabled=True):
        with patch.dict(os.environ, {'PINHAO_ASSIST_DIR': str(self.root), 'PINHAO_ASSIST_TOKEN': 'token'} if enabled else {}, clear=True):
            exec(compile(self.code, 'assist.rpy', 'exec'), {})
        if enabled:
            self.bridge = self.config.periodic_callbacks[0].__self__

    def exchange(self, command_id='one', name='coins', value=20, scope='store', store='store', session=None, token='token'):
        params = {'scope': scope, 'store': store, 'name': name, 'gameSessionId': session or self.bridge.session}
        raw = tagged({'value': value, 'params': params}).hex()
        (self.root / 'commands.txt').write_text(token + '\n' + '\t'.join([command_id, 'setNamedVariable', '', '', 'tagged', raw]), encoding='ascii')
        self.bridge.last_poll = 0
        self.bridge.poll()
        return json.loads((self.root / 'state.json').read_text())

    def test_independent_launch_has_no_callbacks(self):
        self.install(False)
        self.assertEqual(self.config.periodic_callbacks, [])
        self.assertEqual(self.config.after_load_callbacks, [])

    def test_declared_existing_scalars_types_and_scopes(self):
        self.install()
        rows = self.bridge.variables()
        names = {row['name'] for row in rows}
        self.assertEqual(names, {'coins', 'enabled', 'player', 'bonus', 'unlocked', 'counter', 'assigned', 'extra'})
        bonus = next(row for row in rows if row['name'] == 'bonus')
        self.assertEqual((bonus['store'], bonus['type'], bonus['value']), ('store.stats', 'number', 1.5))
        self.assertEqual(next(row for row in rows if row['name'] == 'unlocked')['scope'], 'persistent')

    def test_typed_tagged_command_roundtrip_and_dedup(self):
        self.install()
        result = self.exchange(value=2.5)
        self.assertNotIn('error', result['results'][0])
        self.assertEqual(self.values['coins'], 2.5)
        self.exchange(name='player', value='保留\n制表\t与符号\\"', command_id='two')
        self.assertEqual(self.values['player'], '保留\n制表\t与符号\\"')
        self.exchange(name='player', value='second application', command_id='two')
        self.assertEqual(self.values['player'], '保留\n制表\t与符号\\"')
        bad = self.exchange(name='enabled', value=1, command_id='three')
        self.assertIn('error', bad['results'][0])
        self.assertIs(self.values['enabled'], True)
        self.assertEqual(self.restarted, 2)
        self.assertEqual(self.retained, 2)

    def test_persistent_flush_and_load_rollback_invalidate_session(self):
        self.install()
        self.exchange(name='unlocked', value=True, scope='persistent')
        self.assertIs(self.persistent.unlocked, True)
        self.assertEqual(self.saved, 1)
        previous = self.bridge.session
        self.config.after_load_callbacks[0]()
        self.assertNotEqual(previous, self.bridge.session)
        self.assertIn('error', self.exchange(command_id='stale-load', session=previous)['results'][0])
        previous = self.bridge.session
        self.config.after_default_callbacks[0]()
        self.assertNotEqual(previous, self.bridge.session)
        self.assertIn('error', self.exchange(command_id='stale-rollback', session=previous)['results'][0])
        self.assertEqual(self.values['coins'], 10)

    def test_wrong_token_and_unlisted_variables_do_not_write(self):
        self.install()
        self.assertIn('error', self.exchange(name='__dict__')['results'][0])
        prior = (self.root / 'state.json').read_bytes()
        self.exchange(value=9, token='wrong')
        self.assertEqual((self.root / 'state.json').read_bytes(), prior)
        self.assertEqual(self.values['coins'], 10)


if __name__ == '__main__':
    unittest.main()
