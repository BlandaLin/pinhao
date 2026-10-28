"""Synthetic, neutral fixtures only; no game assets or story text."""
import copy
import hashlib
import json
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import rpgmaker as tool
from rgss_archive import advance, archive_entries, unpack
from ruby_marshal import RObject, Reader, long_bytes


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(tool.serialized(value))


def cmd(code, parameters, indent=0):
    return {'code': code, 'parameters': parameters, 'indent': indent}


def map_commands(mz=False):
    header = ['', 0, 0, 2] + (['Clerk'] if mz else [])
    return [cmd(101, header), cmd(401, ['Hello, \\N[1].']), cmd(401, ['Come this way.']),
            cmd(102, [['Yes', 'No'], 0, 0, 2, 0]), cmd(402, [0, 'Yes']),
            cmd(101, header, 1), cmd(401, ['Thank you.'], 1), cmd(402, [1, 'No']),
            cmd(101, header, 1), cmd(401, ['Goodbye.'], 1), cmd(404, []),
            cmd(320, [1, 'Lin']), cmd(355, ['never_execute_this()']), cmd(0, [])]


def json_game(root, engine='MV', nested=False):
    root = root / 'www' if nested else root
    (root / 'js').mkdir(parents=True)
    (root / 'js' / ('rmmz_core.js' if engine == 'MZ' else 'rpg_core.js')).write_text(
        'Utils.RPGMAKER_VERSION = "1.0.0";', encoding='utf-8')
    save(root / 'data' / 'System.json', {'gameTitle': 'Demo', 'currencyUnit': 'Coin',
          'elements': ['', 'Fire', None], 'terms': {'basic': ['Level'], 'commands': ['Fight', None],
          'messages': {'victory': '%1 wins!'}}, 'variables': ['', 'InternalVariable'], 'switches': ['', 'InternalSwitch']})
    save(root / 'data' / 'Actors.json', [None, {'id': 1, 'name': 'Lin', 'nickname': '',
          'profile': 'A traveler.\nA new arrival.', 'note': '<code:do_not_translate>', 'level': 3}])
    save(root / 'data' / 'Map001.json', {'displayName': 'Inn', 'data': [1, 2, 3], 'events': [None,
          {'id': 1, 'name': 'InternalEvent', 'x': 2, 'y': 4, 'pages': [{'conditions': {'switch1Id': 1},
           'list': map_commands(engine == 'MZ')}]}]})
    save(root / 'data' / 'CustomPlugin.json', {'machineKey': 'Leave unchanged'})
    (root / 'js' / 'plugins.js').write_text('var $plugins = [];', encoding='utf-8')
    (root / 'img').mkdir()
    (root / 'img' / 'title.png').write_bytes(b'not_an_actual_image')
    return root


def marshal(value):
    def symbol(s):
        raw = s.encode('utf-8')
        return b':' + long_bytes(len(raw)) + raw
    if value is None: return b'0'
    if value is True: return b'T'
    if value is False: return b'F'
    if isinstance(value, int): return b'i' + long_bytes(value)
    if isinstance(value, str):
        raw = value.encode('utf-8')
        return b'I"' + long_bytes(len(raw)) + raw + long_bytes(1) + symbol('E') + b'T'
    if isinstance(value, list): return b'[' + long_bytes(len(value)) + b''.join(marshal(v) for v in value)
    if isinstance(value, dict): return b'{' + long_bytes(len(value)) + b''.join(marshal(k) + marshal(v) for k, v in value.items())
    if isinstance(value, RObject):
        if value.data is not None:
            return b'u' + symbol(value.name) + long_bytes(len(value.data)) + value.data
        return b'o' + symbol(value.name) + long_bytes(len(value.attrs)) + b''.join(symbol(k) + marshal(v) for k, v in value.attrs.items())
    raise TypeError(value)


