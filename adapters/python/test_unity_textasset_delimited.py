"""Normal native import and physical writeback using fresh managed reader proof."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import worker
import unity_native as unity
import unity_textasset_delimited as delimited
from test_unity_native import unity_serialized, unity_bundle
from test_unity_textasset_consumers import COMPILER, fixture_assembly


@unittest.skipUnless(unity.available() and COMPILER.is_file(), 'UnityPy and the existing compiler are required')
class DelimiterNativeTests(unittest.TestCase):
    def test_fresh_reader_proof_native_import_and_independent_physical_readback(self):
        with tempfile.TemporaryDirectory(prefix='unity-tail-native-') as temporary:
            root = Path(temporary)
            tools = root / 'tools'
            tools.mkdir()
            cecil = worker.ROOT / 'local/dependencies/managed/Mono.Cecil.dll'
            self.assertTrue(cecil.is_file(), 'Prepare the existing managed tools')
            shutil.copyfile(cecil, tools / cecil.name)
            subprocess.run([str(COMPILER), '/nologo', '/target:exe', '/out:' + str(tools / 'Pinhao.UnityTextAsset.exe'),
                            '/r:' + str(tools / cecil.name), '/r:System.Web.Extensions.dll',
                            str(worker.ROOT / 'packages/runtime/managed/UnityTextAsset.cs')], check=True, capture_output=True)
            game = root / 'game'
            managed = game / 'Fixture_Data/Managed'
            managed.mkdir(parents=True)
            assembly = fixture_assembly(managed)
            assembly.rename(managed / 'ReaderFixture.dll')
            _, top = unity.load_carrier_bytes(unity_bundle(unity_serialized(container=True)))
            indexed = unity.objects(top)
            key = next(key for key, obj in indexed.items() if obj.path_id == 1)
            tree = indexed[key].parse_as_dict()
            original_text = 'first,voice_1,A complete sentence, with comma\r\nfirst,voice_2,Another complete sentence\r\n'
            tree.update(m_Name='unrelated.csv', m_Script=original_text)
            indexed[key].save_typetree(tree)
            carrier = game / 'Fixture_Data/text.bundle'
            carrier.write_bytes(top.save(packer='original'))
            (game / 'Fixture.exe').write_bytes(b'MZ-neutral-nonexecutable')
            (game / 'UnityPlayer.dll').write_bytes(b'neutral-not-executable')
            original = carrier.read_bytes()
            work = root / 'work'
            with mock.patch.dict(os.environ, {'PINHAO_MANAGED_TOOLS': str(tools)}):
                result = worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
            rows = [row for row in result['units'] if row['context'].get('object') == key]
            self.assertEqual([row['source'] for row in rows], ['A complete sentence, with comma', 'Another complete sentence'])
            metadata = worker.native.read(work / 'technical/product-source.json')
            contracts = metadata['textAssetReaderEvidence']['contracts']
            self.assertEqual(sum(contract['displayQualified'] for contract in contracts), 1)
            self.assertEqual(contracts[0]['skipFields'], 2)
            self.assertTrue(worker.roundtrip({'workspaceDir': str(work)})['byteIdentical'])
            output = root / 'built'
            worker.build({'workspaceDir': str(work), 'outputDir': str(output), 'translations': [
                {'id': rows[0]['id'], 'translation': 'Changed complete body, longer than before'}]})
            _, actual = unity.load_carrier(output / 'Fixture_Data/text.bundle')
            expected = original_text.replace('A complete sentence, with comma', 'Changed complete body, longer than before')
            tree = unity.objects(actual)[key].parse_as_dict()
            self.assertEqual(tree['m_Script'], expected)
            self.assertNotIn('"Changed', tree['m_Script'])
            _, before = unity.load_carrier(carrier)
            unity.verify_carrier(before, actual, {key: tree})
            self.assertEqual(carrier.read_bytes(), original)
            self.assertFalse(result.get('runtimeVerified', False))
            # A syntax candidate with no actual display proof must never enable the binder.
            pending = dict(contracts[0], displayQualified=False)
            with self.assertRaisesRegex(ValueError, 'not display authorization'):
                delimited.entries(original_text, pending, unity.readable)


if __name__ == '__main__':
    unittest.main()
