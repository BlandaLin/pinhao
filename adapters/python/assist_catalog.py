"""Read-only RPG Maker event and script catalogue for play-assistance recipes."""
import hashlib
import json
from pathlib import Path
import re
import zlib

from ruby_marshal import Reader, RObject, RString
from rgss_archive import advance, archive_entries

ENGINES = {'MV': '.json', 'MZ': '.json', 'XP': '.rxdata', 'VX': '.rvdata', 'VX Ace': '.rvdata2'}
COMMANDS = {102, 108, 111, 112, 113, 115, 117, 118, 119, 121, 122, 123, 201, 231, 232, 235, 301,
            355, 356, 357, 402, 403, 404, 408, 411, 412, 413, 655}


def digest(value):
    return hashlib.sha256(value).hexdigest()


def text(value):
    if isinstance(value, RString):
        try:
            return value.text()
        except UnicodeError:
            return value.raw.decode('cp932', errors='replace')
    return value if isinstance(value, str) else ''


def field(value, name, default=None):
    if isinstance(value, RObject):
        snake = re.sub(r'(?<!^)(?=[A-Z])', '_', name).lower()
        return value.attrs.get('@' + snake, default)
    return value.get(name, default) if isinstance(value, dict) else default


def plain(value, depth=0):
    if depth > 12:
        return None
    if isinstance(value, RString):
        return text(value)
    if isinstance(value, list):
        return [plain(item, depth + 1) for item in value]
    if isinstance(value, dict):
        return {str(key): plain(item, depth + 1) for key, item in value.items()}
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return None


def commands(value):
    result = []
    for index, command in enumerate(value or []):
        code = field(command, 'code', 0)
        if code in COMMANDS:
            result.append({'index': index, 'code': code, 'indent': field(command, 'indent', 0),
                           'parameters': plain(field(command, 'parameters', []))})
    return result


def pages(event):
    result = []
    for index, page in enumerate(field(event, 'pages', []) or []):
        condition = field(page, 'conditions') or field(page, 'condition')
        conditions = {key: plain(field(condition, key, default)) for key, default in [
            ('switch1Valid', False), ('switch2Valid', False), ('variableValid', False),
            ('selfSwitchValid', False), ('itemValid', False), ('actorValid', False),
            ('switch1Id', 0), ('switch2Id', 0), ('variableId', 0), ('variableValue', 0),
            ('selfSwitchCh', 'A'), ('itemId', 0), ('actorId', 0)]}
        result.append({'index': index, 'conditions': conditions, 'trigger': field(page, 'trigger', 0),
                       'commands': commands(field(page, 'list', []))})
    return result


def normalized_script(raw):
    source = raw.decode('utf-8-sig', errors='replace')
    # Strip only the exact bootstraps installed by this product from the identity.
    pattern = r"\A(?:(?:load 'PinHao(?:Assist|Localization)\.rb'|eval\(File\.open\('PinHao(?:Assist|Localization)\.rb', 'rb'\) \{ \|file\| file\.read \}, TOPLEVEL_BINDING, 'PinHao(?:Assist|Localization)\.rb'\))\r?\n)+"
    return re.sub(pattern, '', source)


def archive_data(archive, extension):
    _, entries = archive_entries(archive)
    with archive.open('rb') as stream:
        for name, offset, size, key in entries:
            if not name.lower().startswith('data/') or Path(name).suffix.lower() != extension:
                continue
            stream.seek(offset)
            output = bytearray(stream.read(size))
            if len(output) != size:
                raise ValueError('Truncated RGSS data resource')
            for index in range(0, len(output), 4):
                for part in range(min(4, len(output) - index)):
                    output[index + part] ^= (key >> (part * 8)) & 255
                key = advance(key)
            yield name, bytes(output)


