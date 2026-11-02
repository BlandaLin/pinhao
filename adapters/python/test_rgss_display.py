"""Native static Ruby display bindings; no Ruby execution or model requests."""
import hashlib
from pathlib import Path
import tempfile
import unittest
import zlib

import rgss_display
import worker
from ruby_marshal import Reader
from test_worker import ruby_game, ruby_value


LABELS = '''module Labels
  Shop = "Buy goods"
  Result = "%1$s received %2$d gold!"
  Key = "state_active"
end
'''
WINDOW = '''class Window_Base < Window
  def draw_text(*args)
    contents.draw_text(*args)
  end
end
class Window_Notice < Window_Base
  def refresh
    draw_text(0, 0, 200, 24, Labels::Shop)
  end
end
'''
MESSAGE = '''class Game_Message
  def add(text)
    @texts.push(text)
  end
end
class Game_Actor
  def show_result
    $game_message.add(sprintf(Labels::Result, name, 3))
  end
end
'''


def selected(*texts):
    return rgss_display.display_constants([{'file': 'slot%d.rb' % i, 'text': text} for i, text in enumerate(texts)])


class RgssDisplayTests(unittest.TestCase):
    def test_requires_actual_display_consumer_not_module_or_label_name(self):
        self.assertEqual(selected(LABELS), [])
        self.assertEqual([row['constant'] for row in selected(LABELS, WINDOW)], ['Labels::Shop'])

    def test_unknown_or_mixed_use_removes_constant_from_automatic_selection(self):
        for extra in ('if Labels::Shop == state\nend\n', 'load_data(Labels::Shop)\n',
                      'copy = Labels::Shop\n', 'Labels::Shop = "replacement"\n'):
            with self.subTest(extra=extra):
                self.assertEqual(selected(LABELS, WINDOW, extra), [])

    def test_draw_text_name_alone_or_overridden_wrapper_is_not_a_proof(self):
        self.assertEqual(selected(LABELS, WINDOW.replace('Window_Base < Window', 'Window_Base < Object')), [])
        extra = 'class Window_Notice < Window_Base\n  def draw_text(*args)\n    load_scene(args[4])\n  end\nend\n'
        self.assertEqual(selected(LABELS, WINDOW, extra), [])
        self.assertEqual(selected(LABELS, WINDOW, 'Window_Base.class_eval(dynamic_code)\n'), [])

    def test_duplicate_definition_and_interpolation_stay_unresolved(self):
        self.assertEqual(selected(LABELS, WINDOW, LABELS), [])
        self.assertEqual(selected(LABELS, WINDOW, 'text = "#{Labels::Shop}"\n'), [])
        self.assertEqual(selected(LABELS.replace('"Buy goods"', '"Buy #{actor}"'), WINDOW), [])

    def test_dynamic_namespaces_and_nested_or_unsupported_literals_stay_unresolved(self):
        for extra in ('module Labels\n  def self.key\n    Shop\n  end\nend\n',
                      'include Labels\n', 'Alias = Labels\n', 'Labels.send(:const_set, :Shop, "key")\n'):
            with self.subTest(extra=extra):
                self.assertEqual(selected(LABELS, WINDOW, extra), [])
        self.assertEqual(selected('module Labels\n  module Inner\n    Shop = "Not outer"\n  end\nend\n', WINDOW), [])
        self.assertEqual(selected('data = <<WORDS\n' + LABELS + 'WORDS\n', WINDOW), [])
        self.assertEqual(selected('module Outer\n  module Labels\n    Shop = "Nested only"\n  end\nend\n', WINDOW), [])
        self.assertEqual(selected(LABELS, WINDOW, 'module Labels\n  Shop = load_key()\nend\n'), [])

    def test_message_add_override_is_not_a_display_consumer(self):
        self.assertEqual([row['constant'] for row in selected(LABELS, MESSAGE)], ['Labels::Result'])
        self.assertEqual(selected(LABELS, MESSAGE.replace('@texts.push(text)', 'load_scene(text)')), [])

    def test_alias_and_dynamic_replacement_invalidate_effective_display_method(self):
        for replacement in ('alias draw_text load_scene', 'alias :draw_text :load_scene',
                            'alias_method :draw_text, :load_scene', 'alias_method("draw_text", "load_scene")',
                            'define_method(:draw_text) { |*args| load_data(args[4]) }'):
            extra = 'class Window_Notice < Window_Base\n  def load_scene(*args)\n    load_data(args[4])\n  end\n  ' + replacement + '\nend\n'
            with self.subTest(replacement=replacement):
                self.assertEqual(selected(LABELS, WINDOW, extra), [])
        harmless = 'class Window_Notice < Window_Base\n  alias old_refresh refresh\nend\n'
        self.assertEqual([row['constant'] for row in selected(LABELS, WINDOW, harmless)], ['Labels::Shop'])

    def test_formatter_checks_each_constant_argument_path(self):
        for expression in ('sprintf("%s", load_data(Labels::Shop))',
                           'format("%s", sprintf("%s", load_data(Labels::Shop)))',
                           '"%s" % [load_data(Labels::Shop)]'):
            body = MESSAGE.replace('sprintf(Labels::Result, name, 3)', expression)
            with self.subTest(expression=expression):
                self.assertEqual(selected(LABELS, body), [])
        for expression in ('sprintf("%s", Labels::Shop)', 'format("%s", Labels::Shop)',
                           '"%s" % [Labels::Shop]', 'Labels::Shop + " suffix"'):
            body = MESSAGE.replace('sprintf(Labels::Result, name, 3)', expression)
            with self.subTest(expression=expression):
                self.assertEqual([row['constant'] for row in selected(LABELS, body)], ['Labels::Shop'])

    def test_render_quotes_interpolation_backslashes_without_injecting_ruby(self):
        value = 'A "quote", \\path and #{not_code}'
        rendered = rgss_display.render_literal(value, '"Buy goods"')
        self.assertEqual(rgss_display.literal_value(rendered), value)
        self.assertIn('\\#{', rendered)

    def test_normal_native_pipeline_precise_slots_controls_and_original(self):
        for engine, extension in (('XP', 'rxdata'), ('VX', 'rvdata'), ('VX Ace', 'rvdata2')):
            with self.subTest(engine=engine), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                game = ruby_game(root / 'game', engine)
                carrier = game / 'Data' / ('Scripts.' + extension)
                raw = b'\x04\x08' + ruby_value([[1, 'UI words', zlib.compress(LABELS.encode())],
                    [2, 'Display', zlib.compress((WINDOW + MESSAGE).encode())],
                    [3, 'Logic', zlib.compress(b'execute_logic()\n')]])
                carrier.write_bytes(raw)
                before_hash = hashlib.sha256(raw).hexdigest()
                work = root / 'work'
                result = worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
                units = [row for row in result['units'] if row['kind'] == 'script_display']
                self.assertEqual(len(units), 2)
                self.assertTrue(worker.roundtrip({'workspaceDir': str(work)})['byteIdentical'])
                shop = next(row for row in units if row['source'] == 'Buy goods')
                report = worker.build({'workspaceDir': str(work), 'outputDir': str(root / 'build'),
                    'translations': [{'legacyId': shop['id'], 'translation': '购买 "物品" #{显示}'}]})
                rewritten = Reader((root / 'build' / 'Data' / carrier.name).read_bytes())
                self.assertIn('购买'.encode(), zlib.decompress(rewritten.root[0][2].raw))
                self.assertEqual(rewritten.root[1][2].raw, Reader(raw).root[1][2].raw)
                self.assertEqual(rewritten.root[2][2].raw, Reader(raw).root[2][2].raw)
                self.assertEqual(hashlib.sha256(carrier.read_bytes()).hexdigest(), before_hash)
                self.assertFalse(report['runtimeVerified'])
                formatted = next(row for row in units if row['source'] != 'Buy goods')
                self.assertEqual(formatted['tokens'], ['{{CTRL0001}}', '{{CTRL0002}}'])
                with self.assertRaises(worker.WorkerError):
                    worker.validate({'workspaceDir': str(work), 'translations': [{'legacyId': formatted['id'], 'translation': 'missing controls'}]})

    def test_original_script_encoding_is_strict_not_lossy(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            game = ruby_game(root / 'game', 'VX')
            carrier = game / 'Data/Scripts.rvdata'
            literal = LABELS.replace('Buy goods', '\u8cfc\u5165')
            raw = b'\x04\x08' + ruby_value([[1, 'Words', zlib.compress(literal.encode('cp932'))],
                                            [2, 'View', zlib.compress(WINDOW.encode())]])
            carrier.write_bytes(raw)
            work = root / 'work'
            extracted = worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
            unit = next(row for row in extracted['units'] if row['kind'] == 'script_display')
            self.assertTrue(worker.roundtrip({'workspaceDir': str(work)})['byteIdentical'])
            with self.assertRaisesRegex(ValueError, 'not representable'):
                worker.build({'workspaceDir': str(work), 'outputDir': str(root / 'bad-build'),
                    'translations': [{'legacyId': unit['id'], 'translation': '\u4e70\u4e1c\u897f'}]})
            self.assertEqual(carrier.read_bytes(), raw)

    def test_native_and_adapter_same_carrier_conflict_is_actionable_not_last_writer_wins(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            game = ruby_game(root / 'game', 'VX Ace')
            carrier = game / 'Data/Scripts.rvdata2'
            raw = b'\x04\x08' + ruby_value([[1, 'Words', zlib.compress(LABELS.encode())],
                                            [2, 'View', zlib.compress(WINDOW.encode())]])
            carrier.write_bytes(raw)
            work = root / 'work'
            extracted = worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
            unit = next(row for row in extracted['units'] if row['kind'] == 'script_display')
            layout = worker.native.read(work / 'technical/product-source.json')['rgssScriptSources']
            source = layout['scripts'][1]
            view_raw = (Path(layout['root']) / source['file']).read_bytes()
            overlay = root / 'overlay'
            target = overlay / source['file']
            target.parent.mkdir(parents=True)
            changed = view_raw + b'\n# independent adapter edit\n'
            target.write_bytes(changed)
            worker.build({'workspaceDir': str(work), 'outputDir': str(root / 'built'),
                'translations': [{'legacyId': unit['id'], 'translation': '\u8d2d\u4e70'}]})
            with self.assertRaises(worker.WorkerError) as caught:
                worker.assemble({'gameDir': str(game), 'workspaceDir': str(work), 'buildDir': str(root / 'built'),
                    'outputDir': str(root / 'product'), 'share': False, 'adapterOverlayDir': str(overlay),
                    'adapterOverlayFiles': [{'file': source['file'], 'sha256': hashlib.sha256(changed).hexdigest(),
                                             'sourceHash': source['viewSha256']}]})
            self.assertEqual(caught.exception.code, 'RGSS_SCRIPT_WRITE_CONFLICT')
            self.assertEqual(caught.exception.diagnostic['resolution'], 'joint-carrier-build')
            self.assertEqual(carrier.read_bytes(), raw)


if __name__ == '__main__':
    unittest.main()
