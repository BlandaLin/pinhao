"""NW.js PE + ZIP distributions; materialize text, retain media in the original."""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import shutil
import struct
import tempfile
import zipfile

from rgss_archive import destination

TEXT_SUFFIXES = {'.ks', '.tjs', '.js', '.json', '.html', '.htm', '.css', '.txt'}


def _entries(archive):
    seen = set()
    for item in archive.infolist():
        name = item.filename.replace('\\', '/').rstrip('/')
        destination(Path('.'), name)
        if name.casefold() in seen:
            raise ValueError('Duplicate NW.js resource: ' + name)
        seen.add(name.casefold())
        if item.flag_bits & 1 or (item.external_attr >> 16) & 0o170000 == 0o120000:
            raise ValueError('Encrypted or linked NW.js resource: ' + name)
        yield name, item


def _prefix(path, offset):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        remaining = offset
        while remaining:
            chunk = stream.read(min(1024 * 1024, remaining))
            if not chunk:
                raise ValueError('Truncated NW.js executable prefix')
            digest.update(chunk)
            remaining -= len(chunk)
    return digest.hexdigest()


def probe(game):
    candidates = []
    for path in sorted(Path(game).glob('*.exe')):
        with path.open('rb') as stream:
            header = stream.read(64)
            if header[:2] != b'MZ' or len(header) != 64:
                continue
            stream.seek(struct.unpack_from('<I', header, 60)[0])
            if stream.read(4) != b'PE\0\0':
                continue
        try:
            with zipfile.ZipFile(path) as archive:
                entries = dict(_entries(archive))
                if ('package.json' not in entries or not any(name.startswith('tyrano/') for name in entries)
                        or not any(name.startswith('data/scenario/') and name.lower().endswith('.ks') for name in entries)):
                    continue
                package = json.loads(archive.read(entries['package.json']).decode('utf-8-sig'))
                main = package.get('main') if isinstance(package, dict) else None
                if not isinstance(main, str):
                    continue
                main = main.removeprefix('app://./').removeprefix('./').split('?', 1)[0].split('#', 1)[0]
                if main not in entries:
                    continue
                offset = min(item.header_offset for item in entries.values())
                if offset < 64:
                    continue
                candidates.append({'engine': 'TyranoScript', 'root': '.', 'support': 'native_source_roundtrip',
                                   'archives': [path.name], 'packed': True, 'archiveFormat': 'nwjs-zip',
                                   'zipOffset': offset, 'entryPoint': main})
        except zipfile.BadZipFile:
            continue
    if len(candidates) > 1:
        raise ValueError('Multiple NW.js game packages found; choose one complete game directory')
    return candidates[0] if candidates else None


def unpack(game, source, info, helpers):
    path = Path(game) / info['archives'][0]
    source.mkdir(parents=True)
    records = []
    with zipfile.ZipFile(path) as archive:
        for name, item in _entries(archive):
            records.append({'file': name, 'bytes': item.file_size, 'crc32': item.CRC,
                            'compressedBytes': item.compress_size, 'directory': item.is_dir()})
            # Bundled Node dependencies are runtime inputs, not author scenarios.
            # Keep their original compressed payloads instead of expanding deeply
            # nested dependency trees into a second Windows installation.
            if (item.is_dir() or 'node_modules' in name.casefold().split('/')
                    or Path(name).suffix.lower() not in TEXT_SUFFIXES or helpers.excluded(name)):
                continue
            target = destination(source, name)
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(item) as incoming, target.open('xb') as outgoing:
                shutil.copyfileobj(incoming, outgoing)
    return {'executable': info['archives'][0], 'zipOffset': info['zipOffset'],
            'prefixSha256': _prefix(path, info['zipOffset']), 'entryPoint': info['entryPoint'], 'members': records}


class _OverlayFile:
    """Keep ZIP offsets relative to the package, as in NW.js's original export."""
    def __init__(self, stream, offset):
        self.stream, self.offset = stream, offset

    def tell(self):
        return self.stream.tell() - self.offset

    def seek(self, offset, whence=0):
        self.stream.seek(offset + (self.offset if whence == 0 else 0), whence)
        return self.tell()

    def read(self, size=-1):
        return self.stream.read(size)

    def write(self, data):
        return self.stream.write(data)

    def flush(self):
        return self.stream.flush()

    def truncate(self, size=None):
        return self.stream.truncate(None if size is None else size + self.offset)


