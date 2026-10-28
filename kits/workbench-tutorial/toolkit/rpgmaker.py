"""AI-oriented RPG Maker localization starter. Python 3.10+, standard library."""
import argparse
import collections
import copy
import hashlib
import json
import os
import re
import sys
from pathlib import Path

from rgss_archive import destination, unpack
from ruby_marshal import Reader, RObject, RString, structure

VERSION = '0.2.0'
TOKEN = re.compile(r'\{\{(?:CTRL|LINE)\d{4}\}\}')
# The final alternatives preserve source controls and a backslash at a physical line boundary.
CONTROL = re.compile(r'\\(?:[A-Za-z]+(?:\[(?:[^\[\]\r\n]|\[[^\]\r\n]*\])*\]|<[^>\r\n]*>)?|[^\r\n])|%[-+0-9.]*[dsf]|%[1-9]\d*|\r\n|[\x00-\x1f]|\\')
FIELDS = {'Actors': ('name', 'nickname', 'profile', 'description'), 'Classes': ('name',),
          'Skills': ('name', 'description', 'message1', 'message2'), 'Items': ('name', 'description'),
          'Weapons': ('name', 'description'), 'Armors': ('name', 'description'),
          'Enemies': ('name',), 'States': ('name', 'message1', 'message2', 'message3', 'message4')}


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result: raise ValueError('Duplicate JSON key: ' + key)
        result[key] = value
    return result


def parse_json(raw):
    return json.loads(raw.decode('utf-8-sig'), object_pairs_hook=unique_keys,
                      parse_constant=lambda x: (_ for _ in ()).throw(ValueError('Invalid JSON number: ' + x)))


def read(path):
    return parse_json(Path(path).read_bytes())


