"""Neutral real serialized-file/UnityFS fixtures, constructed without game assets."""
from __future__ import annotations

import copy
import io
import json
from pathlib import Path
import struct
import os
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import worker
import unity_native as adapter
import text_formats as formats
from test_worker import font_fixture


def node_default(node):
    if node.m_Type == 'string':
        return ''
    if node.m_Type == 'TypelessData':
        return b''
    if node.m_Children and node.m_Children[0].m_Type == 'Array':
        return []
    if node.m_Children:
        return {child.m_Name: node_default(child) for child in node.m_Children}
    return False if node.m_Type == 'bool' else 0


def fixture_nodes(extra=False):
    from UnityPy.helpers.Tpk import get_typetree_node
    from UnityPy.helpers.TypeTreeNode import TypeTreeNode
    def clone(node):
        return TypeTreeNode(node.m_Level, node.m_Type, node.m_Name, node.m_ByteSize, node.m_Version,
                            [clone(child) for child in node.m_Children], m_TypeFlags=node.m_TypeFlags or 0,
                            m_Index=node.m_Index or 0, m_MetaFlag=node.m_MetaFlag or 0)
    result = {kind: clone(get_typetree_node(kind, (2019, 4, 40, 1))) for kind in (49, 128, 115, 114, 102)}
    text = clone(result[49].m_Children[1])
    text.m_Name = 'm_Text'
    result[114].m_Children.append(text)
    result[114].m_Children.append(TypeTreeNode(1, 'string', 'internalTarget', -1, 1, [], m_TypeFlags=0, m_Index=20, m_MetaFlag=0))
    if extra:
        def node(level, kind, name, size=-1, children=None):
            return TypeTreeNode(level, kind, name, size, 1, children or [], m_TypeFlags=0, m_Index=0, m_MetaFlag=0)
        result[114].m_Children.append(node(1, 'string', 'm_text'))
        row = node(3, 'StringTableEntry', 'data', children=[node(4, 'UInt64', 'm_Id', 8), node(4, 'string', 'm_Localized')])
        result[114].m_Children.append(node(1, 'vector', 'm_TableData', children=[node(2, 'Array', 'Array', children=[node(3, 'int', 'size', 4), row])]))
    for tree in result.values():
        for index, node in enumerate(tree.traverse()):
            node.m_Index = index
            node.m_TypeFlags = node.m_TypeFlags or 0
    return result