def repack(original, output, overlay, layout, helpers):
    original, output, overlay = Path(original), Path(output), Path(overlay)
    with zipfile.ZipFile(original) as archive:
        entries = dict(_entries(archive))
        changes = {}
        for name, path in helpers.files_in(overlay):
            item = entries.get(name)
            if item is not None and item.file_size == path.stat().st_size:
                with archive.open(item) as stream, path.open('rb') as proposed:
                    same = True
                    while same:
                        left, right = stream.read(1024 * 1024), proposed.read(1024 * 1024)
                        if left != right:
                            same = False
                        elif not left:
                            break
                if same:
                    continue
            changes[name] = path
        expected = {name: (item.file_size, item.CRC) for name, item in entries.items()}
    helpers.require_copy_space(output.parent, original.stat().st_size + sum(path.stat().st_size for path in changes.values()))
    shutil.copyfile(original, output)
    if changes:
        with output.open('r+b') as stream, zipfile.ZipFile(_OverlayFile(stream, layout['zipOffset']), 'a') as archive:
            # zipfile has no replacement API. Drop only replaced central entries;
            # all original media blocks remain byte-for-byte in the copied image.
            prior = dict(_entries(archive))
            archive.filelist[:] = [item for item in archive.filelist
                                   if item.filename.replace('\\', '/').rstrip('/') not in changes]
            for name in changes:
                archive.NameToInfo.pop(prior[name].filename if name in prior else name, None)
            for name, path in changes.items():
                item = copy.copy(prior[name]) if name in prior else zipfile.ZipInfo(name, (2000, 1, 1, 0, 0, 0))
                item.compress_type = prior[name].compress_type if name in prior else zipfile.ZIP_DEFLATED
                with path.open('rb') as incoming, archive.open(item, 'w') as outgoing:
                    shutil.copyfileobj(incoming, outgoing)
    if _prefix(output, layout['zipOffset']) != layout['prefixSha256']:
        raise ValueError('NW.js executable prefix changed')
    with zipfile.ZipFile(output) as archive:
        actual = dict(_entries(archive))
        if set(actual) != set(expected) | set(changes):
            raise ValueError('NW.js resource member set changed unexpectedly')
        for name, values in expected.items():
            if name not in changes and (actual[name].file_size, actual[name].CRC) != values:
                raise ValueError('Unchanged NW.js resource metadata differs: ' + name)
        for name, path in changes.items():
            with archive.open(actual[name]) as stream, path.open('rb') as proposed:
                while True:
                    left, right = stream.read(1024 * 1024), proposed.read(1024 * 1024)
                    if left != right:
                        raise ValueError('NW.js changed resource readback differs: ' + name)
                    if not left:
                        break
    return {'members': len(actual), 'changedMembers': len(changes), 'prefixPreserved': True,
            'unchangedMemberPayloads': 'Original compressed blocks retained; central metadata checked.'}


def assemble(game, work, built, output, metadata, manifest, font, inventory, helpers, args):
    import adapter_overlay
    import asset_overlay
    import source_native
    layout = metadata['archiveLayouts']
    output.mkdir(parents=True)
    helpers.copy_tree(game, output, inventory, omitted=metadata['archives'], progress=helpers.copy_progress)
    with tempfile.TemporaryDirectory(prefix='nwjs-overlay-', dir=work.parent) as folder:
        overlay = Path(folder)
        for name in manifest['files']:
            target = destination(overlay, name)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(destination(built, name), target)
        source = Path(metadata['nativeSource'])
        entry = layout['entryPoint']
        if font:
            if entry != 'index.html':
                raise ValueError('Tyrano font overlay requires an index.html entry point')
            if not (overlay / entry).is_file():
                shutil.copyfile(destination(source, entry), overlay / 'index.html')
        requested = [name for name, _ in adapter_overlay.entries(args, helpers)]
        requested.extend(name for name, _ in asset_overlay.entries(args, helpers))
        if requested:
            with zipfile.ZipFile(game / layout['executable']) as archive:
                entries = dict(_entries(archive))
                for name in requested:
                    target = destination(overlay, name)
                    if target.is_file():
                        continue
                    if name not in entries:
                        raise ValueError('NW.js overlay original resource is missing: ' + name)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(entries[name]) as incoming, target.open('xb') as outgoing:
                        shutil.copyfileobj(incoming, outgoing)
        adapter_overlay.apply(overlay, args, helpers, inventory, baseline_root=built)
        asset_overlay.apply(overlay, args, helpers, inventory)
        source_native.install_font(overlay, 'TyranoScript', font, inventory, helpers)
        executable = layout['executable']
        inventory['nwjsPackage'] = repack(game / executable, output / executable, overlay, layout, helpers)
    inventory.update(status='assembled_structurally_checked', nativeFiles=len(manifest['files']),
                     launchers=[executable], launchPath=str(output / executable))
    inventory['warnings'].append('NW.js ZIP package rebuilt; game launch and layout acceptance pending')
    helpers.json_write(output / 'PinHao-build-report.json', inventory)
    if args.get('share', True):
        (output / '使用说明-拼好汉化.txt').write_text('本汉化成果由拼好汉化免费分享。切勿付费购买。\n'
                                                        '启动原游戏程序即可游玩，汉化文字已内嵌。\n', encoding='utf-8')
    return {**inventory, 'outputDir': str(output), 'reportPath': str(output / 'PinHao-build-report.json')}
