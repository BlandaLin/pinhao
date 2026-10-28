"""Native source-file adapters; display spans keep scripts and resource identities intact."""
from __future__ import annotations

import ast
import json
import ast
from pathlib import Path
import re
import shutil
import tempfile
import zlib

import rpgmaker as core
import text_formats as formats
import rpa_archive
import asar_native
import kirikiri_native
import renpy_native
import pgmm_native
import nwjs_native
from native_attempt import NativeAttempt
from rgss_archive import destination

ENGINES = ('TyranoScript', 'KiriKiri/KAG', "Ren'Py", 'Godot', 'Pixel Game Maker MV')
READY = 'native_source_roundtrip'
LITERAL = re.compile(r'''(?P<quote>"""|''' + "'''" + r'''|"|')''')


def probe(game):
    for root in (game, game / 'www', game / 'resources' / 'app'):
        if (root / 'tyrano').is_dir() and (root / 'data' / 'scenario').is_dir() and any((root / 'data' / 'scenario').rglob('*.ks')):
            return {'engine': 'TyranoScript', 'root': root.relative_to(game).as_posix(), 'support': READY}
    archive = game / 'resources' / 'app.asar'
    if archive.is_file():
        entries = asar_native.index(archive)
        if any(name.startswith('tyrano/') for name, *_ in entries) and any(name.startswith('data/scenario/') and name.endswith('.ks') for name, *_ in entries):
            return {'engine': 'TyranoScript', 'root': 'resources/app', 'support': READY,
                    'archives': ['resources/app.asar'], 'packed': True, 'archiveFormat': 'asar'}
    nwjs = nwjs_native.probe(game)
    if nwjs:
        return nwjs
    kag = kirikiri_native.probe(game)
    if kag:
        return kag
    scenario = list(game.glob('*.ks')) + list((game / 'scenario').glob('*.ks')) + list((game / 'data' / 'scenario').glob('*.ks'))
    if scenario:
        return {'engine': 'KiriKiri/KAG', 'root': '.', 'support': READY}
    script_root = game / 'game'
    if script_root.is_dir() and ((game / 'renpy').is_dir() or any(script_root.rglob('*.rpy'))
                                or any(script_root.glob('*.rpa')) or any(script_root.rglob('*.rpyc'))):
        archives = sorted(path.relative_to(game).as_posix() for path in script_root.glob('*.rpa'))
        has_source = any(script_root.rglob('*.rpy'))
        if not has_source:
            has_source = any(name.endswith('.rpy') and not name.startswith('tl/')
                             for archive in archives for name, _ in rpa_archive.read_index(game / archive))
        compiled = list(script_root.rglob('*.rpyc'))
        compiled_supported = False
        for path in compiled:
            try:
                renpy_native.inspect_rpyc(path)
                compiled_supported = True
                break
            except (ValueError, zlib.error):
                pass
        archive_scripts = any(name.endswith(('.rpy', '.rpyc')) and not name.startswith('tl/')
                              for archive in archives for name, _ in rpa_archive.read_index(game / archive))
        return {'engine': "Ren'Py", 'root': '.', 'support': READY if has_source or compiled_supported or archive_scripts else 'rpyc_custom_codec_required',
                'archives': archives, 'packed': bool(archives or any(not p.with_suffix('.rpy').is_file() for p in compiled))}
    if (game / 'project.godot').is_file():
        return {'engine': 'Godot', 'root': '.', 'support': READY, 'sourceOnly': True}
    if any(game.glob('*.pck')) or any(game.glob('*.exe')) and (game / '.godot').is_dir():
        return {'engine': 'Godot', 'root': '.', 'support': 'godot_pack_codec_required'}
    return pgmm_native.probe(game)


def quoted(text, start):
    match = LITERAL.match(text, start)
    if not match:
        return None
    quote = match['quote']
    cursor = match.end()
    while cursor < len(text):
        if text[cursor] == '\\':
            cursor += 2
        elif text.startswith(quote, cursor):
            literal = text[start:cursor + len(quote)]
            # Ren'Py allows physical newlines inside ordinary quoted strings.
            normalized = re.sub(r'[ \t]*\r?\n[ \t]*', ' ', literal)
            try:
                value = ast.literal_eval(normalized)
            except (SyntaxError, ValueError):
                return None
            return value, cursor + len(quote)
        else:
            cursor += 1
    return None


