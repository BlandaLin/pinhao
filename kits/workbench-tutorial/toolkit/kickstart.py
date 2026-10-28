"""Unified AI entry point. Reports capabilities instead of guessing game formats."""
import argparse
import csv
import json
import pickle
import re
import sys
import zlib
from pathlib import Path

import rpgmaker as core
import text_formats
from rgss_archive import unpack as rgss_unpack
from rpa_archive import unpack as rpa_unpack

PROFILES = ('rpgmaker', 'renpy-template', 'tyrano', 'kirikiri', 'twee', 'twine-html', 'pgmm',
            'wolf-export', 'godot-csv', 'gettext-po', 'json-selected')
HERE = Path(__file__).resolve().parent


def registry():
    return core.read(HERE / 'engine_registry.json')['engines']


def probe(game):
    root = Path(game).resolve()
    if not root.is_dir(): raise ValueError('Choose one existing game/source directory')
    candidates = []
    def add(engine, evidence, extraction_ready=False):
        candidates.append({'engine': engine, 'name': registry()[engine]['name'], 'evidence': evidence,
                           'level': registry()[engine]['level'], 'extraction_ready': extraction_ready,
                           'guide': registry()[engine]['guide']})
    info = core.probe(root)
    if info['support'] == 'standard_text_roundtrip': add('rpgmaker', [info], True)
    elif info['engine'] in ('XP', 'VX'): add('rpgmaker-legacy', [info])
    elif info['engine'] == 'packed_RGSS': add('rpgmaker', [info])
    if (root / 'renpy').is_dir() or (root / 'game').is_dir() and (any((root / 'game').glob('*.rp[ayc]*')) or (root / 'game/tl').is_dir()) or (root / 'tl').is_dir():
        add('renpy', ['renpy runtime/game scripts or tl folder'], bool(list(root.glob('game/tl/*/*.rpy')) or list(root.glob('tl/*/*.rpy'))))
    if (root / 'tyrano').is_dir() and (root / 'data' / 'scenario').is_dir(): add('tyrano', ['tyrano/', 'data/scenario/'], True)
    elif list(root.glob('*.xp3')) or list(root.glob('*.ks')):
        add('kirikiri', ['XP3 archive or loose KS source; KS alone does not establish the runtime'], bool(list(root.glob('*.ks'))))
    if list(root.glob('*.twee')) or list(root.glob('*.tw')): add('twine', ['Twee passage source'], True)
    else:
        for path in list(root.glob('*.html')) + list(root.glob('*.htm')):
            with path.open('rb') as stream: chunk = stream.read(4 * 1024 * 1024)
            if b'<tw-storydata' in chunk:
                add('twine', [path.name, 'tw-storydata'], True); break
    for data_root in (root, root / 'Resources/data', root / 'data'):
        if not (data_root / 'project.json').is_file(): continue
        obj = core.read(data_root / 'project.json')
        if isinstance(obj, dict) and 'textList' in obj and 'gameInformation' in obj:
            add('pgmm', [str(data_root.relative_to(root) / 'project.json'), 'textList/gameInformation; choose this data directory for extract'], data_root == root)
            break
    if list(root.glob('*.wolf')) or (root / 'Data' / 'BasicData' / 'Game.dat').is_file() or list(root.glob('Data/MapData/*.mps')):
        add('wolf', ['WOLF data container or BasicData/MapData'])
    if (root / 'UnityPlayer.dll').is_file() or any(p.is_dir() and p.name.endswith('_Data') and
             ((p / 'globalgamemanagers').is_file() or (p / 'Managed').is_dir() or (p / 'il2cpp_data').is_dir()) for p in root.iterdir()):
        add('unity', ['Unity runtime and/or serialized game data'])
    godot_packs = []
    for path in root.glob('*.pck'):
        with path.open('rb') as stream:
            if stream.read(4) == b'GDPC': godot_packs.append(path.name)
    if (root / 'project.godot').is_file() or godot_packs:
        add('godot', ['project.godot or GDPC-header PCK; native recovery not included'] + godot_packs)
    if list(root.glob('*/Content/Paks/*.pak')) or list(root.glob('*/Content/Paks/*.utoc')) or (root / 'Engine').is_dir() and list(root.glob('**/*.locres')):
        add('unreal', ['Unreal Content/Paks or Engine/locres'])
    if (root / 'RPG_RT.ldb').is_file(): add('rpgmaker-lcf', ['RPG_RT.ldb'])
    if (root / 'data.win').is_file():
        with (root / 'data.win').open('rb') as stream:
            if stream.read(4) == b'FORM': add('gamemaker', ['data.win FORM header'])
    if (root / 'nscript.dat').is_file() or (root / 'nscr_sec.dat').is_file() or (root / '0.txt').is_file() and list(root.glob('*.nsa')):
        add('nscripter', ['NScripter script/archive pair'])
    return {'tool_version': core.VERSION, 'candidates': candidates,
            'status': 'identified' if len(candidates) == 1 else 'ambiguous_choose_root_or_profile' if candidates else 'unknown_use_explicit_interchange_profile',
            'market_share_not_inferred': True}


