import unittest
from types import SimpleNamespace
from unittest import mock

import worker
import unity_native


class UnityPrefilterTests(unittest.TestCase):
    def test_root_engine_identity_does_not_create_review_work(self):
        tree = {'m_Name': 'Technical object identity', 'm_Script': {'m_FileID': 0, 'm_PathID': 5}}
        self.assertIsNotNone(unity_native.prefilter_no_text(('Neutral', 'Component'), tree))

    def test_nested_business_names_remain_available_to_native_review(self):
        tree = {'m_Name': 'Technical object identity', 'rows': [{'m_Name': 'Welcome traveler'}]}
        self.assertIsNone(unity_native.prefilter_no_text(('Neutral', 'Component'), tree))
        self.assertEqual(list(unity_native.prefilter_string_leaves(tree)), [(('rows', 0, 'm_Name'), 'Welcome traveler')])

    def test_one_empty_instance_does_not_hide_another_instance(self):
        self.assertIsNotNone(unity_native.prefilter_no_text(('Neutral', 'Component'), {'caption': ''}))
        self.assertIsNone(unity_native.prefilter_no_text(('Neutral', 'Component'), {'caption': 'A complete sentence'}))

    def test_custom_component_recovers_business_fields_before_no_text_prefilter(self):
        base = {'m_Name': 'Technical identity', 'm_Script': {'m_FileID': 0, 'm_PathID': 5}}
        complete = {**base, 'displayCaption': 'A complete neutral menu label'}
        obj = SimpleNamespace(type=SimpleNamespace(name='MonoBehaviour'), parse_as_dict=mock.Mock(return_value=base))
        script = {'m_Namespace': 'Neutral', 'm_ClassName': 'NewComponent'}
        with mock.patch.object(unity_native, 'typed_tree', return_value=(complete, None)) as recover, \
                mock.patch.object(unity_native, 'resolve_script', return_value=script):
            tree, binding, entries, issue = unity_native.native_entries(obj, 'Game_Data/level1', {}, 'source')
        recover.assert_called_once_with(obj, 'Game_Data/level1', {}, 'source', schema_context=None)
        self.assertEqual(tree, complete)
        self.assertEqual(issue, 'custom_monobehaviour_display_schema_required')
        self.assertNotIn('prefiltered', binding)
        self.assertEqual(entries, [])
        obj.parse_as_dict.assert_not_called()

    def test_complete_custom_schema_without_strings_can_still_prefilter(self):
        complete = {'m_Name': 'Technical identity', 'm_Counter': 7, 'enabled': True}
        obj = SimpleNamespace(type=SimpleNamespace(name='MonoBehaviour'), parse_as_dict=mock.Mock(return_value=complete))
        with mock.patch.object(unity_native, 'typed_tree', return_value=(complete, None)) as recover, \
                mock.patch.object(unity_native, 'resolve_script', return_value={'m_Namespace': 'Neutral', 'm_ClassName': 'StateComponent'}):
            _, binding, entries, issue = unity_native.native_entries(obj, 'Game_Data/level1', {}, 'source')
        recover.assert_called_once()
        self.assertEqual(issue, unity_native.PREFILTERED_NO_TEXT)
        self.assertTrue(binding['prefiltered'])
        self.assertEqual(entries, [])

    def test_custom_schema_recovery_failure_cannot_become_no_text(self):
        obj = SimpleNamespace(type=SimpleNamespace(name='MonoBehaviour'), parse_as_dict=mock.Mock(return_value={}))
        with mock.patch.object(unity_native, 'typed_tree', side_effect=ValueError('Neutral schema recovery failed')), \
                mock.patch.object(unity_native, 'resolve_script', return_value={'m_Namespace': 'Neutral', 'm_ClassName': 'NewComponent'}):
            with self.assertRaisesRegex(ValueError, 'Neutral schema recovery failed'):
                unity_native.native_entries(obj, 'Game_Data/level1', {}, 'source')


if __name__ == '__main__':
    unittest.main()