def renpy_entries(text, collector, file):
    blocked = None
    ui_block = None
    label = ''
    consumed = 0
    for match in re.finditer(r'[^\n]*\n|[^\n]+$', text):
        if match.start() < consumed:
            continue
        raw = match[0]
        stripped = raw.lstrip(' ')
        indent = len(raw) - len(stripped)
        if not stripped.strip() or stripped.startswith('#'):
            continue
        if ui_block is not None and indent <= ui_block:
            ui_block = None
        if blocked is not None:
            if indent > blocked:
                continue
            blocked = None
        if re.match(r'(?:(?:init\s+(?:-?\d+\s+)?)?python(?:\s+\w+)*|translate\s+\w+\s+\w+)\s*:', stripped):
            blocked = indent
            collector.review.append({'file': file, 'line': text.count('\n', 0, match.start()) + 1,
                                     'kind': 'python_or_existing_translation_block'})
            continue
        if re.match(r'(?:image|transform|show|scene|camera)\b[^\n]*:\s*(?:#.*)?$', stripped):
            # ATL children contain animation/resource values, not narrator text.
            blocked = indent
            if not re.match(r'show\s+text\s+', stripped):
                continue
        new_label = re.match(r'label\s+([\w.]+)', stripped)
        if new_label:
            label = new_label[1]
        if re.match(r'(?:screen|style)\s+[^\n]+:', stripped):
            ui_block = indent
        if stripped.startswith('$'):
            statement = stripped[1:].lstrip()
            try:
                syntax = ast.parse(statement)
                call = syntax.body[0].value if len(syntax.body) == 1 and isinstance(syntax.body[0], ast.Expr) else None
            except SyntaxError:
                call = None
            if isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Name) and call.func.value.id == 'renpy':
                index = 1 if call.func.attr == 'say' else 0 if call.func.attr == 'notify' else None
                argument = call.args[index] if index is not None and len(call.args) > index else None
                if isinstance(argument, ast.Constant) and isinstance(argument.value, str) and argument.lineno == 1:
                    column = len(statement.encode('utf-8')[:argument.col_offset].decode('utf-8'))
                    offset = match.start() + indent + 1 + len(stripped[1:]) - len(statement) + column
                    value = quoted(text, offset)
                    if value is not None and value[0] == argument.value:
                        collector.add(file, formats.span(offset, value[1], 'quoted'), value[0],
                                      'dialogue' if call.func.attr == 'say' else 'ui_text',
                                      {'label': label, 'line': text.count('\n', 0, match.start()) + 1,
                                       'call': 'renpy.' + call.func.attr}, 'renpy')
                        consumed = value[1]
            continue
        if stripped.startswith('#'):
            continue
        context = {'label': label, 'line': text.count('\n', 0, match.start()) + 1}
        prefix = re.match(r'(?:(?:define|default)\s+)?[\w.]+\s*=\s*(?:Character|DynamicCharacter)\s*\(\s*(?:_\(\s*)?', stripped)
        title = re.match(r'define\s+(?:config\.name|gui\.about)\s*=\s*(?:_\(\s*)?', stripped)
        display = re.match(r'(?:show\s+text|text|textbutton|label)\s+(?:_\(\s*)?', stripped)
        if prefix or title or display:
            offset = match.start() + indent + (prefix or title or display).end()
            kind = 'speaker_name' if prefix else 'game_title' if title else 'ui_text'
            speaker = None
        else:
            if ui_block is not None:
                continue
            say = re.match(r'(?:(?P<speaker>[A-Za-z_]\w*)(?:\s+[A-Za-z_]\w*|\s+@\s*[A-Za-z_]\w*)*\s+)?(?=["\x27])', stripped)
            if not say:
                continue
            speaker = say['speaker']
            if speaker in {'image', 'scene', 'show', 'hide', 'play', 'queue', 'voice', 'jump', 'call', 'return', 'old', 'new', 'style', 'default', 'define', 'font', 'add', 'use', 'include'}:
                continue
            offset = match.start() + indent + say.end()
            kind = 'dialogue'
        value = quoted(text, offset)
        if value is None:
            collector.review.append({**context, 'file': file, 'kind': 'unsupported_source_statement'})
            continue
        source, end = value
        if kind == 'dialogue':
            tail = text[end:text.find('\n', end) if '\n' in text[end:] else len(text)].split('#', 1)[0].strip()
            if tail.startswith(':') or tail.startswith('if ') and tail.endswith(':'):
                kind = 'choice'
            elif not re.fullmatch(r'(?:(?:with\s+\w+|nointeract|interact|id\s+[A-Za-z_]\w*)\s*)*', tail):
                collector.review.append({**context, 'file': file, 'kind': 'unsupported_say_suffix'})
                continue
        context['speaker'] = speaker or 'narrator'
        collector.add(file, formats.span(offset, end, 'quoted'), source, kind, context, 'renpy')
        consumed = end


