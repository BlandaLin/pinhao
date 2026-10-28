"""Offline adapter tests; neutral fixture strings only."""
import copy
import json
import pickle
import subprocess
import sys
import tempfile
import unittest
import zlib
from pathlib import Path
from types import SimpleNamespace

import demo
import kickstart
import rpgmaker as core
import text_formats as formats
import rpa_archive
import unity_inventory


class Adapters(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
    def tearDown(self): self.temp.cleanup()

    def work(self, profile, text=None, filename=None, encoding='utf-8', bom=b''):
        source, work = self.root / 'source', self.root / 'work'
        if text is None:
            selection = demo.fixture(source, profile)
        else:
            source.mkdir()
            demo.text_file(source / filename, text, encoding, bom)
            selection = None
        formats.extract(source, work, profile, selection=selection, encoding=encoding)
        return source, work

    def rows(self, work):
        return [row for sheet in core.load_work(work)[1].values() for row in sheet['units']]

    def patched(self, work, changes):
        patch = self.root / 'patch.json'
        core.write(patch, {'schema': 'rpgmaker-ai-patch-v1', 'baseline_sha256': core.sha((work / 'manifest.json').read_bytes()), 'changes': [{'id': r['id'], 'translation': text} for r, text in changes]})
        out = self.root / 'merged'
        core.merge(work, [patch], out)
        return out / 'editable'

    def test_all_synthetic_closed_loops(self):
        for profile in kickstart.PROFILES:
            with self.subTest(profile=profile):
                result = demo.run(profile, self.root / profile)
                self.assertTrue(result['nochange_byte_identical'])
                self.assertEqual(result['verification']['changed'], 1)

    def test_detection_only_examples(self):
        for profile in ('legacy-detection', 'nscripter-detection'):
            result = demo.run(profile, self.root / profile)
            self.assertEqual(len(result['probe']['candidates']), 1)
            self.assertFalse(result['probe']['candidates'][0]['extraction_ready'])

    def test_supported_fixture_detection(self):
        for profile in ('rpgmaker', 'renpy-template', 'tyrano', 'kirikiri', 'twee', 'twine-html', 'pgmm'):
            source = self.root / profile; demo.fixture(source, profile)
            info = kickstart.probe(source)
            self.assertEqual(info['status'], 'identified', profile)
            self.assertTrue(info['candidates'][0]['extraction_ready'], profile)

    def test_godot_pck_signature_not_extension_only(self):
        source = self.root / 'source'; source.mkdir()
        (source / 'wrong.pck').write_bytes(b'notgodot')
        self.assertEqual(kickstart.probe(source)['status'], 'unknown_use_explicit_interchange_profile')
        (source / 'right.pck').write_bytes(b'GDPC' + b'\0' * 20)
        self.assertEqual(kickstart.probe(source)['candidates'][0]['engine'], 'godot')

    def test_ks_nested_attribute_brackets_not_extracted_as_prose(self):
        _, work = self.work('tyrano', '[button graphic=&mp.arr[0] target="*a"]\n[font color="red"]Hello.[p]\n', 'demo.ks')
        rows = self.rows(work)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['kind'], 'paragraph')
        self.assertNotIn('mp.arr', rows[0]['source_preview'])
        self.assertEqual(len(rows[0]['tokens']), 2)

    def test_renpy_existing_and_empty_targets_preserve_bytes(self):
        source, work = self.work('renpy-template', 'translate schinese strings:\n    old "Continue"\n    new ""\n    old "Back"\n    new "Existing translation"\n', 'game/tl/schinese/demo.rpy')
        rows = self.rows(work)
        self.assertEqual(rows[1]['translation'], 'Existing translation')
        out = self.root / 'built'
        core.build(work, work / 'editable', out)
        self.assertEqual((out / 'game/tl/schinese/demo.rpy').read_bytes(), (source / 'game/tl/schinese/demo.rpy').read_bytes())
        changed = self.patched(work, [(rows[0], '\u7ee7\u7eed "quoted"')])
        core.build(work, changed, self.root / 'changed')
        text = (self.root / 'changed/game/tl/schinese/demo.rpy').read_text(encoding='utf-8')
        self.assertIn('new "\u7ee7\u7eed \\"quoted\\""', text)
        self.assertIn('old "Continue"', text)
        self.assertIn('new "Existing translation"', text)

    def test_renpy_control_injection_rejected(self):
        _, work = self.work('renpy-template')
        row = self.rows(work)[0]
        for translation in (row['translation'].replace('{{CTRL0001}}', ''), row['translation'] + '{color=red}', row['translation'] + '[evil]'):
            with self.assertRaises(ValueError): core.restore(translation, core.load_work(work)[0]['units'][row['id']])

    def test_ks_script_is_opaque_and_multiline_not_sliced(self):
        _, work = self.work('tyrano', '*a\n#Clerk\nFirst.[l]\nSecond.[p]\n[ISCRIPT]\nlet x="never translate";\n[ENDSCRIPT]\n_hidden\n', 'demo.ks')
        rows = self.rows(work)
        self.assertEqual(len(rows), 2)
        self.assertIn('Second.', rows[1]['source_preview'])
        self.assertNotIn('never translate', json.dumps(rows))
        with self.assertRaises(ValueError):
            changed = self.patched(work, [(rows[1], '@jump target="*a" ' + rows[1]['translation'])])
            core.build(work, changed, self.root / 'built')

    def test_ks_attribute_quote_injection_rejected_at_build(self):
        _, work = self.work('tyrano')
        row = next(r for r in self.rows(work) if r['kind'] == 'display_attribute')
        changed = self.patched(work, [(row, 'Bad" target="*evil')])
        with self.assertRaises(ValueError): core.build(work, changed, self.root / 'built')

    def test_ks_utf16_bom_preserved(self):
        source, work = self.work('kirikiri')
        row = self.rows(work)[0]
        changed = self.patched(work, [(row, '\u793a\u4f8b')])
        core.build(work, changed, self.root / 'built')
        raw = (self.root / 'built/demo.ks').read_bytes()
        self.assertTrue(raw.startswith(b'\xff\xfe'))
        self.assertIn('\u793a\u4f8b', raw[2:].decode('utf-16-le'))
        self.assertNotEqual(raw, (source / 'demo.ks').read_bytes())

    def test_explicit_cp932_unencodable_translation_fails(self):
        _, work = self.work('kirikiri', 'Hello.\n', 'demo.ks', 'cp932')
        changed = self.patched(work, [(self.rows(work)[0], '\u6c49\u8bed')])
        with self.assertRaises(UnicodeError): core.build(work, changed, self.root / 'built')

    def test_twine_protects_script_macro_quotes_and_link_targets(self):
        _, work = self.work('twee', ':: Start\nWelcome. <<set $x to "a >> b">><<script>>const x="unchanged";<</script>> [[Next|Room]]\n', 'demo.twee')
        row = self.rows(work)[0]
        self.assertNotIn('unchanged', row['source'])
        self.assertNotIn('Room', row['source'])
        changed = self.patched(work, [(row, '\u793a\u4f8b ' + row['translation'])])
        core.build(work, changed, self.root / 'built')
        built = (self.root / 'built/demo.twee').read_text(encoding='utf-8')
        self.assertIn('<<set $x to "a >> b">>', built)
        self.assertIn('const x="unchanged";', built)
        self.assertIn('[[Next|Room]]', built)

    def test_harlowe_rejected(self):
        with self.assertRaises(ValueError): self.work('twee', ':: Start\n(set: $x to 1)Welcome\n', 'demo.twee')

    def test_twine_html_runtime_and_passage_metadata_unchanged(self):
        source, work = self.work('twine-html')
        row = self.rows(work)[0]
        with self.assertRaises(ValueError): core.restore('<plain> ' + row['translation'], core.load_work(work)[0]['units'][row['id']])
        changed = self.patched(work, [(row, '\u793a\u4f8b & ' + row['translation'])])
        core.build(work, changed, self.root / 'built')
        text = (self.root / 'built/demo.html').read_text(encoding='utf-8')
        self.assertIn('\u793a\u4f8b &amp;', text)
        self.assertIn('<script>const engine="unchanged";</script>', text)
        self.assertIn('pid="1" name="Start" tags=""', text)
        self.assertIn('[[Next|Room]]', text)

    def test_csv_quoted_multiline_crlf_and_blank_targets(self):
        source, work = self.work('godot-csv', 'keys,en,schinese\r\nA,"Hello, ""guest"".\nNext line.",\r\nB,Continue,Existing\r\n', 'demo.csv')
        rows = self.rows(work)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1]['translation'], 'Existing')
        row = rows[0]
        changed = self.patched(work, [(row, '\u793a\u4f8b ' + row['translation'])])
        core.build(work, changed, self.root / 'built')
        text = (self.root / 'built/demo.csv').read_bytes().decode()
        parsed = formats.csv_cells(text)
        self.assertEqual(parsed[1][1][0], 'Hello, "guest".\nNext line.')
        self.assertTrue(parsed[1][2][0].startswith('\u793a\u4f8b'))
        self.assertIn('\r\nB,Continue,Existing\r\n', text)

    def test_duplicate_csv_keys_rejected(self):
        with self.assertRaises(ValueError): self.work('godot-csv', 'keys,en,schinese\nA,Hello,\nA,Back,\n', 'demo.csv')

    def test_po_context_plural_and_source_immutable(self):
        source, work = self.work('gettext-po', 'msgctxt "stock"\nmsgid "One item"\nmsgid_plural "Many items"\nmsgstr[0] ""\nmsgstr[1] ""\n', 'demo.po')
        rows = self.rows(work)
        self.assertEqual([r['source'] for r in rows], ['One item', 'Many items'])
        changed = self.patched(work, [(rows[1], '\u591a\u4e2a\u7269\u54c1')])
        core.build(work, changed, self.root / 'built')
        text = (self.root / 'built/demo.po').read_text(encoding='utf-8')
        self.assertIn('msgid_plural "Many items"', text)
        self.assertIn('msgctxt "stock"', text)

    def test_pgmm_title_synchronization(self):
        _, work = self.work('pgmm')
        rows = [r for r in self.rows(work) if r['kind'] == 'game_title']
        with self.assertRaises(ValueError): self.patched(work, [(rows[0], 'New title')])
        # A rejected merge is left for inspection; use a fresh output for the next attempt.
        second = self.root / 'second.json'
        core.write(second, {'schema': 'rpgmaker-ai-patch-v1', 'baseline_sha256': core.sha((work / 'manifest.json').read_bytes()), 'changes': [{'id': r['id'], 'translation': 'New title'} for r in rows]})
        core.merge(work, [second], self.root / 'accepted')
        core.build(work, self.root / 'accepted/editable', self.root / 'built')
        self.assertEqual(core.read(self.root / 'built/info.json')['title'], 'New title')
        self.assertEqual(core.read(self.root / 'built/project.json')['gameInformation']['title'], 'New title')

    def test_wolf_only_display_commands_and_picture_text(self):
        _, work = self.work('wolf-export')
        rows = self.rows(work)
        self.assertEqual(len(rows), 4)
        self.assertNotIn('picture/path.png', json.dumps(rows))
        self.assertNotIn('InternalVariable', json.dumps(rows))

    def test_wolf_custom_glyph_block_protected(self):
        text = 'Hello \\font[3]x\\font[0] @42 \\c[3]guest'
        value, controls, tokens = formats.protected(text, 'wolf')
        self.assertIn('\\font[3]x\\font[0]', controls.values())
        self.assertIn('@42', controls.values())
        self.assertNotIn('@42', value)

    def test_selected_json_metadata_unchanged(self):
        source, work = self.work('json-selected')
        row = self.rows(work)[0]
        changed = self.patched(work, [(row, '\u793a\u4f8b ' + row['translation'])])
        core.build(work, changed, self.root / 'built')
        obj = core.read(self.root / 'built/dialogue.json')
        obj['lines'][0]['text'] = core.read(source / 'dialogue.json')['lines'][0]['text']
        self.assertEqual(obj, core.read(source / 'dialogue.json'))

    def test_selected_json_requires_selection(self):
        source = self.root / 'source'; demo.fixture(source, 'json-selected')
        with self.assertRaises(ValueError): formats.extract(source, self.root / 'work', 'json-selected')

    def test_source_not_modified_in_closed_loop(self):
        source, work = self.work('tyrano')
        before = {p.relative_to(source): p.read_bytes() for p in source.rglob('*') if p.is_file()}
        row = self.rows(work)[0]
        core.build(work, self.patched(work, [(row, '\u793a\u4f8b ' + row['translation'])]), self.root / 'built')
        self.assertEqual(before, {p.relative_to(source): p.read_bytes() for p in source.rglob('*') if p.is_file()})


