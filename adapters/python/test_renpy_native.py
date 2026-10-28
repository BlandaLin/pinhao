"""Compiled RenPy recovery and display bindings, using neutral AST fixtures."""
import hashlib
import json
from pathlib import Path
import pickle
import struct
import tempfile
import unittest
import zlib

import worker
import renpy_native
import source_native
import text_formats
from test_source_worker import rpa


def compiled_fixture(legacy=False, unknown=False):
    decompiler = renpy_native._decompiler()
    factory = decompiler.renpycompat.CLASS_FACTORY
    label = factory('Label', 'renpy.ast')()
    label._name, label.filename, label.linenumber = 'start', 'game/script.rpy', 1
    say = factory('UnknownStatement' if unknown else 'Say', 'renpy.ast')()
    say.filename, say.linenumber, say.what = 'game/script.rpy', 2, 'Welcome [player_name].'
    ret = factory('Return', 'renpy.ast')()
    ret.filename, ret.linenumber = 'game/script.rpy', 3
    label.block = [say, ret]
    raw = decompiler.renpycompat.magic.safe_dumps(({'version': 5003000, 'key': 'unlocked'}, [label]), protocol=4)
    data = zlib.compress(raw)
    if legacy:
        return data
    return renpy_native.HEADER + struct.pack('<III', 1, 46, len(data)) + bytes(24) + data + bytes(16)


