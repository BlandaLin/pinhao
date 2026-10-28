"""Synthetic LCF native encoding, complete-message and native output tests."""
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest import mock
import xml.etree.ElementTree as ET

import worker
import lcf_native as lcf


class LcfNativeTests(unittest.TestCase):
    def setUp(self):
        self.exe = lcf.executable(worker.ROOT)
        if not self.exe:
            self.skipTest('liblcf native codec is not installed')
        parent = worker.ROOT / 'local' / 'native-tests'
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.root = Path(self.temp.name)

    def tearDown(self):
        if hasattr(self, 'temp'):
            self.temp.cleanup()

    def fixture(self, engine):
        game = self.root / 'game'
        game.mkdir()
        for index, (fixture, name) in enumerate((('lcf-neutral.edb', 'RPG_RT.ldb'), ('lcf-neutral.emu', 'Map0001.lmu'))):
            source = worker.ROOT / 'adapters' / 'fixtures' / fixture
            raw = source.read_text(encoding='utf-8').replace('Neutral first line.', '\u3053\u3093\u306b\u3061\u306f\u3002')
            staged = self.root / ('fixture' + source.suffix)
            staged.write_text(raw, encoding='utf-8')
            built = lcf.convert(self.exe, staged, self.root / ('fixture%d' % index), '932', engine)
            shutil.copyfile(built, game / name)
        (game / 'RPG_RT.exe').write_bytes(b'neutral launcher, not executable')
        (game / 'Save01.lsd').write_bytes(b'private neutral save')
        return game

    def pipeline(self, engine):
        game = self.fixture(engine)
        source_hash = {rel: worker.digest_file(path) for rel, path in worker.files_in(game)}
        work, built = self.root / 'work', self.root / 'built'
        extracted = worker.extract({'gameDir': str(game), 'workspaceDir': str(work), 'lcfEngine': engine,
                                    'sourceEncoding': '932', 'targetEncoding': '936'})
        metadata = worker.native.read(work / 'technical' / 'product-source.json')
        self.assertEqual(metadata['additionalSourceRoots'], [str((work / 'baseline').resolve())])
        self.assertTrue((work / 'baseline' / 'RPG_RT.ldb.json').is_file())
        message = next(row for row in extracted['units'] if row['kind'] == 'dialogue')
        self.assertEqual(message['source'], '\u3053\u3093\u306b\u3061\u306f\u3002{{LINE0001}}Neutral second line.')
        report = worker.roundtrip({'workspaceDir': str(work)})
        self.assertTrue(report['nativeSemanticRoundtrip'])
        changes = [{'legacyId': message['id'], 'translation': '\u4f60\u597d{{LINE0001}}\u6b22\u8fce'}]
        built_report = worker.build({'workspaceDir': str(work), 'outputDir': str(built), 'translations': changes})
        self.assertEqual(built_report['encoding'], '936')
        mapped = lcf.convert(self.exe, built / 'Map0001.lmu', self.root / 'verify936', '936', engine)
        doc = ET.parse(mapped).getroot()
        strings = [entry.text or '' for entry in doc.iter('string')]
        self.assertEqual(strings[:2], ['\u4f60\u597d', '\u6b22\u8fce'])
        actor = lcf.convert(self.exe, built / 'RPG_RT.ldb', self.root / 'verify-db', '936', engine)
        self.assertEqual(ET.parse(actor).find('.//Actor/initial_level').text, '3')
        output = self.root / 'output'
        result = worker.assemble({'gameDir': str(game), 'workspaceDir': str(work), 'buildDir': str(built), 'outputDir': str(output)})
        self.assertFalse((output / 'Save01.lsd').exists())
        self.assertTrue((output / 'RPG_RT.ldb').is_file())
        self.assertEqual(result['encoding'], '936')
        self.assertTrue(result['warnings'])
        self.assertEqual(source_hash, {rel: worker.digest_file(path) for rel, path in worker.files_in(game)})

    def test_rpg2000_full_native_data_pipeline(self):
        self.pipeline('2k')

    def test_rpg2003_full_native_data_pipeline(self):
        self.pipeline('2k3')

    def test_native_nochange_delivery_is_original_bytes(self):
        game = self.fixture('2k3')
        work, built = self.root / 'work', self.root / 'built'
        worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
        worker.build({'workspaceDir': str(work), 'outputDir': str(built), 'translations': []})
        self.assertEqual((built / 'Map0001.lmu').read_bytes(), (game / 'Map0001.lmu').read_bytes())
        self.assertEqual((built / 'RPG_RT.ldb').read_bytes(), (game / 'RPG_RT.ldb').read_bytes())

    def test_roundtrip_checks_delivery_not_canonical_intermediate(self):
        game = self.fixture('2k3')
        work = self.root / 'work'
        worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
        original = lcf.projection_build

        def canonicalized(*args, **kwargs):
            outputs, validation = original(*args, **kwargs)
            # Exercise the delivery branch independently of the codec's exact serialization.
            path = next(iter(outputs.values()))
            path.write_bytes(path.read_bytes() + b'\x00')
            return outputs, validation

        with mock.patch.object(lcf, 'projection_build', side_effect=canonicalized):
            report = worker.roundtrip({'workspaceDir': str(work)})
        self.assertTrue(report['passed'])
        self.assertTrue(report['byteIdentical'])
        self.assertFalse(report['codecByteIdentical'])

    def test_leading_empty_dialogue_does_not_overwrite_previous_unit(self):
        game = self.fixture('2k3')
        xml = lcf.convert(self.exe, game / 'Map0001.lmu', self.root / 'empty-leading-source', '932', '2k3')
        document = ET.parse(xml)
        commands = document.find('.//event_commands')
        for code, value in ((10110, ''), (20110, 'Text after an intentional empty line.')):
            command = ET.SubElement(commands, 'EventCommand')
            for tag, content in (('code', str(code)), ('indent', '0'), ('string', value), ('parameters', '')):
                ET.SubElement(command, tag).text = content
        document.write(xml, encoding='utf-8', xml_declaration=True)
        xml.write_bytes(xml.read_bytes().replace(b"<?xml version='1.0' encoding='utf-8'?>", b'<?xml version="1.0" encoding="UTF-8"?>'))
        native = lcf.convert(self.exe, xml, self.root / 'empty-leading-native', '932', '2k3')
        shutil.copyfile(native, game / 'Map0001.lmu')
        work = self.root / 'work'
        extracted = worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
        messages = [row for row in extracted['units'] if row['kind'] == 'dialogue']
        self.assertEqual(len(messages), 2)
        self.assertIn('Neutral second line.', messages[0]['source'])
        self.assertEqual(messages[1]['source'], '{{LINE0001}}Text after an intentional empty line.')
        self.assertTrue(worker.roundtrip({'workspaceDir': str(work)})['passed'])

    def test_roundtrip_still_rejects_changed_protected_field(self):
        game = self.fixture('2k3')
        work = self.root / 'work'
        worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
        original = lcf.convert

        def damaged_reexport(exe, source, output_dir, *args, **kwargs):
            result = original(exe, source, output_dir, *args, **kwargs)
            if output_dir.name.startswith('verify-') and result.suffix == '.edb':
                document = ET.parse(result)
                document.find('.//Actor/initial_level').text = '99'
                document.write(result, encoding='utf-8', xml_declaration=True)
            return result

        with mock.patch.object(lcf, 'convert', side_effect=damaged_reexport):
            with self.assertRaisesRegex(ValueError, 'changed protected fields'):
                worker.roundtrip({'workspaceDir': str(work)})

    def test_roundtrip_still_rejects_changed_delivery_bytes(self):
        game = self.fixture('2k3')
        work = self.root / 'work'
        worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
        original = lcf.build

        def damaged_delivery(work, editable, output, *args, **kwargs):
            report = original(work, editable, output, *args, **kwargs)
            target = output / 'Map0001.lmu'
            target.write_bytes(target.read_bytes() + b'\x00')
            return report

        with mock.patch.object(lcf, 'build', side_effect=damaged_delivery):
            report = worker.roundtrip({'workspaceDir': str(work)})
        self.assertFalse(report['passed'])
        self.assertFalse(report['byteIdentical'])

    def test_unencodable_translation_is_rejected(self):
        game = self.fixture('2k3')
        work = self.root / 'work'
        extracted = worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
        row = next(row for row in extracted['units'] if not row['tokens'])
        with self.assertRaises(UnicodeEncodeError):
            worker.build({'workspaceDir': str(work), 'outputDir': str(self.root / 'bad'),
                          'translations': [{'legacyId': row['id'], 'translation': '\U0001f600'}]})
        self.assertFalse((self.root / 'bad').exists())


if __name__ == '__main__':
    unittest.main()
