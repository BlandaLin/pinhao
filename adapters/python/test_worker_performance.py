"""Command-local native build reuse without weakening independent validation."""
from collections import Counter
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import worker
from test_rpgmaker import json_game


class NativeBuildSnapshotTests(unittest.TestCase):
    def setUp(self):
        parent = worker.ROOT / 'local' / 'native-tests'
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.root = Path(self.temp.name)
        self.game, self.work = self.root / 'game', self.root / 'work'
        json_game(self.game)
        self.extracted = worker.extract({'gameDir': str(self.game), 'workspaceDir': str(self.work)})
        self.rows = self.extracted['units']
        self.name = next(row for row in self.rows if row['kind'] == 'database_name')
        self.dialogue = next(row for row in self.rows if '{{LINE' in row['source'])
        self.args = {'workspaceDir': str(self.work), 'outputDir': str(self.root / 'built'),
                     'translations': [{'id': self.name['id'], 'translation': 'Changed name'}]}

    def tearDown(self):
        self.temp.cleanup()

    def test_one_command_reuses_checked_inputs_but_reads_built_files(self):
        reads = Counter()
        read_bytes = Path.read_bytes

        def counted(path):
            reads[path] += 1
            return read_bytes(path)

        with mock.patch.object(Path, 'read_bytes', counted), \
                mock.patch.object(worker.native, 'load_work', wraps=worker.native.load_work) as load, \
                mock.patch.object(worker.native, 'expected_files', wraps=worker.native.expected_files) as expected:
            report = worker.build(self.args)
        self.assertEqual(load.call_count, 1)
        self.assertEqual(expected.call_count, 1)
        manifest, _ = worker.native.load_work(self.work)
        for file in manifest['files']:
            self.assertEqual(reads[self.work / 'baseline' / file], 1)
            self.assertEqual(reads[self.root / 'built' / file], 1)
        for name in manifest['sheets']:
            self.assertEqual(reads[self.work / 'technical' / 'row-baseline' / name], 1)
            self.assertEqual(reads[self.work / 'editable' / name], 1)
        self.assertEqual(report['changed'], 1)
        self.assertEqual(worker.native.validate(self.work)[2]['changed'], 0)

    def test_inline_changes_keep_accepted_omitted_rows_and_notes(self):
        row = next(row for row in self.rows if row['id'] != self.name['id'])
        manifest, _ = worker.native.load_work(self.work)
        for name in manifest['sheets']:
            sheet = worker.native.read(self.work / 'editable' / name)
            for entry in sheet['units']:
                if entry['id'] == row['id']:
                    entry['translation'] = 'Accepted ' + entry['translation']
                    entry['notes'] = 'Retain this note'
            worker.json_write(self.work / 'editable' / name, sheet)
        before = {path: path.read_bytes() for path in (self.work / 'editable').iterdir()}
        report = worker.build(self.args)
        self.assertEqual(report['changed'], 2)
        self.assertEqual({path: path.read_bytes() for path in before}, before)
        self.assertEqual(worker.native.validate(self.work)[2]['changed'], 1)

    def test_manifest_baseline_and_row_baseline_corruption_still_fail_before_output(self):
        paths = [self.work / 'manifest.json',
                 next((self.work / 'baseline').rglob('*.json')),
                 next((self.work / 'technical' / 'row-baseline').iterdir())]
        for path in paths:
            with self.subTest(path=path.name):
                original = path.read_bytes()
                path.write_bytes(original + b'\n')
                try:
                    with self.assertRaises(ValueError):
                        worker.build(self.args)
                    self.assertFalse((self.root / 'built').exists())
                finally:
                    path.write_bytes(original)
        self.assertEqual(worker.build(self.args)['changed'], 1)

    def test_current_editable_structure_is_not_bypassed_by_inline_translation(self):
        path = next((self.work / 'editable').iterdir())
        sheet = worker.native.read(path)
        sheet['units'][0]['source'] += ' tampered'
        worker.json_write(path, sheet)
        with self.assertRaisesRegex(ValueError, 'Changed ID/source/context/order'):
            worker.build(self.args)
        self.assertFalse((self.root / 'built').exists())

    def test_control_loss_and_duplicate_ids_keep_recovery_inputs(self):
        before = {path: path.read_bytes() for path in (self.work / 'editable').iterdir()}
        cases = [[{'id': self.dialogue['id'], 'translation': 'Lost line separator'}],
                 self.args['translations'] * 2]
        for changes in cases:
            with self.subTest(changes=changes):
                with self.assertRaises(ValueError):
                    worker.build({**self.args, 'translations': changes})
                self.assertFalse((self.root / 'built').exists())
                self.assertEqual({path: path.read_bytes() for path in before}, before)
        self.assertEqual(worker.build(self.args)['changed'], 1)

    def test_next_command_reloads_edited_text_and_independent_verify_is_fresh(self):
        first = self.root / 'first'
        worker.build({**self.args, 'outputDir': str(first), 'translations': None})
        manifest, _ = worker.native.load_work(self.work)
        for name in manifest['sheets']:
            sheet = worker.native.read(self.work / 'editable' / name)
            for row in sheet['units']:
                if row['id'] == self.name['id']:
                    row['translation'] = 'Newly accepted name'
            worker.json_write(self.work / 'editable' / name, sheet)
        second = self.root / 'second'
        result = worker.build({**self.args, 'outputDir': str(second), 'translations': None})
        self.assertEqual(result['changed'], 1)
        self.assertEqual(worker.native.verify(self.work, self.work / 'editable', second)['changed'], 1)
        with self.assertRaisesRegex(ValueError, 'Built file differs'):
            worker.native.verify(self.work, self.work / 'editable', first)

    def test_later_baseline_change_is_never_hidden_by_build_snapshot(self):
        worker.build(self.args)
        path = next((self.work / 'baseline').rglob('*.json'))
        original = path.read_bytes()
        path.write_bytes(original + b'\n')
        with self.assertRaisesRegex(ValueError, 'Baseline resource changed'):
            worker.build({**self.args, 'outputDir': str(self.root / 'next')})
        with self.assertRaisesRegex(ValueError, 'Baseline resource changed'):
            worker.validate({'workspaceDir': str(self.work)})
        with self.assertRaisesRegex(ValueError, 'Baseline resource changed'):
            worker.native.verify(self.work, self.work / 'editable', self.root / 'built')
        self.assertFalse((self.root / 'next').exists())

    def test_readback_detects_bad_write_and_retry_preserves_inputs(self):
        write_bytes = Path.write_bytes
        built = self.root / 'built'
        corrupted = []

        def bad_write(path, raw):
            if path.is_relative_to(built) and path.name != 'build-report.json' and not corrupted:
                corrupted.append(path)
                return write_bytes(path, raw + b'\n')
            return write_bytes(path, raw)

        with mock.patch.object(Path, 'write_bytes', bad_write):
            with self.assertRaisesRegex(ValueError, 'Built file differs'):
                worker.build(self.args)
        self.assertTrue(corrupted)
        self.assertEqual(worker.native.validate(self.work)[2]['changed'], 0)
        self.assertFalse(list(self.root.glob('pinhao-edit-*')))
        self.assertEqual(worker.build({**self.args, 'outputDir': str(self.root / 'retry')})['changed'], 1)

    def test_build_uses_verified_bytes_not_changed_disk_inputs_mid_command(self):
        expected_files = worker.native.expected_files
        path = next((self.work / 'baseline').rglob('*.json'))
        original = path.read_bytes()

        def changed_after_validation(*args, **kwargs):
            path.write_bytes(b'not the validated baseline')
            return expected_files(*args, **kwargs)

        try:
            with mock.patch.object(worker.native, 'expected_files', changed_after_validation):
                self.assertEqual(worker.build(self.args)['changed'], 1)
            with self.assertRaisesRegex(ValueError, 'Baseline resource changed'):
                worker.validate({'workspaceDir': str(self.work)})
        finally:
            path.write_bytes(original)
        with worker.prepared_editable(self.work, self.args['translations']) as (editable, _, _):
            self.assertEqual(worker.native.verify(self.work, editable, self.root / 'built')['changed'], 1)

    def test_report_identifies_verified_manifest_when_disk_changes_mid_command(self):
        expected_files = worker.native.expected_files
        path = self.work / 'manifest.json'
        original = path.read_bytes()

        def changed_after_validation(*args, **kwargs):
            path.write_bytes(original + b'\n')
            return expected_files(*args, **kwargs)

        try:
            with mock.patch.object(worker.native, 'expected_files', changed_after_validation):
                report = worker.build(self.args)
            self.assertEqual(report['manifest_sha256'], worker.native.sha(original))
            with self.assertRaisesRegex(ValueError, 'Manifest changed'):
                worker.validate({'workspaceDir': str(self.work)})
        finally:
            path.write_bytes(original)

    def test_roundtrip_shares_inputs_but_preserves_byte_identity_and_fresh_next_run(self):
        output = self.root / 'roundtrip'
        reads = Counter()
        read_bytes = Path.read_bytes

        def counted(path):
            reads[path] += 1
            return read_bytes(path)

        with mock.patch.object(Path, 'read_bytes', counted), \
                mock.patch.object(worker.native, 'load_work', wraps=worker.native.load_work) as load, \
                mock.patch.object(worker.native, 'expected_files', wraps=worker.native.expected_files) as expected:
            report = worker.roundtrip({'workspaceDir': str(self.work), 'outputDir': str(output)})
        self.assertTrue(report['byteIdentical'])
        self.assertEqual(load.call_count, 1)
        self.assertEqual(expected.call_count, 1)
        manifest, _ = worker.native.load_work(self.work)
        for file in manifest['files']:
            self.assertEqual(reads[self.work / 'baseline' / file], 1)
            self.assertEqual(reads[output / file], 2)
            self.assertEqual((self.work / 'baseline' / file).read_bytes(), (output / file).read_bytes())
        baseline = self.work / 'baseline' / next(iter(manifest['files']))
        baseline.write_bytes(baseline.read_bytes() + b'\n')
        with self.assertRaisesRegex(ValueError, 'Baseline resource changed'):
            worker.roundtrip({'workspaceDir': str(self.work)})


if __name__ == '__main__':
    unittest.main()
