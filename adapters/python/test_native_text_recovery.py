"""Submitted native text failures remain distinct from broken bases and IO."""
import contextlib
import io
import json
import sys
import unittest
from unittest import mock

import worker


class NativeTextRecoveryTests(unittest.TestCase):
    def fixture(self, count=3):
        units = {f'line-{index}': {'id': f'line-{index}', 'tokens': [], 'controls': {}, 'syntax': 'renpy'}
                 for index in range(count)}
        sheets = {'scene.json': {'units': [{'id': ident, 'translation': 'Original text', 'notes': ''}
                                          for ident in units]}}
        stack = contextlib.ExitStack()
        stack.enter_context(mock.patch.object(worker.native, 'load_work', return_value=({'units': units}, sheets)))
        stack.enter_context(mock.patch.object(worker.native, 'read_editable', return_value=sheets))
        stack.enter_context(mock.patch.object(worker.native, 'validate_sheets', return_value=({}, {}, {})))
        self.addCleanup(stack.close)
        return units

    def test_actual_restore_reports_only_submitted_rejections_with_exact_ids(self):
        self.fixture()
        changes = [{'legacyId': 'line-0', 'translation': '[bad] translated'},
                   {'legacyId': 'line-1', 'translation': 'Valid translated text'},
                   {'legacyId': 'line-2', 'translation': '{bad} translated'}]
        with self.assertRaises(worker.WorkerError) as raised:
            with worker.prepared_editable(None, changes, materialize=False):
                self.fail('Rejected text must not reach build')
        self.assertEqual(raised.exception.code, 'NATIVE_TEXT_REJECTED')
        self.assertEqual([row['legacyId'] for row in raised.exception.rejectedTranslations], ['line-0', 'line-2'])
        self.assertTrue(all('New engine syntax' in row['reason'] for row in raised.exception.rejectedTranslations))

    def test_broken_base_and_restore_io_are_not_classified_as_submitted_text(self):
        self.fixture()
        changes = [{'legacyId': 'line-0', 'translation': '[bad] translated'}]
        with mock.patch.object(worker.native, 'validate_sheets', side_effect=ValueError('Broken baseline')):
            with self.assertRaisesRegex(ValueError, 'Broken baseline') as raised:
                with worker.prepared_editable(None, changes, materialize=False):
                    pass
            self.assertFalse(hasattr(raised.exception, 'rejectedTranslations'))
        with mock.patch.object(worker.native, 'restore', side_effect=OSError('Unavailable file')):
            with self.assertRaises(OSError):
                with worker.prepared_editable(None, changes, materialize=False):
                    pass

    def test_unknown_or_duplicate_ids_are_not_content_rejections(self):
        self.fixture()
        for changes, code in [([{'legacyId': 'foreign', 'translation': '[bad]'}], 'UNKNOWN_ID'),
                              ([{'legacyId': 'line-0', 'translation': '[bad]'}] * 2, 'DUPLICATE_ID')]:
            with self.assertRaises(worker.WorkerError) as raised:
                with worker.prepared_editable(None, changes, materialize=False):
                    pass
            self.assertEqual(raised.exception.code, code)

    def test_rejection_envelope_is_finite_and_survives_worker_main(self):
        self.fixture(260)
        changes = [{'legacyId': f'line-{index}', 'translation': '[bad]'} for index in range(260)]
        with mock.patch.object(worker.native, 'restore', side_effect=ValueError('x' * 2000)):
            with self.assertRaises(worker.WorkerError) as raised:
                with worker.prepared_editable(None, changes, materialize=False):
                    pass
        error = raised.exception
        self.assertEqual(len(error.rejectedTranslations), 256)
        self.assertTrue(all(len(row['reason']) == 1024 for row in error.rejectedTranslations))
        output = io.StringIO()
        with mock.patch.dict(worker.COMMANDS, {'validate': mock.Mock(side_effect=error)}), \
                mock.patch.object(sys, 'argv', ['worker.py', 'validate']), \
                mock.patch.object(sys, 'stdin', io.StringIO('{}')), contextlib.redirect_stdout(output):
            self.assertEqual(worker.main(), 2)
        self.assertEqual(json.loads(output.getvalue())['error']['rejectedTranslations'], error.rejectedTranslations)


if __name__ == '__main__':
    unittest.main()
