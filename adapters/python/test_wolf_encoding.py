from pathlib import Path
import tempfile
import unittest
from unittest import mock

import worker
import wolf_native


class WolfEncodingReadbackTests(unittest.TestCase):
    def test_exported_json_is_registered_as_an_additional_read_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            game, work, codec = root / 'game', root / 'work', root / 'codec.exe'
            native = game / 'Data' / 'BasicData' / 'Game.dat'
            native.parent.mkdir(parents=True)
            native.write_bytes(b'neutral native baseline')
            codec.write_bytes(b'codec identity only; not executed')

            def exported(_exe, _source, output, operation):
                self.assertEqual(operation, 'create')
                worker.json_write(output / 'dump' / 'Game.json', {'TitlePlus': 'A visible title.'})

            with mock.patch.object(wolf_native, 'tool', side_effect=exported):
                result = wolf_native.extract(game, work, codec, worker)
            metadata = worker.native.read(work / 'technical' / 'product-source.json')
            self.assertEqual(metadata['additionalSourceRoots'], [str((work / 'baseline').resolve())])
            self.assertTrue((work / 'baseline' / 'Game.json').is_file())
            self.assertFalse((game / 'Game.json').exists())
            self.assertEqual(len(result['units']), 1)

    def test_cp932_replacement_reports_observed_codec_loss(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            expected, actual = root / 'expected', root / 'actual'
            worker.json_write(expected / 'Map.json', {'text': '汉化测试', 'state': 1})
            worker.json_write(actual / 'Map.json', {'text': '?化??', 'state': 1})
            with self.assertRaisesRegex(ValueError, 'outside CP932') as caught:
                wolf_native.verify_dump(expected, actual)
            self.assertEqual(caught.exception.code, 'WOLF_TEXT_ENCODING')

    def test_unicode_route_and_unrelated_structure_keep_original_validation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            expected, actual = root / 'expected', root / 'actual'
            value = {'text': '汉化测试', 'state': 1}
            worker.json_write(expected / 'Map.json', value)
            worker.json_write(actual / 'Map.json', value)
            wolf_native.verify_dump(expected, actual)
            worker.json_write(actual / 'Map.json', {**value, 'state': 2})
            with self.assertRaisesRegex(ValueError, 'protected structure'):
                wolf_native.verify_dump(expected, actual)


if __name__ == '__main__':
    unittest.main()