def scan(args, worker):
    game = worker.path_arg(args, 'gameDir')
    info = worker.native.probe(game)
    engine = info['engine']
    if engine == 'packed_RGSS':
        engine = args.get('engine')
    if engine not in ENGINES:
        raise worker.WorkerError('ASSIST_ENGINE', 'Event catalogue supports RPG Maker MV/MZ/XP/VX/VX Ace')
    if args.get('engine') and args['engine'] != engine:
        raise worker.WorkerError('WRONG_ENGINE', 'Game engine changed since the project was created')
    root = game / info.get('root', '.')
    extension = ENGINES[engine]
    ruby = engine not in ('MV', 'MZ')
    data = root / ('Data' if ruby else 'data')
    resources = {}
    if ruby:
        for archive in sorted(root.iterdir()):
            if archive.suffix.lower() in ('.rgssad', '.rgss2a', '.rgss3a'):
                worker.clean_path(archive)
                resources.update(archive_data(archive, extension))
    if data.is_dir():
        worker.clean_path(data)
        for source in sorted(data.glob('*' + extension)):
            worker.clean_path(source)
            resources[source.relative_to(root).as_posix()] = source.read_bytes()
    files, documents, scripts, issues = [], {}, [], []
    for relative, raw in sorted(resources.items()):
        stem = Path(relative).stem
        if stem not in ('System', 'MapInfos', 'CommonEvents', 'Scripts') and not re.fullmatch(r'Map\d+', stem):
            continue
        value = Reader(raw).root if ruby else worker.native.parse_json(raw)
        if stem == 'Scripts':
            normalized = []
            for index, row in enumerate(value):
                if not isinstance(row, list) or len(row) < 3 or not isinstance(row[2], RString):
                    continue
                try:
                    source = normalized_script(zlib.decompress(row[2].raw))
                except (zlib.error, UnicodeError):
                    issues.append({'code': 'SCRIPT_DECODE', 'file': relative, 'message': 'Script slot could not be decoded'})
                    continue
                normalized.append([plain(row[0]), text(row[1]), source])
                if len(source) <= 8 * 1024 * 1024:
                    scripts.append({'file': relative, 'location': 'scripts[' + str(index) + ']',
                                    'name': text(row[1]), 'source': source, 'sourceHash': digest(source.encode('utf-8'))})
            source_hash = digest(json.dumps(normalized, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
        else:
            source_hash = digest(raw)
            documents[stem] = value
        files.append({'file': relative, 'sha256': source_hash})
    if not ruby:
        plugins = root / 'js' / 'plugins'
        if plugins.is_dir():
            worker.clean_path(plugins)
            for source in sorted(plugins.glob('*.js')):
                if source.name.casefold().startswith('pinhao'):
                    continue
                worker.clean_path(source)
                raw = source.read_bytes()
                relative = source.relative_to(root).as_posix()
                if len(raw) > 8 * 1024 * 1024:
                    issues.append({'code': 'SCRIPT_SIZE', 'file': relative, 'message': 'Large plugin reserved for dedicated review'})
                    files.append({'file': relative, 'sha256': digest(raw)})
                    continue
                scripts.append({'file': relative, 'name': source.stem, 'location': '',
                                'source': raw.decode('utf-8-sig', errors='replace'), 'sourceHash': digest(raw)})
                files.append({'file': relative, 'sha256': digest(raw)})
        plugin_list = root / 'js' / 'plugins.js'
        if plugin_list.is_file():
            worker.clean_path(plugin_list)
            raw = plugin_list.read_bytes()
            scripts.append({'file': 'js/plugins.js', 'name': '$plugins', 'location': '',
                            'source': raw.decode('utf-8-sig', errors='replace'), 'sourceHash': digest(raw)})
    map_infos = documents.get('MapInfos') or {}
    maps = []
    for stem, value in documents.items():
        if not re.fullmatch(r'Map\d+', stem):
            continue
        ident = int(stem[3:])
        metadata = map_infos.get(ident) if isinstance(map_infos, dict) else (map_infos[ident] if ident < len(map_infos) else None)
        raw_events = field(value, 'events', {}) or {}
        events = raw_events.values() if isinstance(raw_events, dict) else raw_events
        maps.append({'id': ident, 'name': text(field(metadata, 'name')),
                     'displayName': text(field(value, 'displayName')), 'width': field(value, 'width', 0),
                     'height': field(value, 'height', 0), 'file': ('Data/' if ruby else 'data/') + stem + extension,
                     'events': [{'id': field(event, 'id', 0), 'name': text(field(event, 'name')),
                                 'x': field(event, 'x', 0), 'y': field(event, 'y', 0), 'pages': pages(event)}
                                for event in events if event]})
    common_events = []
    for value in documents.get('CommonEvents') or []:
        if value:
            common_events.append({'id': field(value, 'id', 0), 'name': text(field(value, 'name')),
                                  'trigger': field(value, 'trigger', 0), 'switchId': field(value, 'switchId', 0),
                                  'commands': commands(field(value, 'list', []))})
    system = documents.get('System')
    return {'engine': engine, 'maps': sorted(maps, key=lambda row: row['id']), 'commonEvents': common_events,
            'switches': [text(value) for value in field(system, 'switches', []) or []],
            'variables': [text(value) for value in field(system, 'variables', []) or []],
            'scripts': scripts, 'files': files, 'issues': issues}
