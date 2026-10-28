"""Godot pack contracts and optional real-engine compiled-resource acceptance."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest
import zlib

import worker
import godot_native as godot
from test_worker import snapshot


def png(red, green, blue):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(bytes((0, red, green, blue, 255)))) + chunk(b'IEND', b'')


def simple_pack(path, entries, version=2, major=4):
    header = b'GDPC' + struct.pack('<4I', version, major, 4, 1)
    if version >= 2:
        header += struct.pack('<IQ', 0, 0)
    header += bytes(64) + struct.pack('<I', len(entries))
    directory_size = sum(4 + len(name.encode()) + 32 + (4 if version >= 2 else 0) for name in entries)
    offset = len(header) + directory_size
    directory, payload = bytearray(), bytearray()
    for name, value in entries.items():
        encoded = name.encode()
        directory.extend(struct.pack('<I', len(encoded)) + encoded + struct.pack('<QQ', offset, len(value)) + hashlib.md5(value).digest())
        if version >= 2:
            directory.extend(struct.pack('<I', 0))
        payload.extend(value)
        offset += len(value)
    path.write_bytes(header + directory + payload)


class GodotPackContracts(unittest.TestCase):
    def setUp(self):
        parent = worker.ROOT / 'local/native-tests'
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_pack_formats_and_embedded_trailer(self):
        for version, major in ((0, 2), (1, 3), (2, 4)):
            pack = self.root / ('v%d.pck' % version)
            simple_pack(pack, {'res://project.godot': b'config_version=5\n', 'res://scene.tscn': b'scene'}, version, major)
            index = godot.pack_index(pack)
            self.assertEqual(index['format'], version)
            self.assertEqual(index['entries'][0]['file'], 'project.godot')
            unpacked = self.root / ('v%d' % version)
            godot.unpack(pack, unpacked, worker)
            self.assertEqual((unpacked / 'scene.tscn').read_bytes(), b'scene')
        pack = self.root / 'v2.pck'
        data = pack.read_bytes()
        # Version 2 absolute file offsets need an embedded-location adjustment.
        prefix = b'MZ neutral embedded fixture'
        raw = bytearray(data)
        struct.pack_into('<I', raw, 20, 2)
        exe = self.root / 'embedded.exe'
        exe.write_bytes(prefix + raw + struct.pack('<Q4s', len(raw), b'GDPC'))
        self.assertEqual(godot.pack_index(exe)['offset'], len(prefix))
        godot.unpack(exe, self.root / 'embedded', worker)
        self.assertEqual((self.root / 'embedded/scene.tscn').read_bytes(), b'scene')

    def test_pack_rejects_bad_paths_collisions_and_hashes(self):
        pack = self.root / 'bad.pck'
        for entries in ({'res://../outside': b'x'}, {'res://CON': b'x'}, {'res://A': b'x', 'res://a': b'y'}):
            simple_pack(pack, entries)
            with self.assertRaises(ValueError):
                godot.pack_index(pack, worker.safe_member)
        simple_pack(pack, {'res://scene.tscn': b'original'})
        raw = bytearray(pack.read_bytes())
        raw[-1] ^= 1
        pack.write_bytes(raw)
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            godot.unpack(pack, self.root / 'bad-output', worker)

    def test_config_autoload_order_and_message_keys(self):
        text = 'config_version=5\n[autoload]\nExisting="*res://old.gd"\n[rendering]\nvalue=1\n'
        result = godot.config_setting(text, 'autoload', 'PinHaoLocalization', '"*res://.pinhao/startup.gd"', first=True)
        self.assertLess(result.index('PinHaoLocalization='), result.index('Existing='))
        self.assertEqual(godot.config_setting(result, 'autoload', 'PinHaoLocalization', '"*res://.pinhao/startup.gd"', first=True), result)
        self.assertIn('value=1', result)
        source = self.root / 'source'
        source.mkdir()
        collector = worker.source_native.formats.Collector(source, 'Godot', 'spans', 120)
        path = source / 'main.gd'
        path.write_text('extends Control\nfunc _ready():\n\t$Label.text = "Whole [b]message[/b]"\n\tprint(tr("KEY", "context"))\n\tprint(tr_n("Apple", "Apples", max(1, count), "fruit"))\n\tprint(tr("dynamic" + suffix))\n\t# tr("COMMENT")\n', encoding='utf-8')
        file, script = collector.document(path)
        messages = {}
        godot.script_entries(script, collector, file, messages)
        godot.message_catalog(source, collector, messages)
        collector.finish(self.root / 'work')
        self.assertIn(('KEY', 'context', None), messages)
        self.assertIn(('Apple', 'fruit', 'Apples'), messages)
        self.assertNotIn(('dynamic', '', None), messages)
        self.assertNotIn(('COMMENT', '', None), messages)
        row = next(row for row in collector.rows if row['source'] == 'KEY')
        self.assertEqual(row['kind'], 'translation_message')
        self.assertEqual(collector.units[row['id']]['file'], '.pinhao/messages.json')
        self.assertEqual(len(collector.rows[0]['tokens']), 2)

    def test_quoted_resource_values_preserve_physical_newlines_and_offsets(self):
        cases = [
            ('"First line\nSecond line"', 'First line\nSecond line'),
            ('"First line\r\nSecond line"', 'First line\r\nSecond line'),
            ("'First line\nSecond line'", 'First line\nSecond line'),
            ('"A \\"quoted\\" label\nNext"', 'A "quoted" label\nNext'),
            ('"""First line\nSecond line"""', 'First line\nSecond line'),
            ('"First' + '\\' + '\nSecond"', 'FirstSecond'),
            ('"First' + '\\' + '\r\nSecond"', 'FirstSecond'),
            ('"First' + '\\' + '\nSecond\nThird"', 'FirstSecond\nThird'),
        ]
        for literal, expected in cases:
            with self.subTest(literal=literal):
                document = 'text = ' + literal + '\nnext = 1\n'
                self.assertEqual(godot.value_at(document, 7), (expected, 7 + len(literal)))
        self.assertIsNone(godot.value_at('"An unclosed\nvalue', 0))
        self.assertIsNone(godot.value_at('"An invalid \\x escape"', 0))

    def test_multiline_scene_display_roundtrip_and_changed_readback(self):
        source = self.root / 'source'
        source.mkdir()
        path = source / 'interface.tscn'
        text = ('[gd_scene format=2]\n[node name="Heading" type="Label"]\n'
                'text = "Harbor\'s Light\nA new morning"\n'
                '[node name="Button" type="Button"]\ntext = "Continue"\n')
        path.write_text(text, encoding='utf-8', newline='')
        original = path.read_bytes()
        collector = worker.source_native.formats.Collector(source, 'Godot', 'spans', 120)
        file, document = collector.document(path)
        godot.scene_entries(document, collector, file)
        self.assertEqual([row['source_preview'] for row in collector.rows],
                         ["Harbor's Light\nA new morning", 'Continue'])
        work = self.root / 'work'
        collector.finish(work)
        self.assertTrue(worker.roundtrip({'workspaceDir': str(work)})['byteIdentical'])
        output = self.root / 'built'
        worker.build({'workspaceDir': str(work), 'outputDir': str(output),
                      'translations': [{'id': collector.rows[0]['id'],
                                        'translation': '\u6d77\u6e2f\u4e4b\u5149' + collector.rows[0]['tokens'][0]
                                        + '\u65b0\u7684\u6e05\u6668'}]})
        reread = worker.source_native.formats.Collector(output, 'Godot', 'spans', 120)
        file, changed = reread.document(output / 'interface.tscn')
        godot.scene_entries(changed, reread, file)
        self.assertEqual([row['source_preview'] for row in reread.rows],
                         ['\u6d77\u6e2f\u4e4b\u5149\n\u65b0\u7684\u6e05\u6668', 'Continue'])
        self.assertEqual(path.read_bytes(), original)

    def test_script_display_data_helpers_and_unresolved_coverage(self):
        source = self.root / 'source'
        source.mkdir()
        helper = ('extends Control\nfunc make_caption(parent, caption: String):\n'
                  '\tvar label = Label.new()\n\tlabel.text = caption\n\treturn label\n')
        script = ('extends Control\n'
                  'const STORY = [{"id": "opening", "title": "The Arrival",\n'
                  '  "body": "Welcome to the village.", "pages": ["A whole paragraph.", "Another paragraph."]}]\n'
                  'const FLAGS = ["opening", "complete"]\n'
                  'const EXTRA = ["A custom narrative with no proven display sink."]\n'
                  'func _ready():\n'
                  '\tmake_caption(self, "Continue")\n'
                  '\tsay("One complete sentence.")\n'
                  '\t$Label.text = ("Available" if flags["ready"] else "Locked")\n'
                  '\t$Label.text = STORY[0]["body"]\n'
                  '\t$Label.text = tr("CATALOG_KEY")\n'
                  '\t$Label.text = """First line\nSecond line"""\n'
                  '\t$Label.text = "# This is visible, not a comment."\n'
                  '\tload("res://scenes/world.tscn")\n'
                  '\t# say("A commented sentence stays untouched.")\n'
                  '\tvar debug = \'set_text("A fake call stays untouched.")\'\n')
        (source / 'helper.gd').write_text(helper, encoding='utf-8')
        path = source / 'story.gd'
        path.write_text(script, encoding='utf-8')
        collector = worker.source_native.formats.Collector(source, 'Godot', 'spans', 120)
        file, text = collector.document(path)
        messages = {}
        candidates = godot.script_entries(text, collector, file, messages, godot.display_wrappers([helper, script]))
        extracted = {row['source_preview'] for row in collector.rows}
        expected = {'The Arrival', 'Welcome to the village.', 'A whole paragraph.', 'Another paragraph.',
                    'Continue', 'One complete sentence.', 'Available', 'Locked',
                    'First line\nSecond line', '# This is visible, not a comment.'}
        self.assertEqual(extracted, expected)
        self.assertIn(('CATALOG_KEY', '', None), messages)
        self.assertTrue(any(item['source'] == 'A custom narrative with no proven display sink.' for item in candidates))
        self.assertFalse(any('commented sentence' in item['source'] for item in candidates))
        work = self.root / 'work'
        collector.finish(work)
        self.assertTrue(worker.roundtrip({'workspaceDir': str(work)})['byteIdentical'])
        translations = [{'id': row['id'], 'translation': '\u7ee7\u7eed\u6545\u4e8b'}
                        for row in collector.rows if row['source_preview'] == 'Continue']
        output = self.root / 'built'
        worker.build({'workspaceDir': str(work), 'outputDir': str(output), 'translations': translations})
        changed = (output / 'story.gd').read_text(encoding='utf-8')
        self.assertIn('make_caption(self, "\u7ee7\u7eed\u6545\u4e8b")', changed)
        self.assertIn('"id": "opening"', changed)
        self.assertIn('STORY[0]["body"]', changed)
        self.assertIn('tr("CATALOG_KEY")', changed)
        self.assertEqual(path.read_text(encoding='utf-8'), script)

    def test_ambiguous_helper_names_and_logic_identity(self):
        scripts = ['func label(first, second):\n\tx.text = first\n',
                   'func label(first, second):\n\tx.text = second\n']
        self.assertNotIn('label', godot.display_wrappers(scripts))
        source = self.root / 'source'
        source.mkdir()
        path = source / 'main.gd'
        path.write_text('extends Control\nfunc _ready():\n'
                        '\t$Label.text = catalog["internal lookup"]\n'
                        '\t$Label.text = "Yes" if key == "internal identity" else "No"\n'
                        '\t$Label.text = lookup("An internal lookup key")\n'
                        '\t$Label.text = &"StringNameIdentity"\n'
                        '\t$Label.text = ^"Node/Path"\n', encoding='utf-8')
        collector = worker.source_native.formats.Collector(source, 'Godot', 'spans', 120)
        file, text = collector.document(path)
        candidates = godot.script_entries(text, collector, file, {})
        self.assertEqual({row['source_preview'] for row in collector.rows}, {'Yes', 'No'})
        internal = next(item for item in candidates if item['source'] == 'internal identity')
        self.assertEqual(internal['classification'], 'logic_identity')

    def test_json_dialogue_resources_keep_keys_ids_and_original_bytes(self):
        source = self.root / 'source'
        source.mkdir()
        path = source / 'narrative.json'
        text = ('{ "scenes": [{"id":"intro", "trigger":"start", "title":"The Invitation", '
                '"pages":["A complete opening paragraph.", "An escaped \\"word\\" appears."], '
                '"choices":[{"id":"accept", "text":"Accept the invitation"}]}], '
                '"items":{"key_01":{"name":"Silver Key", "desc":"Opens the garden gate."}}, '
                '"asset":"res://art/scene.png", "internal_names":["An unresolved custom list."] }')
        path.write_text(text, encoding='utf-8')
        collector = worker.source_native.formats.Collector(source, 'Godot', 'spans', 120)
        file, document = collector.document(path)
        candidates = godot.json_display_entries(document, collector, file)
        extracted = {row['source_preview'] for row in collector.rows}
        self.assertEqual(extracted, {'The Invitation', 'A complete opening paragraph.', 'An escaped "word" appears.',
                                     'Accept the invitation', 'Silver Key', 'Opens the garden gate.'})
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]['path'], ['internal_names', 0])
        work = self.root / 'work'
        collector.finish(work)
        self.assertTrue(worker.roundtrip({'workspaceDir': str(work)})['byteIdentical'])
        output = self.root / 'built'
        worker.build({'workspaceDir': str(work), 'outputDir': str(output),
                      'translations': [{'id': row['id'], 'translation': '\u5b8c\u6574\u5bf9\u767d'}
                                       for row in collector.rows]})
        built = json.loads((output / 'narrative.json').read_text(encoding='utf-8'))
        self.assertEqual(built['scenes'][0]['id'], 'intro')
        self.assertEqual(built['scenes'][0]['trigger'], 'start')
        self.assertEqual(built['scenes'][0]['choices'][0]['id'], 'accept')
        self.assertEqual(built['scenes'][0]['pages'], ['\u5b8c\u6574\u5bf9\u767d', '\u5b8c\u6574\u5bf9\u767d'])
        self.assertEqual(path.read_text(encoding='utf-8'), text)
        for invalid in ('{"text":"One", "text":"Two"}', '{"text":"One",}', '{"text":"One"} extra'):
            empty = worker.source_native.formats.Collector(source, 'Godot', 'spans', 120)
            with self.assertRaises(ValueError):
                godot.json_display_entries(invalid, empty, file)
            self.assertEqual(empty.rows, [])

    def test_missing_script_data_resource_becomes_an_adaptation_candidate(self):
        collector = worker.source_native.formats.Collector(self.root, 'Godot', 'spans', 120)
        candidates = godot.script_entries('var data = JSON.parse_string(FileAccess.get_file_as_string("res://content/dialogue.json"))',
                                          collector, 'main.gd', {})
        self.assertEqual(candidates[0]['kind'], 'godot_missing_resource')
        self.assertEqual(candidates[0]['resource'], 'content/dialogue.json')

    def test_explicit_empty_native_workbench_keeps_configuration_and_source(self):
        if not godot.executable():
            self.skipTest('Prepare the pinned Godot resource tool')
        game = self.root / 'empty-game'
        game.mkdir()
        (game / 'project.godot').write_text('config_version=5\n[application]\nrun/main_scene="res://empty.tscn"\n', encoding='utf-8')
        (game / 'empty.tscn').write_text('[gd_scene format=3]\n[node name="Main" type="Node"]\n', encoding='utf-8')
        before = snapshot(game)
        with self.assertRaises(ValueError):
            godot.extract(game, self.root / 'default-empty-work', godot.probe(game), worker, {})
        work = self.root / 'allowed-empty-work'
        result = godot.extract(game, work, godot.probe(game), worker, {'allowEmpty':True})
        self.assertEqual(result['units'], [])
        self.assertEqual(result['files'], 2)
        self.assertTrue(worker.roundtrip({'workspaceDir':str(work)})['byteIdentical'])
        built = self.root / 'empty-built'
        worker.build({'workspaceDir':str(work), 'outputDir':str(built)})
        for file, data in before.items():
            self.assertEqual((built / file).read_bytes(), data)
        self.assertEqual(snapshot(game), before)


RUNTIME = os.environ.get('PINHAO_TEST_GODOT')
if not RUNTIME:
    candidate = worker.ROOT / 'local/dependencies/godot/Godot_v4.4.1-stable_win64.exe'
    RUNTIME = str(candidate) if candidate.is_file() else None


@unittest.skipUnless(RUNTIME and godot.executable(), 'Godot runtime and GDRETools enable native acceptance')
class GodotRuntimeAcceptance(unittest.TestCase):
    VERSION = '4.4.1'
    RUNTIME = RUNTIME

    def setUp(self):
        parent = worker.ROOT / 'local/native-tests'
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.root = Path(self.temp.name)
        self.game = self.root / 'game'
        self.game.mkdir()
        self.source = self.root / 'source'
        self.source.mkdir()
        self.major = int(self.VERSION[0])
        self.pack_format = 2 if self.major >= 4 else 1 if self.major == 3 else 0
        config = 'config_version=' + ('5' if self.major >= 4 else '4') + '\n[application]\nconfig/name="Neutral"\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n'
        (self.source / 'project.godot').write_text(config, encoding='utf-8')
        if self.major == 2:
            (self.source / 'project.godot').unlink()
            (self.source / 'engine.cfg').write_text('[application]\nname="Neutral"\nmain_scene="res://main.tscn"\n', encoding='utf-8')
        scene = '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://main.gd" id="1"]\n[node name="Main" type="Control"]\nscript = ExtResource("1")\n[node name="Label" type="Label" parent="."]\ntext = "Whole scene text"\n'
        if self.major <= 3:
            scene = scene.replace('format=3', 'format=2').replace('id="1"', 'id=1').replace('ExtResource("1")', 'ExtResource(1)')
        if self.major == 2:
            scene = scene.replace('format=2', 'format=1').replace('script =', 'script/script =')
        (self.source / 'main.tscn').write_text(scene, encoding='utf-8')
        font_check = '$Label.get_theme_font("font").has_char(20013)' if self.major >= 4 else '$Label.get_font("font") is DynamicFont and $Label.get_font("font").font_data.font_path == "res://.pinhao/font.ttf"'
        script = 'extends Control\nfunc _ready():\n\tprint("PINHAO_SCENE=", $Label.text)\n\tprint("PINHAO_DYNAMIC=", tr("Dynamic greeting"))\n\tprint("PINHAO_FONT=", ' + font_check + ')\n\tget_tree().quit()\n'
        title = 'Globals.get("application/name")' if self.major == 2 else 'ProjectSettings.get_setting("application/config/name")'
        script = script.replace('func _ready():\n', 'func _ready():\n\tprint("PINHAO_TITLE=", ' + title + ')\n')
        if self.major == 2:
            script = script.replace('$Label', 'get_node("Label")').replace(' is DynamicFont', ' extends DynamicFont').replace('get_node("Label").text', 'get_node("Label").get_text()').replace('.font_data.font_path', '.get_font_data().get_font_path()')
            script = script.replace('\tprint("PINHAO_FONT=",', '\tcall_deferred("_finish")\nfunc _finish():\n\tprint("PINHAO_FONT=",')
        texture = 'res://.pinhao/images/' + hashlib.sha256(b'picture.png').hexdigest()[:20] + '.tres'
        check = 'FileAccess.file_exists(' + json.dumps(texture) + ')' if self.major >= 4 else 'File.new().file_exists(' + json.dumps(texture) + ')'
        image = 'get_image()' if self.major >= 4 else 'get_data()'
        script = script.replace('\tget_tree().quit()', '\tif ' + check + ':\n\t\tvar texture = load("res://picture.png")\n\t\tprint("PINHAO_IMAGE=", texture.' + image + '.get_pixel(0, 0).g > 0.9)\n\tget_tree().quit()')
        if self.major == 3:
            script = script.replace('\t\tprint("PINHAO_IMAGE=", texture.get_data().get_pixel(0, 0).g > 0.9)', '\t\tvar pixels = texture.get_data()\n\t\tpixels.lock()\n\t\tprint("PINHAO_IMAGE=", pixels.get_pixel(0, 0).g > 0.9)\n\t\tpixels.unlock()')
        if self.major >= 4:
            script = script.replace('\tget_tree().quit()',
                                    '\tvar data = JSON.parse_string(FileAccess.get_file_as_string("res://content/story.json"))\n'
                                    '\tprint("PINHAO_JSON_TITLE=", data["title"])\n'
                                    '\tprint("PINHAO_JSON_BODY=", data["pages"][0])\n'
                                    '\tprint("PINHAO_HELPER=", message_caption("A helper label"))\n'
                                    '\tget_tree().quit()')
            script += ('func message_caption(value):\n\tvar label = Label.new()\n\tlabel.text = value\n'
                       '\tvar result = label.text\n\tlabel.free()\n\treturn result\n')
        (self.source / 'main.gd').write_text(script, encoding='utf-8')
        self.resources = self.root / 'resources'
        self.resources.mkdir()
        if self.major >= 4:
            (self.resources / 'content').mkdir()
            (self.resources / 'content/story.json').write_text(
                '{"id":"story_01", "title":"The Invitation", "pages":["Whole JSON paragraph."]}', encoding='utf-8')
        (self.resources / 'picture.png').write_bytes(png(0, 0, 255))
        for name, payload in {'save/private.json': b'{"personal":"private save"}',
                              'PinHao-assist-session.json': b'{"token":"neutral-private-session"}',
                              'img/save/template.bin': b'authored static resource',
                              'cache/story.bin': b'authored static cache'}.items():
            target = self.resources / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
        (self.resources / '.godot/exported').mkdir(parents=True)
        maker = 'extends SceneTree\nfunc _initialize():\n\tvar destination = OS.get_cmdline_user_args()[0]\n\tassert(ResourceSaver.save(load("res://main.tscn"), destination + "/.godot/exported/main.scn") == OK)\n\tassert(ProjectSettings.save_custom(destination + "/project.binary") == OK)\n\tquit()\n'
        if self.major <= 3:
            maker = maker.replace('_initialize', '_init').replace('OS.get_cmdline_user_args()[0]', 'OS.get_cmdline_args()[OS.get_cmdline_args().size() - 1]').replace('ResourceSaver.save(load("res://main.tscn"), destination + "/.godot/exported/main.scn")', 'ResourceSaver.save(destination + "/.godot/exported/main.scn", load("res://main.tscn"))')
        if self.major == 2:
            maker = maker.replace('OS.get_cmdline_args()[OS.get_cmdline_args().size() - 1]', json.dumps(self.resources.as_posix(), ensure_ascii=False)).replace('ProjectSettings.save_custom(destination + "/project.binary")', 'Globals.save_custom(destination + "/engine.cfb")')
            maker = maker.replace('\tassert(Globals.save_custom', '\tGlobals.set("remap/all", StringArray(["res://main.tscn", "res://.godot/exported/main.scn", "res://main.gd", "res://main.gdc"]))\n\tassert(Globals.save_custom')
            maker = maker.replace('\tassert(Globals.save_custom', '\tGlobals.set_persisting("remap/all", true)\n\tassert(Globals.save_custom')
        (self.source / 'make.gd').write_text(maker, encoding='utf-8')
        self.engine('--headless', '--path', str(self.source), '--script', 'res://make.gd', *(['--', str(self.resources)] if self.major >= 3 else []))
        godot.run(godot.executable(), ['--compile=' + str(self.source / 'main.gd'), '--bytecode=' + self.VERSION, '--output=' + str(self.resources)])
        (self.resources / 'main.tscn.remap').write_text('[remap]\npath="res://.godot/exported/main.scn"\n', encoding='utf-8')
        (self.resources / 'main.gd.remap').write_text('[remap]\npath="res://main.gdc"\n', encoding='utf-8')
        # A binary-only copy is the actual input; the workbench never sees source files.
        shutil.copyfile(self.RUNTIME, self.game / 'Neutral.exe')
        (self.game / 'save').mkdir()
        (self.game / 'save/slot.save').write_bytes(b'private fixture')

    def tearDown(self):
        self.temp.cleanup()

    def engine(self, *args):
        switches = {'--headless': '-nowindow', '--main-pack': '-main_pack', '--path': '-path', '--script': '-s'} if self.major == 2 else {'--headless': '--no-window'} if self.major == 3 else {}
        args = [switches.get(arg, arg) for arg in args]
        result = subprocess.run([self.RUNTIME, *args], capture_output=True, timeout=60,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        output = self.decode(result.stdout + result.stderr)
        self.assertEqual(result.returncode, 0, output)
        self.assertNotIn('SCRIPT ERROR:', output)
        self.assertNotIn('Parse Error:', output)
        return output

    def decode(self, raw):
        try:
            return raw.decode('utf-8')
        except UnicodeDecodeError:
            return raw.decode('mbcs' if os.name == 'nt' else 'utf-8', errors='replace')

    def pipeline(self, embedded=False, image_overlay=False, text_overlay=False):
        pack = self.game / ('Neutral.exe' if embedded else 'Neutral.pck')
        args = ['--pck-create=' + str(self.resources), '--pck-version=' + str(self.pack_format), '--pck-engine-version=' + self.VERSION, '--output=' + str(pack)]
        if embedded:
            # Input and output executables are separate files.
            pack = self.game / 'Embedded.exe'
            standalone = self.root / 'original.pck'
            args[-1] = '--output=' + str(standalone)
            godot.run(godot.executable(), args)
            godot.embed_pack(self.game / 'Neutral.exe', standalone, pack)
            (self.game / 'Neutral.exe').unlink()
        else:
            godot.run(godot.executable(), args)
        original = snapshot(self.game)
        self.assertIn('PINHAO_DYNAMIC=Dynamic greeting', self.engine('--headless', '--main-pack', str(pack)))
        info = godot.probe(self.game)
        self.assertEqual(info['support'], godot.READY)
        work = self.root / 'work'
        result = godot.extract(self.game, work, info, worker, {})
        self.assertTrue(worker.roundtrip({'workspaceDir': str(work)})['byteIdentical'])
        words = {'Whole scene text': '\u6574\u53e5\u573a\u666f\u6587\u5b57', 'Dynamic greeting': '\u52a8\u6001\u95ee\u5019', 'Neutral': '\u4e2d\u6027\u6d4b\u8bd5'}
        if self.major >= 4:
            words.update({'The Invitation': '\u9080\u8bf7', 'Whole JSON paragraph.': '\u5b8c\u6574\u6570\u636e\u6bb5\u843d\u3002',
                          'A helper label': '\u81ea\u5b9a\u4e49\u6807\u7b7e'})
        translations = [{'id': row['id'], 'translation': words[row['source']]}
                        for row in result['units'] if row['source'] in words]
        self.assertEqual(len(translations), len(words))
        built = self.root / 'built'
        worker.build({'workspaceDir': str(work), 'outputDir': str(built), 'translations': translations})
        output = self.root / 'output'
        font = worker.ROOT / 'local/runtime/fonts/LXGWWenKai-Regular.ttf'
        self.assertTrue(font.is_file())
        args = {'gameDir': str(self.game), 'workspaceDir': str(work), 'buildDir': str(built),
                'outputDir': str(output), 'fontPath': str(font)}
        sealed = snapshot(built)
        if text_overlay:
            overlay = self.root / 'text-overlay'
            rows = []
            for rel, before, after in (
                    ('main.gd', '\u81ea\u5b9a\u4e49\u6807\u7b7e', '\u8865\u5145\u6807\u7b7e'),
                    ('content/story.json', '\u5b8c\u6574\u6570\u636e\u6bb5\u843d\u3002', '\u8865\u5145\u6570\u636e\u6bb5\u843d\u3002')):
                original_bytes = (built / rel).read_bytes()
                target = overlay / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(original_bytes.decode('utf-8').replace(before, after), encoding='utf-8')
                rows.append({'file': rel, 'sha256': worker.digest_file(target),
                             'sourceHash': hashlib.sha256(original_bytes).hexdigest()})
            args.update(adapterOverlayDir=str(overlay), adapterOverlayFiles=rows)
        if image_overlay:
            overlay = self.root / 'overlay'
            overlay.mkdir()
            (overlay / 'picture.png').write_bytes(png(0, 255, 0))
            args.update(assetOverlayDir=str(overlay), assetOverlayFiles=[{'file': 'picture.png', 'sha256': worker.digest_file(overlay / 'picture.png'), 'sourceHash': worker.digest_file(self.resources / 'picture.png')}])
        result = godot.assemble(args, worker)
        self.assertFalse(result['sourceOnly'])
        self.assertFalse((output / 'save').exists())
        members = {entry['file'] for entry in godot.pack_index(output / result['pack'])['entries']}
        self.assertNotIn('save/private.json', members)
        self.assertNotIn('PinHao-assist-session.json', members)
        self.assertIn('img/save/template.bin', members)
        self.assertIn('cache/story.bin', members)
        output_text = self.engine('--headless', '--main-pack', str(output / result['pack']))
        self.assertIn('PINHAO_SCENE=\u6574\u53e5\u573a\u666f\u6587\u5b57', output_text)
        self.assertIn('PINHAO_DYNAMIC=\u52a8\u6001\u95ee\u5019', output_text)
        self.assertIn('PINHAO_TITLE=\u4e2d\u6027\u6d4b\u8bd5', output_text)
        if self.major >= 4:
            self.assertIn('PINHAO_JSON_TITLE=\u9080\u8bf7', output_text)
            self.assertIn('PINHAO_JSON_BODY=' + ('\u8865\u5145' if text_overlay else '\u5b8c\u6574') + '\u6570\u636e\u6bb5\u843d\u3002', output_text)
            self.assertIn('PINHAO_HELPER=' + ('\u8865\u5145\u6807\u7b7e' if text_overlay else '\u81ea\u5b9a\u4e49\u6807\u7b7e'), output_text)
        self.assertIn('pinhao_font=true', output_text.lower())
        if image_overlay:
            self.assertIn('pinhao_image=true', output_text.lower())
            self.assertFalse((output / 'picture.png').exists())
            self.assertEqual(result['imageFiles'], 1)
        # The generated game also starts itself without a workbench or --main-pack.
        launched = subprocess.run([result['launchPath'], '--headless' if self.major >= 4 else '--no-window' if self.major == 3 else '-nowindow'], cwd=output, capture_output=True, timeout=60,
                                  creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        launched_text = self.decode(launched.stdout + launched.stderr)
        self.assertEqual(launched.returncode, 0, launched_text)
        self.assertIn('PINHAO_DYNAMIC=\u52a8\u6001\u95ee\u5019', launched_text)
        self.assertEqual(snapshot(self.game), original)
        self.assertEqual(snapshot(built), sealed)
        if text_overlay:
            self.assertEqual(result['adapterFiles'], 2)
        return work, built

    def test_external_pack_game(self):
        self.pipeline()

    def test_embedded_pack_game(self):
        self.pipeline(embedded=True)

    def test_native_png_resource_overlay(self):
        self.pipeline(image_overlay=True)

    def test_native_text_and_png_overlay_preserve_sealed_build(self):
        if self.major < 4:
            self.skipTest('JSON fixture and text overlay assertions use Godot 4')
        self.pipeline(image_overlay=True, text_overlay=True)


GODOT3 = worker.ROOT / 'local/dependencies/godot3/Godot_v3.6.1-stable_win64.exe'


@unittest.skipUnless(GODOT3.is_file() and godot.executable(), 'Godot 3 runtime enables legacy native acceptance')
class Godot3RuntimeAcceptance(GodotRuntimeAcceptance):
    VERSION = '3.6.1'
    RUNTIME = str(GODOT3)


GODOT2 = worker.ROOT / 'local/dependencies/godot2/Godot_v2.1.6-stable_win64.exe'


@unittest.skipUnless(GODOT2.is_file() and godot.executable(), 'Godot 2 runtime enables legacy native acceptance')
class Godot2RuntimeAcceptance(GodotRuntimeAcceptance):
    VERSION = '2.1.6'
    RUNTIME = str(GODOT2)


if __name__ == '__main__':
    unittest.main()
