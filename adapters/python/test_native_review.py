"""Native field review against neutral serialized and UnityFS resources."""
from __future__ import annotations

import copy
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import worker
import native_review
import unity_native as unity
from test_unity_native import fixture_nodes, unity_game, unity_bundle, unity_serialized
from test_unity_semantics import COMPILER, SOURCE


def review_game(root, bundle=False, empty=False):
    from UnityPy.helpers.TypeTreeNode import TypeTreeNode
    nodes = fixture_nodes(extra=True)
    def node(level, kind, name, size=-1, children=None):
        return TypeTreeNode(level, kind, name, size, 1, children or [], m_TypeFlags=0, m_Index=0, m_MetaFlag=0)
    caption = node(7, 'string', 'caption')
    row = node(6, 'FixtureLine', 'data', children=[caption, node(7, 'string', 'eventId')])
    lines = node(4, 'vector', 'lines', children=[node(5, 'Array', 'Array', children=[node(6, 'int', 'size', 4), row])])
    chapter = node(3, 'FixtureChapter', 'data', children=[lines])
    chapters = node(1, 'vector', 'chapters', children=[node(2, 'Array', 'Array', children=[node(3, 'int', 'size', 4), chapter])])
    nodes[114].m_Children.append(chapters)
    nodes[114].m_Children.extend([
        node(1, 'AnimationTriggers', 'm_AnimationTriggers', children=[node(2, 'string', 'm_NormalTrigger')]),
        node(1, 'UnityEvent', 'm_OnClick', children=[node(2, 'PersistentCallGroup', 'm_PersistentCalls', children=[
            node(3, 'vector', 'm_Calls', children=[node(4, 'Array', 'Array', children=[node(5, 'int', 'size', 4),
                node(5, 'PersistentCall', 'data', children=[node(6, 'string', 'm_MethodName'),
                    node(6, 'Arguments', 'm_Arguments', children=[node(7, 'string', 'm_StringArgument'),
                                                               node(7, 'string', 'm_ObjectArgumentAssemblyTypeName')])])])])])]),
        node(1, 'string', 'm_HorizontalAxis'), node(1, 'string', 'animationCaption')])
    for tree in nodes.values():
        for index, item in enumerate(tree.traverse()):
            item.m_Index = index
    with mock.patch('test_unity_native.fixture_nodes', return_value=nodes):
        game = unity_game(root, extra=True)
    managed = game / 'Fixture_Data/Managed'
    managed.mkdir()
    subprocess.run([str(COMPILER), '/nologo', '/optimize+', '/target:library', '/out:' + str(managed / 'Assembly-CSharp.dll'), str(SOURCE)], check=True, capture_output=True)
    path = game / 'Fixture_Data/resources.assets'
    _, top = unity.load_carrier(path)
    obj = unity.objects(top)['@:9']
    tree = obj.parse_as_dict()
    tree['m_Text'] = '' if empty else 'A custom heading.'
    tree['internalTarget'] = '' if empty else 'END_SCENE'
    tree['chapters'] = [] if empty else [{'lines': [{'caption': 'A complete first sentence.', 'eventId': 'event_1'},
                                                   {'caption': 'A complete second sentence.', 'eventId': 'event_2'}]}]
    if not empty:
        tree['m_AnimationTriggers']['m_NormalTrigger'] = 'Normal'
        tree['m_OnClick']['m_PersistentCalls']['m_Calls'] = [{'m_MethodName': 'OpenPanel',
            'm_Arguments': {'m_StringArgument': 'internal_panel', 'm_ObjectArgumentAssemblyTypeName': 'UnityEngine.Object, UnityEngine'}}]
        tree['m_HorizontalAxis'] = 'Horizontal'
        tree['animationCaption'] = 'A traveler waves hello.'
    obj.save_typetree(tree)
    raw = top.save(packer='original')
    if bundle:
        path.unlink()
        path = game / 'Fixture_Data/text.bundle'
        raw = unity_bundle(raw)
    path.write_bytes(raw)
    return game, path


