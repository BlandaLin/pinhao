"""Managed declaration proof excludes metadata, not actual event callback text."""
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import worker
import unity_native
import unity_semantics

COMPILER = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
SOURCE = Path(__file__).resolve().parents[2] / 'packages/runtime/managed/EventMetadataFixture.cs'


@unittest.skipUnless(COMPILER.is_file(), 'Windows .NET Framework compiler is required for metadata declaration fixtures')
class UnityMetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pinhao-unity-event-metadata-')
        self.root = Path(self.temp.name)
        self.assembly = self.root / 'Game_Data/Managed/UnityEngine.dll'
        self.assembly.parent.mkdir(parents=True)
        subprocess.run([str(COMPILER), '/nologo', '/optimize+', '/target:library', '/out:' + str(self.assembly), str(SOURCE)],
                       check=True, capture_output=True)
        self.hash = hashlib.sha256(self.assembly.read_bytes()).hexdigest()
        self.metadata = {'assemblyFilesSha256': {'Game_Data/Managed/UnityEngine.dll': self.hash}}
        self.script = {'assembly': 'UnityEngine.dll', 'namespace': 'Neutral', 'className': 'EventComponent'}
        unity_semantics._METADATA_REPORTS.clear()

    def tearDown(self):
        self.temp.cleanup()

    def fields(self):
        return unity_semantics.metadata_fields(self.root, self.metadata, 'Game_Data/level0', self.script)

    def test_managed_declaration_excludes_only_the_engine_owned_leaf(self):
        fields = self.fields()
        self.assertEqual({tuple(field['path']) for field in fields}, {
            ('OnDisplay', 'm_TypeName'), ('EventArray', '*', 'm_TypeName'), ('EventList', '*', 'm_TypeName')})
        self.assertTrue(all(field['declaringField'] == 'System.String UnityEngine.Events.UnityEventBase::m_TypeName' for field in fields))
        self.assertTrue(all(field['assemblySha256'] == self.hash for field in fields))

    def test_event_callback_body_and_custom_same_name_fields_survive(self):
        fields = self.fields()
        tree = {'m_TypeName': 'Actual root caption', 'Data': {'m_TypeName': 'Actual nested caption'},
                'Shadow': {'m_TypeName': 'Actual shadow caption', 'Caption': 'A complete scene title'},
                'OnDisplay': {'m_TypeName': 'Engine event type', 'm_PersistentCalls': {'m_Calls': [
                    {'m_Arguments': {'m_StringArgument': 'Welcome, traveler. This is actual dialogue.'}}]}},
                'EventArray': [{'m_TypeName': 'Array event type'}],
                'EventList': [{'m_TypeName': 'List event type'}]}
        leaves = list(unity_native.prefilter_string_leaves(tree, metadata_fields=fields))
        self.assertEqual(len(leaves), 5)
        self.assertIn((('OnDisplay', 'm_PersistentCalls', 'm_Calls', 0, 'm_Arguments', 'm_StringArgument'),
                       'Welcome, traveler. This is actual dialogue.'), leaves)
        self.assertIn((('m_TypeName',), 'Actual root caption'), leaves)
        self.assertIn((('Shadow', 'm_TypeName'), 'Actual shadow caption'), leaves)
        self.assertIsNone(unity_native.prefilter_no_text(('Neutral', 'EventComponent'), tree, fields))
        reviewed = list(unity_native.review_string_fields(tree, metadata_fields=fields))
        self.assertEqual(reviewed, leaves)

    def test_only_proven_event_metadata_can_finish_no_text(self):
        tree = {'OnDisplay': {'m_TypeName': 'Engine event type'}}
        self.assertIsNone(unity_native.prefilter_no_text(('Neutral', 'EventComponent'), tree))
        self.assertEqual(unity_native.prefilter_no_text(('Neutral', 'EventComponent'), tree, self.fields()),
                         'engine-event-type-metadata')

    def test_missing_and_changed_assembly_proof_does_not_filter(self):
        self.metadata['assemblyFilesSha256'] = {}
        self.assertEqual(self.fields(), [])
        self.metadata['assemblyFilesSha256'] = {'Game_Data/Managed/UnityEngine.dll': '0' * 64}
        self.assertEqual(self.fields(), [])

    def test_cached_by_source_hash_type_and_version_not_by_object(self):
        with mock.patch.object(unity_semantics, 'run', wraps=unity_semantics.run) as run:
            for _ in range(12):
                self.assertEqual(len(self.fields()), 3)
            self.assertEqual(run.call_count, 1)
            self.metadata['assemblyFilesSha256']['Game_Data/Managed/UnityEngine.dll'] = '0' * 64
            self.assertEqual(self.fields(), [])
            self.assertEqual(run.call_count, 1)

    def test_dependency_hash_mismatch_does_not_filter(self):
        report = {'schema': unity_semantics.METADATA_VERSION, 'assemblySha256': self.hash,
                  'typeName': 'Neutral.EventComponent', 'dependencyAssemblies': {'UnityEngine.dll': '0' * 64},
                  'metadataFields': [{'path': ['OnDisplay', 'm_TypeName'], 'rule': 'unity-event-serialized-type-identity'}]}
        with mock.patch.object(unity_semantics, 'run', return_value=report):
            self.assertEqual(self.fields(), [])


if __name__ == '__main__':
    unittest.main()