def godot_entries(text, collector, file):
    node = ''
    for match in re.finditer(r'[^\n]*\n|[^\n]+$', text):
        raw = match[0]
        if raw.startswith('[node '):
            node = raw.strip()
        display = re.match(r'\s*(text|title|placeholder_text|tooltip_text|dialog_text|item_\d+/text|tab_\d+/title)\s*=\s*', raw)
        if not display:
            continue
        offset = match.start() + display.end()
        value = quoted(text, offset)
        if value is None:
            collector.review.append({'file': file, 'line': text.count('\n', 0, offset) + 1, 'kind': 'nonliteral_display_property'})
            continue
        source, end = value
        collector.add(file, formats.span(offset, end, 'quoted'), source, 'ui_text',
                      {'node': node, 'property': display[1], 'line': text.count('\n', 0, offset) + 1}, 'renpy')


def prepare_archives(game, source, info, helpers, attempt=None, cache_dir=None):
    if info.get('archiveFormat') == 'nwjs-zip':
        return nwjs_native.unpack(game, source, info, helpers)
    if info.get('archiveFormat') == 'pgmm-enc':
        return pgmm_native.prepare(game, source, info, helpers)
    if info.get('archiveFormat') == 'xp3':
        return kirikiri_native.prepare(game, source, info, helpers)
    if info.get('archiveFormat') == 'asar':
        return asar_native.prepare(game, source, info, helpers)
    return renpy_native.merge_archives(game, source, info, helpers, attempt, cache_dir)


def extract(game, work, info, helpers, args):
    if info['engine'] != "Ren'Py":
        return _extract(game, work, info, helpers, args)
    attempt = NativeAttempt(work, info['engine'], helpers, {'name': 'unrpyc', 'commit': renpy_native.UPSTREAM_COMMIT})
    cache_dir = helpers.clean_path(Path(args.get('nativeRecoveryCacheDir') or work.parent / 'native-recovery-cache'))
    try:
        result = _extract(game, work, info, helpers, args, attempt, cache_dir)
        return {**result, 'nativeAttempt': attempt.finish('complete')}
    except Exception as error:
        attempt.fail(error, 'recover_sources')
        raise


