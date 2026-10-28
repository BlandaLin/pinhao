"""A canned neutral three-stage relay, not an automatic translator."""
import copy
from pathlib import Path

import lesson

core = lesson.core


def write_return(path, work, sheets):
    lines = ['WORKBENCH-TEXT-v1', 'BASELINE=' + core.sha((work / 'manifest.json').read_bytes()), '']
    for sheet in sheets.values():
        for row in sheet['units']:
            lines.extend(('ID=' + row['id'], 'TEXT=' + row['translation'], 'NOTE=' + row['notes'], ''))
    lesson.save_text(path, '\n'.join(lines))


def rows(sheets):
    return {row['id']: row for sheet in sheets.values() for row in sheet['units']}


def read_editable(work, editable):
    return {name: core.read(editable / name) for name in core.load_work(work)[1]}


def differences(before, after):
    prior = rows(before)
    result = []
    for ident, row in rows(after).items():
        old = prior[ident]
        if (old['translation'], old['notes']) != (row['translation'], row['notes']):
            result.append({'id': ident, 'source': row['source'], 'context': row['context'],
                           'before': old['translation'], 'after': row['translation'],
                           'notes_before': old['notes'], 'notes_after': row['notes']})
    return result


def prepare(output):
    output = core.fresh(output, (lesson.HERE,))
    output.mkdir(parents=True)
    fixture = output / 'lesson'
    lesson.prepare(fixture, 'rpgmaker')
    work = fixture / 'work'
    immutable = {p.relative_to(fixture): p.read_bytes() for p in fixture.rglob('*') if p.is_file()}
    initial = read_editable(work, fixture / 'reference/good-editable')
    for row in rows(initial).values(): row['notes'] = ''
    profile_id = next(ident for ident, row in rows(initial).items() if row['kind'] == 'database_profile')
    dialogue_id = next(ident for ident, row in rows(initial).items() if row['source'] == 'Hello, {{CTRL0001}}.{{LINE0001}}Come this way.')
    rows(initial)[profile_id]['translation'] = '她是一名旅人。{{CTRL0001}}初来此地。'
    rows(initial)[dialogue_id]['translation'] = '你好，{{CTRL0001}}。{{LINE0001}}到这边来。'
    proof = copy.deepcopy(initial)
    rows(proof)[profile_id]['translation'] = '一名旅人。{{CTRL0001}}初来此地。'
    rows(proof)[profile_id]['notes'] = '按角色资料移除错误的女性代词；保留自然省略。'
    polish = copy.deepcopy(proof)
    rows(polish)[dialogue_id]['translation'] = '您好，{{CTRL0001}}。{{LINE0001}}请这边走。'
    rows(polish)[dialogue_id]['notes'] = '调整礼貌与句法；保留动态姓名、分行和引导含义。'
    current = work / 'editable'
    summaries = []
    for stage, directory, answer in (
        ('translation', '01-translation', initial),
        ('proofreading', '02-proofreading', proof),
        ('polishing', '03-polishing', polish)):
        root = output / directory
        before = read_editable(work, current)
        exported = lesson.export_text(work, current, root / 'input', fixture / 'text-ai/glossary.json', stage)
        reference = root / 'reference/return-text.txt'
        write_return(reference, work, answer)
        if stage == 'polishing':
            bad = copy.deepcopy(answer)
            rows(bad)[dialogue_id]['translation'] = rows(bad)[dialogue_id]['translation'].replace('{{LINE0001}}', '', 1)
            bad_path = root / 'recovery/bad-return-text.txt'
            write_return(bad_path, work, bad)
            failed_output = root / 'recovery/rejected'
            try:
                lesson.import_text(work, bad_path, failed_output)
            except ValueError as error:
                core.write(root / 'recovery/expected-failure.json', {
                    'status': 'rejected_as_expected', 'exception': 'ValueError', 'error': str(error),
                    'id': dialogue_id, 'missing_token': '{{LINE0001}}',
                    'repaired_return': '../reference/return-text.txt', 'successful_build_created': False})
            else:
                raise ValueError('Missing-token demonstration unexpectedly accepted')
            if failed_output.exists(): raise ValueError('Missing-token demonstration left an unexpected output')
        converted = lesson.import_text(work, reference, root / 'accepted')
        diff = differences(before, answer)
        core.write(root / 'changes.json', {'stage': stage, 'changed_records': len(diff), 'changes': diff})
        actual = read_editable(work, root / 'accepted/editable')
        if actual != answer: raise ValueError('Relay return failed to preserve the complete current translation')
        current = root / 'accepted/editable'
        summaries.append({'stage': stage, 'input_sha256': exported['current_editable_sha256'],
                          'output_sha256': lesson.editable_digest(current, actual),
                          'units': converted['units'], 'changed_records_in_this_stage': len(diff),
                          'semantic_review': 'canned_reference_not_automatic_evaluation'})
    final = lesson.integrate(fixture, output / 'final', current)
    if immutable != {p.relative_to(fixture): p.read_bytes() for p in fixture.rglob('*') if p.is_file()}:
        raise ValueError('Relay modified its source lesson')
    result = {'schema': 'localization-relay-lesson-v1', 'version': lesson.LESSON_VERSION,
              'stages': summaries, 'profile_issue_id': profile_id, 'dialogue_issue_id': dialogue_id,
              'bad_return_rejected': True, 'fixed_return_built': True,
              'source_and_baseline_unchanged': True, 'final_verification': final,
              'automatic_translation_or_semantic_review': False, 'runtime_tested': False}
    core.write(output / 'relay.json', result)
    lesson.save_text(output / 'README.md', (lesson.HERE / 'templates/接力示范说明.md').read_text(encoding='utf-8'))
    return result
