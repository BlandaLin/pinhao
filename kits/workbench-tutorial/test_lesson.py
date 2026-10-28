"""Tutorial acceptance tests with neutral resources only."""
import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import lesson
core = lesson.core


class Lessons(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
    def tearDown(self): self.temp.cleanup()

    def test_three_prepared_lessons_and_reference_builds(self):
        for profile in lesson.PROFILES:
            with self.subTest(profile=profile):
                prepared = lesson.prepare(self.root / profile, profile)
                self.assertTrue(prepared['nochange_byte_identical'])
                self.assertEqual(prepared['reference_verification']['units'], prepared['reference_verification']['changed'])
                lesson.check(self.root / profile, self.root / profile / 'reference/good-editable')

    def test_incremental_and_full_return_builds_equal(self):
        root = self.root / 'lesson'; lesson.prepare(root, 'rpgmaker')
        before = {p.relative_to(root): p.read_bytes() for p in root.rglob('*') if p.is_file()}
        a, b = self.root / 'patch-result', self.root / 'full-result'
        lesson.integrate(root, a, patches=[root / 'reference/good-patch.json'])
        lesson.integrate(root, b, root / 'reference/good-editable')
        for file in core.load_work(root / 'work')[0]['files']:
            self.assertEqual((a / 'built' / file).read_bytes(), (b / 'built' / file).read_bytes())
        self.assertEqual(before, {p.relative_to(root): p.read_bytes() for p in root.rglob('*') if p.is_file()})

    def test_three_invalid_returns_rejected(self):
        root = self.root / 'lesson'; lesson.prepare(root, 'rpgmaker')
        for name in ('missing-token', 'duplicate-id', 'wrong-baseline'):
            with self.assertRaises(ValueError): lesson.integrate(root, self.root / name, patches=[root / 'mistakes' / (name + '.json')])
            self.assertFalse((self.root / name).exists())

    def test_plain_text_return_rebuilds_same_complete_editable(self):
        root = self.root / 'lesson'; lesson.prepare(root, 'rpgmaker')
        converted = self.root / 'converted'
        lesson.from_text(root, root / 'reference/good-return-text.txt', converted)
        for file in core.load_work(root / 'work')[1]:
            self.assertEqual(core.read(converted / 'editable' / file), core.read(root / 'reference/good-editable' / file))
        report = lesson.integrate(root, self.root / 'built', converted / 'editable')
        self.assertEqual(report['units'], report['changed'])

    def test_plain_text_bad_header_and_duplicate_id_rejected(self):
        root = self.root / 'lesson'; lesson.prepare(root, 'rpgmaker')
        good = (root / 'reference/good-return-text.txt').read_text(encoding='utf-8')
        identifiers = [line for line in good.splitlines() if line.startswith('ID=')]
        for index, bad in enumerate((good.replace('BASELINE=', 'OTHER=', 1), good.replace(identifiers[1], identifiers[0], 1), good.replace('TEXT=', 'COMMENT=', 1))):
            path = self.root / ('bad%d.txt' % index); path.write_text(bad, encoding='utf-8')
            with self.assertRaises(ValueError): lesson.from_text(root, path, self.root / ('bad%d' % index))

    def test_generic_bridge_preserves_current_proofread_version(self):
        root = self.root / 'lesson'; lesson.prepare(root, 'rpgmaker')
        exported = self.root / 'exported'
        lesson.export_text(root / 'work', root / 'reference/good-editable', exported, root / 'text-ai/glossary.json')
        imported = self.root / 'imported'
        lesson.import_text(root / 'work', exported / 'return-text.txt', imported)
        for file in core.load_work(root / 'work')[1]:
            self.assertEqual(core.read(imported / 'editable' / file), core.read(root / 'reference/good-editable' / file))

    def test_generic_bridge_pgmm_shared_title_validation(self):
        source = self.root / 'source'; lesson.demo.fixture(source, 'pgmm')
        work = self.root / 'work'; lesson.text_formats.extract(source, work, 'pgmm')
        exported = self.root / 'exported'; lesson.export_text(work, None, exported)
        text = (exported / 'return-text.txt').read_text(encoding='utf-8').replace('TEXT=Demo', 'TEXT=New title', 1)
        path = self.root / 'bad-title.txt'; path.write_text(text, encoding='utf-8')
        with self.assertRaises(ValueError): lesson.import_text(work, path, self.root / 'bad-title')

    def test_stage_exports_keep_current_version_and_use_pure_text_tasks(self):
        root = self.root / 'lesson'; lesson.prepare(root, 'rpgmaker')
        current = root / 'reference/good-editable'
        expected = lesson.editable_digest(current, core.load_work(root / 'work')[1])
        for stage, (label, prompt) in lesson.STAGES.items():
            with self.subTest(stage=stage):
                exported = self.root / stage
                report = lesson.export_text(root / 'work', current, exported, root / 'text-ai/glossary.json', stage)
                self.assertEqual(report['stage'], stage)
                self.assertEqual(report['current_editable_sha256'], expected)
                task = (exported / 'TASK.md').read_text(encoding='utf-8')
                self.assertTrue(task.startswith((lesson.HERE / 'prompts' / prompt).read_text(encoding='utf-8')))
                self.assertIn('本轮阶段：' + label, task)
                self.assertIn('当前译文', (exported / 'READING.md').read_text(encoding='utf-8'))
                imported = self.root / (stage + '-accepted')
                lesson.import_text(root / 'work', exported / 'return-text.txt', imported)
                for name in core.load_work(root / 'work')[1]:
                    self.assertEqual(core.read(current / name), core.read(imported / 'editable' / name))

    def test_review_stages_require_explicit_current_editable(self):
        root = self.root / 'lesson'; lesson.prepare(root, 'rpgmaker')
        for stage in ('proofreading', 'polishing', 'unknown'):
            target = self.root / stage
            with self.assertRaises(ValueError): lesson.export_text(root / 'work', None, target, stage=stage)
            self.assertFalse(target.exists())
        exported = lesson.export_text(root / 'work', None, self.root / 'default')
        self.assertEqual(exported['stage'], 'translation')

    def test_stage_cli_selects_role_and_rejects_missing_current_input(self):
        root = self.root / 'lesson'; lesson.prepare(root, 'rpgmaker')
        command = [sys.executable, str(lesson.HERE / 'lesson.py'), 'export-text', '--work', str(root / 'work')]
        failed = subprocess.run(command + ['--stage', 'proofreading', '--out', str(self.root / 'failed')], capture_output=True)
        self.assertEqual(failed.returncode, 2)
        self.assertFalse(json.loads(failed.stdout)['ok'])
        self.assertFalse((self.root / 'failed').exists())
        passed = subprocess.run(command + ['--stage', 'polishing', '--editable', str(root / 'reference/good-editable'),
                                          '--out', str(self.root / 'passed')], capture_output=True)
        self.assertEqual(passed.returncode, 0, passed.stderr)
        self.assertEqual(json.loads(passed.stdout)['stage'], 'polishing')

    def test_complete_relay_preserves_stage_changes_and_recovers_bad_return(self):
        import relay
        root = self.root / 'relay'; report = relay.prepare(root)
        self.assertTrue(report['source_and_baseline_unchanged'])
        self.assertFalse(report['automatic_translation_or_semantic_review'])
        for index in (1, 2):
            self.assertEqual(report['stages'][index]['input_sha256'], report['stages'][index - 1]['output_sha256'])
        self.assertEqual([s['changed_records_in_this_stage'] for s in report['stages']], [18, 1, 1])
        work = root / 'lesson/work'
        bad = root / '03-polishing/recovery/bad-return-text.txt'
        with self.assertRaises(ValueError): lesson.import_text(work, bad, self.root / 'retry-bad')
        self.assertFalse((self.root / 'retry-bad').exists())
        accepted = root / '03-polishing/accepted/editable'
        final_rows = {row['id']: row for name in core.load_work(work)[1] for row in core.read(accepted / name)['units']}
        self.assertEqual(final_rows[report['profile_issue_id']]['translation'], '一名旅人。{{CTRL0001}}初来此地。')
        self.assertEqual(final_rows[report['dialogue_issue_id']]['translation'], '您好，{{CTRL0001}}。{{LINE0001}}请这边走。')
        self.assertTrue(all(row['translation'] != row['source'] for row in final_rows.values()))
        core.verify(work, accepted, root / 'final/built')

    def test_gender_error_is_not_falsely_certified(self):
        root = self.root / 'lesson'; metadata = lesson.prepare(root, 'rpgmaker')
        report = lesson.check(root, root / 'proof-ai/editable')
        self.assertEqual(report['semantic_review'], 'not_evaluated_by_program')
        self.assertIsNotNone(metadata['proofreading_seeded_issue_id'])
        row = next(row for sheet in core.load_work(root / 'work')[1].values() for row in sheet['units'] if row['id'] == metadata['proofreading_seeded_issue_id'])
        self.assertEqual(row['kind'], 'database_profile')

    def test_readonly_context_or_rows_cannot_be_changed(self):
        root = self.root / 'lesson'; lesson.prepare(root, 'rpgmaker')
        incoming = self.root / 'bad-editable'
        for name, sheet in core.load_work(root / 'work')[1].items():
            value = copy.deepcopy(sheet)
            if name.startswith('Actors'): value['units'][0]['context']['invented_gender'] = 'unknown'
            core.write(incoming / name, value)
        with self.assertRaises(ValueError): lesson.check(root, incoming)

    def test_unknown_lesson_or_modified_baseline_rejected(self):
        root = self.root / 'lesson'; lesson.prepare(root, 'rpgmaker')
        (root / 'work/manifest.json').write_bytes(b'{}')
        with self.assertRaises(ValueError): lesson.check(root, None)

    def test_output_cannot_overwrite_or_enter_lesson(self):
        root = self.root / 'lesson'; lesson.prepare(root, 'rpgmaker')
        with self.assertRaises(ValueError): lesson.prepare(root, 'rpgmaker')
        with self.assertRaises(ValueError): lesson.integrate(root, root / 'bad-build')


if __name__ == '__main__': unittest.main()