class RenPyNativeTests(unittest.TestCase):
    def setUp(self):
        parent = worker.ROOT / 'local' / 'native-tests'
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_standard_and_legacy_ast_recovery(self):
        for legacy in (False, True):
            script = self.root / ('old.rpyc' if legacy else 'new.rpyc')
            script.write_bytes(compiled_fixture(legacy))
            self.assertEqual(renpy_native.inspect_rpyc(script)['format'], 'rpyc1' if legacy else 'rpyc2')
            text, metadata, _ = renpy_native.decompile(script)
            self.assertIn('label start:', text)
            self.assertIn('"Welcome [player_name]."', text)
            self.assertEqual(metadata['version'], 5003000)

    def test_missing_sources_only_and_atomic_failure(self):
        game = self.root / 'game'
        game.mkdir()
        (game / 'original.rpy').write_text('label original:\n    return\n', encoding='utf-8')
        (game / 'original.rpyc').write_bytes(b'not decoded because source exists')
        (game / 'new.rpyc').write_bytes(compiled_fixture())
        report = renpy_native.recover_sources(self.root)
        self.assertEqual(len(report['decompiled']), 1)
        self.assertIn('Welcome [player_name].', (game / 'new.rpy').read_text(encoding='utf-8'))
        (game / 'another.rpyc').write_bytes(compiled_fixture())
        (game / 'zbad.rpyc').write_bytes(b'invalid')
        with self.assertRaises((ValueError, zlib.error)):
            renpy_native.recover_sources(self.root)
        self.assertFalse((game / 'another.rpy').exists())

    def test_pickle_globals_cannot_execute(self):
        marker = self.root / 'executed.txt'

        class Dangerous:
            def __reduce__(self):
                return (eval, ('__import__("pathlib").Path(' + repr(str(marker)) + ').touch()',))

        script = self.root / 'bad.rpyc'
        script.write_bytes(zlib.compress(pickle.dumps(Dangerous(), protocol=2)))
        with self.assertRaisesRegex(ValueError, 'global rejected'):
            renpy_native.decompile(script)
        self.assertFalse(marker.exists())
        for payload in (b'\x80\x02\x82\x01.', b'\x80\x02Pexternal\n.'):
            script.write_bytes(zlib.compress(payload))
            with self.assertRaisesRegex(ValueError, 'extension/reference rejected'):
                renpy_native.decompile(script)

    def test_unknown_ast_is_not_silently_replaced_with_pass(self):
        path = self.root / 'unknown.rpyc'
        path.write_bytes(compiled_fixture(unknown=True))
        with self.assertRaisesRegex(ValueError, 'additional decompiler recipe'):
            renpy_native.decompile(path)

    def test_bad_container_is_rejected(self):
        valid = compiled_fixture()
        bad = renpy_native.HEADER + struct.pack('<III', 1, 5, 8) + bytes(24) + valid[46:]
        path = self.root / 'bad.rpyc'
        path.write_bytes(bad)
        with self.assertRaisesRegex(ValueError, 'Overlapping'):
            renpy_native.inspect_rpyc(path)

    def test_markers_python_names_and_controls_are_complete_and_deduplicated(self):
        text = ('define e = Character("Guide")\n'
                'init python:\n'
                '    helper = Character(_("Assistant"))\n'
                '    message = _("Welcome [player_name] {b}friend{/b}")\n'
                '    resource_id = "not a display string"\n'
                '    method_("not a marker")\n'
                'screen panel():\n'
                '    text _("Status panel")\n'
                '    textbutton "Return" action Return()\n'
                'label start:\n'
                '    "Prose mentions _(not a call)"\n')
        path = self.root / 'script.rpy'
        path.write_text(text, encoding='utf-8')
        collector = text_formats.Collector(self.root, "Ren'Py", 'spans', 120)
        file, source = collector.document(path)
        source_native.renpy_entries(source, collector, file)
        renpy_native.collect_extra_entries(source, collector, file)
        values = [row['source_preview'] for row in collector.rows]
        self.assertEqual(values.count('Guide'), 1)
        self.assertEqual(values.count('Status panel'), 1)
        self.assertIn('Assistant', values)
        self.assertIn('Welcome [player_name] {b}friend{/b}', values)
        self.assertNotIn('not a display string', values)
        self.assertNotIn('not a marker', values)
        self.assertEqual(next(row for row in collector.rows if row['source_preview'].startswith('Welcome'))['tokens'],
                         ['{{CTRL0001}}', '{{CTRL0002}}', '{{CTRL0003}}'])

    def test_upstream_sources_match_fixed_hashes(self):
        root = Path(renpy_native.__file__).parent / 'vendor' / 'unrpyc'
        provenance = json.loads((root / 'provenance.json').read_text(encoding='utf-8'))
        self.assertEqual(provenance['commit'], renpy_native.UPSTREAM_COMMIT)
        for file, expected in provenance['files'].items():
            self.assertEqual(hashlib.sha256((root / file).read_bytes()).hexdigest(), expected, file)

    def test_rpyc_only_rpa2_and_rpa3_full_worker_roundtrip(self):
        for version in (2, 3):
            case = self.root / str(version)
            game = case / 'original'
            (game / 'game').mkdir(parents=True)
            (game / 'Game.exe').write_bytes(b'neutral launcher fixture')
            rpa(game / 'game' / 'script.rpa', {'script.rpyc': compiled_fixture(),
                                             'image.bin': b'neutral asset'}, version=version)
            original = hashlib.sha256((game / 'game' / 'script.rpa').read_bytes()).hexdigest()
            work, built, output = case / 'work', case / 'built', case / 'output'
            extracted = worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
            self.assertEqual(extracted['engine'], "Ren'Py")
            self.assertTrue(worker.roundtrip({'workspaceDir': str(work)})['byteIdentical'])
            unit = next(row for row in extracted['units'] if row['source'].startswith('Welcome'))
            worker.build({'workspaceDir': str(work), 'outputDir': str(built),
                          'translations': [{'legacyId': unit['id'], 'translation': 'Hello {{CTRL0001}}.'}]})
            assembled = worker.assemble({'gameDir': str(game), 'workspaceDir': str(work),
                                        'buildDir': str(built), 'outputDir': str(output)})
            self.assertIn('Hello [player_name].', (output / 'game' / 'script.rpy').read_text(encoding='utf-8'))
            self.assertFalse((output / 'game' / 'script.rpyc').exists())
            self.assertFalse((output / 'game' / 'script.rpa').exists())
            self.assertEqual((output / 'game' / 'image.bin').read_bytes(), b'neutral asset')
            self.assertEqual(assembled['launchPath'], str(output / 'Game.exe'))
            self.assertEqual(hashlib.sha256((game / 'game' / 'script.rpa').read_bytes()).hexdigest(), original)

    def archives_fixture(self, directory, config=''):
        game = directory / 'original'
        (game / 'game').mkdir(parents=True)
        rpa(game / 'game' / 'base.rpa', {'asset.bin': b'base', 'script.rpyc': compiled_fixture(),
                                        'script.rpy': b'label outdated:\n    "Outdated archived source"\n    return\n'})
        rpa(game / 'game' / 'zzpatch.rpa', {'asset.bin': b'patched', 'script.rpyc': compiled_fixture()})
        if config:
            (game / 'game' / 'order.rpy').write_text(config, encoding='utf-8')
        return game, {'archives': ['game/base.rpa', 'game/zzpatch.rpa']}

    def test_archive_patch_priority_and_compiled_ast_override_old_archived_source(self):
        game, info = self.archives_fixture(self.root)
        output = self.root / 'staged'
        report = renpy_native.merge_archives(game, output, info, worker)
        self.assertEqual(report['initialOrder'], ['game/zzpatch.rpa', 'game/base.rpa'])
        self.assertEqual((output / 'game' / 'asset.bin').read_bytes(), b'patched')
        self.assertFalse((output / 'game' / 'script.rpy').exists())
        renpy_native.recover_sources(output)
        recovered = (output / 'game' / 'script.rpy').read_text(encoding='utf-8')
        self.assertIn('Welcome [player_name].', recovered)
        self.assertNotIn('Outdated', recovered)

    def test_static_archive_order_and_loose_resources_keep_loader_priority(self):
        game, info = self.archives_fixture(self.root, 'init -100 python:\n    config.archives = ["base", "zzpatch"]\n')
        output = self.root / 'staged'
        report = renpy_native.merge_archives(game, output, info, worker)
        self.assertEqual(report['resourceOrder'], ['game/base.rpa', 'game/zzpatch.rpa'])
        self.assertEqual((output / 'game' / 'asset.bin').read_bytes(), b'base')
        (game / 'game' / 'asset.bin').write_bytes(b'loose resource')
        (game / 'game' / 'script.rpy').write_text('label custom:\n    "Loose source"\n    return\n', encoding='utf-8')
        second = self.root / 'staged2'
        renpy_native.merge_archives(game, second, info, worker)
        self.assertEqual((second / 'game' / 'asset.bin').read_bytes(), b'loose resource')
        renpy_native.recover_sources(second)
        self.assertIn('Loose source', (second / 'game' / 'script.rpy').read_text(encoding='utf-8'))

    def test_archive_configuration_mutations_and_dynamic_order(self):
        config = 'init python:\n    config.archives = ["zzpatch"]\n    config.archives.append("base")\n    config.archives.reverse()\n'
        game, info = self.archives_fixture(self.root, config)
        output = self.root / 'staged'
        report = renpy_native.merge_archives(game, output, info, worker)
        self.assertEqual(report['resourceOrder'], ['game/base.rpa', 'game/zzpatch.rpa'])
        (game / 'game' / 'order.rpy').write_text('init python:\n    if persistent.custom:\n        config.archives.reverse()\n', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Conditional/dynamic'):
            renpy_native.merge_archives(game, self.root / 'staged2', info, worker)


if __name__ == '__main__':
    unittest.main()