@unittest.skipUnless(unity.available() and COMPILER.is_file(), 'Prepare UnityPy and the Windows managed compiler before native field review tests')
class NativeReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pinhao-native-review-')
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def extract_pending(self, game, work):
        # Start without consumer evidence, then restore the real tool for incremental review.
        with mock.patch.object(unity.unity_semantics, 'inspect_fields',
                               return_value={'available': False, 'detail': 'Initial consumer evidence is unavailable', 'fields': []}), \
                mock.patch.object(unity.unity_semantics, 'code_groups', return_value=[]):
            return worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})

    def extract(self, *, bundle=False, empty=False):
        game, path = review_game(self.root, bundle=bundle, empty=empty)
        work = self.root / 'work'
        extracted = self.extract_pending(game, work)
        return game, path, work, extracted

    def inspect(self, work, **extra):
        if not any(key in extra for key in ('file', 'groupId', 'acceptedOnly', 'coverageOnly')):
            metadata = work / 'technical/product-source.json'
            carriers = list(worker.native.read(metadata).get('nativeFilesSha256', {})) if metadata.is_file() else []
            if len(carriers) == 1:
                extra['file'] = carriers[0]
        return worker.COMMANDS['native_review']({'workspaceDir': str(work), **extra})

    def commit(self, work, output, group, fields=None, disposition='display'):
        fields = fields if fields is not None else [{'path': ['chapters', '*', 'lines', '*', 'caption'], 'kind': 'dialogue'}]
        fields = [{**field, **({'displaySites': [use['siteId'] for usage in group.get('fieldUses', {}).get('fields', []) if usage['path'] == field['path']
                              for use in usage['uses'] if use['displayOnly']]} if any(usage['path'] == field['path'] for usage in group.get('fieldUses', {}).get('fields', [])) else {})} for field in fields]
        decision = {'groupId': group['groupId'], 'evidenceHash': group['evidenceHash'],
                    'disposition': disposition, 'reason': 'Fixture schema has an explicit narrative display field.',
                    'fields': fields}
        return worker.COMMANDS['native_adapt']({'workspaceDir': str(work), 'outputDir': str(output), 'decisions': [decision]})

    def test_normal_extract_collects_proven_code_sentences_and_build_preserves_business_values(self):
        game, _ = review_game(self.root)
        assembly = game / 'Fixture_Data/Managed/Assembly-CSharp.dll'
        subprocess.run([str(COMPILER), '/nologo', '/optimize+', '/target:exe', '/out:' + str(assembly), str(SOURCE)],
                       check=True, capture_output=True)
        before = {rel: worker.digest_file(file) for rel, file in worker.files_in(game)}
        work = self.root / 'automatic'
        extracted = worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
        managed = [row for row in extracted['units'] if row['context'].get('type') == 'ManagedMethod']
        self.assertTrue(managed)
        selected = next(row for row in managed if row['source'] == 'Neutral first sentence.')
        self.assertIn('Neutral.DisplayTypewriter::Prepare', selected['context']['method'])
        self.assertIn('allocationOffset', selected['context'])
        self.assertIn('elementIndex', selected['context'])
        self.assertNotIn('Hello ', [row['source'] for row in managed])
        metadata = worker.native.read(work / 'technical/product-source.json')
        groups = unity.unity_semantics.code_groups(Path(metadata['nativeSource']), metadata, worker)
        by_id = {group['groupId']: group for group in groups}
        self.assertTrue(all(by_id[row['context']['reviewGroup']]['verifiedDisplayInputs'] for row in managed))
        self.assertTrue(all(field['displaySites'] for decision in metadata['nativeReviewDecisions'].values()
                            for field in decision['fields']))
        # Accepting literal sentences must not erase unsupported expressions or unsafe display consumers.
        selected_group = by_id[selected['context']['reviewGroup']]
        self.assertTrue(selected_group['unsupportedTemplates'])
        self.assertTrue(any(issue.get('groupId') == selected_group['groupId']
                            and issue['kind'] == unity.unity_semantics.CODE_REVIEW_KIND for issue in extracted['reviewItems']))
        self.assertTrue(any(issue.get('category') == 'info' and 'Mixed or unresolved' in issue.get('detail', '')
                            for issue in extracted['reviewItems']))
        self.assertTrue(worker.roundtrip({'workspaceDir': str(work)})['byteIdentical'])
        built = self.root / 'automatic-built'
        report = worker.build({'workspaceDir': str(work), 'outputDir': str(built),
                               'translations': [{'id': selected['id'], 'translation': '中性句子'}]})
        self.assertTrue(report['displayValidation'][0]['originalBusinessIlUnchanged'])
        self.assertFalse(report['runtimeVerified'])
        executable = self.root / 'AutomaticFixture.exe'
        executable.write_bytes((built / 'Fixture_Data/Managed/Assembly-CSharp.dll').read_bytes())
        actual = subprocess.run([str(executable), 'display-typewriter'], check=True, capture_output=True).stdout.decode('utf-8').splitlines()
        self.assertEqual(actual, ['中性', 'Neutral first sentence.', '中性句子', 'Neu', 'Neutral second sentence.'])
        self.assertEqual({rel: worker.digest_file(file) for rel, file in worker.files_in(game)}, before)

    def test_proven_code_sentences_are_extracted_when_serialized_display_fields_are_empty(self):
        game = unity_game(self.root, zero_display=True)
        path = game / 'Fixture_Data/resources.assets'
        _, top = unity.load_carrier(path)
        obj = unity.objects(top)['@:9']
        tree = obj.parse_as_dict()
        tree['m_Text'] = ''
        obj.save_typetree(tree)
        path.write_bytes(top.save(packer='original'))
        assembly = game / 'Fixture_Data/Managed/Assembly-CSharp.dll'
        assembly.parent.mkdir()
        subprocess.run([str(COMPILER), '/nologo', '/optimize+', '/target:library', '/out:' + str(assembly), str(SOURCE)],
                       check=True, capture_output=True)
        work = self.root / 'code-only'
        extracted = worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
        self.assertTrue(extracted['units'])
        self.assertTrue(all(row['context'].get('type') == 'ManagedMethod' for row in extracted['units']))
        self.assertTrue(worker.roundtrip({'workspaceDir': str(work)})['byteIdentical'])

    def test_nested_fields_extend_stable_units_and_retain_current_work(self):
        for bundle in (False, True):
            with self.subTest(bundle=bundle):
                branch = self.root / ('bundle' if bundle else 'serialized')
                branch.mkdir()
                game, path = review_game(branch, bundle=bundle)
                work = branch / 'work'
                original = self.extract_pending(game, work)
                before = {rel: file.read_bytes() for rel, file in worker.files_in(work)}
                manifest, sheets = worker.native.load_work(work)
                name, sheet, accepted_row = next((name, sheet, row) for name, sheet in sheets.items()
                                                  for row in sheet['units'] if not row['tokens'])
                accepted_row['translation'] = '欢迎来到旅店'
                accepted_row['notes'] = 'Accepted human edit'
                worker.json_write(work / 'editable' / name, sheet)
                before = {rel: file.read_bytes() for rel, file in worker.files_in(work)}
                metadata_before = worker.native.read(work / 'technical/product-source.json')
                source = Path(metadata_before['nativeSource'])
                source_hashes = {rel: worker.digest_file(file) for rel, file in worker.files_in(source)}
                review = self.inspect(work)
                self.assertEqual(review['total'], 1)
                group = review['groups'][0]
                self.assertEqual(group['script']['className'], 'Command')
                self.assertEqual(group['objectCount'], 1)
                self.assertTrue(any(field['path'] == ['chapters', '*', 'lines', '*', 'caption'] and field['count'] == 2
                                    for field in group['fields']))
                output = branch / 'extended'
                result = self.commit(work, output, group)
                self.assertEqual(result['addedUnits'], 2)
                self.assertEqual(len(result['units']), len(original['units']) + 2)
                self.assertTrue(set(row['id'] for row in original['units']) <= set(row['id'] for row in result['units']))
                extended_manifest, _ = worker.native.load_work(output)
                for ident, unit in manifest['units'].items():
                    self.assertEqual(extended_manifest['units'][ident], unit)
                retained = next(row for row in worker.native.read(output / 'editable' / name)['units']
                                if row['id'] == accepted_row['id'])
                self.assertEqual(retained['translation'], '欢迎来到旅店')
                self.assertEqual(retained['notes'], 'Accepted human edit')
                self.assertEqual(worker.native.read(output / 'technical/product-source.json')['nativeSource'], str(source))
                self.assertEqual({rel: file.read_bytes() for rel, file in worker.files_in(work)}, before)
                self.assertEqual({rel: worker.digest_file(file) for rel, file in worker.files_in(source)}, source_hashes)
                self.assertFalse(any(issue['kind'] == 'custom_monobehaviour_display_schema_required' for issue in result['reviewItems']))
                self.assertEqual(result['nativeReviewDecisions'][0]['file'], path.relative_to(game).as_posix())
                self.assertTrue(worker.roundtrip({'workspaceDir': str(output)})['byteIdentical'])
                # Custom source fields retain their identities; only verified consumers receive translated temporaries.
                translations = [{'id': row['id'], 'translation': '一段完整的中文。'} for row in result['units'] if row['kind'] == 'dialogue']
                built = branch / 'built'
                built_report = worker.build({'workspaceDir': str(output), 'outputDir': str(built), 'translations': translations})
                _, actual = unity.load_carrier(built / path.relative_to(game))
                key = ('CAB-fixture' if bundle else '@') + ':9'
                custom = unity.objects(actual)[key].parse_as_dict()
                self.assertEqual(custom['chapters'][0]['lines'][0]['caption'], 'A complete first sentence.')
                self.assertTrue(built_report['displayValidation'][0]['sourceIdentifiersUnchanged'])
                self.assertEqual(custom['chapters'][0]['lines'][0]['eventId'], 'event_1')
                self.assertEqual(custom['internalTarget'], 'END_SCENE')
                self.assertEqual(custom['m_Text'], 'A custom heading.')
                self.assertEqual(custom['m_Script'], {'m_FileID': 0, 'm_PathID': 8})
                # Subsequent field bindings append units instead of renumbering old ones.
                current = self.inspect(output)['groups'][0]
                second = branch / 'extended-again'
                later = self.commit(output, second, current, fields=[{'path': ['m_Text'], 'kind': 'ui_text'}])
                self.assertEqual(later['addedUnits'], 1)
                self.assertEqual(len(later['units']), len(result['units']) + 1)
                self.assertTrue(set(extended_manifest['units']) <= set(worker.native.load_work(second)[0]['units']))
                third = branch / 'repeated'
                repeated = self.commit(second, third, self.inspect(second)['groups'][0])
                self.assertEqual(repeated['addedUnits'], 0)
                self.assertEqual(worker.native.load_work(third)[0], worker.native.load_work(second)[0])
                self.assertTrue(worker.roundtrip({'workspaceDir': str(third)})['byteIdentical'])

    def test_logic_fields_and_stale_evidence_are_rejected_before_writing(self):
        _, _, work, _ = self.extract()
        group = self.inspect(work)['groups'][0]
        for field in (['internalTarget'], ['m_Name'], ['chapters', '*', 'lines', '*', 'eventId'], ['m_Script', 'm_PathID'],
                      ['m_AnimationTriggers', 'm_NormalTrigger'], ['m_HorizontalAxis'],
                      ['m_OnClick', 'm_PersistentCalls', 'm_Calls', '*', 'm_MethodName'],
                      ['m_OnClick', 'm_PersistentCalls', 'm_Calls', '*', 'm_Arguments', 'm_StringArgument'],
                      ['m_OnClick', 'm_PersistentCalls', 'm_Calls', '*', 'm_Arguments', 'm_ObjectArgumentAssemblyTypeName']):
            output = self.root / 'rejected'
            with self.subTest(field=field), self.assertRaises((ValueError, worker.WorkerError)):
                self.commit(work, output, group, fields=[{'path': field}])
            self.assertFalse(output.exists())
        ordinary = self.commit(work, self.root / 'ordinary-display', group, fields=[{'path': ['animationCaption']}])
        self.assertEqual(ordinary['addedUnits'], 1)
        stale = copy.deepcopy(group)
        stale['evidenceHash'] = '0' * 64
        with self.assertRaisesRegex(worker.WorkerError, 'evidence changed'):
            self.commit(work, self.root / 'stale', stale)
        self.assertFalse((self.root / 'stale').exists())
        metadata = worker.native.read(work / 'technical/product-source.json')
        path = Path(metadata['nativeSource']) / group['file']
        path.write_bytes(path.read_bytes() + b'changed')
        with self.assertRaisesRegex(worker.WorkerError, 'source snapshot changed'):
            self.commit(work, self.root / 'changed', group)

    def test_fresh_observation_replaces_old_decision_without_old_field_union_and_keeps_saved_text(self):
        _, _, work, _ = self.extract()
        initial = self.inspect(work)['groups'][0]
        first = self.root / 'first'
        self.commit(work, first, initial, fields=[{'path': ['m_Text'], 'kind': 'ui_text'}])
        manifest, sheets = worker.native.load_work(first)
        name, saved = next((name, row) for name, sheet in sheets.items() for row in sheet['units']
                           if manifest['units'][row['id']]['file'].startswith('__unity_review__/'))
        editable = worker.native.read(first / 'editable' / name)
        next(row for row in editable['units'] if row['id'] == saved['id']).update(translation='已经保存的完整译文', notes='Accepted human note')
        worker.json_write(first / 'editable' / name, editable)
        _, _, _, metadata, source = native_review.context({'workspaceDir': str(first)}, worker)
        fresh = copy.deepcopy(native_review.review_groups(source, metadata, worker, initial['file'])[0])
        fresh['evidenceHash'] = 'b' * 64
        fresh['status'] = 'pending'
        with mock.patch.object(native_review, 'review_groups', return_value=[fresh]):
            with self.assertRaisesRegex(worker.WorkerError, 'evidence changed'):
                self.commit(first, self.root / 'stale-old-hash', initial)
            self.assertFalse((self.root / 'stale-old-hash').exists())
            second = self.root / 'second'
            result = self.commit(first, second, fresh, fields=[{'path': ['animationCaption'], 'kind': 'dialogue'}])
            decision = next(item for item in result['nativeReviewDecisions'] if item['groupId'] == fresh['groupId'])
            self.assertEqual(decision['evidenceHash'], fresh['evidenceHash'])
            self.assertEqual([field['path'] for field in decision['fields']], [['animationCaption']])
            updated, _ = worker.native.load_work(second)
            for ident, row in manifest['units'].items():
                self.assertEqual(updated['units'][ident], row)
            retained = next(row for row in worker.native.read(second / 'editable' / name)['units'] if row['id'] == saved['id'])
            self.assertEqual((retained['translation'], retained['notes']), ('已经保存的完整译文', 'Accepted human note'))
            with self.assertRaisesRegex(worker.WorkerError, 'actual display consumers'):
                self.commit(second, self.root / 'same-hash-disposition', fresh, fields=[], disposition='non-display')
            with self.assertRaisesRegex(ValueError, 'kind conflicts'):
                self.commit(second, self.root / 'same-hash-kind', fresh, fields=[{'path': ['animationCaption'], 'kind': 'description'}])
            merged = self.commit(second, self.root / 'same-hash-addition', fresh, fields=[{'path': ['m_Text'], 'kind': 'ui_text'}])
            current = next(item for item in merged['nativeReviewDecisions'] if item['groupId'] == fresh['groupId'])
            self.assertEqual({tuple(field['path']) for field in current['fields']}, {('m_Text',), ('animationCaption',)})
        newer = {**fresh, 'evidenceHash': 'c' * 64,
                 'fieldUses': {**fresh['fieldUses'], 'fields': []}}
        with mock.patch.object(native_review, 'review_groups', return_value=[newer]):
            replaced = self.commit(second, self.root / 'new-hash-disposition', newer, fields=[], disposition='non-display')
        final = next(item for item in replaced['nativeReviewDecisions'] if item['groupId'] == fresh['groupId'])
        self.assertEqual((final['disposition'], final['fields']), ('non-display', []))
        self.assertTrue(set(manifest['units']) <= set(worker.native.load_work(self.root / 'new-hash-disposition')[0]['units']))

    def test_structural_no_text_non_display_is_persistent_and_idempotent(self):
        _, _, work, extracted = self.extract(empty=True)
        # Resume a legacy pending empty group; fresh extraction can already settle it through the prefilter.
        metadata = worker.native.read(work / 'technical/product-source.json')
        issue = next(item for item in metadata['issues'] if item.get('script', {}).get('className') == 'Command')
        issue['kind'] = 'custom_monobehaviour_display_schema_required'
        metadata['nativeReviewCatalog'] = copy.deepcopy(metadata['issues'])
        worker.json_write(work / 'technical/product-source.json', metadata)
        group = self.inspect(work)['groups'][0]
        self.assertEqual(group['status'], 'no-text')
        self.assertEqual(group['fields'], [])
        out = self.root / 'classified'
        result = self.commit(work, out, group, fields=[], disposition='non-display')
        self.assertEqual(result['addedUnits'], 0)
        self.assertEqual(len(result['units']), len(extracted['units']))
        self.assertEqual(self.inspect(out)['groups'][0]['status'], 'accepted')
        repeated = self.commit(out, self.root / 'classified-again', self.inspect(out)['groups'][0], fields=[], disposition='non-display')
        self.assertEqual(repeated['addedUnits'], 0)
        self.assertEqual(result['nativeReviewDecisions'], repeated['nativeReviewDecisions'])

    def test_stripped_schema_is_persisted_for_independent_native_writeback(self):
        game = unity_game(self.root)
        managed = game / 'Fixture_Data/Managed'
        managed.mkdir()
        subprocess.run([str(COMPILER), '/nologo', '/optimize+', '/target:library', '/out:' + str(managed / 'Assembly-CSharp.dll'), str(SOURCE)], check=True, capture_output=True)
        path = game / 'Fixture_Data/resources.assets'
        path.write_bytes(unity_serialized(stripped=True))
        work = self.root / 'work'
        with mock.patch.object(unity, 'generated_nodes', return_value=fixture_nodes()[114]):
            self.extract_pending(game, work)
            group = self.inspect(work)['groups'][0]
            output = self.root / 'extended'
            result = self.commit(work, output, group, fields=[{'path': ['m_Text'], 'kind': 'ui_text'}])
        metadata = worker.native.read(output / 'technical/product-source.json')
        record = next(record for record in metadata['recordMap'].values() if record.get('reviewGroup'))
        self.assertIn(record['reviewSchema'], metadata['nativeReviewSchemas'])
        new = next(row for row in result['units'] if row['context'].get('reviewGroup'))
        built = self.root / 'built'
        with mock.patch.object(unity, 'generated_nodes', side_effect=AssertionError('Use the reviewed persisted schema')):
            worker.build({'workspaceDir': str(output), 'outputDir': str(built),
                          'translations': [{'id': new['id'], 'translation': '新的完整对白。'}]})
        _, actual = unity.load_carrier(built / 'Fixture_Data/resources.assets')
        custom = unity.objects(actual)['@:9'].read_typetree(fixture_nodes()[114])
        self.assertEqual(custom['m_Text'], 'INTERNAL_LOGIC_TEXT')
        self.assertTrue(worker.native.read(built / 'build-report.json')['displayValidation'][0]['sourceIdentifiersUnchanged'])
        self.assertEqual(custom['internalTarget'], 'END_SCENE')
        self.assertEqual(custom['m_Script'], {'m_FileID': 0, 'm_PathID': 8})

    def test_same_script_objects_share_one_review_group(self):
        game, path = review_game(self.root)
        _, top = unity.load_carrier(path)
        obj = unity.objects(top)['@:7']
        tree = obj.parse_as_dict()
        tree['m_Script']['m_PathID'] = 8
        tree['m_Text'] = 'Another custom display heading.'
        obj.save_typetree(tree)
        path.write_bytes(top.save(packer='original'))
        work = self.root / 'work'
        self.extract_pending(game, work)
        with mock.patch.object(unity, 'objects', wraps=unity.objects) as index:
            review = self.inspect(work)
            self.assertEqual(index.call_count, 1)
        self.assertEqual(review['total'], 1)
        self.assertEqual(review['groups'][0]['objectCount'], 2)
        result = self.commit(work, self.root / 'extended', review['groups'][0], fields=[{'path': ['m_Text']}])
        self.assertEqual(result['addedUnits'], 2)

    def test_partial_binding_reprojects_old_closed_coverage_without_writing_and_can_extend(self):
        _, _, work, _ = self.extract()
        group = self.inspect(work)['groups'][0]
        partial = self.root / 'partial'
        first = self.commit(work, partial, group)
        self.assertEqual(first['addedUnits'], 2)
        pending = self.inspect(partial)['groups'][0]
        self.assertEqual(pending['status'], 'pending')
        self.assertEqual(pending['remainingDisplaySites'], 2)
        # Reproduce an old accepted decision whose coverage was incorrectly cleared.
        metadata = worker.native.read(partial / 'technical/product-source.json')
        metadata['issues'] = []
        worker.json_write(partial / 'technical/product-source.json', metadata)
        before = {rel: path.read_bytes() for rel, path in worker.files_in(partial)}
        projected = self.inspect(partial, acceptedOnly=True, coverageOnly=True)
        managed = [item for item in projected['reviewItems'] if item.get('kind') == native_review.unity_semantics.CODE_REVIEW_KIND]
        self.assertEqual(projected['refreshedGroups'], 1 + len(managed))
        self.assertNotIn('groups', projected)
        self.assertNotIn('units', projected)
        unresolved = [item for item in projected['reviewItems'] if item.get('category') == 'native-schema' and item.get('groupId') == group['groupId']]
        self.assertEqual({tuple(item['field']) for item in unresolved}, {('m_Text',), ('animationCaption',)})
        self.assertEqual(sum(len(item['remainingSites']) for item in unresolved), 2)
        self.assertEqual({rel: path.read_bytes() for rel, path in worker.files_in(partial)}, before)
        manifest, sheets = worker.native.load_work(partial)
        name, sheet, row = next((name, sheet, row) for name, sheet in sheets.items()
                                for row in sheet['units'] if row['id'] in {item['id'] for item in first['units']})
        row['translation'] = '已接受的译文'
        worker.json_write(partial / 'editable' / name, sheet)
        finished = self.root / 'finished'
        result = self.commit(partial, finished, pending, fields=[{'path': ['m_Text']}, {'path': ['animationCaption']}])
        self.assertEqual(result['addedUnits'], 2)
        self.assertTrue(set(manifest['units']) <= set(worker.native.load_work(finished)[0]['units']))
        self.assertEqual(next(item for item in worker.native.read(finished / 'editable' / name)['units']
                              if item['id'] == row['id'])['translation'], row['translation'])
        self.assertEqual(len(result['nativeReviewDecisions'][0]['fields']), 3)
        self.assertEqual(self.inspect(finished)['groups'][0]['status'], 'accepted')
        self.assertFalse(any(item.get('category') == 'native-schema' and item.get('groupId') == group['groupId']
                             for item in self.inspect(finished, acceptedOnly=True, coverageOnly=True)['reviewItems']))

    def test_adapting_another_group_retains_prior_partial_display_coverage(self):
        game, carrier = review_game(self.root)
        (game / 'Fixture_Data/level1').write_bytes(carrier.read_bytes())
        work = self.root / 'work'
        self.extract_pending(game, work)
        first, second = [group for group in self.inspect(work)['groups'] if group.get('candidateType') != 'managed-code']
        partial = self.root / 'partial'
        accepted = self.commit(work, partial, first)
        metadata = worker.native.read(partial / 'technical/product-source.json')
        metadata['issues'] = [item for item in metadata['issues'] if item.get('file') != first['file']]
        worker.json_write(partial / 'technical/product-source.json', metadata)
        another = self.commit(partial, self.root / 'another', second, fields=[{'path': ['m_Text']}])
        remaining = [item for item in another['reviewItems'] if item.get('groupId') == first['groupId']
                     and item.get('category') == 'native-schema']
        self.assertEqual(sum(len(item['remainingSites']) for item in remaining), 2)
        self.assertEqual({tuple(item['field']) for item in remaining}, {('m_Text',), ('animationCaption',)})
        self.assertTrue({item['id'] for item in accepted['units']} <= {item['id'] for item in another['units']})
        self.assertEqual(self.inspect(self.root / 'another', groupId=first['groupId'])['groups'][0]['status'], 'pending')

    def test_review_bounds_and_single_index_per_carrier(self):
        _, _, work, _ = self.extract()
        with mock.patch.object(unity, 'objects', wraps=unity.objects) as index:
            result = self.inspect(work, limit=1)
            self.assertEqual(index.call_count, 1)
        self.assertEqual(result['groups'][0]['groupId'], self.inspect(work)['groups'][0]['groupId'])
        self.assertEqual(result['groups'][0]['evidenceHash'], self.inspect(work)['groups'][0]['evidenceHash'])
        self.assertEqual(self.inspect(work, offset=1)['groups'], [])
        self.assertEqual(self.inspect(work, offset=1)['offset'], 1)
        with mock.patch.object(unity, 'review_groups', wraps=unity.review_groups) as grouped:
            self.inspect(work, groupId=result['groups'][0]['groupId'])
            self.assertEqual(grouped.call_args.args[3], result['groups'][0]['file'])
        for limit in (0, 101, True, '10'):
            with self.assertRaisesRegex(ValueError, 'limit must be an integer'):
                self.inspect(work, limit=limit)
        with self.assertRaisesRegex(worker.WorkerError, 'does not exist'):
            self.inspect(work, groupId='missing')

    def test_other_engines_report_explicit_capability_failure(self):
        root = self.root / 'source'
        root.mkdir()
        (root / 'dialogue.json').write_text('{"text":"A neutral phrase."}', encoding='utf-8')
        collector = native_review.formats.Collector(root, 'Other Engine', 'json', 10)
        file, _ = collector.document(root / 'dialogue.json')
        collector.add(file, ['text'], 'A neutral phrase.', 'display_text', {})
        work = self.root / 'work'
        collector.finish(work)
        with self.assertRaises(worker.WorkerError) as failure:
            self.inspect(work)
        self.assertEqual(failure.exception.code, 'NATIVE_REVIEW_UNSUPPORTED')


