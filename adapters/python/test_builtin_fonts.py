"""Verify the prepared open fonts across the native RPG Maker assembly routes."""
import hashlib
import tempfile
import unittest
from pathlib import Path

import worker
from test_rpgmaker import json_game
from test_worker import ruby_game


FONT_DIR = worker.ROOT / 'local' / 'runtime' / 'fonts'
FONTS = [
    ('SourceHanSerifSC-Regular.otf', 'Source Han Serif SC'),
    ('SourceHanSansSC-Regular.otf', 'Source Han Sans SC'),
    ('LXGWWenKai-Regular.ttf', 'LXGW WenKai'),
]


@unittest.skipUnless(all((FONT_DIR / filename).is_file() for filename, _ in FONTS),
                     'Run npm run prepare:tools to verify real built-in fonts')
class BuiltinFontTests(unittest.TestCase):
    def test_font_metadata_and_native_rpg_assembly(self):
        parent = worker.ROOT / 'local' / 'native-tests'
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as temporary:
            root = Path(temporary)
            for engine in ('MV', 'MZ', 'XP', 'VX', 'VX Ace'):
                with self.subTest(engine=engine):
                    game, work, build = (root / engine / name for name in ('game', 'work', 'build'))
                    if engine in ('MV', 'MZ'):
                        json_game(game, engine)
                    else:
                        ruby_game(game, engine)
                    worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
                    worker.build({'workspaceDir': str(work), 'outputDir': str(build), 'translations': []})
                    for index, (filename, family) in enumerate(FONTS):
                        with self.subTest(font=filename):
                            font = FONT_DIR / filename
                            self.assertEqual(worker.font_family(font), family)
                            output = root / engine / ('output-' + str(index))
                            result = worker.assemble({'gameDir': str(game), 'workspaceDir': str(work),
                                                      'buildDir': str(build), 'outputDir': str(output),
                                                      'fontPath': str(font)})
                            copied = output / result['font']['file']
                            self.assertEqual(result['font']['family'], family)
                            self.assertEqual(hashlib.sha256(copied.read_bytes()).hexdigest(),
                                             hashlib.sha256(font.read_bytes()).hexdigest())
                            self.assertEqual(copied.suffix, font.suffix)


if __name__ == '__main__':
    unittest.main()
