"""Temporary fixture cleanup keeps transient Windows locks bounded and visible."""
import unittest
from unittest.mock import Mock, patch

import test_support as support


def windows_error(code):
    error = OSError('neutral fixture cleanup error')
    error.winerror = code
    return error


class CleanupTests(unittest.TestCase):
    def test_transient_windows_lock_retries_then_succeeds(self):
        for code in (32, 145):
            with self.subTest(code=code), patch.object(support, '_WINDOWS', True), patch.object(support.time, 'sleep') as sleep:
                temporary = Mock()
                temporary.cleanup.side_effect = [windows_error(code), None]
                support.cleanup_temporary(temporary)
                self.assertEqual(temporary.cleanup.call_count, 2)
                sleep.assert_called_once_with(0.05)

    def test_persistent_windows_error_is_raised_after_bounded_retries(self):
        with patch.object(support, '_WINDOWS', True), patch.object(support.time, 'sleep') as sleep:
            temporary = Mock()
            error = windows_error(145)
            temporary.cleanup.side_effect = error
            with self.assertRaises(OSError) as raised:
                support.cleanup_temporary(temporary)
            self.assertIs(raised.exception, error)
            self.assertEqual(temporary.cleanup.call_count, 6)
            self.assertEqual(sleep.call_count, 5)
            self.assertLessEqual(sum(call.args[0] for call in sleep.call_args_list), 1)

    def test_other_errors_and_platforms_raise_immediately(self):
        for windows, code in ((True, 5), (False, 32), (False, 145)):
            with self.subTest(windows=windows, code=code), patch.object(support, '_WINDOWS', windows), patch.object(support.time, 'sleep') as sleep:
                temporary = Mock()
                temporary.cleanup.side_effect = windows_error(code)
                with self.assertRaises(OSError):
                    support.cleanup_temporary(temporary)
                temporary.cleanup.assert_called_once_with()
                sleep.assert_not_called()

    def test_success_needs_one_cleanup(self):
        temporary = Mock()
        support.cleanup_temporary(temporary)
        temporary.cleanup.assert_called_once_with()


if __name__ == '__main__':
    unittest.main()
