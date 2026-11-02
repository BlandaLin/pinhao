"""TextAsset naming is discovery, not authority to translate arbitrary values."""
import json
from pathlib import Path
import tempfile
import unittest

import worker
import native_review
import unity_native as unity


class TextAssetPolicyTests(unittest.TestCase):
    def test_filename_does_not_authorize_logic_strings_or_arrays(self):
        text = json.dumps({'mode': 'BATTLE_MODE_A', 'saveSlot': 'slot_01', 'states': ['state_pending']})
        for name in ('Localization.json', 'settings.json'):
            binding, entries, issue = unity.decoded_text_entries(name, text)
            self.assertEqual(entries, [])
            self.assertEqual(issue, 'json_display_schema_required')

    def test_explicit_display_fields_survive_and_nested_identity_is_not_inherited(self):
        text = json.dumps({'id': 'scene_1', 'text': 'A complete sentence.',
                           'data': {'caption': 'A quiet morning.', 'mode': 'DO_NOT_CHANGE'},
                           'states': ['state_pending'], 'name': 'Guide'})
        _, entries, issue = unity.decoded_text_entries('Localization.json', text)
        self.assertEqual({tuple(x['path']) for x in entries}, {('text',), ('data', 'caption'), ('name',)})
        self.assertIsNone(issue)

    def test_display_array_remains_complete_and_names_alone_do_not_qualify(self):
        _, entries, _ = unity.decoded_text_entries('story.json', '{"text":["One morning.","One evening."],"name":"SCENE_A"}')
        self.assertEqual([x['source'] for x in entries], ['One morning.', 'One evening.', 'SCENE_A'])
        self.assertEqual(unity.decoded_text_entries('Localization.json', '{"name":"SCENE_A"}')[1], [])

    def test_multi_locale_csv_requires_source_selection_and_never_translates_key(self):
        text = 'Key,ja,en\r\nwelcome,Japanese source,English reference\r\n'
        _, entries, issue = unity.decoded_text_entries('Localization.csv', text)
        self.assertEqual(entries, [])
        self.assertEqual(issue, 'csv_language_selection_required')
        binding, entries, issue = unity.decoded_text_entries('Localization.csv', text, source_language='ja')
        self.assertIsNone(issue)
        self.assertEqual([x['path'] for x in entries], [[1, 1]])
        self.assertEqual(entries[0]['language'], 'ja')
        rewritten = unity.render_decoded_text(text, binding, [(entries[0], 'Changed source, longer')])
        self.assertEqual(rewritten, 'Key,ja,en\r\nwelcome,"Changed source, longer",English reference\r\n')

    def test_one_locale_table_has_explicit_identity_and_duplicate_keys_are_not_collapsed(self):
        binding, entries, issue = unity.decoded_text_entries('Localization.csv', 'Key,en\nx,First sentence\nx,Second sentence\n')
        self.assertIsNone(issue)
        self.assertEqual([x['path'] for x in entries], [[1, 1], [2, 1]])
        self.assertEqual([x['key'] for x in entries], ['x', 'x'])
        self.assertEqual(binding['duplicateKeys'], ['x'])

    def test_language_selection_is_exact_and_missing_is_not_a_fallback(self):
        text = 'key,ja,en\nx,Japanese source,English reference\n'
        for language in ('fr', 'key'):
            _, entries, issue = unity.decoded_text_entries('Localization.csv', text, source_language=language)
            self.assertEqual(entries, [])
            self.assertEqual(issue, 'csv_source_language_missing')

    def test_existing_name_with_display_description_is_retained_without_filename_authority(self):
        _, entries, issue = unity.decoded_text_entries('items.csv', 'id,name,description\nx,Quiet stone,A warm stone.\n')
        self.assertIsNone(issue)
        self.assertEqual([entry['path'] for entry in entries], [[1, 1], [1, 2]])
        self.assertEqual(unity.decoded_text_entries('Localization.csv', 'id,name\nx,STATE_PENDING\n')[1], [])

    def test_json_locale_row_requires_selection_preserving_identity_and_reference(self):
        text = '{"rows":[{"key":"greeting","ja":"Japanese source","en":"English reference"}]}'
        _, entries, issue = unity.decoded_text_entries('Localization.json', text)
        self.assertEqual(entries, [])
        self.assertEqual(issue, 'json_language_selection_required')
        binding, entries, issue = unity.decoded_text_entries('Localization.json', text, source_language='en')
        self.assertEqual([x['path'] for x in entries], [['rows', 0, 'en']])
        self.assertEqual(entries[0]['language'], 'en')
        actual = json.loads(unity.render_decoded_text(text, binding, [(entries[0], 'Changed reference')]))
        self.assertEqual(actual['rows'][0]['key'], 'greeting')
        self.assertEqual(actual['rows'][0]['ja'], 'Japanese source')

    def test_unrecognized_language_and_translation_words_do_not_authorize_arbitrary_data(self):
        _, entries, _ = unity.decoded_text_entries('Localization.json', '{"mode":{"translation":"state_pending"},"value":"slot_01","en":"state_active"}')
        self.assertEqual(entries, [])


