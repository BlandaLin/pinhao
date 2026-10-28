from pathlib import Path
import struct
import tempfile
import unittest

import worker
from font_inspection import Font
from test_worker import font_fixture


class FontInspectionTests(unittest.TestCase):
    def test_name_only_font_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'fake.ttf'
            name = 'Fake'.encode('utf-16-be')
            table = struct.pack('>HHH', 0, 1, 18) + struct.pack('>HHHHHH', 3, 1, 1033, 1, len(name), 0) + name
            path.write_bytes(struct.pack('>IHHHH', 0x10000, 1, 0, 0, 0) + struct.pack('>4sIII', b'name', 0, 28, len(table)) + table)
            with self.assertRaisesRegex(worker.WorkerError, 'complete font'):
                worker.font_family(path)

    def test_required_unicode_is_checked_and_non_bmp_missing_is_reported(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'fixture.ttf'
            font_fixture(path)
            result = worker.font_coverage({'fontPath': str(path), 'texts': ['中文 A', '\U0001f680']})
            self.assertEqual(result['missing'], ['U+1F680'])
            self.assertEqual(result['covered'], 3)
            self.assertFalse(result['runtimeFallbackVerified'])

    def test_prepared_fonts_cover_typical_simplified_chinese(self):
        for path in (worker.ROOT / 'local/runtime/fonts').glob('*'):
            if path.suffix.lower() not in ('.ttf', '.otf'):
                continue
            with self.subTest(font=path.name):
                self.assertEqual(Font(path).coverage(['汉化游戏测试，开始继续保存。'])['status'], 'passed')


if __name__ == '__main__':
    unittest.main()