def unity_serialized(extra=False, zero_display=False, stripped=False, endian='<'):
    adapter.unitypy()
    from UnityPy.helpers.TypeTreeHelper import write_typetree
    from UnityPy.streams import EndianBinaryWriter
    nodes = fixture_nodes(extra)
    records = []
    def add(ident, kind, **fields):
        if zero_display:
            if kind == 49:
                fields['m_Script'] = ''
            elif kind == 102 or kind == 114 and ident == 7:
                fields['m_Text'] = ''
        value = node_default(nodes[kind])
        value.update(fields)
        writer = EndianBinaryWriter(endian=endian)
        write_typetree(value, nodes[kind], writer, None)
        records.append((ident, kind, writer.bytes))
    add(1, 49, m_Name='dialogue.json', m_Script=json.dumps({'id': 'welcome_event', 'text': 'Welcome <b>{0}</b>!', 'icon': 'menu/icon.png', 'stats': {'HP': 22}, 'lines': [{'speaker': 'Guide', 'message': 'Take your time.'}]}, ensure_ascii=False))
    add(2, 49, m_Name='dialogue.csv', m_Script='id,text,audio\r\nhello,"Hello, traveler!",voice01.ogg\r\nbye,See you later.,voice02.ogg\r\n')
    add(3, 49, m_Name='story.txt', m_Script='One small step.\r\nOne bright morning.\r\n\r\nThe journey begins.\r\n')
    add(4, 49, m_Name='commands.nani', m_Script='@goto Chapter2\nGuide: untouched script\n')
    add(5, 49, m_Name='binary.bytes', m_Script=b'\xff\x00\x99data'.decode('utf-8', 'surrogateescape'))
    add(6, 115, m_Name='Text', m_ClassName='Text', m_Namespace='UnityEngine.UI', m_AssemblyName='UnityEngine.UI.dll')
    add(7, 114, m_Name='MenuLabel', m_Script={'m_FileID': 0, 'm_PathID': 6}, m_Text='Start adventure', internalTarget='INTERNAL_UI_TARGET')
    add(8, 115, m_Name='Custom', m_ClassName='Command', m_Namespace='Fixture', m_AssemblyName='Assembly-CSharp.dll')
    add(9, 114, m_Name='Command', m_Script={'m_FileID': 0, 'm_PathID': 8}, m_Text='INTERNAL_LOGIC_TEXT', internalTarget='END_SCENE')
    add(10, 102, m_Text='A signpost.', m_Font={'m_FileID': 0, 'm_PathID': 11})
    add(11, 128, m_Name='DynamicFixture', m_FontSize=0, m_FontData=list(b'neutral embedded font data'), m_FontNames=['Fixture Sans'])
    add(12, 128, m_Name='StaticFixture', m_FontSize=16, m_FontData=[], m_FontNames=['Fixture Bitmap'])
    if extra:
        add(13, 115, m_Name='TextMeshProUGUI', m_ClassName='TextMeshProUGUI', m_Namespace='TMPro', m_AssemblyName='Unity.TextMeshPro.dll')
        add(14, 114, m_Name='TMPLabel', m_Script={'m_FileID': 0, 'm_PathID': 13}, m_text='TMP panel label', internalTarget='TMP_INTERNAL')
        add(15, 115, m_Name='StringTable', m_ClassName='StringTable', m_Namespace='UnityEngine.Localization.Tables', m_AssemblyName='Unity.Localization.dll')
        add(16, 114, m_Name='LocalizationTable', m_Script={'m_FileID': 0, 'm_PathID': 15}, m_TableData=[{'m_Id': 9007199254740993, 'm_Localized': 'A localized phrase.'}])
    meta, data = EndianBinaryWriter(endian=endian), EndianBinaryWriter(endian=endian)
    meta.write_string_to_null('2019.4.40f1')
    meta.write_int(5)
    meta.write_boolean(not stripped)
    kinds = list(nodes)
    meta.write_int(len(kinds))
    for kind in kinds:
        meta.write_int(kind)
        meta.write_boolean(False)
        meta.write_short(-1)
        if kind == 114:
            meta.write_bytes(b'\0' * 16)
        meta.write_bytes(b'\0' * 16)
        if not stripped:
            nodes[kind].dump_blob(meta, 17)
    meta.write_int(len(records))
    for ident, kind, raw in records:
        meta.align_stream()
        meta.write_long(ident)
        meta.write_u_int(data.Position)
        meta.write_u_int(len(raw))
        meta.write_int(kinds.index(kind))
        data.write_bytes(raw)
        data.align_stream(8)
    meta.write_int(0)
    meta.write_int(0)
    meta.write_string_to_null('Neutral fixture')
    offset = (20 + len(meta.bytes) + 15) // 16 * 16
    header = struct.pack('>IIII', len(meta.bytes), offset + len(data.bytes), 17, offset) + bytes([endian == '>']) + b'\0' * 3
    return header + meta.bytes + b'\0' * (offset - 20 - len(meta.bytes)) + data.bytes


def unity_bundle(raw):
    members = [('CAB-fixture', raw), ('CAB-fixture.resS', b'opaque resource stream; preserve every byte!')]
    directory = b'\0' * 16 + struct.pack('>iIIH', 1, sum(len(data) for _, data in members), sum(len(data) for _, data in members), 0)
    directory += struct.pack('>i', len(members))
    offset = 0
    for name, data in members:
        directory += struct.pack('>qqI', offset, len(data), 4) + name.encode() + b'\0'
        offset += len(data)
    head = b'UnityFS\0' + struct.pack('>I', 6) + b'5.x.x\0' + b'2018.4.0f1\0'
    size = len(head) + 20 + len(directory) + offset
    return head + struct.pack('>qIII', size, len(directory), len(directory), 64) + directory + b''.join(data for _, data in members)


