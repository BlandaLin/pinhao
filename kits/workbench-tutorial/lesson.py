"""Generate and verify neutral localization workbench lessons. No game runtime."""
import argparse
import copy
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / 'toolkit'))
import demo
import rpgmaker as core
import text_formats

PROFILES = ('rpgmaker', 'renpy-template', 'tyrano')
LESSON_VERSION = '1.3.0'
STAGES = {
    'translation': ('初翻', 'text-only-ai.md'),
    'proofreading': ('校对', 'text-only-proof-ai.md'),
    'polishing': ('润色', 'text-only-polish-ai.md'),
}
WORDS = {
    'Lin': '\u6797\u5ddd',
    'A traveler.{{CTRL0001}}A new arrival.': '\u4e00\u540d\u65c5\u4eba\u3002{{CTRL0001}}\u521d\u6765\u6b64\u5730\u3002',
    'Inn': '\u65c5\u9986', 'Clerk': '\u524d\u53f0\u5458\u5de5',
    'Hello, {{CTRL0001}}.{{LINE0001}}Come this way.': '\u60a8\u597d\uff0c{{CTRL0001}}\u3002{{LINE0001}}\u8bf7\u8fd9\u8fb9\u8d70\u3002',
    'Yes': '\u662f', 'No': '\u5426', 'Thank you.': '\u8c22\u8c22\u3002', 'Goodbye.': '\u518d\u89c1\u3002',
    'Demo': '\u5de5\u4f5c\u53f0\u793a\u4f8b', 'Coin': '\u91d1\u5e01', 'Fire': '\u706b', 'Level': '\u7b49\u7ea7', 'Fight': '\u6218\u6597',
    '{{CTRL0001}} wins!': '{{CTRL0001}}\u83b7\u80dc\u4e86\uff01',
    'Hello, {{CTRL0001}}.': '\u60a8\u597d\uff0c{{CTRL0001}}\u3002', 'Continue': '\u7ee7\u7eed',
    'Welcome.{{CTRL0001}}{{CTRL0002}}Please enter.{{CTRL0003}}': '\u6b22\u8fce\u5149\u4e34\u3002{{CTRL0001}}{{CTRL0002}}\u8bf7\u8fdb\u3002{{CTRL0003}}',
    'Confirm': '\u786e\u8ba4',
}


