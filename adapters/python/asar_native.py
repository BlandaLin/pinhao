"""Read standard Electron ASAR containers without executing the application."""
import json
from pathlib import Path
import re
import struct
import tempfile

from rgss_archive import destination, safe_relative

TEXT_SUFFIXES = {'.ks', '.tjs', '.js', '.json', '.html', '.htm', '.css', '.txt'}


def identity(path):
    info = path.stat()
    return {'size': str(info.st_size), 'mtimeNs': str(info.st_mtime_ns),
            'device': str(info.st_dev), 'inode': str(info.st_ino)}


def pairs(values):
    result = {}
    for key, value in values:
        if key in result:
            raise ValueError('Duplicate ASAR header key')
        result[key] = value
    return result


def index(archive):
    size = archive.stat().st_size
    with archive.open('rb') as stream:
        header = stream.read(16)
        if len(header) != 16:
            raise ValueError('Truncated ASAR header')
        pickle_size, header_size, payload_size, json_size = struct.unpack('<IIII', header)
        if pickle_size != 4 or header_size < 8 or header_size > 64 * 1024 * 1024 or header_size + 8 > size:
            raise ValueError('Invalid ASAR header size')
        if payload_size != header_size - 4 or json_size > payload_size - 4:
            raise ValueError('Invalid ASAR pickle layout')
        raw = stream.read(json_size)
    doc = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs)
    data_start = 8 + header_size
    entries, seen = [], set()
    def visit(node, prefix='', depth=0):
        if not isinstance(node, dict) or depth > 64:
            raise ValueError('Invalid ASAR tree')
        if 'link' in node:
            raise ValueError('ASAR links require a regular copied resource')
        if 'files' in node:
            if not isinstance(node['files'], dict):
                raise ValueError('Invalid ASAR directory')
            for name, child in node['files'].items():
                if '/' in name or '\\' in name or not name:
                    raise ValueError('Invalid ASAR path component')
                path = safe_relative(prefix + name)
                if path.casefold() in seen:
                    raise ValueError('ASAR paths collide on Windows')
                seen.add(path.casefold())
                visit(child, path + '/', depth + 1)
            return
        path = prefix.rstrip('/')
        length = node.get('size')
        if type(length) is not int or length < 0:
            raise ValueError('Invalid ASAR file size')
        unpacked = node.get('unpacked', False)
        if type(unpacked) is not bool:
            raise ValueError('Invalid ASAR unpacked flag')
        if unpacked:
            offset = None
        else:
            value = node.get('offset')
            if not isinstance(value, str) or not re.fullmatch(r'\d+', value):
                raise ValueError('Invalid ASAR file offset')
            offset = data_start + int(value)
            if offset + length > size:
                raise ValueError('ASAR payload outside file')
        entries.append((path, offset, length))
    visit(doc)
    return entries


def _copy_exact(stream, output, length):
    while length:
        chunk = stream.read(min(length, 1024 * 1024))
        if not chunk:
            raise ValueError('Truncated ASAR file')
        output.write(chunk)
        length -= len(chunk)


