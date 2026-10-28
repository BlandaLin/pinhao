"""Executable neutral proof that display localization preserves identities and save keys."""
import hashlib
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import unity_semantics as semantic

COMPILER = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
SOURCE = Path(__file__).resolve().parents[2] / 'packages/runtime/managed/DisplayFixture.cs'


@unittest.skipUnless(COMPILER.is_file(), 'Windows .NET Framework compiler is required for executable Mono fixtures')
class UnitySemanticTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pinhao-display-semantics-')
        self.root = Path(self.temp.name)
        self.assembly = self.root / 'Fixture.exe'
        subprocess.run([str(COMPILER), '/nologo', '/optimize+', '/target:exe', '/out:' + str(self.assembly), str(SOURCE)], check=True, capture_output=True)

    def tearDown(self):
        self.temp.cleanup()

    def inspect(self, name='Neutral.Choice'):
        return semantic.run(['inspect', self.assembly, name])

    def test_direct_and_indirect_display_consumers_keep_logic_and_saved_identity(self):
        original = self.assembly.read_bytes()
        report = self.inspect()
        field = next(field for field in report['fields'] if field['path'] == ['Identity'])
        sites = [use for use in field['uses'] if use['displayOnly']]
        self.assertEqual(len(sites), 2)
        self.assertTrue(any('Message::Show' in ' '.join(use['calls']) for use in sites))
        self.assertTrue(any('Keys::Save' in ' '.join(use['calls']) and not use['displayOnly'] for use in field['uses']))
        plan = self.root / 'plan.json'
        plan.write_text(json.dumps({'assemblySha256': report['assemblySha256'], 'bindings': [
            {'siteId': use['siteId'], 'source': 'Neutral item', 'translation': '中性物品'} for use in sites]}, ensure_ascii=False), encoding='utf-8')
        output = self.root / 'Localized.exe'
        result = semantic.run(['patch', self.assembly, plan, output])
        self.assertTrue(result['originalBusinessIlUnchanged'])
        self.assertEqual(result['bindings'], 2)
        actual = subprocess.run([str(output)], check=True, capture_output=True).stdout.decode('utf-8').splitlines()
        self.assertEqual(actual, ['中性物品', '中性物品 accepted', 'Neutral item', 'Neutral item|Neutral item', 'True'])
        self.assertEqual(self.assembly.read_bytes(), original)

    def test_display_readback_and_business_consumers_cannot_be_selected(self):
        report = self.inspect('Neutral.ReadbackChoice')
        field = next(field for field in report['fields'] if field['path'] == ['Identity'])
        self.assertTrue(any(use['display'] for use in field['uses']))
        self.assertFalse(any(use['displayOnly'] for use in field['uses']))
        plan = self.root / 'unsafe.json'
        plan.write_text(json.dumps({'assemblySha256': report['assemblySha256'], 'bindings': [
            {'siteId': field['uses'][0]['siteId'], 'source': 'Neutral item', 'translation': 'Changed identity'}]}), encoding='utf-8')
        output = self.root / 'Unsafe.exe'
        with self.assertRaisesRegex(ValueError, 'isolated display consumer'):
            semantic.run(['patch', self.assembly, plan, output])
        self.assertFalse(output.exists())

    def test_tmp_getter_callsite_localizes_only_display_and_preserves_property_identity(self):
        original = self.assembly.read_bytes()
        report = self.inspect('Neutral.GetterChoice')
        field = next(field for field in report['fields'] if field['path'] == ['Identity'])
        sites = [use for use in field['uses'] if use['displayOnly']]
        self.assertEqual(len(sites), 1)
        self.assertEqual(sites[0]['siteKind'], 'getter-result')
        self.assertTrue(any('Keys::Save' in ' '.join(use['calls']) and not use['displayOnly'] for use in field['uses']))
        plan = self.root / 'getter-plan.json'
        plan.write_text(json.dumps({'assemblySha256': report['assemblySha256'], 'bindings': [
            {'siteId': sites[0]['siteId'], 'source': 'Neutral getter item', 'translation': '中性属性物品'}]}, ensure_ascii=False), encoding='utf-8')
        output = self.root / 'GetterLocalized.exe'
        result = semantic.run(['patch', self.assembly, plan, output])
        self.assertTrue(result['originalBusinessIlUnchanged'])
        actual = subprocess.run([str(output), 'getter'], check=True, capture_output=True).stdout.decode('utf-8').splitlines()
        self.assertEqual(actual, ['中性属性物品', 'Neutral getter item', 'Neutral getter item'])
        self.assertEqual(self.assembly.read_bytes(), original)
        readback = self.inspect('Neutral.GetterReadback')
        self.assertFalse(any(use['displayOnly'] for row in readback['fields'] for use in row['uses']))

    def test_display_insertion_widens_short_branches_without_changing_control_flow(self):
        original = self.assembly.read_bytes()
        report = self.inspect('Neutral.ShortBranchChoice')
        field = next(field for field in report['fields'] if field['path'] == ['Identity'])
        sites = [use for use in field['uses'] if use['displayOnly']]
        self.assertEqual(len(sites), 2)
        plan = self.root / 'branch-plan.json'
        plan.write_text(json.dumps({'assemblySha256': report['assemblySha256'], 'bindings': [
            {'siteId': use['siteId'], 'source': 'Neutral item', 'translation': '中性物品'} for use in sites]}, ensure_ascii=False), encoding='utf-8')
        output = self.root / 'BranchLocalized.exe'
        result = semantic.run(['patch', self.assembly, plan, output])
        self.assertTrue(result['originalBusinessIlUnchanged'])
        self.assertEqual(result['sites'], 2)
        actual = subprocess.run([str(output), 'branch'], check=True, capture_output=True).stdout.decode('utf-8').splitlines()
        self.assertEqual(actual, ['中性物品', '6', 'Neutral item'])
        self.assertEqual(self.assembly.read_bytes(), original)

    def test_getter_forwarded_field_with_business_length_return_stays_pending(self):
        original = self.assembly.read_bytes()
        report = self.inspect('Neutral.GetterLengthBusiness')
        field = next(field for field in report['fields'] if field['path'] == ['Identity'])
        site = next(use for use in field['uses'] if use['siteKind'] == 'getter-result'
                    and 'GetterLengthBusiness::Show' in use['method'])
        self.assertTrue(site['display'], 'the forwarded string genuinely reaches the UI')
        self.assertFalse(site['displayOnly'], 'a different consumer returns its length as a business value')
        self.assertTrue(site['unresolvedOrBusinessUse'])
        plan = self.root / 'business-length-plan.json'
        plan.write_text(json.dumps({'assemblySha256': report['assemblySha256'], 'bindings': [
            {'siteId': site['siteId'], 'source': 'Neutral reward identity', 'translation': 'Changed reward'}]}), encoding='utf-8')
        output = self.root / 'BusinessLengthLocalized.exe'
        with self.assertRaisesRegex(ValueError, 'isolated display consumer'):
            semantic.run(['patch', self.assembly, plan, output])
        self.assertFalse(output.exists())
        self.assertEqual(self.assembly.read_bytes(), original)

    def test_getter_forwarded_length_business_branch_is_not_proven_by_an_unrelated_substring(self):
        report = self.inspect('Neutral.GetterLengthBranchBusiness')
        field = next(field for field in report['fields'] if field['path'] == ['Identity'])
        site = next(use for use in field['uses'] if use['siteKind'] == 'getter-result'
                    and 'GetterLengthBranchBusiness::Show' in use['method'])
        self.assertTrue(site['display'])
        self.assertFalse(site['displayOnly'], 'a same-field Substring elsewhere does not make a reward branch presentation-only')
        self.assertTrue(site['unresolvedOrBusinessUse'])

    def test_source_hash_and_duplicate_site_identity_conflicts_fail_before_writing(self):
        report = self.inspect()
        use = next(use for field in report['fields'] for use in field['uses'] if use['displayOnly'])
        item = {'siteId': use['siteId'], 'source': 'Neutral item', 'translation': 'Neutral translation'}
        plan = self.root / 'conflict.json'
        for digest, bindings, message in [('0' * 64, [item], 'source assembly hash'),
                                          (report['assemblySha256'], [item, {**item, 'translation': 'Conflicting translation'}], 'Conflicting')]:
            plan.write_text(json.dumps({'assemblySha256': digest, 'bindings': bindings}), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, message):
                semantic.run(['patch', self.assembly, plan, self.root / 'Rejected.exe'])
            self.assertFalse((self.root / 'Rejected.exe').exists())

    def test_cross_type_ui_readback_and_overridable_dispatch_stay_pending(self):
        for name in ('Neutral.CrossChoice', 'Neutral.VirtualChoice', 'Neutral.AliasWriter'):
            with self.subTest(name=name):
                report = self.inspect(name)
                field = next(field for field in report['fields'] if field['path'] in (['Identity'], ['StorageKey']))
                self.assertTrue(field['uses'])
                self.assertFalse(any(use['displayOnly'] for use in field['uses']))

    def test_code_literals_are_complete_elements_and_dynamic_templates_stay_pending(self):
        report = semantic.run(['inspect-code', self.assembly])
        self.assertEqual(report['schema'], 'pinhao-unity-code-text-v1')
        group = next(group for group in report['groups'] if 'Neutral.DisplayTypewriter::Prepare' in group['method'])
        self.assertEqual([row['index'] for row in group['elements']], [0, 1, 2])
        self.assertEqual([row['source'] for row in group['elements']], ['Neutral first sentence.', 'Neutral second sentence.', None])
        self.assertEqual([row['supported'] for row in group['elements']], [True, True, False])
        self.assertEqual(group['elements'][2]['expressionKind'], 'unsupported-template')
        self.assertEqual(group['unsupportedTemplates'], 1)
        safe = [site for site in group['displaySites'] if site['displayOnly']]
        self.assertEqual({site['siteKind'] for site in safe}, {'presentation-store', 'array-element'})
        site = next(site for site in group['displaySites'] if site['displayOnly'])
        self.assertEqual(site['siteKind'], 'presentation-store')
        self.assertTrue(site['displayOnly'])
        self.assertTrue(any(use['role'] == 'length-metadata' for use in site['readUses']))
        self.assertTrue(any('UnityEngine.Debug::Log' in call for call in site['calls']))
        self.assertIn('not a whole-program numerical taint proof', report['scope'])

    def test_presentation_store_translates_before_typewriter_length_and_substring(self):
        original = self.assembly.read_bytes()
        report = semantic.run(['inspect-code', self.assembly])
        group = next(group for group in report['groups'] if 'Neutral.DisplayTypewriter::Prepare' in group['method'])
        site = next(site for site in group['displaySites'] if site['displayOnly'])
        plan = self.root / 'typewriter-plan.json'
        plan.write_text(json.dumps({'assemblySha256': report['assemblySha256'], 'bindings': [
            {'siteId': site['siteId'], 'source': group['elements'][0]['source'], 'translation': '中性句子'}]}, ensure_ascii=False), encoding='utf-8')
        output = self.root / 'TypewriterLocalized.exe'
        result = semantic.run(['patch', self.assembly, plan, output])
        self.assertTrue(result['originalBusinessIlUnchanged'])
        actual = subprocess.run([str(output), 'display-typewriter'], check=True, capture_output=True).stdout.decode('utf-8').splitlines()
        self.assertEqual(actual, ['中性', 'Neutral first sentence.', '中性句子', 'Neu', 'Neutral second sentence.'])
        self.assertEqual(self.assembly.read_bytes(), original)

    def test_presentation_store_business_reads_and_unknown_logger_are_rejected(self):
        report = semantic.run(['inspect-code', self.assembly])
        for typename in ('Typewriter', 'BusinessTypewriter', 'UnknownDiagnosticTypewriter'):
            with self.subTest(typename=typename):
                group = next(group for group in report['groups'] if 'Neutral.' + typename + '::Prepare' in group['method'])
                self.assertTrue(group['displaySites'])
                mutating = [site for site in group['displaySites'] if site['siteKind'] != 'presentation-slice']
                self.assertFalse(any(site['displayOnly'] for site in mutating))
                self.assertTrue(any(site['display'] and site['unresolvedOrBusinessUse'] for site in mutating))
                plan = self.root / 'unsafe-typewriter.json'
                plan.write_text(json.dumps({'assemblySha256': report['assemblySha256'], 'bindings': [
                    {'siteId': mutating[0]['siteId'], 'source': group['elements'][0]['source'], 'translation': 'Not allowed'}]}), encoding='utf-8')
                with self.assertRaisesRegex(ValueError, 'isolated display consumer'):
                    semantic.run(['patch', self.assembly, plan, self.root / 'UnsafeTypewriter.exe'])
                self.assertFalse((self.root / 'UnsafeTypewriter.exe').exists())

    def test_prefix_ui_slice_preserves_original_timing_reward_identity_and_surrogates(self):
        original = self.assembly.read_bytes()
        report = semantic.run(['inspect-code', self.assembly])
        group = next(group for group in report['groups'] if 'Neutral.PrefixTypewriter::Prepare' in group['method'])
        safe = [site for site in group['displaySites'] if site['displayOnly']]
        self.assertEqual(len(safe), 1)
        self.assertEqual(safe[0]['siteKind'], 'presentation-slice')
        self.assertTrue(any(site['siteKind'] == 'presentation-store' and site['unresolvedOrBusinessUse'] for site in group['displaySites']))
        plan = self.root / 'prefix-plan.json'
        plan.write_text(json.dumps({'assemblySha256': report['assemblySha256'], 'bindings': [
            {'siteId': safe[0]['siteId'], 'source': 'abcdef', 'translation': '甲😀乙'}]}, ensure_ascii=False), encoding='utf-8')
        output = self.root / 'PrefixLocalized.exe'
        result = semantic.run(['patch', self.assembly, plan, output])
        self.assertTrue(result['originalBusinessIlUnchanged'])
        actual = subprocess.run([str(output), 'prefix'], check=True, capture_output=True).stdout.decode('utf-8').splitlines()
        self.assertEqual(actual[:8], ['甲😀乙', 'abcdef', 'abcdef', '0.6', '6', 'abcdef', 'abcdef', 'bc'])
        prefixes = [base64.b64decode(value).decode('utf-16-le', errors='strict') for value in actual[8:]]
        self.assertEqual(prefixes, ['', '', '甲', '甲', '甲', '甲😀', '甲😀乙'])
        before_errors = subprocess.run([str(self.assembly), 'prefix-errors'], check=True, capture_output=True).stdout
        after_errors = subprocess.run([str(output), 'prefix-errors'], check=True, capture_output=True).stdout
        self.assertEqual(after_errors, before_errors)
        self.assertEqual(self.assembly.read_bytes(), original)

    def test_prefix_nonzero_offset_and_ui_readback_do_not_gain_slice_permission(self):
        report = semantic.run(['inspect-code', self.assembly])
        group = next(group for group in report['groups'] if 'Neutral.PrefixTypewriter::Prepare' in group['method'])
        self.assertFalse(any(site['siteKind'] == 'presentation-slice' and 'RenderMiddle' in site['method'] for site in group['displaySites']))
        readback = next(group for group in report['groups'] if 'Neutral.PrefixReadback::Prepare' in group['method'])
        self.assertFalse(any(site['displayOnly'] for site in readback['displaySites']))
        cross = next(group for group in report['groups'] if 'Neutral.PrefixCrossReadback::Prepare' in group['method'])
        self.assertFalse(any(site['displayOnly'] for site in cross['displaySites']))

    def test_direct_array_display_maps_only_the_safe_consumer_and_keeps_identity_uses(self):
        report = semantic.run(['inspect-code', self.assembly])
        group = next(group for group in report['groups'] if 'Neutral.DirectArray::.ctor' in group['method'])
        sites = group['displaySites']
        safe = [site for site in sites if site['displayOnly']]
        unsafe = [site for site in sites if not site['displayOnly']]
        self.assertEqual(len(safe), 1)
        self.assertEqual(safe[0]['siteKind'], 'array-element')
        self.assertTrue(safe[0]['display'])
        business = [site for site in unsafe if 'Keys::Save' in ' '.join(site['calls'])]
        self.assertTrue(business)
        self.assertTrue(all(site['display'] is False for site in business))
        plan = self.root / 'array-plan.json'
        plan.write_text(json.dumps({'assemblySha256': report['assemblySha256'], 'bindings': [
            {'siteId': safe[0]['siteId'], 'source': group['elements'][0]['source'], 'translation': '中性数组对白'}]}, ensure_ascii=False), encoding='utf-8')
        output = self.root / 'ArrayLocalized.exe'
        result = semantic.run(['patch', self.assembly, plan, output])
        self.assertTrue(result['originalBusinessIlUnchanged'])
        actual = subprocess.run([str(output), 'array'], check=True, capture_output=True).stdout.decode('utf-8').splitlines()
        self.assertEqual(actual, ['中性数组对白', 'Neutral array sentence.', 'Neutral array sentence.'])


if __name__ == '__main__':
    unittest.main()