def rpa_fixture(path, version=3, entries=None):
    entries = entries or {'game/demo.rpy': b'prefix-body'}
    key = 0x12345678 if version == 3 else 0
    header_size = 34 if version == 3 else 25
    payload, index = bytearray(), {}
    for name, raw in entries.items():
        prefix, body = (raw[:3], raw[3:]) if version == 3 else (b'', raw)
        offset = header_size + len(payload)
        payload.extend(body)
        index[name] = [(offset ^ key, len(body) ^ key, prefix)] if version == 3 else [(offset, len(body))]
    offset = header_size + len(payload)
    header = ('RPA-3.0 %016x %08x\n' % (offset, key) if version == 3 else 'RPA-2.0 %016x\n' % offset).encode()
    assert len(header) == header_size
    path.write_bytes(header + payload + zlib.compress(pickle.dumps(index, protocol=2)))


class ArchivesAndInventory(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.src = self.root / 'source'; self.src.mkdir()
    def tearDown(self): self.temp.cleanup()

    def test_rpa2_and_3_prefixes_default_script_filter(self):
        for version in (2, 3):
            archive = self.src / ('demo%d.rpa' % version)
            rpa_fixture(archive, version, {'game/demo.rpy': b'prefix-body', 'image.png': b'fakeimage'})
            out = self.root / ('out%d' % version)
            report = rpa_archive.unpack(archive, out)
            self.assertEqual((out / 'game/demo.rpy').read_bytes(), b'prefix-body')
            self.assertFalse((out / 'image.png').exists())

    def test_rpa_path_traversal_rejected(self):
        archive = self.src / 'bad.rpa'; rpa_fixture(archive, entries={'../demo.rpy': b'bad'})
        with self.assertRaises(ValueError): rpa_archive.unpack(archive, self.root / 'out')

    def test_pickle_global_is_never_executed(self):
        class Evil:
            def __reduce__(self): return (eval, ('1 / 0',))
        header = b'RPA-2.0 0000000000000019\n'
        archive = self.src / 'bad.rpa'
        archive.write_bytes(header + zlib.compress(pickle.dumps(Evil(), protocol=2)))
        with self.assertRaises(ValueError): rpa_archive.unpack(archive, self.root / 'out')

    def test_corrupt_rpa_cli_error_is_structured(self):
        archive = self.src / 'bad.rpa'
        archive.write_bytes(b'RPA-2.0 0000000000000019\n' + zlib.compress(b''))
        result = subprocess.run([sys.executable, str(Path(kickstart.__file__)), 'unpack', '--archive', str(archive), '--out', str(self.root / 'out')], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertFalse(json.loads(result.stdout)['ok'])
        self.assertEqual(result.stderr, '')

    def test_unity_optional_inventory_data_only(self):
        asset = self.src / 'resources.assets'; asset.write_bytes(b'neutral serialized file fixture')
        def obj(path_id, raw):
            return SimpleNamespace(type=SimpleNamespace(name='TextAsset'), assets_file=SimpleNamespace(name='resources.assets'), path_id=path_id,
                parse_as_object=lambda: SimpleNamespace(m_Name='Neutral', m_Script=raw))
        env = SimpleNamespace(objects=[obj(1, b'{"text":"Welcome"}'), obj(2, b'\x00\xff\x01')])
        report = unity_inventory.inventory(asset, self.root / 'out', lambda _: env)
        self.assertEqual(report['textassets'], 2)
        self.assertEqual(report['text_candidates'], 1)
        self.assertEqual(asset.read_bytes(), b'neutral serialized file fixture')
        self.assertEqual(core.read(self.root / 'out/textassets.json')['assets'][0]['path_id'], 1)


if __name__ == '__main__': unittest.main()
