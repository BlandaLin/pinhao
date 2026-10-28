"""KAG archive reconstruction and private-font bootstrap for independent games."""
from pathlib import Path
import json
import os
import re
import shutil
import struct
import tempfile

import text_formats as formats
import xp3_archive
import asset_overlay
import adapter_overlay
from rgss_archive import destination

# Copy filters exclude these OS files from loose output. Inside an archive they
# remain inert members and must not disappear during an unrelated text rewrite.
ARCHIVE_METADATA = frozenset(('desktop.ini', 'thumbs.db'))


def archives(game):
    candidates = sorted(game.glob('*.xp3'))
    carriers = []
    for path in sorted(game.glob('*.exe')):
        try:
            base = xp3_archive.offset(path)
        except xp3_archive.Xp3Error:
            continue
        if base:
            carriers.append(path)
    return carriers + candidates


def probe(game):
    paths = archives(game)
    if not paths:
        return None
    try:
        for path in paths:
            xp3_archive.index(path)
    except ValueError as error:
        return {'engine': 'KiriKiri/KAG', 'root': '.', 'support': 'xp3_custom_codec_required', 'dependency': str(error)}
    return {'engine': 'KiriKiri/KAG', 'root': '.', 'support': 'native_source_roundtrip',
            'archives': [p.relative_to(game).as_posix() for p in paths], 'packed': True, 'archiveFormat': 'xp3'}


def priority(name):
    stem = Path(name).stem.lower()
    patch = re.fullmatch(r'patch([1-9]\d*)?', stem)
    if patch:
        return 2, int(patch[1] or '1')
    standard = ('video', 'others', 'rule', 'sound', 'bgm', 'fgimage', 'bgimage', 'scenario', 'image', 'system')
    if stem == 'data':
        return 0, 0
    if stem in standard:
        return 1, standard.index(stem)
    return 0, 0


