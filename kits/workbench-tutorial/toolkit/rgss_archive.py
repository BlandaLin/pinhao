"""RGSS archive v1/v3 data extraction; never executes or overwrites a game."""
import struct
from pathlib import Path, PurePosixPath


def safe_relative(name):
    name = name.replace('\\', '/')
    parts = name.split('/')
    if not name or name.startswith('/') or any(p in ('', '.', '..') or ':' in p for p in parts):
        raise ValueError('Unsafe resource path: ' + name)
    if any(p.rstrip(' .') != p for p in parts):
        raise ValueError('Ambiguous resource path: ' + name)
    return PurePosixPath(name).as_posix()


def destination(root, name):
    path = root.joinpath(*safe_relative(name).split('/'))
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError('Resource path escapes output')
    return path


def take(stream, count):
    if count < 0: raise ValueError('Negative archive size')
    data = stream.read(count)
    if len(data) != count: raise ValueError('Truncated archive')
    return data


def integer(stream):
    return struct.unpack('<I', take(stream, 4))[0]


def advance(key):
    return (key * 7 + 3) & 0xffffffff


def archive_entries(path):
    length = path.stat().st_size
    entries = []
    with path.open('rb') as stream:
        header = take(stream, 8)
        if header[:7] != b'RGSSAD\0' or header[7] not in (1, 3):
            raise ValueError('Only RGSSAD header version 1 or 3 is supported')
        version = header[7]
        if version == 3:
            key = (integer(stream) * 9 + 3) & 0xffffffff
            while True:
                offset = integer(stream) ^ key
                if offset == 0: break
                size, payload_key, count = (integer(stream) ^ key for _ in range(3))
                if count > length - stream.tell(): raise ValueError('Invalid archive name length')
                encoded = take(stream, count)
                name = bytes(c ^ ((key >> ((i % 4) * 8)) & 255) for i, c in enumerate(encoded))
                entries.append((safe_relative(name.decode('utf-8')), offset, size, payload_key))
            table_end = stream.tell()
            if any(offset < table_end for _, offset, _, _ in entries):
                raise ValueError('Archive payload overlaps its table')
        else:
            key = 0xDEADCAFE
            while stream.tell() < length:
                count = integer(stream) ^ key
                key = advance(key)
                if count > length - stream.tell(): raise ValueError('Invalid archive name length')
                name = bytearray(take(stream, count))
                for i in range(count):
                    name[i] ^= key & 255
                    key = advance(key)
                size = integer(stream) ^ key
                key = advance(key)
                offset = stream.tell()
                entries.append((safe_relative(name.decode('utf-8')), offset, size, key))
                if size > length - offset: raise ValueError('Truncated archive payload')
                stream.seek(size, 1)
    seen = set()
    for name, offset, size, _ in entries:
        if name.casefold() in seen: raise ValueError('Duplicate archive path: ' + name)
        seen.add(name.casefold())
        if offset + size > length: raise ValueError('Truncated archive payload')
    return version, entries


def unpack(archive, output, all_resources=False):
    archive, output = Path(archive).resolve(), Path(output).resolve()
    if output.exists(): raise ValueError('Output already exists')
    if output.is_relative_to(archive.parent):
        raise ValueError('Unpack outside the original game directory')
    version, entries = archive_entries(archive)
    selected = [e for e in entries if all_resources or
                (e[0].split('/')[0].casefold() == 'data' and Path(e[0]).suffix.lower() in ('.rvdata2', '.rvdata', '.rxdata'))]
    if not selected: raise ValueError('No standard RPG Maker data found')
    # Validate all names before creating the output directory.
    for name, _, _, _ in selected: destination(output, name)
    output.mkdir(parents=True)
    with archive.open('rb') as stream:
        for name, offset, remaining, key in selected:
            path = destination(output, name)
            path.parent.mkdir(parents=True, exist_ok=True)
            stream.seek(offset)
            with path.open('xb') as dest:
                while remaining:
                    block = bytearray(take(stream, min(65536, remaining)))
                    for i in range(0, len(block), 4):
                        for j in range(min(4, len(block) - i)):
                            block[i + j] ^= (key >> (8 * j)) & 255
                        key = advance(key)
                    dest.write(block)
                    remaining -= len(block)
    return {'archive_version': version, 'files': len(selected), 'bytes': sum(e[2] for e in selected),
            'all_resources': all_resources, 'status': 'unpacked_not_runtime_tested'}