def ruby_game(root):
    data = root / 'Data'
    data.mkdir(parents=True)
    def obj(class_name, **fields): return RObject(class_name, {'@' + k: v for k, v in fields.items()})
    entries = [obj('RPG::EventCommand', **c) for c in map_commands()]
    event = obj('RPG::Event', pages=[obj('RPG::Event::Page', list=entries)], x=2, y=4)
    records = {'System': obj('RPG::System', game_title='Demo', currency_unit='Coin', elements=['', 'Fire'],
                            terms=obj('RPG::System::Terms', basic=['Level'])),
               'Actors': [None, obj('RPG::Actor', name='Lin', description='A traveler.', note='', level=3)],
               'Map001': obj('RPG::Map', display_name='Inn', events={1: event}, data=RObject('Table', data=b'\0opaque\xff'))}
    for name, value in records.items(): (data / (name + '.rvdata2')).write_bytes(b'\x04\x08' + marshal(value))
    return root


def crypt_payload(raw, key):
    result = bytearray(raw)
    for i in range(len(result)):
        result[i] ^= (key >> ((i % 4) * 8)) & 255
        if i % 4 == 3: key = advance(key)
    return bytes(result)


def archive_v3(path, resources):
    seed, key, payload_key = 17, 17 * 9 + 3, 123456
    offset = 12 + sum(16 + len(n.encode()) for n, _ in resources) + 4
    table, payloads = bytearray(b'RGSSAD\0\x03' + struct.pack('<I', seed)), []
    for name, raw in resources:
        filename = name.encode('utf-8')
        table.extend(struct.pack('<IIII', offset ^ key, len(raw) ^ key, payload_key ^ key, len(filename) ^ key))
        table.extend(c ^ ((key >> ((i % 4) * 8)) & 255) for i, c in enumerate(filename))
        payloads.append(crypt_payload(raw, payload_key))
        offset += len(raw)
    table.extend(struct.pack('<I', key))
    path.write_bytes(bytes(table) + b''.join(payloads))


def archive_v1(path, resources):
    result, key = bytearray(b'RGSSAD\0\x01'), 0xDEADCAFE
    for name, raw in resources:
        filename = name.encode('utf-8')
        result.extend(struct.pack('<I', len(filename) ^ key)); key = advance(key)
        for c in filename:
            result.append(c ^ (key & 255)); key = advance(key)
        result.extend(struct.pack('<I', len(raw) ^ key)); key = advance(key)
        result.extend(crypt_payload(raw, key))
    path.write_bytes(result)


