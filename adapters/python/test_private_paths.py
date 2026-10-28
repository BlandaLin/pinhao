import json
from pathlib import Path
import unittest

import worker


class PrivatePathPolicyTests(unittest.TestCase):
    def test_canonical_cases_keep_static_assets_and_exclude_runtime_data(self):
        cases = json.loads((Path(__file__).parent / 'fixtures/private-path-cases.json').read_text(encoding='utf-8'))
        for case in cases:
            with self.subTest(path=case['path']):
                self.assertEqual(worker.excluded(case['path']), case['excluded'])


if __name__ == '__main__':
    unittest.main()
