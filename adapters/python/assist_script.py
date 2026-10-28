"""Script-engine live variables using documented startup and property interfaces."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from assist_transaction import InstallTransaction
import zlib

import godot_native
import kirikiri_native
import pgmm_native
import text_formats
import xp3_archive

TEMPLATES = Path(__file__).parent / 'templates'
FAMILIES = ('TyranoScript', 'KiriKiri/KAG', 'Godot', pgmm_native.ENGINE)


def available(engine):
    names = {'TyranoScript': ('assist_script_common.js', 'assist_tyrano.js'),
             'KiriKiri/KAG': ('assist_script.tjs',), 'Godot': ('assist_script.gd',),
             pgmm_native.ENGINE: ('assist_script_common.js', 'assist_pgmm.js')}
    return engine in names and all((TEMPLATES / name).is_file() for name in names[engine]) and (engine != 'Godot' or godot_native.executable() is not None)


def tyrano_root(game):
    for root in (game, game / 'www', game / 'resources/app', game / 'Resources/app'):
        if (root / 'index.html').is_file() and (root / 'tyrano/plugins/kag/kag.js').is_file():
            return root
    return None


def kag_scripts(game):
    layers = []
    standard_patches = False
    for archive in sorted(kirikiri_native.archives(game), key=lambda path: (kirikiri_native.priority(path.name), path.name.casefold())):
        _, entries = xp3_archive.index(archive)
        scripts = {}
        for entry in entries:
            if Path(entry.name).name.casefold() not in ('initialize.tjs', 'afterinit2.tjs') or entry.size > 2 * 1024 * 1024:
                continue
            raw = b''
            with archive.open('rb') as stream:
                for method, offset, length, packed in entry.segments:
                    stream.seek(offset)
                    data = xp3_archive.exact(stream, packed)
                    raw += xp3_archive.inflate(data, length) if method else data
            if zlib.adler32(raw) & 0xffffffff != entry.checksum:
                raise ValueError('KAG initializer requires its extraction filter')
            try:
                text = text_formats.decode_source(raw)[0]
            except UnicodeError:
                text = raw.decode('cp932')
            scripts[entry.name.casefold()] = text
            normalized = re.sub(r'\s+', '', text)
            standard_patches |= 'for(vari=2;;i++)' in normalized and ('"patch"+i+".xp3"' in normalized or "'patch'+i+'.xp3'" in normalized)
        layers.append((archive.name, scripts))
    numbers = {int(match[1]) for name, _ in layers if (match := re.fullmatch(r'patch([2-9]|[1-9]\d+)\.xp3', name, re.I))}
    contiguous, number = set(), 2
    while number in numbers:
        contiguous.add(number)
        number += 1
    result, owners = {}, {}
    for name, scripts in layers:
        match = re.fullmatch(r'patch(\d+)\.xp3', name, re.I)
        if standard_patches and match and (str(int(match[1])) != match[1] or int(match[1]) not in contiguous):
            continue
        for relative, text in scripts.items():
            previous = owners.get(relative)
            if previous and previous[1] != text and kirikiri_native.priority(name) == kirikiri_native.priority(previous[0]):
                raise ValueError('Overlapping KAG startup resources need their loader order: ' + relative)
            result[relative] = text
            owners[relative] = (name, text)
    for root in (game / 'data', game):
        for relative in ('system/Initialize.tjs', 'Initialize.tjs', 'AfterInit2.tjs'):
            path = root / relative
            if path.is_file():
                result[relative.casefold()] = kirikiri_native.text_read(path)
    return result


def kag_loader(game):
    return any('AfterInit2.tjs' in text and 'KAGLoadScript' in text
               for name, text in kag_scripts(game).items() if name.endswith('initialize.tjs'))


def pgmm_project(game):
    info = pgmm_native.probe(game)
    if not info or info['support'] != pgmm_native.READY:
        return None
    root = game / info['root']
    raw = (root / 'project.json').read_bytes()
    encrypted = raw.startswith(b'enc')
    key = pgmm_native.resource_key(root) if encrypted else None
    document = json.loads(pgmm_native.decrypt_resource(raw, key).decode('utf-8-sig'))
    if not all(isinstance(document.get(name), list) for name in ('pluginList', 'variableList', 'switchList')):
        return None
    return root, document, key


def godot_info(game):
    info = godot_native.probe(game)
    if not info or info['support'] != godot_native.READY:
        return None
    if info.get('packed'):
        index = godot_native.pack_index(game / info['archives'][0])
        major = index['version'][0]
    else:
        config = game / 'project.godot'
        if not config.is_file():
            major = 2 if (game / 'engine.cfg').is_file() else 0
        else:
            major = 4 if 'config_version=5' in config.read_text(encoding='utf-8-sig') else 3
    return (info, major) if major in (2, 3, 4) else None


def capabilities(game, helpers=None):
    game = Path(game)
    engine = ''
    detail = '当前资源需要对应引擎的运行桥适配。'
    try:
        if tyrano_root(game):
            engine, detail = 'TyranoScript', 'f 游戏变量与 sf 系统变量实时读写。'
        elif pgmm_project(game):
            engine, detail = pgmm_native.ENGINE, '项目已定义的公共变量与开关实时读写。'
        elif godot_info(game):
            engine, detail = 'Godot', 'Godot 2/3/4 场景与自动加载节点的脚本属性实时读写。'
        elif kag_loader(game):
            engine, detail = 'KiriKiri/KAG', '标准 KAG3 f 游戏变量与 sf 系统变量实时读写。'
    except (OSError, ValueError, UnicodeError) as error:
        detail = str(error)
    supported = bool(engine and available(engine))
    return {'supported': supported, 'engine': engine, 'modes': ['live'] if supported else [], 'detail': detail}


def js_source(name):
    common = (TEMPLATES / 'assist_script_common.js').read_text(encoding='utf-8')
    return '(function(){\n' + common + '\n' + (TEMPLATES / name).read_text(encoding='utf-8') + '\n})()'


def godot_source(major):
    text = (TEMPLATES / 'assist_script.gd').read_text(encoding='utf-8')
    if major == 4:
        text = text.replace('.empty()', '.is_empty()').replace('TYPE_REAL', 'TYPE_FLOAT')
        text = text.replace('OS.get_unix_time()', 'Time.get_unix_time_from_system()').replace('OS.get_ticks_usec()', 'Time.get_ticks_usec()')
        replacements = {'__PINHAO_PAUSE_MODE__': 'process_mode = Node.PROCESS_MODE_ALWAYS', '__PINHAO_BYTE_ARRAY__': 'PackedByteArray',
                        '__PINHAO_READ_FILE__': 'FileAccess.get_file_as_string(directory.path_join("commands.txt"))',
                        '__PINHAO_WRITE_FILE__': 'var file = FileAccess.open(directory.path_join("state.json"), FileAccess.WRITE)\n\tif file:\n\t\tfile.store_string(JSON.stringify(payload))\n\t\tfile.close()'}
    else:
        replacements = {'__PINHAO_PAUSE_MODE__': 'pause_mode = Node.PAUSE_MODE_PROCESS', '__PINHAO_BYTE_ARRAY__': 'PoolByteArray',
                        '__PINHAO_READ_FILE__': 'read_file(directory.plus_file("commands.txt"))',
                        '__PINHAO_WRITE_FILE__': 'var file = File.new()\n\tif file.open(directory.plus_file("state.json"), File.WRITE) == OK:\n\t\tfile.store_string(to_json(payload))\n\t\tfile.close()'}
        text += '\nfunc read_file(path):\n\tvar file = File.new()\n\tif file.open(path, File.READ) != OK:\n\t\treturn ""\n\tvar value = file.get_as_text()\n\tfile.close()\n\treturn value\n'
    for key, value in replacements.items():
        text = text.replace(key, value)
    if major == 2:
        text = text.replace('PoolByteArray()', 'RawArray()').replace('node.name', 'node.get_name()').replace('child.name', 'child.get_name()')
        text = text.replace('to_json(payload)', 'payload.to_json()')
        text = text.replace('pause_mode = Node.PAUSE_MODE_PROCESS', 'set_pause_mode(Node.PAUSE_MODE_PROCESS)')
        text = text.replace('OS.get_ticks_usec()', 'OS.get_ticks_msec()').replace('get_instance_id()', 'get_instance_ID()')
        text = text.replace('get_tree().current_scene', 'get_tree().get_current_scene()')
        text = text.replace('get_node_or_null(row.store)', 'get_node(row.store) if has_node(row.store) else null')
        text = text.replace('params.get(', 'dict_value(params, ')
        text = text.replace('hex.is_valid_hex_number()', 'valid_hex(hex)')
        text = text.replace('char(raw[cursor])', 'RawArray([raw[cursor]]).get_string_from_ascii()')
        text += '\nfunc dict_value(value, key, fallback):\n\treturn value[key] if value.has(key) else fallback\n'
        text += '\nfunc valid_hex(value):\n\tif value.empty():\n\t\treturn false\n\tfor index in range(value.length()):\n\t\tif "0123456789abcdefABCDEF".find(value.substr(index, 1)) < 0:\n\t\t\treturn false\n\treturn true\n'
    return text


def install_godot(game, helpers, transaction):
    info, major = godot_info(game)
    pack = game / info['archives'][0] if info.get('packed') else None
    with tempfile.TemporaryDirectory(prefix='pinhao-assist-godot-', dir=game.parent) as temporary:
        temporary = Path(temporary)
        stage = temporary / 'stage'
        if pack:
            index = godot_native.unpack(pack, stage, helpers)
        else:
            stage = game
            index = None
        config_name = 'engine.cfg' if major == 2 else 'project.godot'
        config = stage / config_name
        if not config.is_file():
            recovered = temporary / 'recovered'
            godot_native.run(godot_native.executable(), ['--recover=' + str(pack), '--output=' + str(recovered)])
            config = recovered / config_name
        if not config.is_file():
            raise ValueError('Godot project configuration recovery failed')
        text = godot_native.config_setting(config.read_text(encoding='utf-8-sig'), 'autoload', 'PinHaoAssist', '"*res://.pinhao/assist.gd"')
        support = stage / '.pinhao'
        if pack:
            support.mkdir(exist_ok=True)
            (support / 'assist.gd').write_text(godot_source(major), encoding='utf-8')
            (stage / config_name).write_text(text, encoding='utf-8')
            (stage / ('engine.cfb' if major == 2 else 'project.binary')).unlink(missing_ok=True)
        else:
            transaction.write(support / 'assist.gd', godot_source(major).encode('utf-8'))
            transaction.write(stage / config_name, text.encode('utf-8'))
            transaction.remove(stage / ('engine.cfb' if major == 2 else 'project.binary'))
        if pack:
            rebuilt = temporary / 'assisted.pck'
            godot_native.run(godot_native.executable(), ['--pck-create=' + str(stage), '--output=' + str(rebuilt),
                             '--pck-version=' + str(index['format']), '--pck-engine-version=' + '.'.join(map(str, index['version']))])
            result = temporary / pack.name
            if info.get('embedded'):
                godot_native.embed_pack(pack, rebuilt, result)
            else:
                os.replace(rebuilt, result)
            actual = godot_native.pack_index(result, helpers.safe_member)
            expected = {rel: helpers.digest_file(path) for rel, path in helpers.files_in(stage)}
            if {entry['file'] for entry in actual['entries']} != set(expected):
                raise ValueError('Godot assist pack inventory differs')
            with result.open('rb') as stream:
                for entry in actual['entries']:
                    stream.seek(entry['offset'])
                    if hashlib.sha256(godot_native.exact(stream, entry['bytes'])).hexdigest() != expected[entry['file']]:
                        raise ValueError('Godot assist pack payload differs: ' + entry['file'])
            transaction.copy(result, pack)


def install(args, helpers):
    game = helpers.clean_path(helpers.path_arg(args, 'outputDir'))
    capability = capabilities(game, helpers)
    if not capability['supported']:
        return {**capability, 'status': 'unsupported'}
    return InstallTransaction(game, helpers).run(lambda transaction: _install(game, capability, helpers, transaction))


def _install(game, capability, helpers, transaction):
    engine = capability['engine']
    if engine == 'TyranoScript':
        root = tyrano_root(game)
        script = root / 'data/others/PinHaoAssist.js'
        helpers.clean_path(script)
        transaction.write(script, (js_source('assist_tyrano.js') + ';\n').encode('utf-8'))
        entry = root / 'index.html'
        text = entry.read_text(encoding='utf-8-sig')
        marker = '<script src="data/others/PinHaoAssist.js"></script>'
        if marker not in text:
            text = re.sub(r'</body\s*>', lambda match: marker + '\n' + match[0], text, count=1, flags=re.I) if re.search(r'</body\s*>', text, re.I) else text + '\n' + marker
            transaction.write(entry, text.encode('utf-8'))
    elif engine == 'KiriKiri/KAG':
        script = helpers.clean_path(game / 'PinHaoAssist.tjs')
        transaction.write(script, b'\xff\xfe' + (TEMPLATES / 'assist_script.tjs').read_text(encoding='utf-8').encode('utf-16-le'))
        entry = helpers.clean_path(game / 'AfterInit2.tjs')
        resources = kag_scripts(game)
        text = kirikiri_native.text_read(entry) if entry.is_file() else resources.get('afterinit2.tjs', '')
        marker = 'Scripts.execStorage(System.exePath + "PinHaoAssist.tjs");'
        if marker not in text:
            transaction.write(entry, b'\xff\xfe' + (text + '\n' + marker + '\n').encode('utf-16-le'))
    elif engine == pgmm_native.ENGINE:
        root, document, key = pgmm_project(game)
        definitions = []
        def walk(items, store):
            for item in items:
                if item.get('folder'):
                    walk(item.get('children', []), store)
                elif type(item.get('id')) is int and item['id'] > 0:
                    definitions.append({'id': item['id'], 'name': str(item.get('name', '')), 'store': store})
        walk(document['variableList'], 'variables')
        walk(document['switchList'], 'switches')
        relative = 'plugins/PinHaoAssist.js'
        target = helpers.clean_path(root / relative)
        source = js_source('assist_pgmm.js').replace('__PINHAO_DEFINITIONS__', json.dumps(definitions, ensure_ascii=False))
        transaction.write(target, source.encode('utf-8'))
        plugins = document['pluginList']
        old = next((item for item in plugins if item.get('filename') == relative), None)
        if old is None:
            ids = []
            def plugin_ids(items):
                for item in items:
                    ids.append(item['id'])
                    plugin_ids(item.get('children', []))
            plugin_ids(plugins)
            plugins.append({'id': max(ids, default=0) + 1, 'name': 'PinHaoAssist', 'folder': False,
                            'filename': relative, 'srcFilename': relative, 'enabled': True, 'internalJson': None, 'paramValueJson': []})
        else:
            old['enabled'] = True
        raw = json.dumps(document, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        if key is not None:
            raw = pgmm_native.encrypt_resource(raw, key)
            if pgmm_native.decrypt_resource(raw, key) != json.dumps(document, ensure_ascii=False, separators=(',', ':')).encode('utf-8'):
                raise ValueError('PGMM assist encrypted project differs')
        transaction.write(helpers.clean_path(root / 'project.json'), raw)
    else:
        install_godot(game, helpers, transaction)
    return {**capability, 'transport': 'file'}
