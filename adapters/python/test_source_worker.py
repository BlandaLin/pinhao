"""Source engine native round trips and assembly, using neutral fixtures."""
import json
import os
from pathlib import Path
import pickle
import struct
import tempfile
import unittest
from unittest.mock import patch
import zlib

import worker
import asar_native
from test_worker import font_fixture, snapshot
from test_support import cleanup_temporary


def rpa(path, files, version=3):
    header = b'RPA-3.0 0000000000000000 12345678\n' if version == 3 else b'RPA-2.0 0000000000000000\n'
    key = 0x12345678 if version == 3 else 0
    offset = len(header)
    index = {}
    payload = bytearray()
    for name, value in files.items():
        index[name] = [(offset ^ key, len(value) ^ key)]
        payload.extend(value)
        offset += len(value)
    header = ('RPA-3.0 %016x %08x\n' % (offset, key) if version == 3 else 'RPA-2.0 %016x\n' % offset).encode('ascii')
    path.write_bytes(header + payload + zlib.compress(pickle.dumps(index, protocol=2)))


def asar(path, files):
    tree = {'files': {}}
    offset = 0
    payload = bytearray()
    for name, value in files.items():
        node = tree
        parts = name.split('/')
        for part in parts[:-1]:
            node = node['files'].setdefault(part, {'files': {}})
        node['files'][parts[-1]] = {'offset': str(offset), 'size': len(value)}
        payload.extend(value)
        offset += len(value)
    raw = json.dumps(tree).encode('utf-8')
    padded = raw + b'\0' * (-len(raw) % 4)
    header = struct.pack('<II', len(padded) + 4, len(raw)) + padded
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(struct.pack('<II', 4, len(header)) + header + payload)