@unittest.skipUnless(unity.available(), 'UnityPy is required')
class TextAssetNativePolicyTests(unittest.TestCase):
    def test_language_choice_uses_native_review_and_keeps_reference_column(self):
        from test_unity_native import unity_game
        for name, text, language, source_value in (
                ('Localization.csv', 'key,ja,en\r\nx,Japanese source,English reference\r\n', 'ja', 'Japanese source'),
                ('Localization.json', '{"rows":[{"key":"x","ja":"Japanese source","en":"English reference"}]}', 'en', 'English reference')):
            with self.subTest(name=name), tempfile.TemporaryDirectory(prefix='unity-language-review-') as temporary:
                root = Path(temporary)
                game = unity_game(root)
                path = game / 'Fixture_Data/resources.assets'
                _, before = unity.load_carrier(path)
                obj = unity.objects(before)['@:1']
                tree = obj.parse_as_dict()
                tree.update(m_Name=name, m_Script=text)
                obj.save_typetree(tree)
                path.write_bytes(before.save(packer='original'))
                original = path.read_bytes()
                work = root / 'work'
                extracted = worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
                self.assertNotIn(source_value, [row['source'] for row in extracted['units']])
                inspected = native_review.inspect({'workspaceDir': str(work)}, worker)
                group = next(group for group in inspected['groups'] if group.get('candidateType') == 'textasset-language')
                self.assertEqual({tuple(field['path']) for field in group['fields']}, {('language', 'ja'), ('language', 'en')})
                decision = {'groupId': group['groupId'], 'evidenceHash': group['evidenceHash'], 'disposition': 'display',
                            'fields': [{'path': ['language', language], 'kind': 'localized_string'}],
                            'reason': 'Select the actual source language; preserve key and reference language.'}
                stale = dict(decision, evidenceHash='0' * 64)
                with self.assertRaisesRegex(worker.WorkerError, 'evidence changed'):
                    native_review.adapt({'workspaceDir': str(work), 'outputDir': str(root / 'stale'), 'decisions': [stale]}, worker)
                adapted = root / 'adapted'
                result = native_review.adapt({'workspaceDir': str(work), 'outputDir': str(adapted), 'decisions': [decision]}, worker)
                self.assertEqual(result['addedUnits'], 1)
                self.assertTrue(worker.roundtrip({'workspaceDir': str(adapted)})['byteIdentical'])
                row = next(row for row in result['units'] if row['source'] == source_value)
                output = root / 'built'
                worker.build({'workspaceDir': str(adapted), 'outputDir': str(output),
                              'translations': [{'id': row['id'], 'translation': 'Changed complete sentence'}]})
                _, actual = unity.load_carrier(output / 'Fixture_Data/resources.assets')
                self.assertEqual(unity.objects(actual)['@:1'].parse_as_dict()['m_Script'], text.replace(source_value, 'Changed complete sentence') if name.endswith('.csv') else
                                 json.dumps({'rows': [{'key': 'x', 'ja': 'Japanese source', 'en': 'Changed complete sentence'}]}, ensure_ascii=False, indent=2))
                repeated = native_review.adapt({'workspaceDir': str(adapted), 'outputDir': str(root / 'repeated'), 'decisions': [decision]}, worker)
                self.assertEqual(repeated['addedUnits'], 0)
                conflicting = dict(decision, fields=[{'path': ['language', 'en' if language == 'ja' else 'ja'], 'kind': 'localized_string'}])
                with self.assertRaisesRegex(ValueError, 'conflicts'):
                    native_review.adapt({'workspaceDir': str(adapted), 'outputDir': str(root / 'conflicting'), 'decisions': [conflicting]}, worker)
                self.assertEqual(path.read_bytes(), original)

    def test_normal_worker_extract_and_native_csv_write_preserve_other_objects(self):
        from test_unity_native import unity_game
        with tempfile.TemporaryDirectory(prefix='unity-language-policy-') as temporary:
            root = Path(temporary)
            game = unity_game(root, bundle=True)
            carrier = game / 'Fixture_Data/text.bundle'
            _, before = unity.load_carrier(carrier)
            indexed = unity.objects(before)
            first_key = next(key for key, obj in indexed.items() if obj.path_id == 1)
            second_key = next(key for key, obj in indexed.items() if obj.path_id == 2)
            obj = indexed[first_key]
            tree = obj.parse_as_dict()
            tree.update(m_Name='Localization.json', m_Script='{"mode":"BATTLE_MODE_A","states":["state_pending"]}')
            obj.save_typetree(tree)
            obj = indexed[second_key]
            tree = obj.parse_as_dict()
            original_text = 'Key,ja,en\r\nwelcome,"Source, sentence",English reference\r\nwelcome,Second source,Second reference\r\n'
            tree.update(m_Name='Localization.csv', m_Script=original_text)
            obj.save_typetree(tree)
            carrier.write_bytes(before.save(packer='original'))
            source_bytes = carrier.read_bytes()
            work = root / 'work'
            extracted = worker.extract({'gameDir': str(game), 'workspaceDir': str(work), 'sourceLanguage': 'ja'})
            self.assertFalse(any(row['source'] in ('BATTLE_MODE_A', 'state_pending', 'English reference') for row in extracted['units']))
            rows = [row for row in extracted['units'] if row['context'].get('object') == second_key]
            self.assertEqual([row['source'] for row in rows], ['Source, sentence', 'Second source'])
            self.assertTrue(all(row['context']['language'] == 'ja' and row['context']['key'] == 'welcome' for row in rows))
            self.assertTrue(worker.roundtrip({'workspaceDir': str(work)})['byteIdentical'])
            output = root / 'built'
            worker.build({'workspaceDir': str(work), 'outputDir': str(output), 'translations': [
                {'id': rows[0]['id'], 'translation': 'Changed, complete sentence'}]})
            _, built = unity.load_carrier(output / 'Fixture_Data/text.bundle')
            self.assertEqual(unity.objects(built)[second_key].parse_as_dict()['m_Script'],
                             original_text.replace('"Source, sentence"', '"Changed, complete sentence"'))
            _, source = unity.load_carrier(carrier)
            self.assertEqual(carrier.read_bytes(), source_bytes)
            unity.verify_carrier(source, built, {second_key: unity.objects(built)[second_key].parse_as_dict()})


if __name__ == '__main__':
    unittest.main()
