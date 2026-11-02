"""Read-only checks for known RPG resource references, not a mobile runtime proof."""
import json
from pathlib import PurePosixPath
import re

from native_attempt import filesystem_path
from rpgmaker_plugins import TOKENS


IMAGE_LOADERS = {
    'loadAnimation': 'animations', 'loadBattleback1': 'battlebacks1', 'loadBattleback2': 'battlebacks2',
    'loadEnemy': 'enemies', 'loadCharacter': 'characters', 'loadFace': 'faces', 'loadParallax': 'parallaxes',
    'loadPicture': 'pictures', 'loadSvActor': 'sv_actors', 'loadSvEnemy': 'sv_enemies',
    'loadSystem': 'system', 'loadTileset': 'tilesets', 'loadTitle1': 'titles1', 'loadTitle2': 'titles2',
}
AUDIO_SUFFIXES = {'.ogg': ('ogg', False), '.m4a': ('iso-bmff', False),
                  '.rpgmvo': ('ogg', True), '.rpgmvm': ('iso-bmff', True),
                  '.ogg_': ('ogg', True), '.m4a_': ('iso-bmff', True)}
ENCRYPTED_HEADER = bytes.fromhex('5250474d560000000003010000000000')
LOAD_CALL = re.compile(r'\b(ImageManager|AudioManager)\.([A-Za-z_$][\w$]*)\s*\(')
STRING = re.compile(r'''\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*(?=[,)])''')


def string_arg(text):
    match = STRING.match(text)
    if not match:
        return None
    token = match[1]
    try:
        value = json.loads(token) if token[0] == '"' else token[1:-1] if '\\' not in token else None
    except ValueError:
        return None
    return (value, match.end()) if isinstance(value, str) else None


def audio_header(path, suffix, key):
    expected, encrypted = AUDIO_SUFFIXES[suffix]
    with filesystem_path(path).open('rb') as stream:
        head = stream.read(80)
    reason = None
    if encrypted:
        if head[:16] != ENCRYPTED_HEADER or len(head) < 32:
            reason = 'encrypted-header-unrecognized'
        elif not isinstance(key, str) or not re.fullmatch(r'[0-9a-fA-F]{32}', key):
            reason = 'encryption-key-unavailable'
        else:
            secret = bytes.fromhex(key)
            head = bytes(value ^ secret[index] for index, value in enumerate(head[16:32])) + head[32:]
    container = 'unknown' if reason else 'ogg' if head.startswith(b'OggS') else 'iso-bmff' if head[4:8] == b'ftyp' else 'unknown'
    return {'expectedContainer': expected, 'container': container, 'encrypted': encrypted,
            'status': 'unverified' if container == 'unknown' else 'matched' if container == expected else 'mismatch',
            'reason': reason or ('container-unrecognized' if container == 'unknown' else None),
            'inspection': 'header-only', 'runtimeDecodeVerified': False}