class SourceNativeTests(unittest.TestCase):
    def setUp(self):
        parent = worker.ROOT / 'local' / 'native-tests'
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.root = Path(self.temp.name)
        self.game = self.root / 'game'
        self.game.mkdir()

    def tearDown(self):
        cleanup_temporary(self.temp)

    def test_renpy_non_dialogue_blocks_do_not_hide_literal_narration(self):
        script = self.game / 'game/script.rpy'
        script.parent.mkdir()
        script.write_text('init:\n    image inv ticket:\n        "images/ticket.png"\n'
                          '        zoom .45\ntransform pulse:\n    contains:\n        "animation-id"\n'
                          'label start:\n    "images/ticket.png"\n    show portrait:\n'
                          '        "portrait-id"\n    "A clear morning."\n', encoding='utf-8')
        work = self.root / 'blocks-work'
        result = worker.extract({'gameDir': str(self.game), 'workspaceDir': str(work)})
        self.assertEqual([row['source'] for row in result['units']], ['images/ticket.png', 'A clear morning.'])
        self.assertTrue(worker.roundtrip({'workspaceDir': str(work)})['byteIdentical'])
        self.assertEqual(result['units'][0]['context']['line'], 9)

    def test_renpy_show_text_uses_literal_display_span_and_preserves_atl(self):
        script = self.game / 'game/script.rpy'
        script.parent.mkdir()
        script.write_text('label start:\n    show text "Morning\\nHarbor" at truecenter\n'
                          '    show text "Arrival":\n        alpha 0.0\n        "animation-id"\n'
                          '    show "resource-id"\n    "A clear morning."\n', encoding='utf-8')
        work = self.root / 'cards-work'
        result = worker.extract({'gameDir': str(self.game), 'workspaceDir': str(work)})
        self.assertEqual(len(result['units']), 3)
        row = next(row for row in result['units'] if row['source'].startswith('Morning'))
        self.assertIn('Harbor', row['source'])
        self.assertTrue(worker.roundtrip({'workspaceDir': str(work)})['byteIdentical'])
        changed = '\u6e05\u6668' + ''.join(row['tokens']) + '\u6e2f\u53e3'
        built = self.root / 'cards-built'
        worker.build({'workspaceDir': str(work), 'outputDir': str(built),
                      'translations': [{'legacyId': row['id'], 'translation': changed}]})
        rewritten = (built / 'game/script.rpy').read_text(encoding='utf-8')
        self.assertIn('show text "\u6e05\u6668\\n\u6e2f\u53e3" at truecenter', rewritten)
        self.assertIn('"animation-id"', rewritten)
        self.assertIn('show "resource-id"', rewritten)

    def test_ks_control_only_blocks_are_not_translation_units(self):
        source = '*start\n[r][p]\n\n[trans method=crossfade][wt]\n\n123[p]\n\n... [p]\n\nWelcome[p]\n'
        (self.game / 'first.ks').write_text(source, encoding='utf-8')
        work = self.root / 'controls-work'
        result = worker.extract({'gameDir': str(self.game), 'workspaceDir': str(work)})
        self.assertEqual(len(result['units']), 3)
        self.assertTrue(any(row['source'].startswith('123') for row in result['units']))
        self.assertTrue(any(row['source'].startswith('...') for row in result['units']))
        self.assertTrue(worker.roundtrip({'workspaceDir': str(work)})['byteIdentical'])

    def test_tyrano_escape_prefix_is_outside_writable_page(self):
        scenario = self.game / 'data/scenario'
        scenario.mkdir(parents=True)
        (self.game / 'tyrano').mkdir()
        source = '*start\n___ Fill the blanks.[p]\n__ Keep the first escape.[p]\n'
        (scenario / 'first.ks').write_text(source, encoding='utf-8')
        work = self.root / 'escaped-work'
        result = worker.extract({'gameDir': str(self.game), 'workspaceDir': str(work)})
        self.assertEqual(len(result['units']), 2)
        self.assertTrue(result['units'][0]['source'].startswith('__ Fill'))
        row = result['units'][0]
        changed = '__ \u586b\u5199\u7a7a\u767d\u3002' + ''.join(row['tokens'])
        self.assertTrue(worker.roundtrip({'workspaceDir': str(work)})['byteIdentical'])
        built = self.root / 'escaped-built'
        worker.build({'workspaceDir': str(work), 'outputDir': str(built),
                      'translations': [{'legacyId': row['id'], 'translation': changed}]})
        actual = (built / 'data/scenario/first.ks').read_text(encoding='utf-8')
        self.assertIn('___ \u586b\u5199\u7a7a\u767d\u3002[p]', actual)
        self.assertIn('__ Keep the first escape.[p]', actual)

    def test_kag_underscore_is_not_assumed_to_be_tyrano_escape(self):
        (self.game / 'first.ks').write_text('*start\n_Literal blank.[p]\n', encoding='utf-8')
        result = worker.extract({'gameDir': str(self.game), 'workspaceDir': str(self.root / 'kag-underscore')})
        self.assertEqual(result['engine'], 'KiriKiri/KAG')
        self.assertTrue(result['units'][0]['source'].startswith('_Literal blank.'))

    def test_renpy_inline_display_calls_preserve_script_arguments(self):
        script = self.game / 'game/script.rpy'
        script.parent.mkdir()
        script.write_text('label start:\n    "A bright morning."\n    $ renpy.say(None, "Follow the river.")\n    $ renpy.notify("New chapter")\n    $ renpy.say(None, next_line)\n    $ call_unknown("resource-id")\n', encoding='utf-8')
        work = self.root / 'inline-work'
        result = worker.extract({'gameDir': str(self.game), 'workspaceDir': str(work)})
        self.assertEqual({row['source'] for row in result['units']}, {'A bright morning.', 'Follow the river.', 'New chapter'})
        self.assertTrue(worker.roundtrip({'workspaceDir': str(work)})['byteIdentical'])
        line = next(row for row in result['units'] if row['source'] == 'Follow the river.')
        built = self.root / 'inline-built'
        worker.build({'workspaceDir': str(work), 'outputDir': str(built),
                      'translations': [{'legacyId': line['id'], 'translation': '沿着河流前进。'}]})
        rewritten = (built / 'game/script.rpy').read_text(encoding='utf-8')
        self.assertIn('renpy.say(None, "沿着河流前进。")', rewritten)
        self.assertIn('renpy.say(None, next_line)', rewritten)
        self.assertIn('call_unknown("resource-id")', rewritten)

    def test_zero_display_packed_source_retains_native_assembly_with_explicit_allow_empty(self):
        resources = {'tyrano/tyrano.js': b'const engine = 1;',
                     'data/scenario/first.ks': b'*start\n[eval exp="state = 1"]\n',
                     'index.html': b'<html><body></body></html>'}
        asar(self.game / 'resources/app.asar', resources)
        (self.game / 'Game.exe').write_bytes(b'neutral launcher, never executed')
        original = snapshot(self.game)
        with self.assertRaises(worker.WorkerError):
            worker.extract({'gameDir':str(self.game), 'workspaceDir':str(self.root / 'default-work')})
        work, built, output = [self.root / name for name in ('empty-work', 'built', 'output')]
        result = worker.extract({'gameDir':str(self.game), 'workspaceDir':str(work), 'allowEmpty':True})
        self.assertEqual(result['units'], [])
        self.assertTrue(worker.roundtrip({'workspaceDir':str(work)})['byteIdentical'])
        worker.build({'workspaceDir':str(work), 'outputDir':str(built)})
        assembled = worker.assemble({'gameDir':str(self.game), 'workspaceDir':str(work),
                                     'buildDir':str(built), 'outputDir':str(output), 'share':False})
        self.assertEqual(assembled['engine'], 'TyranoScript')
        for file, data in resources.items():
            self.assertEqual((output / 'resources/app' / file).read_bytes(), data)
        self.assertEqual(snapshot(self.game), original)

    def pipeline(self, engine, change=None, font=False):
        (self.game / 'Game.exe').write_bytes(b'neutral executable fixture')
        (self.game / 'save').mkdir(exist_ok=True)
        (self.game / 'save' / 'file1.save').write_bytes(b'private fixture')
        before = snapshot(self.game)
        info = worker.probe({'gameDir': str(self.game)})
        self.assertEqual(info['engine'], engine)
        self.assertTrue(info['capabilities']['extract'])
        self.work = self.root / 'work'
        result = worker.extract({'gameDir': str(self.game), 'workspaceDir': str(self.work)})
        self.assertEqual(result['engine'], engine)
        self.assertTrue(worker.roundtrip({'workspaceDir': str(self.work)})['byteIdentical'])
        changes = []
        if change:
            row = next(row for row in result['units'] if row['source'] == change[0])
            changes.append({'legacyId': row['id'], 'translation': change[1]})
        built = self.root / 'built'
        worker.build({'workspaceDir': str(self.work), 'outputDir': str(built), 'translations': changes})
        self.output = self.root / 'output'
        args = {'gameDir': str(self.game), 'workspaceDir': str(self.work), 'buildDir': str(built), 'outputDir': str(self.output)}
        if font:
            path = self.root / 'font.ttf'
            font_fixture(path)
            args['fontPath'] = str(path)
        assembled = worker.assemble(args)
        self.assertFalse((self.output / 'save').exists())
        self.assertEqual(snapshot(self.game), before)
        self.assertEqual(assembled['launchPath'], str(self.output / 'Game.exe'))
        self.assertEqual(worker.native.validate(self.work)[2]['changed'], 0)
        return result, assembled

    def test_tyrano_whole_paragraph_names_and_controls(self):
        scenario = self.game / 'data' / 'scenario'
        scenario.mkdir(parents=True)
        (self.game / 'tyrano').mkdir()
        (self.game / 'index.html').write_text('<html><head></head><body></body></html>', encoding='utf-8')
        script = '*start\n[chara_new name="lin" jname="Lin" storage="lin.png"]\n#lin:happy\nFirst line\nSecond line[r]Done[p]\n[glink text="Continue" target="*next"]\n[iscript]\nf.label="internal";\n[endscript]\n'
        (scenario / 'first.ks').write_text(script, encoding='utf-8')
        result, assembled = self.pipeline('TyranoScript', ('Continue', '\u7ee7\u7eed'), font=True)
        self.assertTrue(any(row['source'].startswith('First line{{CTRL') and 'Second line' in row['source'] for row in result['units']))
        output = (self.output / 'data' / 'scenario' / 'first.ks').read_text(encoding='utf-8')
        self.assertIn('text="\u7ee7\u7eed" target="*next"', output)
        self.assertIn('f.label="internal";', output)
        self.assertIn('#lin:happy', output)
        self.assertNotIn('lin', [row['source'] for row in result['units']])
        self.assertIn('Lin', [row['source'] for row in result['units']])
        self.assertIn('font', assembled)
        self.assertIn('pinhao-font.css', (self.output / 'index.html').read_text(encoding='utf-8'))

    def test_kag_cp932_changes_become_unicode_bom(self):
        (self.game / 'first.ks').write_bytes('*start\r\n#\u6797\r\n\u3088\u3046\u3053\u305d[p]\r\n'.encode('cp932'))
        _, assembled = self.pipeline('KiriKiri/KAG', ('\u3088\u3046\u3053\u305d{{CTRL0001}}', '\u6b22\u8fce{{CTRL0001}}'))
        raw = (self.output / 'first.ks').read_bytes()
        self.assertTrue(raw.startswith(b'\xff\xfe'))
        self.assertIn('#\u6797', raw.decode('utf-16'))
        self.assertIn('\u6b22\u8fce[p]', raw.decode('utf-16'))
        self.assertTrue(worker.capabilities('KiriKiri/KAG')['font'])

    def test_tyrano_standard_asar_is_assembled_as_loose_electron_app(self):
        asar(self.game / 'resources' / 'app.asar', {
            'data/scenario/first.ks': b'*start\nWelcome[p]\n',
            'package.json': b'{"main":"index.html"}',
            'index.html': b'<html><head></head><body>neutral</body></html>',
            'tyrano/tyrano.js': b'// neutral engine marker',
            'data/bgimage/neutral.png': b'neutral asset',
            'save/private.json': b'{"personal":"private save"}',
            'img/save/template.bin': b'authored static resource',
            'cache/story.bin': b'authored static cache',
        })
        self.pipeline('TyranoScript', font=True)
        self.assertFalse((self.output / 'resources' / 'app.asar').exists())
        self.assertTrue((self.output / 'resources' / 'app' / 'data' / 'scenario' / 'first.ks').is_file())
        self.assertEqual((self.output / 'resources' / 'app' / 'data' / 'bgimage' / 'neutral.png').read_bytes(), b'neutral asset')
        self.assertIn('pinhao-font.css', (self.output / 'resources' / 'app' / 'index.html').read_text(encoding='utf-8'))
        self.assertFalse((self.output / 'resources/app/save/private.json').exists())
        self.assertEqual((self.output / 'resources/app/img/save/template.bin').read_bytes(), b'authored static resource')
        self.assertEqual((self.output / 'resources/app/cache/story.bin').read_bytes(), b'authored static cache')

    def test_asar_unpacked_sidecar_and_bad_paths(self):
        archive = self.root / 'app.asar'
        asar(archive, {'native.bin': b'fixture'})
        raw = archive.read_bytes()
        header_size = struct.unpack('<I', raw[4:8])[0]
        tree = {'files': {'native.bin': {'size': 7, 'unpacked': True}}}
        body = json.dumps(tree).encode('utf-8')
        padded = body + b'\0' * (-len(body) % 4)
        header = struct.pack('<II', len(padded) + 4, len(body)) + padded
        archive.write_bytes(struct.pack('<II', 4, len(header)) + header)
        sidecar = Path(str(archive) + '.unpacked')
        sidecar.mkdir()
        (sidecar / 'native.bin').write_bytes(b'fixture')
        asar_native.unpack(archive, self.root / 'unpacked', worker)
        self.assertEqual((self.root / 'unpacked' / 'native.bin').read_bytes(), b'fixture')
        asar(archive, {'../bad': b'fixture'})
        with self.assertRaises(ValueError):
            asar_native.index(archive)

    def test_asar_materializes_only_needed_sources_and_streams_original_media(self):
        resources = {'tyrano/tyrano.js': b'// runtime', 'package.json': b'{"main":"index.html"}',
                     'index.html': b'<html><head></head></html>',
                     'data/scenario/first.ks': b'*start\nWelcome[p]\n',
                     'data/bgimage/title.png': b'original image',
                     'data/bgm/theme.ogg': b'original audio' * 1000,
                     'node_modules/runtime/index.js': b'original dependency',
                     'save/private.json': b'private state'}
        archive = self.game / 'resources/app.asar'
        asar(archive, resources)
        original = snapshot(self.game)
        work, built, output = [self.root / name for name in ('selective-work', 'selective-built', 'selective-output')]
        extracted = worker.extract({'gameDir': str(self.game), 'workspaceDir': str(work)})
        metadata = worker.native.read(work / 'technical/product-source.json')
        view = Path(metadata['nativeSource'])
        self.assertEqual(metadata['archiveFormat'], 'asar')
        self.assertFalse((view / 'resources/app/data/bgimage/title.png').exists())
        self.assertFalse((view / 'resources/app/data/bgm/theme.ogg').exists())
        self.assertFalse((view / 'resources/app/node_modules').exists())
        self.assertEqual(extracted['images'][0]['file'], 'resources/app/data/bgimage/title.png')
        self.assertTrue(extracted['images'][0]['archived'])
        request = {'gameDir': str(self.game), 'workspaceDir': str(work),
                   'files': ['resources/app/data/bgimage/title.png']}
        materialized = worker.materialize_source(request)
        self.assertEqual(materialized['sourceRoot'], str(view))
        self.assertEqual((view / request['files'][0]).read_bytes(), resources['data/bgimage/title.png'])
        self.assertFalse((view / 'resources/app/data/bgm/theme.ogg').exists())
        self.assertEqual(worker.materialize_source(request)['materialized'], 1)
        for file in ['../outside.png', 'resources/app/save/private.json', 'resources/app/missing.png']:
            with self.assertRaises(ValueError):
                worker.materialize_source({**request, 'files': [file]})
        row = extracted['units'][0]
        changed = '\u6b22\u8fce' + ''.join(row['tokens'])
        self.assertTrue(worker.roundtrip({'workspaceDir': str(work)})['byteIdentical'])
        worker.build({'workspaceDir': str(work), 'outputDir': str(built),
                      'translations': [{'legacyId': row['id'], 'translation': changed}]})
        assembled = worker.assemble({'gameDir': str(self.game), 'workspaceDir': str(work),
                                     'buildDir': str(built), 'outputDir': str(output), 'share': False})
        self.assertEqual(assembled['asarPackage']['members'], len(resources))
        for file in ['data/bgimage/title.png', 'data/bgm/theme.ogg', 'node_modules/runtime/index.js']:
            self.assertEqual((output / 'resources/app' / file).read_bytes(), resources[file])
        self.assertIn('\u6b22\u8fce[p]', (output / 'resources/app/data/scenario/first.ks').read_text(encoding='utf-8'))
        self.assertFalse((output / 'resources/app/save').exists())
        self.assertEqual(snapshot(self.game), original)

    def test_asar_source_materialization_rejects_changed_view_or_original(self):
        archive = self.game / 'resources/app.asar'
        asar(archive, {'tyrano/tyrano.js': b'// marker',
                       'data/scenario/first.ks': b'*start\nWelcome[p]\n',
                       'data/bgimage/title.png': b'original image'})
        work = self.root / 'materialization-work'
        worker.extract({'gameDir': str(self.game), 'workspaceDir': str(work)})
        request = {'gameDir': str(self.game), 'workspaceDir': str(work),
                   'files': ['resources/app/data/bgimage/title.png']}
        first = worker.materialize_source(request)
        target = Path(first['sourceRoot']) / request['files'][0]
        target.write_bytes(b'changed image')
        with self.assertRaisesRegex(ValueError, 'materialized member changed'):
            worker.materialize_source(request)
        target.unlink()
        with archive.open('ab') as stream:
            stream.write(b'original changed')
        with self.assertRaises(worker.WorkerError) as changed:
            worker.materialize_source(request)
        self.assertEqual(changed.exception.code, 'SOURCE_CHANGED')
        self.assertFalse(target.exists())

    def test_asar_interrupted_member_does_not_leave_a_partial_source_on_resume(self):
        archive = self.root / 'atomic.asar'
        asar(archive, {'image.png': b'original image bytes'})
        output = self.root / 'atomic-view'
        with patch.object(asar_native, '_copy_exact', side_effect=OSError('interrupted read')):
            with self.assertRaisesRegex(OSError, 'interrupted'):
                asar_native.unpack(archive, output, worker, names=['image.png'])
        self.assertFalse((output / 'image.png').exists())
        self.assertEqual(list(output.glob('*.part')), [])
        asar_native.unpack(archive, output, worker, names=['image.png'], existing=True)
        self.assertEqual((output / 'image.png').read_bytes(), b'original image bytes')

    def test_renpy_source_skips_python_assets_existing_languages(self):
        scripts = self.game / 'game'
        scripts.mkdir()
        source = ('define lin = Character("Lin")\n'
                  'image bg = "images/back.png"\n'
                  'init python:\n    internal = "private-key-name"\n    "not dialogue"\n'
                  'label start:\n    scene bg "not display"\n    lin happy "Hello [player]. {b}Welcome{/b}"\n'
                  '    "A whole\n    logical line"\n'
                  '    menu:\n        "Enter" if ready:\n            jump house\n'
                  'screen controls():\n    textbutton _("Continue") action Return()\n'
                  '    imagebutton:\n        idle "gui/start_idle.png"\n        hover "gui/start_hover.png"\n'
                  'style menu_button:\n    background "gui/menu.png"\n'
                  'translate other start_hash:\n    "Inline translation"\n'
                  'translate other strings:\n    old "Old string"\n    new "Existing translation"\n')
        (scripts / 'script.rpy').write_text(source, encoding='utf-8')
        (scripts / 'script.rpyc').write_bytes(b'obsolete compiled fixture')
        (scripts / 'tl' / 'other').mkdir(parents=True)
        (scripts / 'tl' / 'other' / 'script.rpy').write_text('translate other start:\n    "Other language"\n', encoding='utf-8')
        result, assembled = self.pipeline("Ren'Py", ('Enter', '\u8fdb\u5165'), font=True)
        values = [row['source'] for row in result['units']]
        self.assertIn('Lin', values)
        self.assertIn('A whole logical line', values)
        self.assertIn('Continue', values)
        self.assertNotIn('not dialogue', values)
        self.assertNotIn('images/back.png', values)
        self.assertNotIn('Other language', values)
        self.assertNotIn('gui/start_idle.png', values)
        self.assertNotIn('gui/start_hover.png', values)
        self.assertNotIn('gui/menu.png', values)
        self.assertNotIn('Inline translation', values)
        self.assertNotIn('Existing translation', values)
        self.assertFalse((self.output / 'game' / 'script.rpyc').exists())
        self.assertIn('"\u8fdb\u5165" if ready:', (self.output / 'game' / 'script.rpy').read_text(encoding='utf-8'))
        self.assertIn('font', assembled)
        self.assertFalse(any(item['kind'] == 'compiled_script_requires_decompiler' for item in result['reviewItems']))

    def test_renpy_rpa2_and_rpa3_native_source_assembly(self):
        for version in (2, 3):
            with self.subTest(version=version):
                game = self.game / str(version)
                game.mkdir()
                (game / 'game').mkdir()
                rpa(game / 'game' / 'script.rpa', {'script.rpy': b'label start:\n    "Welcome"\n', 'images/neutral.png': b'asset'}, version)
                original_game = self.game
                self.game = game
                # Keep independent work paths for each archive version.
                saved_root = self.root
                self.root = self.root / ('v%d' % version)
                self.root.mkdir()
                self.pipeline("Ren'Py", ('Welcome', '\u6b22\u8fce'))
                self.assertFalse((self.output / 'game' / 'script.rpa').exists())
                self.assertFalse((self.output / 'game' / 'script.rpyc').exists())
                self.assertEqual((self.output / 'game' / 'images' / 'neutral.png').read_bytes(), b'asset')
                self.assertIn('\u6b22\u8fce', (self.output / 'game' / 'script.rpy').read_text(encoding='utf-8'))
                self.game, self.root = original_game, saved_root

    def test_renpy_default_archive_order_follows_engine(self):
        folder = self.game / 'game'
        folder.mkdir()
        rpa(folder / 'a.rpa', {'script.rpy': b'label start:\n    "A"\n'})
        rpa(folder / 'b.rpa', {'script.rpy': b'label start:\n    "B"\n'})
        result = worker.extract({'gameDir': str(self.game), 'workspaceDir': str(self.root / 'work')})
        self.assertEqual([row['source'] for row in result['units']], ['B'])

    def test_godot_scene_display_properties_only(self):
        (self.game / 'project.godot').write_text('config_version=5\n', encoding='utf-8')
        (self.game / 'Game.pck').write_bytes(b'original exported pack fixture')
        scene = '[gd_scene format=3]\n[ext_resource path="res://script.gd" id="1"]\n[node name="Menu" type="Control"]\ntext = "Continue"\nresource_name = "internal-id"\n[node name="Story" type="Label"]\ntext = "Welcome [b]friend[/b]"\n'
        (self.game / 'menu.tscn').write_text(scene, encoding='utf-8')
        before = snapshot(self.game)
        work = self.root / 'godot-work'
        self.assertEqual(worker.probe({'gameDir': str(self.game)})['engine'], 'Godot')
        result = worker.extract({'gameDir': str(self.game), 'workspaceDir': str(work)})
        self.assertTrue(worker.roundtrip({'workspaceDir': str(work)})['byteIdentical'])
        row = next(row for row in result['units'] if row['source'] == 'Continue')
        built_dir = self.root / 'godot-built'
        worker.build({'workspaceDir': str(work), 'outputDir': str(built_dir),
                      'translations': [{'id': row['id'], 'translation': '\u7ee7\u7eed'}]})
        self.assertEqual(len(result['units']), 2)
        built = (built_dir / 'menu.tscn').read_text(encoding='utf-8')
        self.assertIn('text = "\u7ee7\u7eed"', built)
        self.assertIn('resource_name = "internal-id"', built)
        self.assertIn('res://script.gd', built)
        with patch.dict(os.environ, {'PINHAO_GODOT_RUNTIME': ''}):
            with self.assertRaises(worker.WorkerError) as error:
                worker.assemble({'gameDir': str(self.game), 'workspaceDir': str(work),
                                 'buildDir': str(built_dir), 'outputDir': str(self.root / 'godot-output')})
        self.assertEqual(error.exception.code, 'GODOT_RUNTIME_MISSING')
        self.assertFalse((self.root / 'godot-output').exists())
        self.assertEqual(snapshot(self.game), before)

    def test_pgmm_native_json_resource_identity(self):
        project = {'textList': [{'id': 8, 'name': 'InternalLabel', 'folder': False, 'text': {'ja_JP': 'Welcome'}}], 'gameInformation': {'title': 'Neutral'}, 'sceneList': [{'id': 1}]}
        (self.game / 'project.json').write_text(json.dumps(project), encoding='utf-8')
        self.pipeline('Pixel Game Maker MV', ('Welcome', '\u6b22\u8fce'))
        actual = json.loads((self.output / 'project.json').read_text(encoding='utf-8'))
        self.assertEqual(actual['textList'][0]['text']['ja_JP'], '\u6b22\u8fce')
        self.assertEqual(actual['textList'][0]['name'], 'InternalLabel')
        self.assertEqual(actual['sceneList'], project['sceneList'])

    def test_compiled_engines_do_not_claim_native_route(self):
        (self.game / 'game').mkdir()
        (self.game / 'game' / 'script.rpyc').write_bytes(b'fixture')
        self.assertFalse(worker.probe({'gameDir': str(self.game)})['capabilities']['extract'])
        rpa(self.game / 'game' / 'compiled.rpa', {'story.rpyc': b'compiled fixture', 'image.png': b'asset'})
        self.assertTrue(worker.probe({'gameDir': str(self.game)})['capabilities']['extract'])
        with self.assertRaises((ValueError, zlib.error)):
            worker.extract({'gameDir': str(self.game), 'workspaceDir': str(self.root / 'bad-compiled')})
        other = self.root / 'godot'
        other.mkdir()
        (other / 'game.pck').write_bytes(b'fixture')
        self.assertFalse(worker.probe({'gameDir': str(other)})['capabilities']['extract'])
        xp3 = self.root / 'kag'
        xp3.mkdir()
        (xp3 / 'data.xp3').write_bytes(b'fixture')
        self.assertFalse(worker.probe({'gameDir': str(xp3)})['capabilities']['extract'])

    def test_pgmm_shared_title_validation(self):
        project = {'textList': [], 'gameInformation': {'title': 'Neutral'}}
        (self.game / 'project.json').write_text(json.dumps(project), encoding='utf-8')
        (self.game / 'info.json').write_text('{"title":"Neutral"}', encoding='utf-8')
        work = self.root / 'work'
        result = worker.extract({'gameDir': str(self.game), 'workspaceDir': str(work)})
        first, second = result['units']
        with self.assertRaisesRegex(ValueError, 'Shared display fields'):
            worker.validate({'workspaceDir': str(work), 'translations': [{'id': first['id'], 'translation': 'Title A'}, {'id': second['id'], 'translation': 'Title B'}]})

    def test_kag_scenario_layout_does_not_become_tyrano(self):
        scenario = self.game / 'data' / 'scenario'
        scenario.mkdir(parents=True)
        (scenario / 'first.ks').write_text('*start\nWelcome[p]\n', encoding='utf-8')
        self.assertEqual(worker.probe({'gameDir': str(self.game)})['engine'], 'KiriKiri/KAG')

    def test_tyrano_reference_ids_and_cross_file_display_names(self):
        (self.game / 'tyrano').mkdir()
        scenario = self.game / 'data' / 'scenario'
        scenario.mkdir(parents=True)
        (scenario / 'characters.ks').write_text('[chara_new name="yuko" jname="Yuko" storage="yuko.png"]\n', encoding='utf-8')
        (scenario / 'scene.ks').write_text('*start\n#yuko:angry\nWelcome[p]\n', encoding='utf-8')
        result, _ = self.pipeline('TyranoScript', ('Yuko', '\u4f18\u5b50'))
        self.assertNotIn('yuko', [row['source'] for row in result['units']])
        self.assertIn('name="yuko" jname="\u4f18\u5b50"', (self.output / 'data' / 'scenario' / 'characters.ks').read_text(encoding='utf-8'))
        self.assertIn('#yuko:angry', (self.output / 'data' / 'scenario' / 'scene.ks').read_text(encoding='utf-8'))

    def test_godot_bbcode_control_loss_is_rejected(self):
        (self.game / 'project.godot').write_text('config_version=5\n', encoding='utf-8')
        (self.game / 'scene.tscn').write_text('[gd_scene format=3]\n[node name="Story" type="RichTextLabel"]\ntext = "Welcome [url=https://example.invalid]friend[/url]"\n', encoding='utf-8')
        work = self.root / 'work'
        result = worker.extract({'gameDir': str(self.game), 'workspaceDir': str(work)})
        row = result['units'][0]
        self.assertEqual(len(row['tokens']), 2)
        with self.assertRaises(ValueError):
            worker.build({'workspaceDir': str(work), 'outputDir': str(self.root / 'bad'), 'translations': [{'id': row['id'], 'translation': 'Welcome friend'}]})

    def test_new_engine_control_loss_and_source_drift_rejected(self):
        (self.game / 'first.ks').write_text('*start\nWelcome[r]friend[p]\n', encoding='utf-8')
        self.pipeline('KiriKiri/KAG')
        row = next(row for sheet in worker.native.load_work(self.work)[1].values() for row in sheet['units'])
        with self.assertRaises(ValueError):
            worker.build({'workspaceDir': str(self.work), 'outputDir': str(self.root / 'bad'), 'translations': [{'id': row['id'], 'translation': 'lost controls'}]})
        (self.game / 'first.ks').write_text('*start\nchanged\n', encoding='utf-8')
        with self.assertRaises(worker.WorkerError) as error:
            worker.assemble({'gameDir': str(self.game), 'workspaceDir': str(self.work), 'buildDir': str(self.root / 'built'), 'outputDir': str(self.root / 'drift')})
        self.assertEqual(error.exception.code, 'SOURCE_CHANGED')


if __name__ == '__main__':
    unittest.main()
