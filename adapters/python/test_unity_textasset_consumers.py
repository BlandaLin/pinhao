import unittest
import os
from pathlib import Path
import subprocess
import tempfile
import hashlib
import json

from unity_textasset_consumers import inspect_report, match_resource, inspect, discover

COMPILER = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
TOOL = Path(os.environ.get('PINHAO_MANAGED_TOOLS', '')) / 'Pinhao.UnityTextAsset.exe'


def fixture_assembly(root):
    output = Path(root) / 'ReaderFixture.exe'
    source = Path(__file__).parent / 'fixtures/unity_textasset_reader.cs'
    subprocess.run([str(COMPILER), '/nologo', '/optimize+', '/target:exe', '/out:' + str(output), str(source)],
                   check=True, capture_output=True)
    return output


def instructions(skip=2, delimiter=','):
    shape = [
        ('ldloc.0', None), ('ldstr', delimiter), ('ldc.i4.0', None),
        ('call', 'System.Char System.String::get_Chars(System.Int32)'), ('ldc.i4.0', None),
        ('callvirt', 'System.String[] System.String::Split(System.Char,System.StringSplitOptions)'), ('stloc.1', None),
        ('ldloc.1', None), ('ldc.i4', skip), ('ldelem.ref', None), ('stloc.2', None),
        ('ldloc.1', None), ('ldlen', None), ('conv.i4', None), ('ldc.i4', skip + 2), ('blt', 42),
        ('ldloc.3', None), ('ldloc.2', None), ('callvirt', 'System.Void Buffer::Set(System.String)'),
        ('ldc.i4', skip + 1), ('stloc.s', 4), ('br', 34),
        ('ldloc.3', None), ('ldstr', delimiter), ('callvirt', 'Buffer Buffer::Append(System.String)'),
        ('ldloc.1', None), ('ldloc.s', 4), ('ldelem.ref', None), ('callvirt', 'Buffer Buffer::Append(System.String)'),
        ('pop', None), ('ldloc.s', 4), ('ldc.i4.1', None), ('add', None), ('stloc.s', 4),
        ('ldloc.s', 4), ('ldloc.1', None), ('ldlen', None), ('conv.i4', None), ('blt', 22),
        ('ldloc.3', None), ('callvirt', 'System.String System.Object::ToString()'), ('stloc.2', None),
        ('ldloc.2', None), ('ret', None)]
    return [{'offset': index, 'op': op, 'operand': value} for index, (op, value) in enumerate(shape)]