def unpack(archive, output, helpers, *, names=None, skip=(), existing=False, inventory=None):
    entries = index(archive)
    sidecar = Path(str(archive) + '.unpacked')
    requested = None if names is None else set(names)
    if requested is not None and requested - {name for name, _, _ in entries}:
        raise ValueError('Requested ASAR member is missing')
    omitted = set(skip)
    for name, offset, length in entries:
        helpers.safe_member(name)
        destination(output, name)
        if offset is None:
            source = helpers.clean_path(destination(sidecar, name))
            if not source.is_file() or source.stat().st_size != length:
                raise ValueError('ASAR unpacked file missing or changed: ' + name)
    selected = [(name, offset, length) for name, offset, length in entries
                if (requested is None or name in requested) and name not in omitted]
    helpers.require_copy_space(output, sum(length for name, _, length in selected if not destination(output, name).exists()))
    output.mkdir(parents=True, exist_ok=existing)
    with archive.open('rb') as stream:
        for name, offset, length in selected:
            target = destination(output, name)
            helpers.clean_path(target)
            if target.exists():
                if not existing or not target.is_file():
                    raise ValueError('ASAR member output already exists: ' + name)
                if offset is None:
                    incoming = destination(sidecar, name).open('rb')
                else:
                    stream.seek(offset)
                    incoming = stream
                try:
                    remaining = length
                    with target.open('rb') as saved:
                        while remaining:
                            chunk = incoming.read(min(remaining, 1024 * 1024))
                            if not chunk or saved.read(len(chunk)) != chunk:
                                raise ValueError('ASAR materialized member changed: ' + name)
                            remaining -= len(chunk)
                        if saved.read(1):
                            raise ValueError('ASAR materialized member changed: ' + name)
                finally:
                    if incoming is not stream:
                        incoming.close()
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(dir=target.parent, prefix='.pinhao-asar-', suffix='.part', delete=False) as dest:
                    temporary = Path(dest.name)
                    if offset is None:
                        with destination(sidecar, name).open('rb') as incoming:
                            _copy_exact(incoming, dest, length)
                    else:
                        stream.seek(offset)
                        _copy_exact(stream, dest, length)
                temporary.rename(target)
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
            if inventory is not None:
                inventory['copied'] = inventory.get('copied', 0) + 1
    return {'members': len(entries), 'materialized': len(selected)}


def prepare(game, source, info, helpers):
    archive = game / info['archives'][0]
    baseline = identity(archive)
    entries = index(archive)
    names = [name for name, _, _ in entries if Path(name).suffix.lower() in TEXT_SUFFIXES
             and 'node_modules' not in name.casefold().split('/') and not helpers.excluded(name)]
    unpack(archive, source / info['root'], helpers, names=names)
    if identity(archive) != baseline:
        raise ValueError('ASAR changed during selective extraction')
    sidecar = Path(str(archive) + '.unpacked')
    return {'archive': info['archives'][0], 'identity': baseline, 'members': [
        {'file': name, 'bytes': length, 'unpacked': offset is None,
         **({'identity': identity(destination(sidecar, name))} if offset is None else {})}
        for name, offset, length in entries]}


def materialize(game, source, metadata, files, helpers):
    layout = metadata['archiveLayouts']
    archive = helpers.clean_path(destination(game, layout['archive']))
    if identity(archive) != layout['identity']:
        raise helpers.WorkerError('SOURCE_CHANGED', 'ASAR original changed; extract a new revision')
    root = Path(metadata['root'])
    names = []
    members = {row['file']: row for row in layout['members']}
    sidecar = Path(str(archive) + '.unpacked')
    for file in files:
        name = Path(helpers.safe_member(file)).relative_to(root).as_posix()
        if name not in members or helpers.excluded(name):
            raise ValueError('ASAR source member is missing or private: ' + name)
        row = members[name]
        if row['unpacked'] and identity(helpers.clean_path(destination(sidecar, name))) != row['identity']:
            raise helpers.WorkerError('SOURCE_CHANGED', 'ASAR sidecar member changed: ' + name)
        names.append(name)
    result = unpack(archive, source / root, helpers, names=names, existing=True)
    if identity(archive) != layout['identity']:
        raise helpers.WorkerError('SOURCE_CHANGED', 'ASAR changed during member reading')
    return result


def assemble(game, output, metadata, overlay, inventory, helpers):
    layout = metadata['archiveLayouts']
    archive = game / layout['archive']
    entries = index(archive)
    expected = [(row['file'], row['bytes'], row['unpacked']) for row in layout['members']]
    if [(name, length, offset is None) for name, offset, length in entries] != expected:
        raise ValueError('ASAR member index changed; extract a new revision')
    skip = set(overlay)
    for name, _, _ in entries:
        if helpers.excluded(name):
            skip.add(name)
            inventory['excluded'].append(str(Path(metadata['root']) / name).replace('\\', '/'))
    return unpack(archive, output / metadata['root'], helpers, skip=skip, inventory=inventory)