def unity_game(root, bundle=False, extra=False, zero_display=False):
    game = Path(root) / 'game'
    (game / 'Fixture_Data').mkdir(parents=True)
    (game / 'Fixture.exe').write_bytes(b'MZ-neutral-launcher')
    (game / 'UnityPlayer.dll').write_bytes(b'neutral-not-executable')
    raw = unity_serialized(extra, zero_display)
    (game / 'Fixture_Data' / ('text.bundle' if bundle else 'resources.assets')).write_bytes(unity_bundle(raw) if bundle else raw)
    (game / 'save01.sav').write_bytes(b'private save')
    return game


@unittest.skipUnless(adapter.available(), 'Prepare UnityPy 1.23.0 before Unity asset tests')
class UnityNativeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pinhao-unity-')
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def schema_case(self):
        assembly = self.root / 'Fixture_Data' / 'Managed' / 'Neutral.dll'
        assembly.parent.mkdir(parents=True)
        assembly.write_bytes(b'neutral schema version one')
        obj = SimpleNamespace(assets_file=SimpleNamespace(unity_version='2019.4.40f1'))
        script = {'m_AssemblyName': assembly.name, 'm_Namespace': 'Neutral', 'm_ClassName': 'Caption'}
        script_id = tuple(script.values())

        def key():
            identity = (str(self.root.resolve()), 'Fixture_Data', obj.assets_file.unity_version,
                        ((assembly.name, adapter.hashlib.sha256(assembly.read_bytes()).hexdigest()),), adapter.TYPE_TREE_VERSION)
            return identity, script_id

        return assembly, obj, script, key

    def test_schema_scope_reuses_identity_across_objects_and_carriers(self):
        assembly, obj, script, key = self.schema_case()
        nodes, context, stats = object(), {}, []
        stat = Path.stat

        def count_stat(path, *args, **kwargs):
            if path == assembly:
                stats.append(path)
            return stat(path, *args, **kwargs)

        with mock.patch.object(adapter, 'schema_files', return_value=[assembly]) as enumerate_files, \
                mock.patch.object(Path, 'stat', count_stat), \
                mock.patch.dict(adapter._SCHEMA_IDENTITIES, {}, clear=True), \
                mock.patch.dict(adapter._GENERATED_NODES, {key(): nodes}, clear=True):
            for carrier in ('Fixture_Data/level1', 'Fixture_Data/level2'):
                self.assertIs(adapter.generated_nodes(obj, script, self.root, carrier, schema_context=context), nodes)
            enumerate_files.assert_called_once()
            self.assertEqual(len(stats), 1)

    def test_new_schema_scope_rechecks_modified_assembly(self):
        assembly, obj, script, key = self.schema_case()
        before, after = object(), object()
        with mock.patch.object(adapter, 'schema_files', return_value=[assembly]) as enumerate_files, \
                mock.patch.dict(adapter._SCHEMA_IDENTITIES, {}, clear=True), \
                mock.patch.dict(adapter._GENERATED_NODES, {key(): before}, clear=True):
            self.assertIs(adapter.generated_nodes(obj, script, self.root, 'Fixture_Data/level1', schema_context={}), before)
            assembly.write_bytes(b'neutral schema version two with a changed size')
            adapter._GENERATED_NODES[key()] = after
            self.assertIs(adapter.generated_nodes(obj, script, self.root, 'Fixture_Data/level1', schema_context={}), after)
            self.assertEqual(enumerate_files.call_count, 2)
            self.assertEqual(len(adapter._SCHEMA_IDENTITIES), 2)

    def test_null_script_with_empty_serialized_identity_is_not_a_class_guessing_task(self):
        base = {'m_Name': 'Neutral orphan component', 'm_Script': {'m_FileID': 0, 'm_PathID': 0}}
        obj = SimpleNamespace(type=SimpleNamespace(name='MonoBehaviour'), version=(2019, 4, 40, 1),
                              parse_as_dict=lambda: base, serialized_type=SimpleNamespace(
                                  script_type_index=-1, script_id=bytes(16), old_type_hash=bytes(16)))
        with mock.patch.object(adapter, 'resolve_script') as resolve, mock.patch.object(adapter, 'generated_nodes') as generate:
            with self.assertRaises(adapter.MissingMonoScript):
                adapter.typed_tree(obj, 'Fixture_Data/resources.assets', {}, self.root)
            resolve.assert_not_called()
            generate.assert_not_called()
        obj.serialized_type.old_type_hash = bytes([1]) + bytes(15)
        with mock.patch.object(adapter, 'resolve_script', return_value=None):
            with self.assertRaisesRegex(ValueError, 'unambiguous carrier'):
                adapter.typed_tree(obj, 'Fixture_Data/resources.assets', {}, self.root)

    def test_real_serialized_fixture_and_bundle_are_readable(self):
        for raw in (unity_serialized(), unity_bundle(unity_serialized())):
            _, top = adapter.load_carrier_bytes(raw)
            objects = adapter.objects(top)
            self.assertEqual(len(objects), 12)
            self.assertEqual(next(obj.parse_as_dict()['m_Text'] for obj in objects.values() if obj.type.name == 'TextMesh'), 'A signpost.')
            saved = top.save(packer='original')
            _, actual = adapter.load_carrier_bytes(saved)
            adapter.verify_carrier(top, actual, {})

    def test_stripped_schema_reads_pointer_endianness_and_checks_nontext_fields(self):
        nodes = fixture_nodes()[114]
        for endian in ('<', '>'):
            with self.subTest(endian=endian):
                _, top = adapter.load_carrier_bytes(unity_serialized(stripped=True, endian=endian))
                indexed = adapter.objects(top)
                loaded = {'Fixture_Data/resources.assets': (None, top)}
                with mock.patch.object(adapter, 'generated_nodes', return_value=nodes) as generate:
                    tree, generated = adapter.typed_tree(indexed['@:7'], 'Fixture_Data/resources.assets', loaded, self.root)
                    self.assertEqual(generate.call_args.args[1]['m_ClassName'], 'Text')
                    self.assertEqual(tree['m_Script'], {'m_FileID': 0, 'm_PathID': 6})
                    self.assertEqual(tree['internalTarget'], 'INTERNAL_UI_TARGET')
                    expected = copy.deepcopy(tree)
                    expected['m_Text'] = '开始冒险'
                    indexed['@:7'].save_typetree(expected, generated)
                    raw = adapter.save_checked(top, {'@:7': expected}, {'@:7': generated})
                    _, actual = adapter.load_carrier_bytes(raw)
                    self.assertEqual(adapter.objects(actual)['@:7'].read_typetree(generated), expected)
                    altered = copy.deepcopy(expected)
                    altered['m_Enabled'] = 1 if expected['m_Enabled'] == 0 else 0
                    adapter.objects(actual)['@:7'].save_typetree(altered, generated)
                    _, bad = adapter.load_carrier_bytes(actual.save(packer='original'))
                    with self.assertRaisesRegex(ValueError, 'text readback mismatch'):
                        adapter.verify_carrier(top, bad, {'@:7': expected}, {'@:7': generated})

    def test_same_path_id_in_other_carrier_does_not_replace_local_script(self):
        _, first = adapter.load_carrier_bytes(unity_serialized(stripped=True))
        _, second = adapter.load_carrier_bytes(unity_serialized(stripped=True))
        nodes = fixture_nodes()[115]
        other = adapter.objects(second)['@:6']
        tree = other.read_typetree(nodes)
        tree['m_ClassName'] = 'UnrelatedClass'
        other.save_typetree(tree, nodes)
        _, second = adapter.load_carrier_bytes(second.save(packer='original'))
        loaded = {'Fixture_Data/first.assets': (None, first), 'Fixture_Data/second.assets': (None, second)}
        with mock.patch.object(adapter, 'generated_nodes', return_value=fixture_nodes()[114]) as generate:
            adapter.typed_tree(adapter.objects(first)['@:7'], 'Fixture_Data/first.assets', loaded, self.root)
            self.assertEqual(generate.call_args.args[1]['m_ClassName'], 'Text')

    def test_clean_managed_schema_bridge_recovers_stripped_ui_and_reuses_identity(self):
        executable = worker.ROOT / 'local/dependencies/unity-schema/Pinhao.UnitySchema.exe'
        compiler = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        if not executable.is_file() or not compiler.is_file():
            self.skipTest('Prepare the clean managed Unity schema tool')
        game = unity_game(self.root)
        managed = game / 'Fixture_Data/Managed'
        managed.mkdir()
        subprocess.run([str(compiler), '/nologo', '/target:library', '/out:' + str(managed / 'UnityEngine.UI.dll'),
                        str(Path(__file__).parent / 'fixtures/mono_ui_schema.cs')], check=True, capture_output=True)
        path = game / 'Fixture_Data/resources.assets'
        path.write_bytes(unity_serialized(stripped=True))
        _, top = adapter.load_carrier(path)
        obj = adapter.objects(top)['@:7']
        tree, nodes = adapter.typed_tree(obj, 'Fixture_Data/resources.assets', {'Fixture_Data/resources.assets': (None, top)}, game)
        self.assertEqual(tree['m_Text'], 'Start adventure')
        self.assertEqual(tree['internalTarget'], 'INTERNAL_UI_TARGET')
        current = len(adapter._GENERATED_NODES)
        again = adapter.typed_tree(obj, 'Fixture_Data/resources.assets', {'Fixture_Data/resources.assets': (None, top)}, game)
        self.assertIs(again[1], nodes)
        self.assertEqual(len(adapter._GENERATED_NODES), current)
        updated = copy.deepcopy(tree)
        updated['m_Text'] = '清晨出发'
        obj.save_typetree(updated, nodes)
        raw = adapter.save_checked(top, {'@:7': updated}, {'@:7': nodes})
        _, actual = adapter.load_carrier_bytes(raw)
        self.assertEqual(adapter.objects(actual)['@:7'].read_typetree(nodes)['m_Text'], '清晨出发')

    def pipeline(self, bundle):
        game = unity_game(self.root, bundle)
        original = {rel: path.read_bytes() for rel, path in worker.files_in(game)}
        work, built, output = self.root / 'work', self.root / 'built', self.root / 'output'
        info = adapter.probe(game)
        self.assertEqual(info['engine'], 'Unity')
        self.assertEqual(len(info['carriers']), 1)
        extracted = adapter.extract(game, work, info, worker, {})
        self.assertEqual(len(extracted['units']), 9)
        self.assertFalse(any('INTERNAL' in unit['source'] or '@goto' in unit['source'] for unit in extracted['units']))
        self.assertTrue(any(issue['kind'] == 'custom_monobehaviour_display_schema_required' for issue in extracted['reviewItems']))
        self.assertTrue(adapter.roundtrip(work, worker)['byteIdentical'])
        _, sheets = worker.native.load_work(work)
        for name, sheet in sheets.items():
            for unit in sheet['units']:
                if unit['source'] == 'Start adventure':
                    unit['translation'] = '开始冒险'
                elif unit['source'] == 'Hello, traveler!':
                    unit['translation'] = '你好，旅人！'
                elif unit['source'] == 'A signpost.':
                    unit['translation'] = '一块路牌。'
                elif unit['source'] == 'Take your time.':
                    unit['translation'] = '慢慢来。'
            worker.json_write(work / 'editable' / name, sheet)
        result = adapter.build(work, work / 'editable', built, worker)
        self.assertEqual(result['nativeChangedFiles'], 1)
        font = self.root / 'chosen.ttf'
        font_fixture(font)
        result = adapter.assemble({'gameDir': str(game), 'workspaceDir': str(work), 'buildDir': str(built), 'outputDir': str(output), 'fontPath': str(font)}, worker)
        self.assertEqual(result['font']['objects'], 1)
        self.assertTrue(result['launchPath'].endswith('Fixture.exe'))
        self.assertFalse((output / 'save01.sav').exists())
        carrier = info['carriers'][0]
        _, top = adapter.load_carrier(output / carrier)
        trees = {obj.path_id: obj.parse_as_dict() for obj in adapter.objects(top).values()}
        self.assertEqual(trees[7]['m_Text'], '开始冒险')
        self.assertEqual(trees[7]['internalTarget'], 'INTERNAL_UI_TARGET')
        self.assertEqual(trees[9]['m_Text'], 'INTERNAL_LOGIC_TEXT')
        self.assertEqual(trees[10]['m_Text'], '一块路牌。')
        self.assertEqual(bytes(trees[11]['m_FontData']), font.read_bytes())
        self.assertEqual(trees[11]['m_FontNames'], ['Fixture Sans'])
        self.assertEqual(trees[12]['m_FontData'], [])
        self.assertEqual(json.loads(trees[1]['m_Script'])['lines'][0]['message'], '慢慢来。')
        self.assertEqual(json.loads(trees[1]['m_Script'])['id'], 'welcome_event')
        self.assertIn('你好，旅人！', trees[2]['m_Script'])
        self.assertIn('voice01.ogg', trees[2]['m_Script'])
        self.assertEqual(original, {rel: path.read_bytes() for rel, path in worker.files_in(game)})

    def test_serialized_native_pipeline(self):
        self.pipeline(False)

    def test_unityfs_native_pipeline(self):
        self.pipeline(True)

    def test_zero_display_carriers_keep_native_roundtrip_and_assembly(self):
        for bundle in (False, True):
            with self.subTest(bundle=bundle):
                parent = self.root / ('bundle' if bundle else 'serialized')
                game = unity_game(parent, bundle=bundle, zero_display=True)
                info = adapter.probe(game)
                original = {file: path.read_bytes() for file, path in worker.files_in(game)}
                with self.assertRaises(worker.WorkerError):
                    adapter.extract(game, parent / 'default-work', info, worker, {})
                work, built, output = [parent / name for name in ('empty-work', 'built', 'output')]
                result = adapter.extract(game, work, info, worker, {'allowEmpty':True})
                self.assertEqual(result['units'], [])
                self.assertTrue(adapter.roundtrip(work, worker)['byteIdentical'])
                worker.build({'workspaceDir':str(work), 'outputDir':str(built)})
                assembled = adapter.assemble({'gameDir':str(game), 'workspaceDir':str(work),
                                               'buildDir':str(built), 'outputDir':str(output), 'share':False}, worker)
                self.assertFalse(assembled['runtimeVerified'])
                carrier = info['carriers'][0]
                self.assertEqual((output / carrier).read_bytes(), original[carrier])
                self.assertEqual(original, {file:path.read_bytes() for file,path in worker.files_in(game)})

    def test_format_boundaries_and_control_tokens(self):
        for name, text in [('flow.nani', '@goto Scene\nGuide: Hello'), ('flow.yarn', 'title: Start\n---\nHello'), ('data.txt', 'return target;'), ('raw.bytes', b'\xff\0'.decode('utf-8', 'surrogateescape'))]:
            self.assertFalse(adapter.text_asset_entries(name, text)[1])
        binding, entries, _ = adapter.text_asset_entries('item.json', '{"id":"resource123","icon":"res/icon.png","description":"Read <b>{0}</b>!"}')
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]['path'], ['description'])
        self.assertEqual(len(formats.protected(entries[0]['source'], 'formatted')[2]), 3)
        original = 'id,text\n1,"Hello, world!"\n'
        binding, entries, _ = adapter.text_asset_entries('dialogue.csv', original)
        rewritten = adapter.render_text_asset(original, binding, [(entries[0], '你好，世界！')])
        self.assertIn('1,你好，世界！', rewritten)
        for name, text in [('dialogue', 'id,text\n1,Hello!\n'), ('dialogue', 'A new morning.\n'), ('dialogue.json', '\ufeff{"text":"Hello!"}')]:
            self.assertTrue(adapter.text_asset_entries(name, text)[1])
        self.assertFalse(adapter.text_asset_entries('settings.json', '{"name":"MAIN_SCENE","path":"a/b"}')[1])

    def test_utf16_textasset_preserves_encoding_and_bom(self):
        raw = b'\xff\xfe' + '{"id":"keep","text":"A new morning."}'.encode('utf-16-le')
        original = raw.decode('utf-8', 'surrogateescape')
        binding, entries, _ = adapter.text_asset_entries('dialogue.json', original)
        self.assertEqual(binding['encoding'], 'utf-16-le')
        rewritten = adapter.render_text_asset(original, binding, [(entries[0], '崭新的清晨。')]).encode('utf-8', 'surrogateescape')
        self.assertTrue(rewritten.startswith(b'\xff\xfe'))
        self.assertEqual(json.loads(rewritten[2:].decode('utf-16-le')), {'id': 'keep', 'text': '崭新的清晨。'})

    def test_dynamic_font_with_real_bundled_font_data(self):
        fonts = Path(__file__).resolve().parents[2] / 'local/runtime/fonts'
        font = next(iter(fonts.glob('LXGWWenKai*.ttf')), None)
        if font is None:
            self.skipTest('Prepare the bundled OFL font for the full font-data round-trip')
        game = unity_game(self.root)
        path = game / 'Fixture_Data/resources.assets'
        family = worker.font_family(font)
        adapter.apply_font(path, [{'object': '@:11'}], font.read_bytes(), family)
        _, top = adapter.load_carrier(path)
        tree = adapter.objects(top)['@:11'].parse_as_dict()
        self.assertEqual(bytes(tree['m_FontData']), font.read_bytes())
        self.assertEqual(tree['m_FontNames'], [family])

    def test_tmp_and_unity_localization_native_fields(self):
        game = unity_game(self.root, bundle=True, extra=True)
        work, built = self.root / 'work', self.root / 'built'
        extracted = adapter.extract(game, work, adapter.probe(game), worker, {})
        self.assertEqual(len(extracted['units']), 11)
        self.assertTrue(any(row['kind'] == 'tmp_font_atlas_requires_separate_font_adapter' for row in extracted['reviewItems']))
        _, sheets = worker.native.load_work(work)
        for name, sheet in sheets.items():
            for unit in sheet['units']:
                if unit['source'] == 'TMP panel label':
                    unit['translation'] = '面板标签'
                elif unit['source'] == 'A localized phrase.':
                    unit['translation'] = '一条本地化文字。'
            worker.json_write(work / 'editable' / name, sheet)
        adapter.build(work, work / 'editable', built, worker)
        _, top = adapter.load_carrier(built / 'Fixture_Data/text.bundle')
        trees = {obj.path_id: obj.parse_as_dict() for obj in adapter.objects(top).values()}
        self.assertEqual(trees[14]['m_text'], '面板标签')
        self.assertEqual(trees[14]['internalTarget'], 'TMP_INTERNAL')
        self.assertEqual(trees[16]['m_TableData'], [{'m_Id': 9007199254740993, 'm_Localized': '一条本地化文字。'}])

    def test_source_snapshot_and_built_carrier_tampering(self):
        game = unity_game(self.root)
        work, built = self.root / 'work', self.root / 'built'
        adapter.extract(game, work, adapter.probe(game), worker, {})
        metadata = worker.native.read(work / 'technical/product-source.json')
        carrier = next(iter(metadata['nativeFilesSha256']))
        source = Path(metadata['nativeSource']) / carrier
        raw = source.read_bytes()
        source.write_bytes(raw + b'changed')
        with self.assertRaises(worker.WorkerError):
            adapter.build(work, work / 'editable', built, worker)
        source.write_bytes(raw)
        built = self.root / 'built-ok'
        adapter.build(work, work / 'editable', built, worker)
        (built / carrier).write_bytes(b'changed carrier')
        with self.assertRaises(worker.WorkerError):
            adapter.assemble({'gameDir': str(game), 'workspaceDir': str(work), 'buildDir': str(built), 'outputDir': str(self.root / 'output')}, worker)


if __name__ == '__main__':
    unittest.main()
