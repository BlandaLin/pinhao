"""Bounded Godot display sources, not a full-program semantic analyzer."""
from pathlib import Path
import tempfile
import unittest

import worker
import godot_native as godot


class GodotSourceTrace(unittest.TestCase):
    def setUp(self):
        parent = worker.ROOT / 'local/native-tests'
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def extract(self, sources):
        documents = []
        collector = godot.formats.Collector(self.root, 'Godot', 'spans', 120)
        for name, text in sources.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(text.encode('utf-8'))
            file, document = collector.document(path)
            documents.append((path, file, document))
        trace = godot.godot_source_trace.analyze(documents, godot.script_literals, godot.value_at,
                                                godot.DISPLAY, godot.DISPLAY_CALLS)
        candidates = []
        for path, file, text in documents:
            if path.suffix == '.gd':
                candidates.extend(godot.script_entries(text, collector, file, {}, provenance=trace))
            elif path.suffix == '.json':
                candidates.extend(godot.json_display_entries(text, collector, file, trace))
        return collector, trace, candidates

    def test_static_array_column_and_unrelated_logic_column(self):
        script = ('const ROWS = [["A heading", "chapter_key"], ["Second heading", "other_key"]]\n'
                  'func _ready():\n\tvar h = Label.new()\n\tfor row in ROWS:\n'
                  '\t\th.text = row[0]\n\t\tif row[1] == "chapter_key":\n\t\t\tpass\n')
        collector, _, _ = self.extract({'main.gd': script})
        self.assertEqual({row['source_preview'] for row in collector.rows}, {'A heading', 'Second heading'})
        for row in collector.rows:
            self.assertIn('consumers', row['context']['evidence'])

    def test_mixed_use_and_unknown_function_remain_candidates(self):
        script = ('const ROWS = [["Mixed heading", "internal_key"]]\n'
                  'func _ready():\n\tvar h = Label.new()\n\tfor row in ROWS:\n'
                  '\t\th.text = row[0]\n\t\tif row[0] == "Mixed heading":\n\t\t\tpass\n'
                  '\t\tunknown_consumer(row[1])\n')
        collector, trace, candidates = self.extract({'main.gd': script})
        self.assertEqual(collector.rows, [])
        self.assertTrue(any(item['source'] == 'Mixed heading' for item in candidates))
        self.assertTrue(trace.uses)

    def test_json_precise_source_to_local_parameter_sink(self):
        script = ('func _ready():\n'
                  '\tvar data = JSON.parse_string(FileAccess.get_file_as_string("res://content/data.json"))\n'
                  '\tfor row in data["entries"]:\n\t\tshow_caption(row)\n'
                  'func show_caption(entry):\n\tvar button = Button.new()\n'
                  '\tbutton.tooltip_text = str(entry.get("explanation", ""))\n')
        content = '{"entries":[{"explanation":"A full tooltip.","trigger":"internal_key"}]}'
        collector, _, candidates = self.extract({'main.gd': script, 'content/data.json': content})
        self.assertEqual({row['source_preview'] for row in collector.rows}, {'A full tooltip.'})
        self.assertFalse(any(item.get('source') == 'A full tooltip.' for item in candidates))
        self.assertEqual(collector.rows[0]['context']['path'], ['entries', 0, 'explanation'])

    def test_json_path_and_receiver_are_not_guessed(self):
        script = ('func _ready():\n'
                  '\tvar data = JSON.parse_string(FileAccess.get_file_as_string("res://one.json"))\n'
                  '\tfor row in data["entries"]:\n\t\tunknown_receiver.text = row["explanation"]\n')
        content = '{"entries":[{"explanation":"A full tooltip."}]}'
        collector, _, _ = self.extract({'main.gd': script, 'one.json': content, 'two.json': content})
        self.assertEqual(collector.rows, [])

    def test_local_return_and_alias_keep_complete_semantic_value(self):
        script = ('const MENU = ["A complete label"]\n'
                  'func caption(value):\n\tvar alias = value[0]\n\treturn alias\n'
                  'func _ready():\n\tvar button = Button.new()\n\tbutton.text = caption(MENU)\n')
        collector, _, _ = self.extract({'main.gd': script})
        self.assertEqual({row['source_preview'] for row in collector.rows}, {'A complete label'})

    def test_setter_and_typed_receiver_scopes(self):
        script = ('const TEXT = "A complete caption"\n'
                  'func show_label():\n\tvar widget = Label.new()\n\twidget.set_text(TEXT)\n'
                  'func unknown(widget):\n\twidget.text = TEXT\n')
        collector, _, _ = self.extract({'main.gd': script})
        self.assertEqual(collector.rows, [])
        script = script[:script.index('func unknown')]
        collector, _, _ = self.extract({'main.gd': script})
        self.assertEqual({row['source_preview'] for row in collector.rows}, {'A complete caption'})

    def test_cross_script_member_and_escaped_return_are_not_display_only(self):
        script = ('const TEXT = "A complete caption"\nfunc _ready():\n'
                  '\tvar label = Label.new()\n\tlabel.text = TEXT\n')
        collector, _, _ = self.extract({'main.gd': script, 'logic.gd': 'func read():\n\treturn Other.TEXT\n'})
        self.assertEqual(collector.rows, [])
        collector, _, _ = self.extract({'main.gd': script + 'func export_value():\n\treturn TEXT\n'})
        self.assertEqual(collector.rows, [])

    def test_unknown_source_hint_never_qualifies_json_by_field_name(self):
        script = ('func render(row):\n\tvar label = Label.new()\n'
                  '\tlabel.tooltip_text = transform(str(row.get("explanation", "")))\n')
        content = '{"explanation":"A tooltip with unresolved source."}'
        collector, _, candidates = self.extract({'main.gd': script, 'data.json': content})
        self.assertEqual(collector.rows, [])
        item = next(candidate for candidate in candidates if candidate.get('file') == 'data.json')
        self.assertEqual(item['consumerHints'][0]['qualification'], 'source_unresolved')

    def test_receiver_rebinding_parameters_and_script_alias_invalidate_type(self):
        for change in ('widget = LogicStore.new()', 'widget = factory()', 'widget = other',
                       'widget = Label.new()\n\twidget.script = script_resource',
                       'var alias = widget\n\talias.set_script(script_resource)'):
            script = ('const TEXT = "A logic identifier"\nfunc _ready():\n'
                      '\tvar widget = Label.new()\n\t' + change + '\n\twidget.text = TEXT\n')
            with self.subTest(change=change):
                collector, _, _ = self.extract({'main.gd': script})
                self.assertEqual(collector.rows, [])
        script = ('var widget: Label\nconst TEXT = "A logic identifier"\n'
                  'func render(widget):\n\twidget.text = TEXT\n')
        collector, _, _ = self.extract({'main.gd': script})
        self.assertEqual(collector.rows, [])

    def test_existing_json_display_field_cannot_bypass_unknown_use(self):
        content = '{"text":"A complete node path", "cost":-1}'
        for consumer in ('get_node', 'custom_lookup', 'load'):
            script = ('func _ready():\n'
                      '\tvar data = JSON.parse_string(FileAccess.get_file_as_string("res://data.json"))\n'
                      '\tvar label = Label.new()\n\tlabel.text = data["text"]\n'
                      '\t' + consumer + '(data["text"])\n')
            with self.subTest(consumer=consumer):
                collector, _, candidates = self.extract({'main.gd': script, 'data.json': content})
                self.assertEqual(collector.rows, [])
                item = next(candidate for candidate in candidates if candidate.get('file') == 'data.json')
                self.assertTrue(any(use['kind'] == 'unresolved_call:' + consumer for use in item['sourceUses']))

    def test_container_escape_is_not_scalar_logic_evidence_or_new_authority(self):
        content = '{"text":"Existing text field", "explanation":"Unproven extra field"}'
        script = ('func _ready():\n'
                  '\tvar data = JSON.parse_string(FileAccess.get_file_as_string("res://data.json"))\n'
                  '\tvar label = Label.new()\n\tlabel.text = data["text"]\n'
                  '\tlabel.tooltip_text = data["explanation"]\n\tunknown_consumer(data)\n')
        collector, trace, candidates = self.extract({'main.gd': script, 'data.json': content})
        self.assertEqual({row['source_preview'] for row in collector.rows}, {'Existing text field'})
        self.assertEqual(trace.accepted('data.json'), [])
        item = next(candidate for candidate in candidates if candidate.get('source') == 'Unproven extra field')
        self.assertTrue(any(use['precision'] == 'container' for use in item['sourceUses']))

    def test_native_extract_entry_and_exact_changed_readback(self):
        if not godot.executable():
            self.skipTest('Pinned GDRE tool enables normal native entry')
        game = self.root / 'game'
        game.mkdir()
        (game / 'project.godot').write_text('config_version=5\n[application]\nconfig/name="Neutral"\n', encoding='utf-8')
        script = ('const GROUPS = [["An independent heading", "logical_key"]]\n'
                  'func _ready():\n\tvar label = Label.new()\n'
                  '\tfor row in GROUPS:\n\t\tlabel.text = row[0]\n')
        (game / 'main.gd').write_text(script, encoding='utf-8')
        work = self.root / 'workbench'
        result = godot.extract(game, work, godot.probe(game), worker, {})
        unit = next(row for row in result['units'] if row['source_preview'] == 'An independent heading')
        self.assertTrue(worker.roundtrip({'workspaceDir': str(work)})['byteIdentical'])
        output = self.root / 'output'
        worker.build({'workspaceDir': str(work), 'outputDir': str(output),
                      'translations': [{'id': unit['id'], 'translation': '\u72ec\u7acb\u6807\u9898'}]})
        self.assertEqual((output / 'main.gd').read_text(encoding='utf-8'),
                         script.replace('An independent heading', '\u72ec\u7acb\u6807\u9898'))
        self.assertEqual((game / 'main.gd').read_text(encoding='utf-8'), script)

    def test_normal_workbench_roundtrip_and_non_target_preservation(self):
        script = ('const MENU = [["First heading", "save_identity"]]\r\n'
                  'func _ready():\r\n\tvar button = Button.new()\r\n'
                  '\tfor entry in MENU:\r\n\t\tbutton.text = entry[0]\r\n')
        collector, _, _ = self.extract({'main.gd': script})
        work = self.root.parent / (self.root.name + '-work')
        built = self.root.parent / (self.root.name + '-build')
        try:
            collector.finish(work)
            self.assertTrue(worker.roundtrip({'workspaceDir': str(work)})['byteIdentical'])
            result = worker.build({'workspaceDir': str(work), 'outputDir': str(built),
                                   'translations': [{'id': row['id'], 'translation': '\u4e00\u4e2a\u5b8c\u6574\u7684\u6807\u9898'}
                                                    for row in collector.rows]})
            actual = (built / 'main.gd').read_bytes()
            self.assertEqual(actual, script.replace('First heading', '\u4e00\u4e2a\u5b8c\u6574\u7684\u6807\u9898').encode('utf-8'))
            self.assertEqual((self.root / 'main.gd').read_bytes(), script.encode('utf-8'))
            self.assertTrue(result)
        finally:
            import shutil
            shutil.rmtree(work, ignore_errors=True)
            shutil.rmtree(built, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