class ControlContractTests(unittest.TestCase):
    def unit(self, parts):
        source, controls, tokens = tool.protect(parts)
        return {'id': 'neutral-controls', 'source': source, 'controls': controls, 'tokens': tokens}

    def test_every_source_c0_control_roundtrips(self):
        for code in range(32):
            with self.subTest(code=code):
                parts = ['Before' + chr(code) + 'after']
                unit = self.unit(parts)
                self.assertEqual(tool.restore(unit['source'], unit), parts)
                self.assertFalse(any(ord(char) < 32 for char in unit['source']))

    def test_backslashes_at_part_boundaries_and_crlf_roundtrip(self):
        for slashes in range(1, 6):
            with self.subTest(slashes=slashes):
                parts = ['Cafe\u0301\t' + '\\' * slashes, 'Next\r\nline\\N[1]', 'Last\\']
                unit = self.unit(parts)
                self.assertEqual(tool.restore(unit['source'], unit), parts)
                self.assertEqual(unit['tokens'], tool.TOKEN.findall(unit['source']))
                translated = unit['source'].replace('Next', 'Following')
                self.assertEqual(tool.restore(translated, unit), [parts[0], parts[1].replace('Next', 'Following'), parts[2]])

    def test_new_raw_controls_and_backslashes_are_rejected(self):
        unit = self.unit(['Plain\\N[1]', 'Next'])
        for injected in [chr(code) for code in range(32)] + ['\\', '\\N[2]']:
            with self.subTest(injected=repr(injected)):
                with self.assertRaises(ValueError):
                    tool.restore(unit['source'] + injected, unit)

    def test_reserved_placeholders_and_changed_order_remain_rejected(self):
        for source in ('literal {{CTRL0001}}', 'literal {{LINE0001}}', 'literal {{broken}}'):
            with self.subTest(source=source), self.assertRaises(ValueError):
                tool.protect([source])
        unit = self.unit(['Before\t\\', 'After\x00'])
        first, second = unit['tokens'][:2]
        reordered = unit['source'].replace(first, 'swap', 1).replace(second, first, 1).replace('swap', second, 1)
        for changed in (unit['source'].replace('{{CTRL0001}}', ''),
                        unit['source'].replace('{{LINE0001}}', '{{LINE0002}}'),
                        unit['source'] + '{{CTRL9999}}', reordered):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                tool.restore(changed, unit)

    def test_text_format_profiles_share_source_control_contract(self):
        import text_formats
        source = 'Cafe\u0301\tvalue\x00\r\nNext\\'
        for syntax in text_formats.EXTRA:
            with self.subTest(syntax=syntax):
                value, controls, tokens = text_formats.protected(source, syntax)
                unit = {'id': 'format-' + syntax, 'controls': controls, 'tokens': tokens, 'syntax': syntax}
                self.assertEqual(tool.restore(value, unit), [source])
                with self.assertRaises(ValueError): tool.restore(value + '\x01', unit)

    def test_json_and_marshal_source_controls_keep_original_bytes(self):
        for engine in ('MV', 'MZ', 'VX Ace'):
            with self.subTest(engine=engine), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                game = ruby_game(root / 'game') if engine == 'VX Ace' else json_game(root / 'game', engine)
                if engine == 'VX Ace':
                    path = game / 'Data' / 'Map001.rvdata2'
                    reader = Reader(path.read_bytes())
                    values = {'Hello, \\N[1].': 'Cafe\u0301\t\\', 'Come this way.': 'Following\x00\r\nline\\'}
                    path.write_bytes(reader.patch({s.index: values[s.text()] for s in reader.strings if s.text() in values}))
                else:
                    path = game / 'data' / 'Map001.json'
                    doc = tool.read(path)
                    entries = doc['events'][1]['pages'][0]['list']
                    entries[1]['parameters'][0] = 'Cafe\u0301\t\\'
                    entries[2]['parameters'][0] = 'Following\x00\r\nline\\'
                    if engine == 'MZ': entries[0]['parameters'][4] = 'Clerk\t'
                    save(path, doc)
                original = {p.relative_to(game).as_posix(): p.read_bytes() for p in game.rglob('*') if p.is_file()}
                work, built = root / 'work', root / 'built'
                tool.extract(game, work)
                tool.build(work, work / 'editable', built)
                tool.verify(work, work / 'editable', built)
                for file in tool.read(work / 'manifest.json')['files']:
                    self.assertEqual((built / file).read_bytes(), original[file])
                self.assertEqual(original, {p.relative_to(game).as_posix(): p.read_bytes() for p in game.rglob('*') if p.is_file()})


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.game = self.root / 'game'
        self.work = self.root / 'work'
        json_game(self.game)
        tool.extract(self.game, self.work, batch_size=4)

    def tearDown(self):
        self.temp.cleanup()

    def rows(self):
        return [r for p in sorted((self.work / 'editable').glob('*.json')) for r in tool.read(p)['units']]

    def patch(self, changes, name='patch.json', **extra):
        path = self.root / name
        save(path, {'schema': 'rpgmaker-ai-patch-v1', 'baseline_sha256': tool.sha((self.work / 'manifest.json').read_bytes()),
                    'changes': changes, **extra})
        return path

    def test_mv_mz_and_www_detection(self):
        self.assertEqual(tool.probe(self.game)['engine'], 'MV')
        nested = self.root / 'mz'
        json_game(nested, 'MZ', True)
        self.assertEqual(tool.probe(nested)['root'], 'www')
        tool.extract(nested, self.root / 'mz-work')

    def test_complete_messages_context_and_null_terms(self):
        rows = self.rows()
        message = next(r for r in rows if 'Hello' in r['source_preview'])
        self.assertIn('{{LINE0001}}', message['source'])
        self.assertIn('{{CTRL0001}}', message['source'])
        self.assertEqual(message['context']['line_count'], 2)
        self.assertEqual(next(r for r in rows if r['source'] == 'Goodbye.')['context']['branch_path'][0]['index'], 1)
        _, _, report = tool.validate(self.work)
        self.assertEqual(report['changed'], 0)

    def test_native_target_index_is_sealed_and_keeps_controls_without_story_graph(self):
        manifest_raw = (self.work / 'manifest.json').read_bytes()
        index_raw = (self.work / 'technical' / 'native-targets.json').read_bytes()
        index = tool.parse_json(index_raw)
        self.assertEqual(index['format'], 'pinhao-native-targets-1')
        self.assertEqual(index['manifestSha256'], tool.sha(manifest_raw))
        self.assertEqual((self.work / 'technical' / 'native-targets.sha256').read_text().strip(), tool.sha(index_raw))
        manifest = tool.parse_json(manifest_raw)
        self.assertEqual(index['files'], manifest['files'])
        self.assertEqual(set(index['units']), set(manifest['units']))
        for ident, native in manifest['units'].items():
            self.assertEqual(index['units'][ident], {key: native[key] for key in ('id', 'file', 'source', 'controls', 'kind', 'targets')})

    def test_block_relations_have_one_owner_and_review_only_blocks_keep_their_evidence(self):
        for engine in ('MV', 'MZ'):
            with self.subTest(engine=engine):
                game = json_game(self.root / ('relations-' + engine), engine)
                resource = game / 'data' / 'Map001.json'
                doc = tool.read(resource)
                entries = doc['events'][1]['pages'][0]['list']
                entries[-1:-1] = [cmd(111, [0, 1, 0]), cmd(117, [7]), cmd(201, [1, 9, 1, 2]),
                                   cmd(411, []), cmd(355, ['review_this()'], 1), cmd(412, [])]
                doc['events'][1]['pages'].append({'list': [cmd(117, [8]), cmd(355, ['keep_unknown()'])]})
                save(resource, doc)
                work = self.root / ('relations-work-' + engine)
                tool.extract(game, work)
                manifest = tool.read(work / 'manifest.json')
                contexts = [ctx for native in manifest['units'].values() for ctx in native['contexts'] if 'storyBlockRef' in ctx]
                self.assertEqual(sum(len(ctx.get('storyLinks', [])) for ctx in contexts), 3)
                self.assertEqual(len({ctx['storyBlockRef'] for ctx in contexts}), 1)
                self.assertEqual(len({ctx['storyLinksHash'] for ctx in contexts}), 1)
                links = next(ctx['storyLinks'] for ctx in contexts if 'storyLinks' in ctx)
                self.assertEqual(links[-1]['state'], 'unknown')
                review = tool.read(work / 'review-required.json')
                review_contexts = [item['context'] for item in review if item.get('context', {}).get('page') == 1]
                self.assertEqual(sum(len(ctx.get('storyLinks', [])) for ctx in review_contexts), 1)
                self.assertEqual(review_contexts[0]['storyLinks'][0]['target'], {'common_event': 8})
                _, _, report = tool.validate(work)
                self.assertEqual(report['changed'], 0)

    def test_twenty_thousand_dialogues_and_thousand_relations_remain_linear(self):
        game = json_game(self.root / 'large-neutral')
        resource = game / 'data' / 'Map001.json'
        doc = tool.read(resource)
        entries = []
        for index in range(20000):
            entries.extend([cmd(101, ['', 0, 0, 2]), cmd(401, ['Complete neutral sentence %d.' % index])])
        for index in range(400):
            entries.extend([cmd(111, [0, index, 0]), cmd(355, ['keep_logic()'], 1), cmd(412, []), cmd(117, [index + 1])])
        for index in range(200):
            entries.append(cmd(201, [0 if index % 2 else 1, index + 1, 2, 3]))
        entries.append(cmd(0, []))
        doc['events'][1]['pages'][0]['list'] = entries
        save(resource, doc)
        work = self.root / 'large-neutral-work'
        report = tool.extract(game, work)
        self.assertGreaterEqual(report['units'], 20000)
        manifest = tool.read(work / 'manifest.json')
        contexts = [ctx for native in manifest['units'].values() for ctx in native['contexts'] if 'storyBlockRef' in ctx]
        self.assertEqual(sum(len(ctx.get('storyLinks', [])) for ctx in contexts), 1000)
        review = tool.read(work / 'review-required.json')
        self.assertEqual(sum(len(item.get('context', {}).get('storyLinks', [])) for item in review), 0)
        self.assertLess((work / 'manifest.json').stat().st_size, 64 * 1024 * 1024)
        self.assertLess((work / 'technical' / 'native-targets.json').stat().st_size, 16 * 1024 * 1024)
        for item in review:
            if item.get('context', {}).get('map') == 'Map001':
                self.assertEqual(item['context']['storyLinksHash'], contexts[0]['storyLinksHash'])

    def test_nochange_is_byte_identical_and_original_readonly(self):
        before = {p.relative_to(self.game).as_posix(): p.read_bytes() for p in self.game.rglob('*') if p.is_file()}
        out = self.root / 'built'
        tool.build(self.work, self.work / 'editable', out)
        tool.verify(self.work, self.work / 'editable', out)
        manifest = tool.read(self.work / 'manifest.json')
        for file in manifest['files']: self.assertEqual((out / file).read_bytes(), (self.game / file).read_bytes())
        self.assertEqual(before, {p.relative_to(self.game).as_posix(): p.read_bytes() for p in self.game.rglob('*') if p.is_file()})

    def test_merge_build_choice_labels_and_notes(self):
        row = next(r for r in self.rows() if r['kind'] == 'choice' and r['source'] == 'Yes')
        patch = self.patch([{'id': row['id'], 'translation': 'Proceed', 'notes': 'Neutral test'}])
        merged = self.root / 'merged'
        tool.merge(self.work, [patch], merged)
        out = self.root / 'built'
        tool.build(self.work, merged / 'editable', out)
        doc = tool.read(out / 'data' / 'Map001.json')
        entries = doc['events'][1]['pages'][0]['list']
        self.assertEqual(entries[3]['parameters'][0][0], 'Proceed')
        self.assertEqual(entries[4]['parameters'][1], 'Proceed')
        self.assertEqual(doc['data'], [1, 2, 3])
        self.assertEqual(tool.read(merged / 'notes.json')[row['id']], 'Neutral test')
        self.assertEqual(next(r for p in (merged / 'editable').glob('*.json') for r in tool.read(p)['units'] if r['id'] == row['id'])['notes'], '')
        tool.verify(self.work, merged / 'editable', out)

    def test_choice_editor_labels_can_differ_from_display_text(self):
        for engine in ('MV', 'MZ'):
            with self.subTest(engine=engine):
                game, work = self.root / engine, self.root / (engine + '-work')
                json_game(game, engine)
                resource = game / 'data' / 'Map001.json'
                doc = tool.read(resource)
                entries = doc['events'][1]['pages'][0]['list']
                entries[4]['parameters'][1] = 'Previous option \\V[9]'
                save(resource, doc)
                original = resource.read_bytes()
                tool.extract(game, work)
                unchanged = self.root / (engine + '-unchanged')
                tool.build(work, work / 'editable', unchanged)
                self.assertEqual((unchanged / 'data' / 'Map001.json').read_bytes(), original)
                for path in (work / 'editable').glob('*.json'):
                    sheet = tool.read(path)
                    for row in sheet['units']:
                        if row['kind'] == 'choice' and row['source'] == 'Yes':
                            row['translation'] = 'Proceed'
                    save(path, sheet)
                output = self.root / (engine + '-changed')
                tool.build(work, work / 'editable', output)
                tool.verify(work, work / 'editable', output)
                changed = tool.read(output / 'data' / 'Map001.json')
                expected = copy.deepcopy(doc)
                expected['events'][1]['pages'][0]['list'][3]['parameters'][0][0] = 'Proceed'
                self.assertEqual(changed, expected)
                self.assertEqual(resource.read_bytes(), original)

    def test_choice_branch_still_requires_matching_index(self):
        resource = self.game / 'data' / 'Map001.json'
        doc = tool.read(resource)
        doc['events'][1]['pages'][0]['list'][4]['parameters'][0] = 2
        save(resource, doc)
        with self.assertRaisesRegex(ValueError, 'Unmatched choice branch'):
            tool.extract(self.game, self.root / 'invalid-branch')

    def test_controls_and_line_count_preserved(self):
        row = next(r for r in self.rows() if 'Hello' in r['source_preview'])
        text = row['source'].replace('Hello', 'Welcome').replace('Come this way.', 'Follow me.')
        merged = self.root / 'merged'
        tool.merge(self.work, [self.patch([{'id': row['id'], 'translation': text}])], merged)
        out = self.root / 'built'
        tool.build(self.work, merged / 'editable', out)
        entries = tool.read(out / 'data' / 'Map001.json')['events'][1]['pages'][0]['list']
        self.assertEqual(entries[1]['parameters'][0], 'Welcome, \\N[1].')
        self.assertEqual(entries[2]['parameters'][0], 'Follow me.')

    def test_bad_patch_rejected_before_output(self):
        row = next(r for r in self.rows() if 'Hello' in r['source_preview'])
        cases = [{'id': 'unknown', 'translation': 'Text'}, {'id': row['id'], 'translation': 'No tokens'},
                 {'id': row['id'], 'translation': row['source'] + '\n'},
                 {'id': row['id'], 'translation': row['source'] + '\\N[2]'},
                 {'id': row['id'], 'translation': row['source'], 'source': 'Changed'},
                 {'id': row['id'], 'translation': ''}]
        for index, change in enumerate(cases):
            with self.subTest(index=index):
                out = self.root / ('bad%d' % index)
                with self.assertRaises(ValueError): tool.merge(self.work, [self.patch([change])], out)
                self.assertFalse(out.exists())

    def test_duplicate_ids_even_identical_rejected(self):
        row = self.rows()[0]
        change = {'id': row['id'], 'translation': row['source']}
        patch = self.patch([change, change])
        with self.assertRaises(ValueError): tool.merge(self.work, [patch], self.root / 'bad')
        patch = self.patch([change])
        with self.assertRaises(ValueError): tool.merge(self.work, [patch, patch], self.root / 'bad')

    def test_wrong_baseline_rejected(self):
        patch = self.patch([])
        doc = tool.read(patch); doc['baseline_sha256'] = 'wrong'; save(patch, doc)
        with self.assertRaises(ValueError): tool.merge(self.work, [patch], self.root / 'bad')

    def test_manifest_drift_rejected(self):
        path = self.work / 'manifest.json'
        doc = tool.read(path)
        next(iter(doc['units'].values()))['targets'] = [[1, 'level']]
        save(path, doc)
        with self.assertRaises(ValueError): tool.validate(self.work)

    def test_reordered_and_nontranslation_fields_rejected(self):
        p = next(p for p in (self.work / 'editable').glob('*.json') if len(tool.read(p)['units']) > 1)
        original = tool.read(p)
        for change in ('order', 'context', 'source', 'tokens'):
            doc = copy.deepcopy(original)
            if change == 'order': doc['units'].reverse()
            else: doc['units'][0][change] = 'Changed'
            save(p, doc)
            with self.assertRaises(ValueError): tool.validate(self.work)
        save(p, original)

    def test_baseline_drift_and_missing_sheets_rejected(self):
        path = self.work / 'baseline' / 'data' / 'Actors.json'
        raw = path.read_bytes(); path.write_bytes(raw + b' ')
        with self.assertRaises(ValueError): tool.validate(self.work)
        path.write_bytes(raw)
        next((self.work / 'editable').glob('*.json')).unlink()
        with self.assertRaises(ValueError): tool.validate(self.work)

    def test_refuses_existing_or_nested_outputs(self):
        with self.assertRaises(ValueError): tool.extract(self.game, self.work)
        with self.assertRaises(ValueError): tool.extract(self.game, self.game / 'new')
        with self.assertRaises(ValueError): tool.build(self.work, self.work / 'editable', self.work / 'new')

    def test_tampered_build_rejected(self):
        out = self.root / 'built'
        tool.build(self.work, self.work / 'editable', out)
        path = out / 'data' / 'Map001.json'
        doc = tool.read(path); doc['data'][0] = 99; save(path, doc)
        with self.assertRaises(ValueError): tool.verify(self.work, self.work / 'editable', out)

    def test_review_and_images_not_auto_translated(self):
        kinds = {r['kind'] for r in tool.read(self.work / 'review-required.json')}
        self.assertIn('plugin_parameters', kinds)
        self.assertIn('unhandled_data_file', kinds)
        self.assertEqual(len(tool.read(self.work / 'image-inventory.json')), 1)
        self.assertFalse(any('machineKey' in r['source'] or 'never_execute' in r['source'] for r in self.rows()))

    def test_unsupported_xp_detected_not_written(self):
        root = self.root / 'xp'; (root / 'Data').mkdir(parents=True)
        (root / 'Data' / 'System.rxdata').write_bytes(b'fixture')
        self.assertEqual(tool.probe(root)['support'], 'detect_unpack_only')
        with self.assertRaises(ValueError): tool.extract(root, self.root / 'bad')

    def test_duplicate_json_keys_rejected(self):
        with self.assertRaises(ValueError): tool.parse_json(b'{"a":1,"a":2}')

    def test_cli_failure_is_json_and_nonzero(self):
        patch = self.patch([{'id': 'unknown', 'translation': 'Text'}])
        result = subprocess.run([sys.executable, '-X', 'utf8', str(Path(tool.__file__)), 'merge',
                                 '--work', str(self.work), '--patch', str(patch), '--out', str(self.root / 'bad')],
                                capture_output=True, text=True, encoding='utf-8', check=False)
        self.assertEqual(result.returncode, 2)
        self.assertFalse(json.loads(result.stdout)['ok'])
        self.assertFalse((self.root / 'bad').exists())

    def test_cli_patch_template_has_manifest_hash(self):
        output = self.root / 'template.json'
        result = subprocess.run([sys.executable, '-X', 'utf8', str(Path(tool.__file__)), 'patch-template',
                                 '--work', str(self.work), '--out', str(output)],
                                capture_output=True, text=True, encoding='utf-8', check=False)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(tool.read(output)['baseline_sha256'], tool.sha((self.work / 'manifest.json').read_bytes()))


class RubyAndArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_ace_changed_text_and_binary_table_preserved(self):
        game = ruby_game(self.root / 'game'); work = self.root / 'work'
        tool.extract(game, work)
        for p in (work / 'editable').glob('*.json'):
            doc = tool.read(p)
            for row in doc['units']:
                if row['source'] == 'Yes': row['translation'] = '\u786e\u8ba4'
            save(p, doc)
        out = self.root / 'built'
        tool.build(work, work / 'editable', out)
        tool.verify(work, work / 'editable', out)
        reader = Reader((out / 'Data' / 'Map001.rvdata2').read_bytes())
        self.assertEqual(reader.root.attrs['@data'].data, b'\0opaque\xff')
        entries = reader.root.attrs['@events'][1].attrs['@pages'][0].attrs['@list']
        self.assertEqual(entries[4].attrs['@parameters'][1].text(), '\u786e\u8ba4')

    def test_marshal_shared_string_reference_preserved(self):
        raw = b'\x04\x08[' + long_bytes(2) + marshal('Lin') + b'@' + long_bytes(1)
        reader = Reader(raw)
        patched = Reader(reader.patch({1: 'Traveler'}))
        self.assertIs(patched.root[0], patched.root[1])
        self.assertEqual(patched.root[0].text(), 'Traveler')

    def test_marshal_invalid_link_and_truncated_input_rejected(self):
        for raw in (b'\x04\x08@\xfa', b'\x04\x08"\x10abc', b'no'):
            with self.assertRaises(ValueError): Reader(raw)

    def test_archive_v1_and_v3_and_data_only(self):
        resources = [('Data\\System.rvdata2', b'\x04\x08abc'), ('Graphics/test.png', b'ignore'),
                     ('Data/Map001.rvdata2', bytes(range(256)) * 260 + b'tail')]
        for version, generator in ((1, archive_v1), (3, archive_v3)):
            path = self.root / ('test%d.arc' % version); generator(path, resources)
            out = self.root.parent / (self.root.name + '-unpack-%d' % version)
            # Archive and output are siblings, never an original game's child.
            try:
                report = unpack(path, out)
                self.assertEqual(report['files'], 2)
                self.assertEqual((out / 'Data' / 'Map001.rvdata2').read_bytes(), resources[2][1])
                self.assertFalse((out / 'Graphics').exists())
            finally:
                if out.exists():
                    import shutil
                    shutil.rmtree(out)

    def test_archive_path_traversal_duplicate_and_truncation(self):
        path = self.root / 'bad.arc'
        for resources in ([('../escape', b'a')], [('Data/A.rvdata2', b'a'), ('data/a.rvdata2', b'b')]):
            archive_v3(path, resources)
            with self.assertRaises(ValueError): archive_entries(path)
        archive_v3(path, [('Data/A.rvdata2', b'abc')]); path.write_bytes(path.read_bytes()[:-1])
        with self.assertRaises(ValueError): archive_entries(path)


if __name__ == '__main__':
    unittest.main()