def serialized(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode('utf-8')


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as stream: stream.write(serialized(value))


def fresh(path, protected=()):
    path = Path(path).resolve()
    if path.exists(): raise ValueError('Output already exists: ' + path.name)
    for root in protected:
        if path.is_relative_to(Path(root).resolve()):
            raise ValueError('Output must be outside source/work directories')
    return path


def protect(parts):
    controls, tokens, result = {}, [], []
    def replace(match):
        token = '{{CTRL%04d}}' % (len(controls) + 1)
        controls[token] = match[0]
        tokens.append(token)
        return token
    for i, part in enumerate(parts):
        if i:
            token = '{{LINE%04d}}' % i
            result.append(token)
            tokens.append(token)
        result.append(CONTROL.sub(replace, part))
    value = ''.join(result)
    if TOKEN.findall(value) != tokens or '{{' in TOKEN.sub('', value) or '}}' in TOKEN.sub('', value):
        raise ValueError('Source contains reserved placeholder syntax')
    return value, controls, tokens


def restore(text, unit):
    if not isinstance(text, str) or not text.strip(): raise ValueError('Empty/non-string translation: ' + unit['id'])
    if TOKEN.findall(text) != unit['tokens']: raise ValueError('Changed placeholder count/order: ' + unit['id'])
    plain = TOKEN.sub('', text)
    if '{{' in plain or '}}' in plain or CONTROL.search(plain) or any(ord(c) < 32 for c in plain):
        raise ValueError('Raw control/newline or malformed placeholder: ' + unit['id'])
    if unit.get('syntax'):
        from text_formats import check_plain
        check_plain(plain, unit['syntax'])
    parts = re.split(r'\{\{LINE\d{4}\}\}', text)
    return [TOKEN.sub(lambda m: unit['controls'][m[0]], part) for part in parts]


def probe(game):
    game = Path(game).resolve()
    if not game.is_dir(): raise ValueError('Game directory does not exist')
    candidates = []
    for root in (game, game / 'www'):
        for engine, core in (('MV', 'rpg_core.js'), ('MZ', 'rmmz_core.js')):
            if (root / 'js' / core).is_file() and (root / 'data' / 'System.json').is_file():
                text = (root / 'js' / core).read_text(encoding='utf-8-sig')
                match = re.search(r'RPGMAKER_VERSION\s*=\s*[\'"]([^\'"]+)', text)
                candidates.append({'engine': engine, 'root': root.relative_to(game).as_posix(),
                                   'version': match[1] if match else 'unknown', 'support': 'standard_text_roundtrip',
                                   'data_dir': 'data', 'extension': '.json'})
        for engine, ext in (('VX Ace', '.rvdata2'), ('VX', '.rvdata'), ('XP', '.rxdata')):
            if (root / 'Data' / ('System' + ext)).is_file():
                with (root / 'Data' / ('System' + ext)).open('rb') as stream:
                    marshal_header = stream.read(2) == b'\x04\x08'
                candidates.append({'engine': engine, 'root': root.relative_to(game).as_posix(), 'version': 'unknown',
                                   'support': 'standard_text_roundtrip' if engine == 'VX Ace' or marshal_header else 'detect_unpack_only',
                                   'data_dir': 'Data', 'extension': ext})
    archives = [p.name for p in sorted(game.iterdir()) if p.suffix.lower() in ('.rgssad', '.rgss2a', '.rgss3a')]
    if len(candidates) > 1: raise ValueError('Ambiguous engines; choose one concrete game root')
    if candidates:
        return {**candidates[0], 'archives': archives, 'tool_version': VERSION,
                'limits': ['custom_plugins_scripts_images_not_automatically_translated', 'runtime_acceptance_required']}
    if archives:
        return {'engine': 'packed_RGSS', 'root': '.', 'support': 'unpack_first', 'archives': archives,
                'tool_version': VERSION}
    return {'engine': 'unknown', 'root': '.', 'support': 'unsupported', 'archives': [], 'tool_version': VERSION}


def at(value, path):
    for key in path: value = value[key]
    return value


def put(value, path, text):
    at(value, path[:-1])[path[-1]] = text


def attr(value, key, default=None):
    return value.attrs.get('@' + key, default) if isinstance(value, RObject) else default


def extract(game, output, batch_size=120):
    info = probe(game)
    if info['support'] != 'standard_text_roundtrip':
        raise ValueError('Engine not ready for extraction: ' + info['support'] + '; run probe/unpack first')
    if not 1 <= batch_size <= 500: raise ValueError('batch-size must be 1..500')
    root = Path(game).resolve() / info['root']
    output = fresh(output, (Path(game),))
    ruby = info['engine'] in ('VX Ace', 'VX', 'XP')
    raw_files, docs, readers = {}, {}, {}
    for path in sorted((root / info['data_dir']).glob('*' + info['extension'])):
        rel, raw = path.relative_to(root).as_posix(), path.read_bytes()
        raw_files[rel] = raw
        if ruby:
            readers[rel] = Reader(raw)
            docs[rel] = readers[rel].root
        else:
            docs[rel] = parse_json(raw)
    rows, units, review, used, ownership = [], {}, [], {}, {}
    counts = collections.Counter()

    def add(file, targets, parts, kind, context):
        if not parts or not any(p.strip() for p in parts): return None
        key = (file, tuple(targets) if ruby else tuple(tuple(p) for p in targets))
        if key in used:
            units[used[key]]['contexts'].append(context)
            return used[key]
        for target in key[1]:
            if (file, target) in ownership: raise ValueError('Overlapping/shared text groups require game-specific handling')
        counts[Path(file).stem] += 1
        ident = Path(file).stem + ':%05d' % counts[Path(file).stem]
        source, controls, tokens = protect(parts)
        units[ident] = {'id': ident, 'file': file, 'targets': targets, 'source': source,
                        'controls': controls, 'tokens': tokens, 'kind': kind, 'contexts': [context]}
        rows.append({'id': ident, 'kind': kind, 'source': source, 'translation': source,
                     'source_preview': '\n'.join(parts), 'tokens': tokens, 'context': context, 'notes': ''})
        used[key] = ident
        for target in key[1]: ownership[(file, target)] = ident
        return ident

    def field(file, obj, key, path, kind, context):
        value = attr(obj, key) if ruby else obj.get(key)
        if isinstance(value, RString): return add(file, [value.index], [value.text()], kind, context)
        if isinstance(value, str): return add(file, [path + [key]], [value], kind, context)
        return None

    def add_values(file, values, paths, kind, context):
        if ruby:
            if not all(isinstance(v, RString) for v in values): raise ValueError('Expected Marshal text')
            return add(file, [v.index for v in values], [v.text() for v in values], kind, context)
        if not all(isinstance(v, str) for v in values): raise ValueError('Expected JSON text')
        return add(file, paths, values, kind, context)

    def get(obj, key, default=None):
        return attr(obj, key, default) if ruby else obj.get(key, default)

    def commands(file, entries, base, context):
        if not isinstance(entries, list): raise ValueError('Expected event command list')
        choices, branches, links, i = {}, {}, [], 0
        row_start, review_start = len(rows), len(review)
        location = {'file': file, **{key: context[key] for key in
                    ('map', 'event', 'page', 'common_event', 'troop', 'scene', 'label', 'node', 'object', 'record') if key in context}}
        block_ref = 'block-' + sha(json.dumps(location, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))[:24]
        while i < len(entries):
            cmd = entries[i]
            code, indent, params = get(cmd, 'code'), get(cmd, 'indent'), get(cmd, 'parameters', [])
            if not isinstance(params, list): raise ValueError('Expected command parameters')
            path = base + [i, 'parameters']
            ctx = {**context, 'command': i, 'code': code, 'indent': indent,
                   'storyBlockRef': block_ref,
                   'branch_path': [v for k, v in sorted(branches.items()) if k < indent]}
            if code == 101 or code == 105 and info['engine'] not in ('XP', 'VX'):
                linecode, j, values, paths = 401 if code == 101 else 405, i + 1, [], []
                if code == 101 and info['engine'] == 'XP':
                    # RGSS1 stores the first message line on command 101 itself.
                    if not params or not isinstance(params[0], RString):
                        raise ValueError('Expected XP first message line')
                    values.append(params[0])
                    paths.append(path + [0])
                while j < len(entries) and get(entries[j], 'code') == linecode and get(entries[j], 'indent') == indent:
                    values.append(get(entries[j], 'parameters')[0])
                    paths.append(base + [j, 'parameters', 0])
                    j += 1
                ctx['line_count'] = len(values)
                if code == 101:
                    ctx['face'] = '' if info['engine'] == 'XP' else ((params[0].text() if ruby and isinstance(params[0], RString) else params[0]) if params else '')
                    ctx['speaker'] = params[4] if not ruby and len(params) > 4 else 'unknown'
                    ctx['speaker_basis'] = 'explicit-name-field' if ctx['speaker'] != 'unknown' else 'unknown'
                    if not ruby and len(params) > 4 and isinstance(params[4], str) and params[4].strip():
                        add(file, [path + [4]], [params[4]], 'speaker_name', ctx)
                add_values(file, values, paths, 'dialogue' if code == 101 else 'scroll_text', ctx)
                i = j
                continue
            if code in (401, 405):
                raise ValueError('Orphan dialogue line; custom event layout needs adaptation')
            if code == 102:
                choices[indent] = []
                for index, value in enumerate(params[0]):
                    ident = add_values(file, [value], [path + [0, index]], 'choice', {**ctx, 'choice': index})
                    choices[indent].append((ident, value.text() if ruby else value))
            elif code == 402:
                index = params[0]
                if indent not in choices or not 0 <= index < len(choices[indent]): raise ValueError('Unmatched choice branch')
                ident, original = choices[indent][index]
                label = params[1].text() if ruby else params[1]
                branches[indent] = {'type': 'choice', 'index': index, 'label': original}
                target = params[1].index if ruby else path + [1]
                # The engine branches by index; a stale editor label remains its own annotation.
                if label != original:
                    review.append({'file': file, 'context': ctx, 'kind': 'choice_editor_label',
                                   'choice': index, 'editable': False})
                elif ident:
                    unit = units[ident]
                    if target not in unit['targets']: unit['targets'].append(target)
            elif code == 403:
                branches[indent] = {'type': 'choice_cancel'}
            elif code == 404:
                choices.pop(indent, None)
                branches.pop(indent, None)
            elif code == 111:
                branches[indent] = {'type': 'conditional', 'command': i, 'side': 'then'}
                links.append({'kind': 'conditional-branch', 'command': i, 'state': 'confirmed',
                              'target': {**context}, 'branch': 'then', 'condition': [p.text() if isinstance(p, RString) else p for p in params]})
            elif code == 411:
                branches[indent] = {'type': 'conditional', 'command': i, 'side': 'else'}
            elif code == 412:
                branches.pop(indent, None)
            elif code in (320, 324, 325):
                add_values(file, [params[1]], [path + [1]], 'actor_attribute',
                           {**ctx, 'actor_id': params[0], 'actor_attribute': {320: 'name', 324: 'nickname', 325: 'profile'}[code]})
            elif code == 117:
                target = params[0] if params and isinstance(params[0], int) else None
                links.append({'kind': 'common-event-call', 'command': i,
                              'state': 'confirmed' if target is not None else 'unknown',
                              'target': {'common_event': target} if target is not None else None})
            elif code == 201:
                direct = len(params) >= 4 and params[0] == 0 and isinstance(params[1], int)
                links.append({'kind': 'map-transfer', 'command': i, 'state': 'confirmed' if direct else 'unknown',
                              'target': {'map': 'Map%03d' % params[1]} if direct else None,
                              'coordinates': params[2:4] if direct else None})
            elif code in (355, 655, 356, 357, 108, 408):
                review.append({'file': file, 'context': ctx, 'kind': 'event_script_plugin_or_comment', 'editable': False})
            i += 1
        if links:
            # Relations belong to the complete position block, not to every line.
            links_hash = sha(json.dumps(links, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
            for row in rows[row_start:]: row['context']['storyLinksHash'] = links_hash
            for item in review[review_start:]: item['context']['storyLinksHash'] = links_hash
            if len(rows) > row_start:
                anchor = rows[row_start]
                previous = anchor['context']
                anchor['context'] = {**previous, 'storyLinks': links}
                native = units[anchor['id']]
                native['contexts'] = [anchor['context'] if item is previous else item for item in native['contexts']]
            elif len(review) > review_start:
                review[review_start]['context'] = {**review[review_start]['context'], 'storyLinks': links}

    for file, obj in docs.items():
        stem = Path(file).stem
        if stem in FIELDS:
            for index, record in enumerate(obj):
                if record is None: continue
                for key in FIELDS[stem]: field(file, record, key, [index], 'database_' + key,
                    {'record': index, 'field': key, **({'actor_id': index} if stem == 'Actors' else {})})
                if get(record, 'note'):
                    review.append({'file': file, 'record': index, 'kind': 'note_tags', 'editable': False})
        elif stem == 'System':
            for key in (('game_title', 'currency_unit') if ruby else ('gameTitle', 'currencyUnit')):
                field(file, obj, key, [], 'system_text', {'field': key})
            keys = ('elements', 'skill_types', 'weapon_types', 'armor_types') if ruby else ('elements', 'skillTypes', 'weaponTypes', 'armorTypes', 'equipTypes')
            for key in keys:
                for index, value in enumerate(get(obj, key, [])):
                    if value is None: continue
                    add_values(file, [value], [[key, index]], 'system_type', {'field': key, 'index': index})
            terms = get(obj, 'terms') or get(obj, 'words')
            items = terms.attrs.items() if ruby and isinstance(terms, RObject) else terms.items() if isinstance(terms, dict) else []
            for key, values in items:
                if isinstance(values, RString):
                    add_values(file, [values], [['terms', key]], 'system_term', {'field': key})
                    continue
                for index, value in (enumerate(values) if isinstance(values, list) else values.items() if isinstance(values, dict) else []):
                    if value is None: continue
                    add_values(file, [value], [['terms', key, index]], 'system_term', {'field': key, 'index': index})
            review.append({'file': file, 'kind': 'switch_variable_labels_and_custom_system_fields', 'editable': False})
        elif re.fullmatch(r'Map\d+', stem):
            field(file, obj, 'display_name' if ruby else 'displayName', [], 'map_display_name', {'map': stem})
            events = get(obj, 'events', {}) if ruby else obj.get('events', [])
            iterable = events.items() if isinstance(events, dict) else enumerate(events)
            for event_id, event in iterable:
                if event is None: continue
                for page_index, page in enumerate(get(event, 'pages', [])):
                    commands(file, get(page, 'list', []), ['events', event_id, 'pages', page_index, 'list'],
                             {'map': stem, 'event': event_id, 'page': page_index, 'x': get(event, 'x'), 'y': get(event, 'y')})
        elif stem in ('CommonEvents', 'Troops'):
            for index, event in enumerate(obj):
                if event is None: continue
                if stem == 'CommonEvents': commands(file, get(event, 'list', []), [index, 'list'], {'common_event': index})
                else:
                    for page_index, page in enumerate(get(event, 'pages', [])):
                        commands(file, get(page, 'list', []), [index, 'pages', page_index, 'list'], {'troop': index, 'page': page_index})
        elif stem == 'Scripts':
            review.append({'file': file, 'kind': 'ruby_scripts', 'editable': False, 'records': len(obj)})
        elif stem not in ('Animations', 'Tilesets', 'MapInfos'):
            review.append({'file': file, 'kind': 'unhandled_data_file', 'editable': False})
    for path in sorted((root / 'js').glob('*.js')):
        if path.name == 'plugins.js': review.append({'file': path.relative_to(root).as_posix(), 'kind': 'plugin_parameters', 'editable': False})
    plugins = root / 'js' / 'plugins'
    for path in sorted(plugins.glob('*.js')):
        review.append({'file': path.relative_to(root).as_posix(), 'kind': 'plugin_source', 'editable': False})
    image_paths = []
    for folder in ('img', 'Graphics'):
        for path in sorted((root / folder).rglob('*')):
            if path.is_file() and path.suffix.lower() in ('.png', '.png_', '.rpgmvp', '.jpg', '.webp', '.bmp'):
                image_paths.append({'file': path.relative_to(root).as_posix(), 'status': 'unreviewed_image'})
    if not rows: raise ValueError('No standard display text extracted')
    sheets = {}
    by_file = collections.defaultdict(list)
    for row in rows: by_file[units[row['id']]['file']].append(row)
    for file, file_rows in sorted(by_file.items()):
        for offset in range(0, len(file_rows), batch_size):
            name = Path(file).stem + '_%03d.json' % (offset // batch_size + 1)
            sheets[name] = {'schema': 'rpgmaker-ai-units-v1', 'units': file_rows[offset:offset + batch_size]}
    manifest = {'schema': 'rpgmaker-ai-work-v1', 'tool_version': VERSION, 'engine': info['engine'],
                'version': info['version'], 'game_root_hint': info['root'], 'backend': 'marshal' if ruby else 'json',
                'files': {f: {'sha256': sha(raw), 'bytes': len(raw)} for f, raw in raw_files.items()},
                'sheets': {name: sha(serialized(sheet)) for name, sheet in sheets.items()}, 'units': units}
    report = {'engine': info['engine'], 'files': len(raw_files), 'units': len(rows), 'sheets': len(sheets),
              'review_items': len(review), 'unreviewed_images': len(image_paths), 'translated': 0,
              'status': 'extracted_not_runtime_tested'}
    output.mkdir(parents=True)
    for file, raw in raw_files.items():
        dest = destination(output / 'baseline', file)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(raw)
    for name, sheet in sheets.items():
        write(output / 'editable' / name, sheet)
        write(output / 'technical' / 'row-baseline' / name, sheet)
    write(output / 'manifest.json', manifest)
    (output / 'technical' / 'manifest.sha256').write_text(sha(serialized(manifest)) + '\n', encoding='ascii')
    native_targets = {'format': 'pinhao-native-targets-1', 'manifestSha256': sha(serialized(manifest)),
                      'schema': manifest['schema'], 'files': manifest['files'],
                      'units': {ident: {key: unit[key] for key in ('id', 'file', 'source', 'controls', 'kind', 'targets')}
                                for ident, unit in units.items()}}
    write(output / 'technical' / 'native-targets.json', native_targets)
    (output / 'technical' / 'native-targets.sha256').write_text(sha(serialized(native_targets)) + '\n', encoding='ascii')
    write(output / 'review-required.json', review)
    write(output / 'image-inventory.json', image_paths)
    write(output / 'extraction-report.json', report)
    return report


def stat_stamp(path):
    """Cheap file identity; None means the file cannot be stat-ed."""
    try:
        info = os.stat(path)
    except OSError:
        return None
    return info.st_size, info.st_mtime_ns


# One worker command re-prepares the same workspace up to six times. The cache is
# cleared by reset_work_cache() at every command entry, so no result survives the
# command that produced it and a later edit is never hidden by stale metadata.
WORK_CACHE = {}


def reset_work_cache():
    WORK_CACHE.clear()


def _cached_work(work):
    entry = WORK_CACHE.get(str(work))
    if entry is None:
        return None
    if (entry['manifest_stamp'], entry['seal_stamp']) != (stat_stamp(entry['manifest_path']), stat_stamp(entry['seal_path'])):
        return None
    if any(stat_stamp(Path(path)) != value for path, value in entry['stamps'].items()):
        return None
    return entry


def _read_work(work):
    manifest_path, seal_path = work / 'manifest.json', work / 'technical' / 'manifest.sha256'
    manifest_raw = manifest_path.read_bytes()
    if sha(manifest_raw) != seal_path.read_text(encoding='ascii').strip():
        raise ValueError('Manifest changed; restore original work metadata')
    manifest = parse_json(manifest_raw)
    if manifest.get('schema') != 'rpgmaker-ai-work-v1': raise ValueError('Unsupported work schema')
    if manifest['backend'] not in ('json', 'marshal', 'spans'): raise ValueError('Unsupported backend')
    baseline_files, sheet_raw, stamps = {}, {}, {}
    for file, meta in manifest['files'].items():
        path = destination(work / 'baseline', file)
        raw = path.read_bytes()
        if sha(raw) != meta['sha256']:
            raise ValueError('Baseline resource changed: ' + file)
        baseline_files[file], stamps[str(path)] = raw, stat_stamp(path)
    for name, expected in manifest['sheets'].items():
        path = destination(work / 'technical' / 'row-baseline', name)
        raw = path.read_bytes()
        if sha(raw) != expected: raise ValueError('Baseline sheet changed: ' + name)
        sheet_raw[name], stamps[str(path)] = raw, stat_stamp(path)
    return {'work': str(work), 'manifest_path': manifest_path, 'seal_path': seal_path,
            'manifest_stamp': stat_stamp(manifest_path), 'seal_stamp': stat_stamp(seal_path),
            'manifest_sha256': sha(manifest_raw), 'manifest': manifest,
            'baseline_files': baseline_files, 'sheet_raw': sheet_raw, 'stamps': stamps,
            'baseline_stamps': {file: stamps[str(destination(work / 'baseline', file))]
                                for file in manifest['files']}}


def manifest_view(entry):
    """Share the parsed manifest, but never its mutable top-level containers."""
    manifest = entry['manifest']
    view = dict(manifest)
    for key in ('files', 'units', 'sheets'):
        if isinstance(view.get(key), dict):
            view[key] = dict(view[key])
    return view


def load_work(work, *, snapshot=None):
    work = Path(work)
    entry = _cached_work(work)
    if entry is None:
        entry = _read_work(work)
        reset_work_cache()
        WORK_CACHE[str(work)] = entry
    if snapshot is not None:
        snapshot.update(manifest_sha256=entry['manifest_sha256'],
                        baseline_files=dict(entry['baseline_files']),
                        baseline_stamps=dict(entry['baseline_stamps']))
    # Callers keep rows of the returned sheets as their own working copy
    # (lesson.import_text edits them in place), so every call re-parses them.
    originals = {name: parse_json(raw) for name, raw in entry['sheet_raw'].items()}
    return manifest_view(entry), originals


def verified_baseline(work, manifest):
    """Verified baseline bytes; re-read only when no validated copy is cached."""
    work = Path(work)
    entry = _cached_work(work)
    if entry is not None and entry['manifest']['files'] == manifest['files']:
        return dict(entry['baseline_files'])
    return {file: destination(work / 'baseline', file).read_bytes() for file in manifest['files']}


def validate(work, editable=None):
    work = Path(work)
    manifest, originals = load_work(work)
    return validate_sheets(manifest, originals, read_editable(work, manifest, editable))


def read_editable(work, manifest, editable=None):
    editable = Path(editable) if editable is not None else Path(work) / 'editable'
    if not editable.is_dir(): raise ValueError('Editable directory missing')
    if set(p.name for p in editable.iterdir()) != set(manifest['sheets']):
        raise ValueError('Missing/unexpected editable files')
    return {name: read(destination(editable, name)) for name in manifest['sheets']}


def validate_sheets(manifest, originals, incoming_sheets):
    if set(incoming_sheets) != set(originals): raise ValueError('Missing/unexpected editable files')
    values, changed = {}, 0
    for name, original in originals.items():
        incoming = incoming_sheets[name]
        if not isinstance(incoming, dict) or set(incoming) != set(original) or incoming.get('schema') != original['schema']:
            raise ValueError('Changed sheet schema: ' + name)
        rows = incoming['units']
        if not isinstance(rows, list) or len(rows) != len(original['units']): raise ValueError('Changed row count: ' + name)
        for old, row in zip(original['units'], rows):
            if not isinstance(row, dict) or set(row) != set(old): raise ValueError('Changed row fields')
            masked = copy.deepcopy(row)
            for key in ('translation', 'notes'):
                if not isinstance(row[key], str): raise ValueError('Expected text field: ' + key)
                masked[key] = old[key]
            if masked != old: raise ValueError('Changed ID/source/context/order: ' + old['id'])
            ident = row['id']
            if ident in values or ident not in manifest['units']: raise ValueError('Duplicate/unknown ID: ' + ident)
            values[ident] = restore(row['translation'], manifest['units'][ident])
            changed += row['translation'] != old['translation']
    if set(values) != set(manifest['units']): raise ValueError('Missing unit IDs')
    groups = {}
    for ident, unit in manifest['units'].items():
        if 'sync_group' not in unit: continue
        group = unit['sync_group']
        if group in groups and groups[group] != values[ident]: raise ValueError('Shared display fields must match: ' + group)
        groups[group] = values[ident]
    return manifest, values, {'units': len(values), 'changed': changed, 'status': 'validated_not_runtime_tested'}


def merge(work, patches, output):
    work = Path(work)
    manifest, originals = load_work(work)
    output = fresh(output, (work,))
    expected = sha((work / 'manifest.json').read_bytes())
    changes, notes = {}, {}
    for path in patches:
        patch = read(path)
        if not isinstance(patch, dict) or set(patch) != {'schema', 'baseline_sha256', 'changes'}:
            raise ValueError('Patch must contain schema/baseline_sha256/changes only')
        if patch['schema'] != 'rpgmaker-ai-patch-v1' or patch['baseline_sha256'] != expected:
            raise ValueError('Wrong patch schema/baseline')
        if not isinstance(patch['changes'], list): raise ValueError('changes must be an array')
        for row in patch['changes']:
            if not isinstance(row, dict) or not {'id', 'translation'} <= set(row) or set(row) - {'id', 'translation', 'notes'}:
                raise ValueError('Unexpected patch fields')
            ident = row['id']
            if not isinstance(ident, str) or ident not in manifest['units']: raise ValueError('Unknown patch ID')
            if ident in changes: raise ValueError('Repeated ID; no automatic winner: ' + ident)
            restore(row['translation'], manifest['units'][ident])
            if not isinstance(row.get('notes', ''), str): raise ValueError('notes must be text')
            changes[ident] = row['translation']
            if row.get('notes'): notes[ident] = row['notes']
    prepared = copy.deepcopy(originals)
    for sheet in prepared.values():
        for row in sheet['units']:
            if row['id'] in changes: row['translation'] = changes[row['id']]
    output.mkdir(parents=True)
    for name, sheet in prepared.items(): write(output / 'editable' / name, sheet)
    write(output / 'notes.json', notes)
    write(output / 'merge-report.json', {'patch_ids': len(changes), 'manifest_sha256': expected})
    _, _, report = validate(work, output / 'editable')
    return {**report, 'patch_ids': len(changes), 'notes': len(notes)}


def expected_files(work, manifest, values, *, baseline_files=None):
    if manifest['backend'] == 'spans':
        from text_formats import build_spans
        return build_spans(work, manifest, values, baseline_files=baseline_files)
    raw_files = (baseline_files if baseline_files is not None else verified_baseline(work, manifest))
    plans = collections.defaultdict(dict)
    for ident, unit in manifest['units'].items():
        parts = values[ident]
        if parts == restore(unit.get('initial_value', unit['source']), unit): continue
        targets = unit['targets']
        if unit['kind'] == 'choice': parts = parts * len(targets)
        if len(parts) != len(targets): raise ValueError('Changed physical line count: ' + ident)
        for target, text in zip(targets, parts):
            key = target if manifest['backend'] == 'marshal' else tuple(target)
            plan = plans[unit['file']]
            if key in plan and plan[key] != text: raise ValueError('Conflicting shared text target')
            plan[key] = text
    prepared = {}
    for file, raw in raw_files.items():
        if not plans[file]:
            prepared[file] = raw
        elif manifest['backend'] == 'json':
            doc = parse_json(raw)
            patched = copy.deepcopy(doc)
            for path, text in plans[file].items(): put(patched, path, text)
            encoded = serialized(patched)
            reloaded = parse_json(encoded)
            for path in plans[file]: put(reloaded, path, at(doc, path))
            if reloaded != doc: raise ValueError('Non-text structure changed: ' + file)
            prepared[file] = encoded
        else:
            reader = Reader(raw)
            patched = reader.patch(plans[file])
            replacement_bytes = {index: text.encode('utf-8') for index, text in plans[file].items()}
            if structure(Reader(patched).root) != structure(reader.root, replacement_bytes):
                raise ValueError('Marshal graph changed beyond allowed strings: ' + file)
            prepared[file] = patched
    return prepared


def link_or_write(destination_path, raw, source, *, reuse_source):
    """Materialize a built resource without re-sending bytes the baseline already holds."""
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    if reuse_source:
        try:
            os.link(source, destination_path)
            return 'linked'
        except OSError:
            pass  # Different volume or a filesystem without hard links.
    destination_path.write_bytes(raw)
    return 'written'


def build(work, editable, output, *, validated=None, snapshot=None, verify_output=False):
    # Supplied snapshots belong only to the current worker command, never a later verification.
    manifest, values, report = validated if validated is not None else validate(work, editable)
    work, output = Path(work), fresh(output, (Path(work), Path(editable)))
    baseline = (snapshot or {}).get('baseline_files') or {}
    stamps = (snapshot or {}).get('baseline_stamps') or {}
    prepared = expected_files(work, manifest, values, baseline_files=baseline or None)
    output.mkdir(parents=True)
    digests, counts = {}, {'files_written': 0, 'files_linked': 0, 'files_skipped': 0}
    for file, raw in prepared.items():
        known = (manifest['files'].get(file) or {}).get('sha256')
        # The baseline digest is already verified by load_work, so an unchanged
        # resource costs neither a re-hash here nor a copy below.
        unchanged = known is not None and (baseline.get(file) is raw or sha(raw) == known)
        digests[file] = known if unchanged else sha(raw)
        path, source = destination(output, file), destination(work / 'baseline', file)
        if path.is_file() and sha(path.read_bytes()) == digests[file]:
            counts['files_skipped'] += 1
            continue
        # A baseline edited after validation must never be linked into the build.
        reusable = unchanged and stamps.get(file) == stat_stamp(source)
        outcome = link_or_write(path, raw, source, reuse_source=reusable)
        counts['files_linked' if outcome == 'linked' else 'files_written'] += 1
    manifest_digest = snapshot['manifest_sha256'] if snapshot is not None else sha((work / 'manifest.json').read_bytes())
    report = {**report, 'files': len(prepared), 'manifest_sha256': manifest_digest,
              'status': 'built_structurally_verified_not_runtime_tested', **counts,
              'files_sha256': digests}
    write(output / 'build-report.json', report)
    if verify_output:
        verify_prepared(prepared, output)
    return report


def verify(work, editable, output):
    manifest, values, report = validate(work, editable)
    expected = expected_files(work, manifest, values)
    verify_prepared(expected, output)
    return {**report, 'files': len(expected), 'status': 'verified_not_runtime_tested'}


def verify_prepared(expected, output):
    output = Path(output)
    actual_paths = {p.relative_to(output).as_posix() for p in output.rglob('*') if p.is_file()}
    if actual_paths != set(expected) | {'build-report.json'}: raise ValueError('Unexpected/missing built files')
    for file, raw in expected.items():
        if destination(output, file).read_bytes() != raw: raise ValueError('Built file differs from validated plan: ' + file)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', action='version', version=VERSION)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('probe'); p.add_argument('--game', type=Path, required=True)
    p = sub.add_parser('unpack'); p.add_argument('--archive', type=Path, required=True); p.add_argument('--out', type=Path, required=True); p.add_argument('--all-resources', action='store_true')
    p = sub.add_parser('extract'); p.add_argument('--game', type=Path, required=True); p.add_argument('--out', type=Path, required=True); p.add_argument('--batch-size', type=int, default=120)
    for name in ('validate', 'merge', 'build', 'verify', 'roundtrip', 'patch-template'):
        p = sub.add_parser(name)
        p.add_argument('--work', type=Path, required=True)
        if name in ('validate', 'build', 'verify'): p.add_argument('--editable', type=Path)
        if name in ('merge', 'build', 'roundtrip', 'patch-template'): p.add_argument('--out', type=Path, required=True)
        if name == 'merge': p.add_argument('--patch', type=Path, nargs='+', required=True)
        if name == 'verify': p.add_argument('--build', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == 'probe': result = probe(args.game)
        elif args.command == 'unpack': result = unpack(args.archive, args.out, args.all_resources)
        elif args.command == 'extract': result = extract(args.game, args.out, args.batch_size)
        elif args.command == 'validate': result = validate(args.work, args.editable)[2]
        elif args.command == 'merge': result = merge(args.work, args.patch, args.out)
        elif args.command == 'build': result = build(args.work, args.editable or args.work / 'editable', args.out)
        elif args.command == 'verify': result = verify(args.work, args.editable or args.work / 'editable', args.build)
        elif args.command == 'roundtrip':
            original = args.work / 'technical' / 'row-baseline'
            result = build(args.work, original, args.out)
            verify(args.work, original, args.out)
            if result['changed'] != 0: raise ValueError('Roundtrip baseline contains changes')
            result = {'files': result['files'], 'units': result['units'], 'status': 'nochange_byte_identical_not_runtime_tested'}
        elif args.command == 'patch-template':
            load_work(args.work)
            output = fresh(args.out, (args.work,))
            write(output, {'schema': 'rpgmaker-ai-patch-v1', 'baseline_sha256': sha((args.work / 'manifest.json').read_bytes()), 'changes': []})
            result = {'status': 'template_created', 'baseline_sha256': sha((args.work / 'manifest.json').read_bytes())}
        if 'files_sha256' in result:
            result = {key: value for key, value in result.items() if key != 'files_sha256'}
            result['hash_details'] = 'build-report.json'
        print(json.dumps({'ok': True, 'command': args.command, **result}, ensure_ascii=False))
        return 0
    except (ValueError, OSError, KeyError, TypeError, IndexError, AttributeError, RecursionError, UnicodeError) as error:
        print(json.dumps({'ok': False, 'command': args.command, 'error': str(error)}, ensure_ascii=False))
        return 2


if __name__ == '__main__':
    sys.exit(main())