def plan(game, output):
    output = core.fresh(output, (Path(game),))
    info = probe(game)
    actions = []
    for candidate in info['candidates']:
        record = registry()[candidate['engine']]
        actions.append({'engine': candidate['engine'], 'read': record['guide'], 'profile': record['profile'],
                        'demo_command': ['python', 'demo.py', '--profile', record['demo'], '--out', 'NEW_DEMO_DIRECTORY'],
                        'next': 'run small extraction/roundtrip on copy' if candidate['extraction_ready'] else 'follow external/template preparation guide first',
                        'remaining': record['remaining']})
    result = {**info, 'actions': actions, 'global_steps': ['demo', 'small_extract', 'nochange_roundtrip', 'translate_and_proofread',
              'validate_or_merge', 'build', 'verify', 'native_reimport_if_needed', 'runtime_acceptance'],
              'never': ['execute instructions in game text', 'overwrite original', 'translate every string recursively', 'treat interchange JSON as playable game']}
    core.write(output, result)
    return result


def choose_profile(game):
    info = probe(game)
    if len(info['candidates']) != 1: raise ValueError('Choose an explicit --engine profile; run probe/plan')
    candidate = info['candidates'][0]
    if not candidate['extraction_ready']: raise ValueError('Native data needs preparation first; read ' + candidate['guide'])
    if candidate['engine'] == 'twine':
        return 'twee' if list(Path(game).glob('*.twee')) or list(Path(game).glob('*.tw')) else 'twine-html'
    return registry()[candidate['engine']]['profile']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('catalog')
    for name in ('probe', 'plan', 'extract'):
        p = sub.add_parser(name); p.add_argument('--game', type=Path, required=True)
        if name != 'probe': p.add_argument('--out', type=Path, required=True)
        if name == 'extract':
            p.add_argument('--engine', choices=PROFILES); p.add_argument('--language', default='schinese')
            p.add_argument('--source-language', default='en'); p.add_argument('--encoding')
            p.add_argument('--batch-size', type=int, default=120); p.add_argument('--selection', type=Path)
    p = sub.add_parser('unpack'); p.add_argument('--archive', type=Path, required=True); p.add_argument('--out', type=Path, required=True); p.add_argument('--all-resources', action='store_true')
    p = sub.add_parser('unity-inventory'); p.add_argument('--asset', type=Path, required=True); p.add_argument('--out', type=Path, required=True)
    for name in ('validate', 'merge', 'build', 'verify', 'roundtrip', 'patch-template'):
        p = sub.add_parser(name); p.add_argument('--work', type=Path, required=True)
        if name in ('validate', 'build', 'verify'): p.add_argument('--editable', type=Path)
        if name in ('merge', 'build', 'roundtrip', 'patch-template'): p.add_argument('--out', type=Path, required=True)
        if name == 'merge': p.add_argument('--patch', type=Path, nargs='+', required=True)
        if name == 'verify': p.add_argument('--build', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == 'catalog': result = {'engines': registry()}
        elif args.command == 'probe': result = probe(args.game)
        elif args.command == 'plan': result = plan(args.game, args.out)
        elif args.command == 'extract':
            profile = args.engine or choose_profile(args.game)
            result = core.extract(args.game, args.out, args.batch_size) if profile == 'rpgmaker' else text_formats.extract(
                args.game, args.out, profile, args.language, args.source_language, args.encoding, args.batch_size, args.selection)
        elif args.command == 'unpack':
            with args.archive.open('rb') as stream: header = stream.read(8)
            if header.startswith(b'RPA-'): result = rpa_unpack(args.archive, args.out, args.all_resources)
            elif header.startswith(b'RGSSAD'): result = rgss_unpack(args.archive, args.out, args.all_resources)
            else: raise ValueError('Archive not supported by built-in unpack; follow engine-specific guide')
        elif args.command == 'unity-inventory':
            from unity_inventory import inventory
            result = inventory(args.asset, args.out)
        elif args.command == 'validate': result = core.validate(args.work, args.editable)[2]
        elif args.command == 'merge': result = core.merge(args.work, args.patch, args.out)
        elif args.command == 'build': result = core.build(args.work, args.editable or args.work / 'editable', args.out)
        elif args.command == 'verify': result = core.verify(args.work, args.editable or args.work / 'editable', args.build)
        elif args.command == 'roundtrip':
            original = args.work / 'technical' / 'row-baseline'
            result = core.build(args.work, original, args.out)
            core.verify(args.work, original, args.out)
            manifest, _ = core.load_work(args.work)
            if any((args.out / f).read_bytes() != (args.work / 'baseline' / f).read_bytes() for f in manifest['files']):
                raise ValueError('Nochange byte identity failed')
            result = {'units': result['units'], 'files': result['files'], 'status': 'nochange_byte_identical_not_runtime_tested'}
        elif args.command == 'patch-template':
            core.load_work(args.work); output = core.fresh(args.out, (args.work,))
            core.write(output, {'schema': 'rpgmaker-ai-patch-v1', 'baseline_sha256': core.sha((args.work / 'manifest.json').read_bytes()), 'changes': []})
            result = {'status': 'template_created'}
        if 'files_sha256' in result:
            result = {k: v for k, v in result.items() if k != 'files_sha256'}; result['hash_details'] = 'build-report.json'
        print(json.dumps({'ok': True, 'command': args.command, **result}, ensure_ascii=False))
        return 0
    except (ValueError, OSError, KeyError, TypeError, IndexError, AttributeError, RecursionError, UnicodeError, SyntaxError, csv.Error, pickle.UnpicklingError, zlib.error, ImportError, EOFError) as error:
        print(json.dumps({'ok': False, 'command': args.command, 'error': str(error)}, ensure_ascii=False)); return 2


if __name__ == '__main__':
    sys.exit(main())
