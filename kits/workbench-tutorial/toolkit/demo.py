"""Neutral, offline demonstrations. Never loads a user's game."""
import argparse
import json
from pathlib import Path

import kickstart
import rpgmaker as core
import text_formats

PROFILES = kickstart.PROFILES + ('legacy-detection', 'nscripter-detection')


def text_file(path, text, encoding='utf-8', bom=b''):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(bom + text.encode(encoding))


def fixture(root, profile):
    root.mkdir(parents=True)
    selection = None
    if profile == 'rpgmaker':
        from test_rpgmaker import json_game
        json_game(root, 'MZ')
    elif profile == 'renpy-template':
        text_file(root / 'game/tl/schinese/demo.rpy', '# Native translation template; neutral fixture only.\ntranslate schinese demo_a:\n    # clerk "Hello, [player]."\n    clerk ""\n\ntranslate schinese strings:\n    old "Continue"\n    new ""\n\ntranslate schinese python:\n    machine_key = "Do not translate"\n')
    elif profile in ('tyrano', 'kirikiri'):
        path = root / ('data/scenario/demo.ks' if profile == 'tyrano' else 'demo.ks')
        if profile == 'tyrano': (root / 'tyrano').mkdir()
        text_file(path, '*start\n#Clerk:smile\nWelcome.[l]\nPlease enter.[p]\n[glink text="Confirm" target="*next"]\n[iscript]\nvar internal = "Do not translate";\n[endscript]\n', 'utf-16-le' if profile == 'kirikiri' else 'utf-8', b'\xff\xfe' if profile == 'kirikiri' else b'')
    elif profile == 'twee':
        text_file(root / 'demo.twee', ':: StoryTitle\nDemo\n:: StoryData\n{"format":"SugarCube","format-version":"2.37.3"}\n:: Start\nWelcome, $player.\n<<if $ready>>Come in.<<endif>>\n[[Next|Room]]\n:: Room\nA quiet room.\n:: Code [script]\nconst internal = "Do not translate";\n')
    elif profile == 'twine-html':
        text_file(root / 'demo.html', '<!doctype html><html><body><script>const engine="unchanged";</script><tw-storydata name="Demo" format="SugarCube" startnode="1"><tw-passagedata pid="1" name="Start" tags="">Welcome, $player. &lt;&lt;if $ready&gt;&gt;Enter.&lt;&lt;endif&gt;&gt; [[Next|Room]]</tw-passagedata><tw-passagedata pid="2" name="Room" tags="">A quiet room.</tw-passagedata><tw-passagedata pid="3" name="Code" tags="script">const internal="unchanged";</tw-passagedata></tw-storydata></body></html>')
    elif profile == 'pgmm':
        core.write(root / 'project.json', {'textList': [{'id': 1, 'folder': False, 'name': 'InternalWelcome', 'text': {'en': 'Welcome.\nPlease enter.'}, 'fontId': 5}], 'gameInformation': {'title': 'Demo'}, 'fontList': [{'id': 5, 'name': 'InternalFont'}]})
        core.write(root / 'info.json', {'title': 'Demo', 'version': '1.0'})
    elif profile == 'wolf-export':
        core.write(root / 'Map001.json', {'events': [{'name': 'InternalEvent', 'commands': [{'code': 101, 'intArgs': [], 'stringArgs': ['Welcome.\nPlease enter.']}, {'code': 102, 'intArgs': [], 'stringArgs': ['Yes', 'No']}, {'code': 150, 'intArgs': [32], 'stringArgs': ['Notice']}, {'code': 150, 'intArgs': [0], 'stringArgs': ['picture/path.png']}, {'code': 121, 'intArgs': [1], 'stringArgs': ['InternalVariable']}]}]})
    elif profile == 'godot-csv':
        text_file(root / 'messages.csv', 'keys,en,schinese\r\nWELCOME,"Welcome, {player}.",\r\nCONTINUE,Continue,\r\n')
    elif profile == 'gettext-po':
        text_file(root / 'messages.po', 'msgid ""\nmsgstr "Language: zh_CN\\n"\n\nmsgctxt "menu"\nmsgid "Continue"\nmsgstr ""\n\nmsgctxt "greeting"\nmsgid "Welcome, {player}."\nmsgstr ""\n')
    elif profile == 'json-selected':
        core.write(root / 'dialogue.json', {'native_id': 41, 'resource': 'internal/path', 'lines': [{'speaker': 'CLERK_ID', 'text': 'Welcome, {player}.'}], 'build_metadata': 'unchanged'})
        selection = root / 'selection.json'
        core.write(selection, {'schema': 'kickstart-json-selection-v1', 'fields': [{'file': 'dialogue.json', 'path': ['lines', 0, 'text'], 'kind': 'display_text', 'context': {'speaker_id': 'CLERK_ID'}}]})
    elif profile == 'legacy-detection':
        text_file(root / 'Data/System.rxdata', 'Neutral detection signature; not a Marshal fixture')
    elif profile == 'nscripter-detection':
        text_file(root / '0.txt', '; neutral detection fixture\n*start\n')
        text_file(root / 'demo.nsa', 'Neutral signature; not a real archive')
    else: raise ValueError('Unknown fixture profile')
    return selection


def run(profile, output):
    output = core.fresh(output)
    selection = fixture(output / 'source', profile)
    if profile.endswith('-detection'):
        result = {'profile': profile, 'probe': kickstart.probe(output / 'source'), 'status': 'detection_only_no_native_roundtrip'}
        kickstart.plan(output / 'source', output / 'plan.json')
    else:
        source, work = output / 'source', output / 'work'
        report = core.extract(source, work) if profile == 'rpgmaker' else text_formats.extract(source, work, profile, selection=selection)
        manifest, sheets = core.load_work(work)
        core.build(work, work / 'editable', output / 'nochange')
        core.verify(work, work / 'editable', output / 'nochange')
        if any((output / 'nochange' / f).read_bytes() != (work / 'baseline' / f).read_bytes() for f in manifest['files']): raise ValueError('Demo nochange identity failed')
        row = next(r for sheet in sheets.values() for r in sheet['units'] if r['kind'] != 'game_title')
        patch = {'schema': 'rpgmaker-ai-patch-v1', 'baseline_sha256': core.sha((work / 'manifest.json').read_bytes()), 'changes': [{'id': row['id'], 'translation': '\u793a\u4f8b ' + row['translation'], 'notes': 'Technical marker, not a story translation.'}]}
        core.write(output / 'return-patch.json', patch)
        core.merge(work, [output / 'return-patch.json'], output / 'merged')
        core.build(work, output / 'merged/editable', output / 'built')
        checked = core.verify(work, output / 'merged/editable', output / 'built')
        result = {'profile': profile, 'extraction': report, 'verification': checked, 'nochange_byte_identical': True,
                  'status': 'synthetic_closed_loop_native_runtime_not_tested'}
    core.write(output / 'demo-report.json', result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', choices=PROFILES, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.profile, args.out), ensure_ascii=False))


if __name__ == '__main__': main()