def save_text(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8', newline='\n') as stream: stream.write(text)


def prepare(output, profile):
    output = core.fresh(output, (HERE,))
    source, work = output / 'source', output / 'work'
    selection = demo.fixture(source, profile)
    report = core.extract(source, work, batch_size=120) if profile == 'rpgmaker' else text_formats.extract(source, work, profile, selection=selection)
    manifest, originals = core.load_work(work)
    core.build(work, work / 'editable', output / 'reference/nochange')
    core.verify(work, work / 'editable', output / 'reference/nochange')
    if any((output / 'reference/nochange' / f).read_bytes() != (work / 'baseline' / f).read_bytes() for f in manifest['files']):
        raise ValueError('Nochange identity failed')
    gold, changes = copy.deepcopy(originals), []
    for sheet in gold.values():
        for row in sheet['units']:
            if row['source'] not in WORDS: raise ValueError('Lesson translation missing for neutral fixture: ' + row['id'])
            row['translation'] = WORDS[row['source']]
            row['notes'] = 'Neutral tutorial reference; valid alternative wording is allowed.'
            changes.append({'id': row['id'], 'translation': row['translation'], 'notes': row['notes']})
    glossary = {'schema': 'tutorial-glossary-v1', 'entries': [
        {'source': 'Lin', 'target': '\u6797\u5ddd', 'role': 'actor_id_1', 'gender': 'male', 'evidence': 'Author-defined neutral fixture; no appearance-based inference.'},
        {'source': 'Clerk', 'target': '\u524d\u53f0\u5458\u5de5', 'role': 'speaker', 'gender': 'unknown', 'evidence': 'Do not infer a gender from a job title.'},
        {'source': 'Inn', 'target': '\u65c5\u9986', 'role': 'location'},
        {'source': 'Continue', 'target': '\u7ee7\u7eed', 'role': 'menu'}]}
    for name, sheet in originals.items(): core.write(output / 'text-ai/editable' / name, sheet)
    for name, sheet in gold.items(): core.write(output / 'reference/good-editable' / name, sheet)
    core.write(output / 'text-ai/glossary.json', glossary)
    core.write(output / 'proof-ai/glossary.json', glossary)
    core.write(output / 'text-only-ai/glossary.json', glossary)
    proof = copy.deepcopy(gold)
    issue_id = None
    if profile == 'rpgmaker':
        for sheet in proof.values():
            for row in sheet['units']:
                if row['kind'] == 'database_profile':
                    issue_id = row['id']
                    row['translation'] = '\u5979\u662f\u4e00\u540d\u65c5\u4eba\u3002{{CTRL0001}}\u521d\u6765\u6b64\u5730\u3002'
                    row['notes'] = ''
    for name, sheet in proof.items(): core.write(output / 'proof-ai/editable' / name, sheet)
    core.validate(work, output / 'proof-ai/editable')
    template = (HERE / 'prompts/text-ai.md').read_text(encoding='utf-8')
    save_text(output / 'text-ai/TASK.md', template.replace('<EDITABLE_DIRECTORY>', 'editable').replace('<GLOSSARY_FILE>', 'glossary.json'))
    template = (HERE / 'prompts/proof-ai.md').read_text(encoding='utf-8')
    save_text(output / 'proof-ai/TASK.md', template.replace('<EDITABLE_DIRECTORY>', 'editable').replace('<GLOSSARY_FILE>', 'glossary.json'))
    digest = core.sha((work / 'manifest.json').read_bytes())
    def plain_return(sheets):
        lines = ['WORKBENCH-TEXT-v1', 'BASELINE=' + digest, '']
        for sheet in sheets.values():
            for row in sheet['units']: lines.extend(('ID=' + row['id'], 'TEXT=' + row['translation'], 'NOTE=' + row['notes'], ''))
        return '\n'.join(lines)
    save_text(output / 'text-only-ai/return-text.txt', plain_return(originals))
    save_text(output / 'reference/good-return-text.txt', plain_return(gold))
    readings = ['# \u53ea\u8bfb\u539f\u6587\u4e0e\u4e0a\u4e0b\u6587\n']
    for sheet in originals.values():
        for row in sheet['units']:
            readings.extend(('## ' + row['id'], '\n\u539f\u6587\uff1a\n\n```text\n' + row['source_preview'] + '\n```\n',
                             '\u5e26\u4fdd\u62a4\u7b26\u7684\u539f\u6587\uff1a`' + row['source'] + '`\n',
                             '\u4e0a\u4e0b\u6587\uff1a`' + json.dumps(row['context'], ensure_ascii=False) + '`\n'))
    save_text(output / 'text-only-ai/READING.md', '\n'.join(readings))
    save_text(output / 'text-only-ai/TASK.md', (HERE / 'prompts/text-only-ai.md').read_text(encoding='utf-8'))
    good_patch = {'schema': 'rpgmaker-ai-patch-v1', 'baseline_sha256': digest, 'changes': changes}
    core.write(output / 'reference/good-patch.json', good_patch)
    core.write(output / 'text-ai/patch-template.json', {'schema': 'rpgmaker-ai-patch-v1', 'baseline_sha256': digest, 'changes': []})
    token_row = next(row for sheet in gold.values() for row in sheet['units'] if row['tokens'])
    token_bad = {'id': token_row['id'], 'translation': token_row['translation'].replace(token_row['tokens'][0], '', 1)}
    for filename, rows, baseline in (
        ('missing-token.json', [token_bad], digest),
        ('duplicate-id.json', [changes[0], changes[0]], digest),
        ('wrong-baseline.json', [changes[0]], '0' * 64)):
        core.write(output / 'mistakes' / filename, {'schema': 'rpgmaker-ai-patch-v1', 'baseline_sha256': baseline, 'changes': rows})
    core.merge(work, [output / 'reference/good-patch.json'], output / 'reference/merged')
    core.build(work, output / 'reference/merged/editable', output / 'reference/built')
    checked = core.verify(work, output / 'reference/merged/editable', output / 'reference/built')
    result = {'schema': 'localization-lesson-v1', 'version': LESSON_VERSION, 'profile': profile,
              'extraction': report, 'reference_verification': checked, 'baseline_sha256': digest,
              'nochange_byte_identical': True, 'proofreading_seeded_issue_id': issue_id,
              'runtime_tested': False, 'status': 'neutral_data_lesson_not_a_playable_game'}
    core.write(output / 'lesson.json', result)
    save_text(output / 'README.md', '# \u4e2d\u6027\u5de5\u4f5c\u53f0\u7ec3\u4e60\n\ntext-ai \u4ea4\u7ed9\u7ffb\u8bd1 AI\uff1bproof-ai \u4ea4\u7ed9\u6821\u5bf9 AI\u3002\u5b83\u4eec\u4e0d\u9700\u8981\u8bfb\u4ee3\u7801\u3002\n\nreference \u662f\u6280\u672f\u4eba\u5458\u7684\u53c2\u8003\u7b54\u6848\uff0cmistakes \u662f\u9519\u8bef\u683c\u5f0f\u793a\u4f8b\u3002work \u548c source \u53ea\u8bfb\u3002\n\n\u8fd9\u662f\u81ea\u9020\u4e2d\u6027\u6570\u636e\uff0c\u6ca1\u6709\u5f15\u64ce\u8fd0\u884c\u5668\uff0c\u4e0d\u662f\u53ef\u73a9\u6e38\u620f\u3002\u7ed3\u6784\u6821\u9a8c\u4e0d\u7b49\u4e8e\u8bed\u4e49\u6821\u5bf9\u901a\u8fc7\u3002\n')
    return result


def checked_lesson(lesson):
    lesson = Path(lesson).resolve()
    metadata = core.read(lesson / 'lesson.json')
    if metadata.get('schema') != 'localization-lesson-v1': raise ValueError('Unsupported lesson')
    if core.sha((lesson / 'work/manifest.json').read_bytes()) != metadata['baseline_sha256']:
        raise ValueError('Lesson baseline mismatch')
    core.load_work(lesson / 'work')
    return lesson


def check(lesson, editable):
    lesson = checked_lesson(lesson)
    editable = Path(editable) if editable is not None else lesson / 'text-ai/editable'
    manifest, values, report = core.validate(lesson / 'work', editable)
    # Syntax-slot and target-plan checks belong to the technical side, not the translator.
    core.expected_files(lesson / 'work', manifest, values)
    return {**report, 'semantic_review': 'not_evaluated_by_program', 'runtime_tested': False}


def import_text(work, incoming, output):
    work = Path(work).resolve()
    incoming = Path(incoming)
    output = core.fresh(output, (HERE, work, incoming))
    manifest, sheets = core.load_work(work)
    lines = incoming.read_text(encoding='utf-8-sig').splitlines()
    digest = core.sha((work / 'manifest.json').read_bytes())
    if len(lines) < 2 or lines[:2] != ['WORKBENCH-TEXT-v1', 'BASELINE=' + digest]: raise ValueError('Text-return format or baseline mismatch')
    fields = [line for line in lines[2:] if line != '']
    originals = [row for sheet in sheets.values() for row in sheet['units']]
    if len(fields) != len(originals) * 3: raise ValueError('Text-return record count/physical line mismatch')
    values = {}
    for index, row in enumerate(originals):
        ident, text, note = fields[index * 3:index * 3 + 3]
        if ident != 'ID=' + row['id']: raise ValueError('Missing/changed/duplicate/reordered text-return ID: ' + row['id'])
        if not text.startswith('TEXT=') or not note.startswith('NOTE='): raise ValueError('Expected TEXT and NOTE fields')
        row['translation'], row['notes'] = text[5:], note[5:]
        values[row['id']] = core.restore(row['translation'], manifest['units'][row['id']])
    core.expected_files(work, manifest, values)
    output.mkdir(parents=True)
    for name, sheet in sheets.items(): core.write(output / 'editable' / name, sheet)
    _, _, report = core.validate(work, output / 'editable')
    report = {**report, 'semantic_review': 'not_evaluated_by_program', 'runtime_tested': False}
    core.write(output / 'conversion-report.json', report)
    return {**report, 'status': 'plain_text_converted_and_structurally_validated'}


def from_text(lesson, incoming, output):
    lesson = checked_lesson(lesson)
    core.fresh(output, (lesson,))
    return import_text(lesson / 'work', incoming, output)


def editable_digest(editable, names):
    members = [(name, core.sha((Path(editable) / name).read_bytes())) for name in sorted(names)]
    return core.sha(json.dumps(members, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))


def export_text(work, editable, output, glossary=None, stage='translation'):
    if stage not in STAGES: raise ValueError('Unsupported text stage: ' + str(stage))
    if stage != 'translation' and editable is None:
        raise ValueError('Proofreading/polishing requires --editable pointing to the current complete translation')
    work = Path(work).resolve()
    editable = Path(editable) if editable is not None else work / 'editable'
    output = core.fresh(output, (HERE, work, editable))
    manifest, values, report = core.validate(work, editable)
    core.expected_files(work, manifest, values)
    sheets = {name: core.read(editable / name) for name in core.load_work(work)[1]}
    current_digest = editable_digest(editable, sheets)
    lines = ['WORKBENCH-TEXT-v1', 'BASELINE=' + core.sha((work / 'manifest.json').read_bytes()), '']
    readings = ['# \u53ea\u8bfb\u539f\u6587\u4e0e\u4e0a\u4e0b\u6587\n']
    for sheet in sheets.values():
        for row in sheet['units']:
            if '\n' in row['notes'] or '\r' in row['notes']: raise ValueError('Plain-text mode requires one-line notes; use full editable instead')
            lines.extend(('ID=' + row['id'], 'TEXT=' + row['translation'], 'NOTE=' + row['notes'], ''))
            readings.extend(('## ' + row['id'], '\n\u539f\u6587\uff1a\n\n```text\n' + row['source_preview'] + '\n```\n',
                             '当前译文：\n\n```text\n' + row['translation'] + '\n```\n',
                             '\u4e0a\u4e0b\u6587\uff1a`' + json.dumps(row['context'], ensure_ascii=False) + '`\n'))
    terms = core.read(glossary) if glossary else {'schema': 'tutorial-glossary-v1', 'entries': [], 'note': '\u8bf7\u8d1f\u8d23\u4eba\u8865\u5145\u672f\u8bed\u4e0e\u89d2\u8272\u8bc1\u636e\uff1b\u8fd9\u4efd\u7a7a\u8868\u4e0d\u63d0\u4f9b\u6027\u522b\u5224\u65ad\u3002'}
    output.mkdir(parents=True)
    save_text(output / 'return-text.txt', '\n'.join(lines))
    save_text(output / 'READING.md', '\n'.join(readings))
    label, prompt = STAGES[stage]
    task = (HERE / 'prompts' / prompt).read_text(encoding='utf-8')
    task += '\n## 本次导出信息\n\n本轮阶段：' + label + '\n\n'
    task += '当前完整工作表的版本指纹：`' + current_digest + '`。由技术侧生成，不需文字 AI 计算或修改。\n\n'
    task += '`READING.md` 的当前译文是输入快照；只修改 `return-text.txt` 的 TEXT/NOTE，返回完整文件。'
    task += '其他文件只读。疑点或未完成范围可另附短报告，不改变回包结构。\n'
    save_text(output / 'TASK.md', task)
    core.write(output / 'glossary.json', terms)
    result = {**report, 'stage': stage, 'current_editable_sha256': current_digest,
              'glossary_supplied': glossary is not None}
    core.write(output / 'export-report.json', result)
    return {**result, 'status': 'current_complete_editable_exported_as_plain_text'}


def integrate(lesson, output, editable=None, patches=None):
    lesson = checked_lesson(lesson)
    incoming = [Path(editable)] if editable is not None else list(patches or [])
    output = core.fresh(output, (HERE, lesson, *incoming))
    work = lesson / 'work'
    if patches:
        core.merge(work, patches, output / 'merged')
        editable = output / 'merged/editable'
    else:
        editable = Path(editable) if editable is not None else lesson / 'text-ai/editable'
        check(lesson, editable)
    core.build(work, editable, output / 'built')
    report = core.verify(work, editable, output / 'built')
    notes = {row['id']: row['notes'] for name in core.load_work(work)[1] for row in core.read(editable / name)['units'] if row['notes']}
    core.write(output / 'notes.json', notes)
    result = {**report, 'notes_saved_separately': len(notes), 'semantic_review': 'requires_text_AI_or_human', 'runtime_tested': False}
    core.write(output / 'result.json', result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('prepare'); p.add_argument('--profile', choices=PROFILES, default='rpgmaker'); p.add_argument('--out', type=Path, required=True)
    p = sub.add_parser('check'); p.add_argument('--lesson', type=Path, required=True); p.add_argument('--editable', type=Path)
    p = sub.add_parser('from-text'); p.add_argument('--lesson', type=Path, required=True); p.add_argument('--text', type=Path, required=True); p.add_argument('--out', type=Path, required=True)
    p = sub.add_parser('export-text'); p.add_argument('--work', type=Path, required=True); p.add_argument('--editable', type=Path); p.add_argument('--out', type=Path, required=True); p.add_argument('--glossary', type=Path)
    p.add_argument('--stage', choices=STAGES, default='translation', help='Select translation, proofreading, or polishing task; latter stages require --editable')
    p = sub.add_parser('prepare-relay'); p.add_argument('--out', type=Path, required=True)
    p = sub.add_parser('import-text'); p.add_argument('--work', type=Path, required=True); p.add_argument('--text', type=Path, required=True); p.add_argument('--out', type=Path, required=True)
    p = sub.add_parser('integrate'); p.add_argument('--lesson', type=Path, required=True); p.add_argument('--out', type=Path, required=True)
    group = p.add_mutually_exclusive_group(); group.add_argument('--editable', type=Path); group.add_argument('--patch', type=Path, nargs='+')
    args = parser.parse_args()
    try:
        if args.command == 'prepare': result = prepare(args.out, args.profile)
        elif args.command == 'check': result = check(args.lesson, args.editable)
        elif args.command == 'from-text': result = from_text(args.lesson, args.text, args.out)
        elif args.command == 'export-text': result = export_text(args.work, args.editable, args.out, args.glossary, args.stage)
        elif args.command == 'prepare-relay':
            import relay
            result = relay.prepare(args.out)
        elif args.command == 'import-text': result = import_text(args.work, args.text, args.out)
        else: result = integrate(args.lesson, args.out, args.editable, args.patch)
        print(json.dumps({'ok': True, **result}, ensure_ascii=False)); return 0
    except (ValueError, OSError, KeyError, TypeError, IndexError, UnicodeError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False)); return 2


if __name__ == '__main__': sys.exit(main())