def prepare(game, source, info, helpers):
    source.mkdir(parents=True)
    owners, layouts = {}, []
    numbers = {int(match[1]) for name in info['archives']
               if (match := re.fullmatch(r'patch([2-9]|[1-9]\d+)\.xp3', Path(name).name, re.I))}
    contiguous, number = set(), 2
    while number in numbers:
        contiguous.add(number)
        number += 1
    standard_patches = False
    for rel in sorted(info['archives'], key=lambda name: (priority(name), name.casefold())):
        path = game / rel
        base, indexed = xp3_archive.index(path)
        with tempfile.TemporaryDirectory(prefix='pinhao-xp3-', dir=source.parent) as temp:
            folder = Path(temp) / 'resources'
            materialized = [entry.name for entry in indexed if xp3_archive.filesystem_member(entry.name)
                            and Path(entry.name).name.casefold() not in ARCHIVE_METADATA]
            xp3_archive.unpack(path, folder, helpers, names=materialized)
            for script in folder.rglob('Initialize.tjs'):
                try:
                    initializer = re.sub(r'\s+', '', text_read(script))
                except UnicodeError:
                    continue
                if 'for(vari=2;;i++)' in initializer and ('"patch"+i+".xp3"' in initializer or "'patch'+i+'.xp3'" in initializer):
                    standard_patches = True
            patch = re.fullmatch(r'patch(\d+)\.xp3', Path(rel).name, re.I)
            active = not (standard_patches and patch and
                          (str(int(patch[1])) != patch[1] or int(patch[1]) not in contiguous))
            names, source_hashes = [], {}
            for name, resource in helpers.files_in(folder):
                # Archive payloads can include persistent player data as well.
                if helpers.excluded(name):
                    continue
                names.append(name)
                if not active:
                    continue
                digest = helpers.digest_file(resource)
                source_hashes[name] = digest
                previous = owners.get(name.casefold())
                if previous and previous[1] != digest and priority(rel) == priority(previous[0]):
                    raise helpers.WorkerError('ARCHIVE_OVERRIDE_RECIPE', 'Overlapping XP3 resources need their loader order: ' + name)
                owners[name.casefold()] = (rel, digest)
                target = destination(source, name)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(resource, target)
            materialized_names = set(materialized)
            opaque = [entry.name for entry in indexed if entry.name not in materialized_names
                      and (not helpers.excluded(entry.name) or Path(entry.name).name.casefold() in ARCHIVE_METADATA)]
            layouts.append({'file': rel, 'base': base, 'members': names + opaque, 'opaqueMembers': opaque,
                            'sourceHashes': source_hashes, 'active': active})
    for rel, path in helpers.files_in(game):
        if rel in info['archives'] or helpers.excluded(rel) or path.suffix.lower() in ('.exe', '.dll'):
            continue
        target = destination(source, rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
    return layouts


def pe_bits(path):
    with Path(path).open('rb') as stream:
        header = stream.read(64)
        if len(header) < 64 or header[:2] != b'MZ':
            return None
        stream.seek(struct.unpack_from('<I', header, 60)[0])
        pe = stream.read(6)
    if len(pe) != 6 or pe[:4] != b'PE\0\0':
        return None
    return {0x14c: 32, 0x8664: 64}.get(struct.unpack_from('<H', pe, 4)[0])


def runtime_bits(root):
    executables = [path for path in root.glob('*.exe') if not re.search(r'config|crash|install|unins|setup', path.name, re.I)]
    executables.sort(key=lambda path: (path.name.casefold() not in ('game.exe', 'krkr.exe', 'krkrz.exe'), path.name.casefold()))
    return pe_bits(executables[0]) if executables else None


def plugin(root, bits=32, game_roots=()):
    candidates = []
    for game in game_roots:
        candidates.extend(path for path in game.rglob('*.dll') if path.name.casefold() == 'addfont.dll')
    for name in ('PINHAO_KAG_ADDFONT' + str(bits), 'PINHAO_KAG_ADDFONT'):
        if os.environ.get(name):
            candidates.append(Path(os.environ[name]))
    candidates.append(root / 'local/dependencies/kirikiri' / ('addFont64.dll' if bits == 64 else 'addFont.dll'))
    return next((path for path in candidates if path.is_file() and pe_bits(path) == bits), None)


def text_read(path):
    try:
        return formats.decode_source(path.read_bytes())[0]
    except UnicodeDecodeError:
        return path.read_bytes().decode('cp932')


def install_font(root, font, inventory, helpers, runtime_root=None):
    if not font:
        return
    family = helpers.font_family(font)
    target = root / 'pinhao-localization' / ('font' + font.suffix.lower())
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(font, target)
    # KAG3 executes AfterInit2 from the executable directory after creating its layers.
    after = root / 'AfterInit2.tjs'
    previous = text_read(after) if after.is_file() else ''
    bits = runtime_bits(runtime_root or root)
    dll = plugin(helpers.ROOT, bits, (root, runtime_root or root)) if bits else None
    if dll:
        plugin_target = target.parent / 'addFont.dll'
        if dll.resolve() != plugin_target.resolve():
            shutil.copyfile(dll, plugin_target)
        license_file = dll.parent / 'LICENSE.txt'
        if license_file.is_file():
            shutil.copyfile(license_file, target.parent / 'addFont-LICENSE.txt')
    registration = ('if(typeof System.addFont == "undefined")\n'
                    '    Plugins.link(System.exePath + "pinhao-localization/addFont.dll");\n'
                    'System.addFont(System.exePath + ' + json.dumps(target.relative_to(root).as_posix()) + ', true);\n')
    bootstrap = (registration + 'var pinhaoFace = ' + json.dumps(family, ensure_ascii=False) + ';\n'
                 'kag.chDefaultFace = pinhaoFace;\n'
                 'for(var pinhaoPage = 0; pinhaoPage < 2; pinhaoPage++) {\n'
                 '    var pinhaoLayers = (pinhaoPage ? kag.back : kag.fore).messages;\n'
                 '    for(var pinhaoIndex = 0; pinhaoIndex < pinhaoLayers.count; pinhaoIndex++) {\n'
                 '        pinhaoLayers[pinhaoIndex].userFace = pinhaoFace;\n'
                 '        pinhaoLayers[pinhaoIndex].defaultFace = pinhaoFace;\n'
                 '        pinhaoLayers[pinhaoIndex].resetFont();\n'
                 '    }\n}\n')
    if not dll:
        inventory['warnings'].append('KAG private font needs an addFont plugin matching its ' + (str(bits) + '-bit' if bits else 'PE') + ' runtime')
        return
    after.write_bytes(b'\xff\xfe' + (previous + '\n' + bootstrap).encode('utf-16-le'))
    inventory['font'] = {'family': family, 'file': target.relative_to(root).as_posix(), 'sha256': helpers.digest_file(target)}
    inventory['runtime'] = 'AfterInit2.tjs'


def assemble(game, source, built, metadata, manifest, output, font, inventory, helpers, args=None):
    """Rebuild original archive carriers and retain the shipped engine executable."""
    with tempfile.TemporaryDirectory(prefix='pinhao-kag-build-', dir=built.parent) as temp:
        staged = Path(temp) / 'resources'
        staged.mkdir()
        helpers.copy_tree(source, staged, {'copied': 0, 'excluded': []})
        for rel in manifest['files']:
            target = destination(staged, rel)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(built / rel, target)
        asset_overlay.apply(staged, args or {}, helpers, inventory)
        adapter_overlay.apply(staged, args or {}, helpers, inventory, baseline_root=built)
        install_font(staged, font, inventory, helpers, runtime_root=game)
        packed = set()
        for layout_index, layout in enumerate(metadata['archiveLayouts']):
            rel = layout['file']
            target = destination(output, rel)
            if not layout.get('active', True):
                # Keep dormant payloads, while applying the same private-member policy.
                xp3_archive.repack(game / rel, target, {}, members=layout['members'])
            else:
                replacements = {name: destination(staged, name) for name in layout['members']
                                if name not in layout.get('opaqueMembers', []) and destination(staged, name).is_file()
                                and helpers.digest_file(destination(staged, name)) != layout.get('sourceHashes', {}).get(name)}
                xp3_archive.repack(game / rel, target, replacements, members=layout['members'])
            _, indexed = xp3_archive.index(target)
            if {item.name for item in indexed} != set(layout['members']):
                raise helpers.WorkerError('XP3_BUILD', 'Rebuilt archive membership differs')
            if layout.get('active', True):
                packed.update(name.casefold() for name in layout['members'])
        # Font bootstrap and ordinary loose overrides stay next to the original runtime.
        for rel, path in helpers.files_in(staged):
            if rel.casefold() in packed and not (game / rel).is_file() and rel.casefold() != 'afterinit2.tjs':
                continue
            target = destination(output, rel)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
    inventory['archiveFormat'] = 'xp3'
    inventory['rebuiltArchives'] = len(metadata['archiveLayouts'])