def _extract(game, work, info, helpers, args, attempt=None, cache_dir=None):
    source = game
    archive_layouts = None
    if info.get('packed'):
        source = helpers.fresh(work.parent / (work.name + '-native-source'), (game, work))
        archive_layouts = prepare_archives(game, source, info, helpers, attempt, cache_dir)
    recovery = renpy_native.recover_sources(source, attempt, cache_dir) if info['engine'] == "Ren'Py" and source != game else None
    root = source / info.get('root', '.')
    collector = formats.Collector(root, info['engine'], 'json' if info['engine'] == 'Pixel Game Maker MV' else 'spans', int(args.get('batchSize', 120)))
    if info.get('archiveFormat') == 'xp3':
        for layout in archive_layouts:
            for name in layout.get('opaqueMembers', []):
                collector.review.append({'file': layout['file'], 'member': name,
                                         'kind': 'archive_operating_system_metadata' if Path(name).name.casefold() in kirikiri_native.ARCHIVE_METADATA else 'archive_member_not_filesystem_representable',
                                         'disposition': 'preserved-original-bytes'})
    if info['engine'] in ('TyranoScript', 'KiriKiri/KAG'):
        scenario = root / 'data' / 'scenario' if (root / 'data' / 'scenario').is_dir() else root
        for path in sorted(scenario.rglob('*.ks')):
            if helpers.excluded(path.relative_to(root).as_posix()):
                continue
            encoding = args.get('sourceEncoding')
            if not encoding:
                try:
                    formats.decode_source(path.read_bytes())
                except UnicodeDecodeError:
                    encoding = 'cp932'
            file, text = collector.document(path, encoding)
            if info['engine'] == 'KiriKiri/KAG':
                collector.meta[file].update(target_encoding='utf-16-le', target_bom='fffe')
            elif encoding == 'cp932':
                collector.meta[file].update(target_encoding='utf-8', target_bom='')
            formats.ks_entries(text, collector, file, speaker_names=False)
    elif info['engine'] == "Ren'Py":
        scripts = sorted((root / 'game').rglob('*.rpy'))
        for path in scripts:
            file = path.relative_to(root).as_posix()
            if helpers.excluded(file) or '/tl/' in file or '/cache/' in file:
                continue
            file, text = collector.document(path)
            renpy_entries(text, collector, file)
            renpy_native.collect_extra_entries(text, collector, file)
        for path in sorted((root / 'game').rglob('*.rpyc')):
            if not path.with_suffix('.rpy').is_file():
                collector.review.append({'file': path.relative_to(root).as_posix(), 'kind': 'compiled_script_requires_decompiler'})
    elif info['engine'] == 'Godot':
        for path in sorted([*root.rglob('*.tscn'), *root.rglob('*.tres')]):
            rel = path.relative_to(root).as_posix()
            if helpers.excluded(rel) or rel.startswith(('.godot/', '.import/')):
                continue
            file, text = collector.document(path)
            godot_entries(text, collector, file)
        collector.review.append({'kind': 'gdscript_dynamic_strings_and_packed_resources_require_recipe'})
    else:
        file, document = collector.document(root / 'project.json')
        formats.pgmm_entries(document, collector, file)
        if (root / 'info.json').is_file():
            file, document = collector.document(root / 'info.json')
            title = next((unit['source'] for unit in collector.units.values() if unit['kind'] == 'game_title'), '')
            if document.get('title', '') != title:
                raise ValueError('PGMM project/info titles differ; resolve before extraction')
            collector.add(file, ['title'], document.get('title', ''), 'game_title', {})
            for unit in collector.units.values():
                if unit['kind'] == 'game_title':
                    unit['sync_group'] = 'pgmm_game_title'
    if not collector.units and args.get('allowEmpty') is not True:
        raise helpers.WorkerError('NATIVE_TEXT_UNAVAILABLE', info['engine'] + ': no supported source display statements; inspect compiled resources')
    for row in collector.rows:
        if row['kind'] == 'display_attribute' and row['context'].get('attribute') == 'jname':
            row['kind'] = 'display_name'
            collector.units[row['id']]['kind'] = 'display_name'
    report = collector.finish(work, allow_empty=args.get('allowEmpty') is True)
    manifest, sheets = core.load_work(work)
    files = {str(Path(info.get('root', '.')) / file).replace('\\', '/'): meta['sha256'] for file, meta in manifest['files'].items()}
    if info.get('packed'):
        files = {rel: helpers.digest_file(game / rel) for rel in info['archives']}
        files.update({rel: helpers.digest_file(path) for rel, path in helpers.files_in(game) if rel.startswith('game/') and path.suffix.lower() in ('.rpy', '.rpyc')})
        if info.get('archiveFormat') == 'asar':
            files.update({rel: helpers.digest_file(path) for rel, path in helpers.files_in(game) if rel.startswith('resources/app.asar.unpacked/')})
        if info.get('archiveFormat') == 'xp3':
            files.update({rel: helpers.digest_file(path) for rel, path in helpers.files_in(game)
                          if path.suffix.lower() in ('.ks', '.tjs') and not helpers.excluded(rel)})
        if info.get('archiveFormat') == 'pgmm-enc':
            files = archive_layouts['sourceFiles']
    fingerprint = core.sha(core.serialized(files))
    metadata = {'schema': 'pinhao-native-source-v1', 'engine': info['engine'], 'root': info.get('root', '.'),
                'sourceFiles': files, 'sourceFingerprint': fingerprint, 'packed': bool(info.get('packed')),
                'nativeSource': str(source) if info.get('packed') else None, 'archives': info.get('archives', [])}
    if info.get('archiveFormat') == 'xp3':
        metadata.update(archiveFormat='xp3', archiveLayouts=archive_layouts)
    elif info.get('archiveFormat') == 'pgmm-enc':
        metadata.update(archiveFormat='pgmm-enc', archiveLayouts=archive_layouts)
    elif info.get('archiveFormat') == 'nwjs-zip':
        metadata.update(archiveFormat='nwjs-zip', archiveLayouts=archive_layouts)
    elif info.get('archiveFormat') == 'asar':
        metadata.update(archiveFormat='asar', archiveLayouts=archive_layouts)
    elif archive_layouts is not None:
        metadata['archiveLayouts'] = archive_layouts
    if recovery:
        metadata['scriptRecovery'] = recovery
    helpers.json_write(work / 'technical' / 'product-source.json', metadata)
    rows = [{**row, 'legacyId': row['id'], 'file': manifest['units'][row['id']]['file']} for sheet in sheets.values() for row in sheet['units']]
    images = [{'file': str(Path(info.get('root', '.') if info.get('packed') else '.') / rel).replace('\\', '/'), 'kind': 'image_candidate', 'writable': False}
              for rel, path in helpers.files_in(root) if path.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp') and not helpers.excluded(rel)]
    if info.get('archiveFormat') == 'asar':
        images = [{'file': str(Path(info['root']) / row['file']).replace('\\', '/'),
                   'kind': 'image_candidate', 'writable': False, 'archived': True}
                  for row in archive_layouts['members'] if Path(row['file']).suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp')
                  and not helpers.excluded(row['file'])]
    helpers.json_write(work / 'image-inventory.json', images)
    helpers.json_write(work / 'dynamic-candidates.json', [])
    return {**report, 'engine': info['engine'], 'workDir': str(work), 'workspaceDir': str(work),
            'manifestPath': str(work / 'manifest.json'), 'sourceFingerprint': fingerprint, 'units': rows,
            'reviewItems': collector.review, 'dynamicCandidates': [], 'images': images,
            'capabilities': helpers.capabilities(info['engine'])}


def install_font(game_root, engine, font, inventory, helpers):
    if not font:
        return
    family = helpers.font_family(font)
    if engine == 'KiriKiri/KAG':
        kirikiri_native.install_font(game_root, font, inventory, helpers)
        return
    elif engine == pgmm_native.ENGINE:
        pgmm_native.install_font(game_root, font, inventory, helpers)
        return
    elif engine == "Ren'Py":
        target = game_root / 'game' / 'pinhao-localization' / ('font' + font.suffix.lower())
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(font, target)
        font_name = target.relative_to(game_root / 'game').as_posix()
        value = json.dumps(font_name)
        script = ('init 999 python:\n'
                  '    style.default.font = ' + value + '\n'
                  '    if hasattr(renpy.store, "gui"):\n' +
                  ''.join('        ' + expression + ' = ' + value + '\n' for expression in
                          ('gui.text_font', 'gui.name_text_font', 'gui.interface_text_font')))
        (game_root / 'game' / 'zzpinhao_font.rpy').write_text(script, encoding='utf-8')
    elif engine == 'TyranoScript' and (game_root / 'index.html').is_file():
        target = game_root / 'data' / 'others' / ('PinHaoChinese' + font.suffix.lower())
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(font, target)
        css = ('@font-face{font-family:PinHaoChinese;src:url(' + json.dumps(target.name) + ')}\n'
               '.message_inner,.chara_name_area,.glink_button,.log_body{font-family:PinHaoChinese,serif!important}\n')
        (target.parent / 'pinhao-font.css').write_text(css, encoding='utf-8')
        html = (game_root / 'index.html').read_text(encoding='utf-8-sig')
        link = '<link rel="stylesheet" href="data/others/pinhao-font.css">'
        if re.search(r'</head\s*>', html, re.I):
            html = re.sub(r'</head\s*>', lambda match: link + '\n' + match[0], html, count=1, flags=re.I)
        else:
            html = link + '\n' + html
        (game_root / 'index.html').write_text(html, encoding='utf-8')
    else:
        inventory['warnings'].append(engine + ': font installation requires an engine-specific runtime recipe')
        return
    inventory['font'] = {'family': family, 'file': target.relative_to(game_root).as_posix(), 'sha256': helpers.digest_file(target)}