class ReaderProofTests(unittest.TestCase):
    def inspect(self, code, builders=None):
        methods = []
        for name, shape in {
            '.ctor': [('ldarg.0', None), ('call', 'System.Void System.Object::.ctor()'), ('ret', None)],
            'Set': [('ldarg.0', None), ('ldarg.1', None), ('stfld', 'System.String Buffer::value'), ('ret', None)],
            'Append': [('ldarg.0', None), ('dup', None), ('ldfld', 'System.String Buffer::value'), ('ldarg.1', None),
                       ('call', 'System.String System.String::Concat(System.String,System.String)'),
                       ('stfld', 'System.String Buffer::value'), ('ldarg.0', None), ('ret', None)],
            'ToString': [('ldarg.0', None), ('ldfld', 'System.String Buffer::value'), ('ret', None)]}.items():
            methods.append({'type': 'Buffer', 'name': name, 'instructions': [
                {'offset': n, 'op': op, 'operand': value} for n, (op, value) in enumerate(shape)]})
        return inspect_report({'assemblySha256': 'a' * 64, 'builderMethods': methods if builders is None else builders, 'methods': [
            {'method': 'System.String Neutral::Read(System.String)', 'token': 1, 'instructions': code}]})['contracts']

    def test_full_tail_loop_is_syntax_only_not_display_authorization(self):
        for skip in (1, 2, 4, 12):
            rows = self.inspect(instructions(skip))
            self.assertEqual([row['skipFields'] for row in rows], [skip])
            self.assertFalse(rows[0]['displayQualified'])
            self.assertEqual(len(rows[0]['methodEvidenceSha256']), 64)

    def test_loop_identity_boundaries_reject_near_matches(self):
        for index, field, value in ((8, 'operand', 0), (23, 'operand', '|'), (26, 'operand', 5),
                                    (31, 'op', 'ldc.i4.2'), (38, 'operand', 23), (21, 'operand', 35),
                                    (15, 'operand', 43), (5, 'operand', 'System.String[] Custom::Split(System.Char,System.StringSplitOptions)')):
            code = instructions()
            code[index][field] = value
            self.assertEqual(self.inspect(code), [], (index, field, value))

    def test_missing_source_hash_is_not_evidence(self):
        with self.assertRaises(ValueError):
            inspect_report({'methods': []})

    def test_exact_resource_row_tail_to_ui_is_qualified(self):
        prefix = [('newobj', 'System.Void Buffer::.ctor()'), ('stloc.3', None), ('ldstr', 'Neutral/Dialog'),
                  ('call', 'UnityEngine.TextAsset UnityEngine.Resources::Load<UnityEngine.TextAsset>(System.String)'),
                  ('callvirt', 'System.String UnityEngine.TextAsset::get_text()'), ('ldstr', '\n'),
                  ('ldc.i4.0', None), ('call', 'System.Char System.String::get_Chars(System.Int32)'),
                  ('ldc.i4.0', None), ('callvirt', 'System.String[] System.String::Split(System.Char,System.StringSplitOptions)'),
                  ('stloc.s', 5), ('ldc.i4.0', None), ('stloc.s', 6), ('br', None),
                  ('ldloc.s', 5), ('ldloc.s', 6), ('ldelem.ref', None), ('stloc.0', None)]
        code = [{'offset': n, 'op': op, 'operand': value} for n, (op, value) in enumerate(prefix)]
        for item in instructions():
            item['offset'] += len(prefix)
            if item['op'] in ('br', 'blt'):
                item['operand'] += len(prefix)
            code.append(item)
        code[-2:] = [{'offset': n + len(prefix) + 42, 'op': op, 'operand': value} for n, (op, value) in enumerate([
            ('ldarg.0', None), ('ldloc.2', None), ('callvirt', 'System.Void UnityEngine.UI.Text::set_text(System.String)'),
            ('ldloc.s', 6), ('ldc.i4.1', None), ('add', None), ('stloc.s', 6), ('ldloc.s', 6), ('ldloc.s', 5),
            ('ldlen', None), ('conv.i4', None), ('blt', 14), ('ret', None)])]
        code[13]['operand'] = code[-6]['offset']
        rows = self.inspect(code)
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]['displayQualified'])
        self.assertEqual(match_resource({'contracts': rows}, 'Assets/Resources/Neutral/Dialog.txt'), rows[0])
        self.assertIsNone(match_resource({'contracts': rows}, 'Assets/Other/Neutral/Dialog.txt'))
        self.assertIsNone(match_resource({'contracts': rows}, 'Assets/Resources/Neutral/DialogBackup.txt'))
        self.assertFalse(self.inspect(code, [])[0]['displayQualified'])
        code[len(prefix) + 44]['operand'] = 'System.Void Unknown.Widget::set_text(System.String)'
        self.assertFalse(self.inspect(code)[0]['displayQualified'])


@unittest.skipUnless(COMPILER.is_file() and TOOL.is_file(), 'Prepared TextAsset managed helper required')
class ExecutableReaderProofTests(unittest.TestCase):
    def test_compiled_reader_exports_qualified_contract_and_runs_original_semantics(self):
        with tempfile.TemporaryDirectory(prefix='pinhao-reader-proof-') as root:
            assembly = fixture_assembly(root)
            before = hashlib.sha256(assembly.read_bytes()).hexdigest()
            report = inspect(assembly, TOOL)
            self.assertEqual(len(report['contracts']), 1)
            contract = report['contracts'][0]
            self.assertTrue(contract['builderQualified'])
            self.assertTrue(contract['displayQualified'])
            self.assertTrue(contract['allLines'])
            self.assertEqual(contract['skipFields'], 2)
            self.assertEqual(contract['resourceKey'], 'Neutral/Dialog')
            self.assertEqual(subprocess.run([str(assembly)], check=True, capture_output=True).stdout.decode().strip(), 'Neutral tail, with comma')
            self.assertEqual(hashlib.sha256(assembly.read_bytes()).hexdigest(), before)
            found = discover(root, {assembly.name: before}, executable=TOOL)
            self.assertEqual(found['contracts'][0]['assemblyFile'], assembly.name)
            raw = json.loads(subprocess.run([str(TOOL), str(assembly)], check=True, capture_output=True, encoding='utf-8-sig').stdout)
            method = next(item for item in raw['methods'] if item['method'] == contract['method'])
            method['hasExceptionHandlers'] = True
            self.assertFalse(inspect_report(raw)['contracts'][0]['displayQualified'])
            method['hasExceptionHandlers'] = False
            raw['methods'].append({'method': 'Other::Business', 'instructions': [
                {'offset': 0, 'op': 'ldstr', 'operand': 'Neutral/Dialog'}]})
            self.assertFalse(inspect_report(raw)['contracts'][0]['displayQualified'])
            raw['methods'].pop()
            append = next(item for item in raw['builderMethods'] if item['name'] == 'Append')
            append['instructions'][4]['operand'] = 'System.String Unknown::Rewrite(System.String,System.String)'
            self.assertFalse(inspect_report(raw)['contracts'][0]['builderQualified'])


if __name__ == '__main__':
    unittest.main()
