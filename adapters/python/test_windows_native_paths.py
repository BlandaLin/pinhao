"""Real Windows native-resource I/O beyond MAX_PATH, without game assets or APIs."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import worker
import unity_native as adapter
from native_attempt import filesystem_path
from rgss_archive import destination
from test_unity_native import unity_bundle, unity_game, unity_serialized


LONG_CARRIER = ('Fixture_Data/StreamingAssets/aa/StandaloneWindows64/'
                '9d407b121328bc30142698878cbb0e96_unitybuiltinshaders_'
                '2c5050c4806b0e569095f14a3a85261c.bundle')


@unittest.skipUnless(os.name == 'nt', 'Windows extended-length filesystem paths')
class WindowsNativePathTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pw-')
        self.root = Path(self.temp.name)
        # Cleanup also needs the extended path when descendants cross MAX_PATH.
        self.temp.name = str(filesystem_path(self.root))
        self.addCleanup(self.temp.cleanup)

    def output_at(self, rel, length, label):
        base = self.root / label
        padding = length - len(str(base / rel))
        if padding < 0:
            self.skipTest('Temporary root is too long for the exact boundary fixture')
        output = self.root / (label + 'x' * padding)
        self.assertEqual(len(str(output / rel)), length)
        return output

    def unity_case(self):
        if not adapter.available():
            self.skipTest('Prepare the fixed UnityPy 1.23.0 codec')
        game = unity_game(self.root, bundle=True)
        carrier = filesystem_path(game / LONG_CARRIER)
        carrier.parent.mkdir(parents=True, exist_ok=True)
        carrier.write_bytes(unity_bundle(unity_serialized()))
        work = self.root / 'w'
        extracted = adapter.extract(game, work, adapter.probe(game), worker, {})
        self.assertEqual(len(extracted['units']), 18)
        metadata = worker.native.read(work / 'technical/product-source.json')
        self.assertFalse(metadata['nativeSource'].startswith('\\\\?\\'))
        return game, work, metadata

    def test_unchanged_unity_carrier_copy_at_260_characters(self):
        _, work, metadata = self.unity_case()
        built = self.output_at(LONG_CARRIER, 260, 'b')
        report = adapter.build(work, work / 'editable', built, worker)
        self.assertEqual(report['nativeChangedFiles'], 0)
        for rel, expected in metadata['nativeFilesSha256'].items():
            self.assertEqual(worker.digest_file(built / rel), expected)
        self.assertFalse(report['buildDir'].startswith('\\\\?\\'))

    def test_changed_unity_carrier_and_assembly_beyond_260(self):
        game, work, metadata = self.unity_case()
        original = {rel: worker.digest_file(path) for rel, path in worker.files_in(game)}
        manifest, sheets = worker.native.load_work(work)
        changed = 0
        for name, sheet in sheets.items():
            for row in sheet['units']:
                virtual = manifest['units'][row['id']]['file']
                if (metadata['recordMap'][virtual]['carrier'] == LONG_CARRIER
                        and row['source'] == 'Take your time.'):
                    row['translation'] = '\u6162\u6162\u6765\u3002'
                    changed += 1
            worker.json_write(work / 'editable' / name, sheet)
        self.assertEqual(changed, 1)
        built = self.output_at(LONG_CARRIER, 310, 'changed')
        report = adapter.build(work, work / 'editable', built, worker)
        self.assertEqual(report['nativeChangedFiles'], 1)
        self.assertNotEqual(worker.digest_file(built / LONG_CARRIER), metadata['nativeFilesSha256'][LONG_CARRIER])
        self.assertEqual(worker.digest_file(built / 'Fixture_Data/text.bundle'),
                         metadata['nativeFilesSha256']['Fixture_Data/text.bundle'])
        _, top = adapter.load_carrier(built / LONG_CARRIER)
        objects = {obj.path_id: obj for obj in adapter.objects(top).values()}
        text = json.loads(objects[1].parse_as_dict()['m_Script'])
        self.assertEqual(text['lines'][0]['message'], '\u6162\u6162\u6765\u3002')
        self.assertEqual(text['id'], 'welcome_event')
        self.assertEqual(objects[7].parse_as_dict()['internalTarget'], 'INTERNAL_UI_TARGET')
        output = self.output_at(LONG_CARRIER, 330, 'assembled')
        assembled = adapter.assemble({'gameDir': str(game), 'workspaceDir': str(work),
                                      'buildDir': str(built), 'outputDir': str(output), 'share': False}, worker)
        self.assertFalse(assembled['runtimeVerified'])
        self.assertEqual(worker.digest_file(output / LONG_CARRIER), worker.digest_file(built / LONG_CARRIER))
        entries = dict(worker.files_in(output))
        self.assertIn(LONG_CARRIER, entries)
        self.assertEqual(entries[LONG_CARRIER], output / LONG_CARRIER)
        self.assertFalse(any(str(path).startswith('\\\\?\\') or '\\' in rel for rel, path in entries.items()))
        self.assertEqual(original, {rel: worker.digest_file(path) for rel, path in worker.files_in(game)})

    def test_copy_tree_and_source_hash_checks_use_long_logical_paths(self):
        source = self.output_at(LONG_CARRIER, 300, 'source')
        target = self.output_at(LONG_CARRIER, 320, 'copied')
        raw = b'neutral opaque resource bytes'
        path = filesystem_path(source / LONG_CARRIER)
        path.parent.mkdir(parents=True)
        path.write_bytes(raw)
        metadata = {'sourceFiles': {LONG_CARRIER: hashlib.sha256(raw).hexdigest()}}
        worker.source_unchanged(source, metadata)
        self.assertEqual(list(worker.files_in(source)), [(LONG_CARRIER, source / LONG_CARRIER)])
        inventory = {'excluded': []}
        worker.copy_tree(source, target, inventory)
        self.assertEqual(inventory['copied'], 1)
        worker.source_unchanged(target, metadata)
        worker.copy_tree(source, target, inventory)
        self.assertEqual(inventory['copied'], 1)
        self.assertEqual(inventory['skipped'], 1)
        filesystem_path(target / LONG_CARRIER).write_bytes(b'changed')
        with self.assertRaisesRegex(worker.WorkerError, 'Original native resources changed'):
            worker.source_unchanged(target, metadata)

    def test_long_path_support_preserves_unsafe_and_overlap_rejection(self):
        source = self.root / 'source'
        source.mkdir()
        for name in ('../escape', '/absolute', 'C:/absolute', 'dir/../escape'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                destination(source, name)
        with self.assertRaises(worker.WorkerError) as error:
            worker.copy_tree(source, source / 'nested-output', {'excluded': []})
        self.assertEqual(error.exception.code, 'OUTPUT_OVERLAP')

    def test_long_path_support_still_rejects_junctions(self):
        source, outside = self.root / 'junction-source', self.root / 'junction-target'
        source.mkdir()
        outside.mkdir()
        link = source / 'linked'
        result = subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(outside)],
                                capture_output=True, check=False)
        if result.returncode:
            self.skipTest('Filesystem does not allow a junction fixture')
        try:
            with self.assertRaises(worker.WorkerError) as error:
                list(worker.files_in(source))
            self.assertEqual(error.exception.code, 'SYMLINK')
            with self.assertRaises(worker.WorkerError) as error:
                worker.clean_path(link / 'descendant')
            self.assertEqual(error.exception.code, 'SYMLINK')
        finally:
            os.rmdir(filesystem_path(link))


if __name__ == '__main__':
    unittest.main()