class NativeCoverageProjectionTests(unittest.TestCase):
    def test_managed_producers_group_by_display_chain_and_keep_complete_sentence_locations(self):
        import unity_semantics as semantics
        with tempfile.TemporaryDirectory(prefix='pinhao-code-candidates-') as temporary:
            source = Path(temporary)
            assembly = source / 'Data/Managed/Neutral.dll'
            assembly.parent.mkdir(parents=True)
            assembly.write_bytes(b'neutral managed candidate evidence')
            digest = worker.digest_file(assembly)
            site = {'siteId': 'display-site-v1:' + 'a' * 64, 'siteKind': 'presentation-store',
                    'field': 'System.String Neutral.Controller::Current', 'display': True, 'displayOnly': True}
            def method(token, offset, text, unsupported=False):
                return {'groupId': 'physical-' + str(token) + '-' + str(offset), 'method': 'System.Void Neutral.Story::Scene' + str(token) + '()',
                        'methodToken': token, 'allocationOffset': offset, 'arrayField': 'System.String[] Neutral.Story::Sentences',
                        'elements': [{'index': 0, 'source': text, 'expressionKind': 'literal', 'supported': True, 'sourceOffsets': [offset + 2]},
                                     *([{'index': 1, 'source': None, 'expressionKind': 'unsupported-template', 'supported': False,
                                         'sourceOffsets': [offset + 6]}] if unsupported else [])], 'displaySites': [site]}
            report = {'schema': semantics.CODE_VERSION, 'assemblySha256': digest, 'groups': [
                method(1, 8, 'A complete first sentence.', True), method(1, 42, 'A complete second sentence.'),
                method(2, 8, 'A complete first sentence.')]}
            metadata = {'engine': unity.ENGINE, 'assemblyFilesSha256': {'Data/Managed/Neutral.dll': digest},
                        'issues': [{'file': 'Data/level1', 'kind': 'prefiltered_no_text', 'script': {'assembly': 'Neutral.dll'}}]}
            semantics._CODE_REPORTS.clear()
            with mock.patch.object(semantics, 'run', return_value=report) as inspect_code:
                groups = semantics.code_groups(source, metadata, worker)
                self.assertEqual(len(groups), 1)
                group = groups[0]
                self.assertEqual(group['objectCount'], 3)
                self.assertEqual(group['fields'][0]['count'], 3)
                self.assertEqual(group['unsupportedTemplates'], 1)
                self.assertEqual(len(group['_objects']), 3)  # Two allocations in one method must not overwrite each other.
                self.assertEqual(len(semantics.code_groups(source, metadata, worker)), 1)
                self.assertEqual(inspect_code.call_count, 1)
                self.assertEqual(semantics.code_groups(source, metadata, worker, 'Data/other.assets'), [])
            field = {'path': ['sentences', '*'], 'kind': 'dialogue', 'displaySites': [site['siteId']]}
            bound = semantics.bind_field(group, field, worker)
            entries = unity.review_entries(group, [bound])
            self.assertEqual([item['entry']['source'] for item in entries], [
                'A complete first sentence.', 'A complete second sentence.', 'A complete first sentence.'])
            self.assertEqual({item['entry']['codeOrigin']['allocationOffset'] for item in entries}, {8, 42})
            self.assertEqual({item['entry']['codeOrigin']['methodToken'] for item in entries}, {1, 2})
            self.assertFalse(any('fragment' in item['entry']['source'] for item in entries))
            decision = {'groupId': group['groupId'], 'evidenceHash': group['evidenceHash'], 'disposition': 'non-display',
                        'fields': [], 'reason': 'No direct serialized field can be rewritten.'}
            with self.assertRaises(worker.WorkerError) as rejection:
                native_review.decision_for(group, decision, worker)
            self.assertEqual(rejection.exception.code, 'NATIVE_CODE_DISPLAY_REQUIRED')
            decision.update(disposition='display', fields=[field])
            metadata['nativeReviewDecisions'] = {group['groupId']: native_review.decision_for(group, decision, worker)}
            collector = native_review.extend_rows(source, {'units': {}, 'files': {}}, {'engine': unity.ENGINE, 'recordMap': {}},
                                                  [(group, metadata['nativeReviewDecisions'][group['groupId']])], worker)
            self.assertEqual(len(collector.rows), 3)
            self.assertEqual(len({row['id'] for row in collector.rows}), 3)
            self.assertEqual(collector.units[collector.rows[0]['id']]['sync_group'], collector.units[collector.rows[2]['id']]['sync_group'])
            self.assertNotEqual(collector.rows[0]['context']['scene'], collector.rows[2]['context']['scene'])
            metadata['issues'] = semantics.code_issues(metadata, groups)
            projected = native_review.coverage_issues(metadata, groups)
            self.assertTrue(any(item.get('kind') == semantics.CODE_REVIEW_KIND for item in projected))
            self.assertEqual(group['status'], 'pending')  # Accepted literal sentences do not settle unsupported templates.
            before = copy.deepcopy(metadata)
            with mock.patch.object(native_review, 'context', return_value=(source, {}, {}, metadata, source)):
                coverage = native_review.inspect({'acceptedOnly': True, 'coverageOnly': True}, worker)
                detailed = native_review.inspect({'groupId': group['groupId']}, worker)
            self.assertNotIn('groups', coverage)
            self.assertNotIn('units', coverage)
            self.assertEqual(metadata, before)
            self.assertEqual(sum(len(item['literalElements']) for item in detailed['groups'][0]['producerElements']), 3)
            # No proven display input is a research task, not an unconditionally blocked verdict.
            for physical in report['groups']:
                physical['displaySites'] = []
            semantics._CODE_REPORTS.clear()
            with mock.patch.object(semantics, 'run', return_value=report):
                unknown = semantics.code_groups(source, metadata, worker)[0]
            self.assertEqual(unknown['status'], 'pending')
            unknown_decision = {'groupId': unknown['groupId'], 'evidenceHash': unknown['evidenceHash'],
                                'disposition': 'non-display', 'fields': [],
                                'reason': 'Inspected producer consumers establish resource identity use, not display.'}
            self.assertEqual(native_review.decision_for(unknown, unknown_decision, worker)['disposition'], 'non-display')
            for is_display in (False, True):
                for physical in report['groups']:
                    physical['displaySites'] = [{**site, 'display': is_display, 'displayOnly': False,
                                                'unresolvedOrBusinessUse': True,
                                                'calls': ['UnityEngine.SceneManagement.SceneManager::LoadScene(System.String)']
                                                if not is_display else ['UnityEngine.UI.Text::set_text(System.String)']}]
                semantics._CODE_REPORTS.clear()
                with mock.patch.object(semantics, 'run', return_value=report):
                    consumer = semantics.code_groups(source, metadata, worker)[0]
                self.assertEqual(consumer['hasDisplayEvidence'], is_display)
                self.assertFalse(consumer['verifiedDisplayInputs'])
                self.assertEqual(consumer['fieldUses']['fields'][0]['uses'][0], report['groups'][0]['displaySites'][0])
                decision = {**unknown_decision, 'groupId': consumer['groupId'], 'evidenceHash': consumer['evidenceHash']}
                if is_display:
                    with self.assertRaises(worker.WorkerError) as rejection:
                        native_review.decision_for(consumer, decision, worker)
                    self.assertEqual(rejection.exception.code, 'NATIVE_CODE_DISPLAY_REQUIRED')
                else:
                    self.assertEqual(native_review.decision_for(consumer, decision, worker)['disposition'], 'non-display')

    def test_one_of_31_sites_keeps_30_pending_and_mixed_uses_informational(self):
        sites = ['display-site-v1:' + str(index).zfill(64) for index in range(32)]
        group = {'groupId': 'group', 'file': 'Data/level1', 'script': {'className': 'Neutral'},
                 'evidenceHash': 'hash', '_objects': {'@:' + str(index): {} for index in range(1, 17)}, 'status': 'accepted',
                 'fields': [{'path': ['Caption']}], 'fieldUses': {'available': True, 'fields': [{'path': ['Caption'], 'uses': [
                     *({'siteId': site, 'display': True, 'displayOnly': True} for site in sites[:31]),
                     {'siteId': sites[31], 'display': True, 'displayOnly': False}]}]}}
        decision = {'groupId': 'group', 'evidenceHash': 'hash', 'disposition': 'display',
                    'fields': [{'path': ['Caption'], 'displaySites': sites[:1]}]}
        unrelated = {'file': 'Data/level2', 'object': '@:2', 'kind': 'unity_typetree_adapter_required'}
        metadata = {'nativeReviewDecisions': {'group': decision}, 'issues': [unrelated,
                    {'file': group['file'], 'object': '@:1', 'kind': 'custom_monobehaviour_display_schema_required'}]}
        before = copy.deepcopy(metadata)
        issues = native_review.coverage_issues(metadata, [group])
        pending = next(item for item in issues if item.get('category') == 'native-schema')
        self.assertEqual(pending['remainingSites'], sites[1:31])
        self.assertEqual(pending['count'], 16)
        self.assertEqual(group['status'], 'pending')
        self.assertEqual(group['remainingDisplaySites'], 30)
        self.assertEqual(next(item for item in issues if item.get('category') == 'info')['remainingSites'], sites[31:])
        self.assertIn(unrelated, issues)
        self.assertEqual(metadata, before)
        decision['fields'][0]['displaySites'] = sites[:31]
        metadata['issues'] = issues
        group['status'] = 'accepted'
        complete = native_review.coverage_issues(metadata, [group])
        self.assertFalse(any(item.get('category') == 'native-schema' for item in complete))
        self.assertEqual(group['remainingDisplaySites'], 0)
        self.assertEqual(group['status'], 'accepted')
        self.assertIn(unrelated, complete)
        self.assertEqual(len([item for item in complete if item.get('category') == 'info']), 1)
        group['fieldUses'] = {'available': False, 'fields': []}
        unresolved = native_review.coverage_issues(metadata, [group])
        self.assertEqual(group['status'], 'pending')
        self.assertTrue(any(item.get('category') == 'native-schema' and 'unavailable' in item['detail'] for item in unresolved))

    def test_coverage_projection_without_accepted_display_groups_does_not_load_carriers(self):
        issues = [{'file': 'Data/level1', 'kind': 'unity_typetree_adapter_required'}]
        metadata = {'engine': unity.ENGINE, 'issues': issues, 'nativeReviewDecisions': {}}
        with mock.patch.object(native_review, 'context', return_value=(Path('neutral'), {}, {}, metadata, Path('source'))), \
                mock.patch.object(unity, 'review_groups') as load:
            result = native_review.inspect({'acceptedOnly': True, 'coverageOnly': True}, worker)
        load.assert_not_called()
        self.assertEqual(result['refreshedGroups'], 0)
        self.assertEqual(result['reviewItems'], issues)


if __name__ == '__main__':
    unittest.main()