def inspect(source, game_root, engine, source_entries, entries, plugin_manifest):
    source_files, packaged = dict(source_entries), set(dict(entries))
    prefix = game_root.relative_to(source).as_posix()
    prefix = '' if prefix == '.' else prefix + '/'
    folded = {}
    for name in source_files:
        folded.setdefault(name.casefold(), []).append(name)
    items, audio, checked = [], [], 0

    def issue(kind, file, **detail):
        items.append({'kind': kind, 'file': file, 'originalSourceAttribution': 'unknown', **detail})

    def document(relative):
        path = source_files.get(prefix + relative)
        if path is None:
            return None
        try:
            return json.loads(filesystem_path(path).read_text(encoding='utf-8-sig'))
        except (OSError, UnicodeError, ValueError):
            issue('data-json-unresolved', prefix + relative)
            return None

    system = document('data/System.json')
    system = system if isinstance(system, dict) else {}

    def dependency(file, pointer, folder, name, media='image', suffixes=None):
        nonlocal checked
        if not isinstance(name, str) or not name:
            return
        checked += 1
        if suffixes is None:
            encrypted = system.get('hasEncryptedAudio' if media == 'audio' else 'hasEncryptedImages') is True
            if media == 'audio':
                suffixes = (('.rpgmvo', '.rpgmvm') if engine == 'MV' else ('.ogg_', '.m4a_')) if encrypted else ('.ogg', '.m4a')
            else:
                suffixes = ('.rpgmvp' if engine == 'MV' else '.png_',) if encrypted else ('.png',)
        expected = [prefix + folder + '/' + name + ext for ext in suffixes]
        present = [candidate for candidate in expected if candidate in packaged]
        if present:
            return
        excluded = [candidate for candidate in expected if candidate in source_files]
        alternatives = sorted({actual for candidate in expected for actual in folded.get(candidate.casefold(), [])})
        kind = 'resource-excluded' if excluded else 'resource-case-mismatch' if alternatives else 'resource-missing-in-export-source'
        issue(kind, file, pointer=pointer, expected=expected, candidates=excluded or alternatives,
              exportSourceStatus='present' if excluded or alternatives else 'missing',
              ambiguousCaseMatch=len(alternatives) > 1,
              evidence='direct-call-text-candidate' if file.endswith('.js') else 'known-rpg-data-field',
              automaticRepair=False, repairReason='diagnostic-only; no renames, aliases, or guessed dynamic resources')

    def emit(file, parts, folder, name, media='image'):
        dependency(file, '/' + '/'.join(str(part).replace('~', '~0').replace('/', '~1') for part in parts), folder, name, media)

    actor_fields = {'characterName': 'characters', 'faceName': 'faces', 'battlerName': 'sv_actors'}
    map_fields = {'parallaxName': 'parallaxes', 'battleback1Name': 'battlebacks1', 'battleback2Name': 'battlebacks2'}
    command_images = {101: {0: 'faces'}, 231: {1: 'pictures'}, 283: {0: 'battlebacks1', 1: 'battlebacks2'},
                      284: {0: 'parallaxes'}, 322: {1: 'characters', 3: 'faces', 5: 'sv_actors'}, 323: {1: 'characters'}}
    command_audio = {241: 'bgm', 245: 'bgs', 249: 'me', 250: 'se'}

    def walk(file, profile, value, parts=()):
        if isinstance(value, dict):
            params, code = value.get('parameters'), value.get('code')
            if isinstance(params, list) and isinstance(code, int):
                for index, folder in command_images.get(code, {}).items():
                    if folder == 'sv_actors' and not system.get('optSideView'):
                        continue
                    if index < len(params):
                        emit(file, (*parts, 'parameters', index), 'img/' + folder, params[index])
                if code in command_audio and params and isinstance(params[0], dict):
                    emit(file, (*parts, 'parameters', 0, 'name'), 'audio/' + command_audio[code], params[0].get('name'), 'audio')
            for key, child in value.items():
                location = (*parts, key)
                folder = None
                if profile == 'Actors' and len(location) == 2:
                    folder = actor_fields.get(key)
                    if folder == 'sv_actors' and not system.get('optSideView'):
                        folder = None
                elif profile == 'Enemies' and len(location) == 2 and key == 'battlerName':
                    folder = 'sv_enemies' if system.get('optSideView') else 'enemies'
                elif profile == 'Animations' and len(location) == 2:
                    folder = {'animation1Name': 'animations', 'animation2Name': 'animations'}.get(key)
                elif profile == 'System':
                    folder = {'title1Name': 'titles1', 'title2Name': 'titles2', **map_fields}.get(key) if len(location) == 1 else (
                        'characters' if len(location) == 2 and location[0] in ('boat', 'ship', 'airship') and key == 'characterName' else None)
                    if key == 'name' and (parts in (('titleBgm',), ('battleBgm',), ('victoryMe',), ('defeatMe',))
                            or len(parts) == 2 and (parts[0] == 'sounds' or parts[0] in ('boat', 'ship', 'airship') and parts[1] == 'bgm')):
                        audio_folder = 'se' if parts[0] == 'sounds' else 'me' if parts[0] in ('victoryMe', 'defeatMe') else 'bgm'
                        emit(file, location, 'audio/' + audio_folder, child, 'audio')
                elif profile == 'Map':
                    folder = map_fields.get(key) if len(location) == 1 else None
                    if key in ('battleback1Name', 'battleback2Name') and not value.get('specifyBattleback'):
                        folder = None
                    if len(location) == 6 and location[0] == 'events' and location[2] == 'pages' and location[4:] == ('image', 'characterName'):
                        folder = 'characters'
                    if len(location) == 2 and location[0] in ('bgm', 'bgs') and key == 'name':
                        emit(file, location, 'audio/' + location[0], child, 'audio')
                if folder:
                    emit(file, location, 'img/' + folder, child)
                if profile == 'Tilesets' and key == 'tilesetNames' and len(location) == 2 and isinstance(child, list):
                    for index, name in enumerate(child):
                        emit(file, (*location, index), 'img/tilesets', name)
                walk(file, profile, child, location)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                walk(file, profile, child, (*parts, index))

    for file in sorted(source_files):
        local = file[len(prefix):] if file.startswith(prefix) else ''
        match = re.fullmatch(r'data/(Actors|Enemies|Tilesets|Animations|System|CommonEvents|Troops|Map\d+)\.json', local)
        if match:
            value = system if match[1] == 'System' else document(local)
            walk(file, 'Map' if match[1].startswith('Map') else match[1], value)

    for detail in plugin_manifest['unresolved']:
        issue('plugin-manifest-unresolved', prefix + 'js/plugins.js', detail=detail)
    for row in plugin_manifest['plugins']:
        if row.get('status') is not True or not isinstance(row.get('name'), str):
            continue
        name = row['name']
        file = prefix + 'js/plugins/' + name + '.js'
        dependency(prefix + 'js/plugins.js', 'enabled:' + name, 'js/plugins', name, suffixes=('.js',))
        if file not in source_files:
            continue
        text = filesystem_path(source_files[file]).read_text(encoding='utf-8-sig', errors='replace')
        # Reuse manifest token boundaries only to exclude obvious comments/strings, not as a JS parser.
        tokens, token_index = list(TOKENS.finditer(text)), 0
        for call in LOAD_CALL.finditer(text):
            while token_index < len(tokens) and tokens[token_index].end() <= call.start():
                token_index += 1
            token = tokens[token_index] if token_index < len(tokens) else None
            if token is not None and token.start() <= call.start() < token.end():
                if token.group().startswith('`'):
                    issue('dynamic-resource-unresolved', file, pointer='line:' + str(text.count('\n', 0, call.start()) + 1),
                          call='template-resource-expression')
                continue
            owner, method = call.groups()
            if owner == 'AudioManager' and method not in ('createBuffer', 'playBgm', 'playBgs', 'playMe', 'playSe', 'loadStaticSe', 'playStaticSe'):
                continue
            if owner == 'ImageManager' and not method.startswith('load'):
                continue
            location = 'line:' + str(text.count('\n', 0, call.start()) + 1)
            argument = string_arg(text[call.end():])
            if owner == 'ImageManager' and method in IMAGE_LOADERS and argument:
                dependency(file, location, 'img/' + IMAGE_LOADERS[method], argument[0])
            elif owner == 'AudioManager' and method == 'createBuffer' and argument and argument[0] in ('bgm', 'bgs', 'me', 'se'):
                rest = text[call.end() + argument[1]:]
                second = string_arg(rest[1:]) if rest.startswith(',') else None
                if second:
                    dependency(file, location, 'audio/' + argument[0], second[0], 'audio')
                else:
                    issue('dynamic-resource-unresolved', file, pointer=location, call=owner + '.' + method)
            else:
                issue('dynamic-resource-unresolved', file, pointer=location, call=owner + '.' + method)

    for file in sorted(packaged):
        local = file[len(prefix):] if file.startswith(prefix) else ''
        suffix = PurePosixPath(local).suffix.lower()
        if local.startswith('audio/') and suffix in AUDIO_SUFFIXES:
            result = audio_header(source_files[file], suffix, system.get('encryptionKey'))
            audio.append({'file': file, **result})
            if result['status'] != 'matched':
                issue('audio-container-' + result['status'], file, **result)
    containers = {row['file']: row['container'] for row in audio if row['status'] == 'matched'}
    for row in audio if engine == 'MV' else []:
        if row['container'] == 'ogg' and row['status'] == 'matched':
            suffix = PurePosixPath(row['file']).suffix.lower()
            alternate = row['file'][:-len(suffix)] + ('.rpgmvm' if row['encrypted'] else '.m4a')
            if containers.get(alternate) != 'iso-bmff':
                issue('mobile-audio-selection-unverified', row['file'], expectedMobileVariant=alternate,
                      detail='No matching M4A header for this OGG track. Stock MV may select M4A; plugin/JoiPlay selection and decoding require device evidence.',
                      automaticRepair=False, repairReason='No forced codec, fabricated M4A, or unverified runtime patch')
    return {'scope': 'known-database-fields-and-direct-plugin-load-calls', 'originAttribution': 'unknown',
            'sourceStage': 'assembled-export-source', 'referencesChecked': checked, 'audioInventory': audio,
            'reviewItems': items, 'automaticRepairs': [], 'phoneRuntimeVerified': False,
            'unverified': ['JavaScript aliases, regex literals and template execution', 'indirect/dynamically generated references',
                           'actual runtime audio selector and encryption overrides', 'runtime codec decoding', 'phone gameplay'],
            'warnings': [f'手机资源预检有 {len(items)} 项待核对；未自动修复，详见包内手机报告'] if items else []}
