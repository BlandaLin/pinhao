"""Standard XP3 archives and executable overlays, following the public KiriKiri format."""
from dataclasses import dataclass
import hashlib
from pathlib import Path
import struct
import zlib

from rgss_archive import destination, safe_relative

MAGIC = b'XP3\r\n \n\x1a\x8bg\x01'
INDEX_LIMIT = 128 * 1024 * 1024


class Xp3Error(ValueError):
    code = 'XP3_FORMAT'


def filesystem_member(name):
    """Archive identities can be valid while not representable as Windows files."""
    for part in safe_relative(name).split('/'):
        if len(part.encode('utf-16-le')) // 2 > 255 or any(c in part for c in '<>"|?*'):
            return False
        if part.split('.', 1)[0].upper() in {'CON', 'PRN', 'AUX', 'NUL', *(f'COM{i}' for i in range(1, 10)), *(f'LPT{i}' for i in range(1, 10))}:
            return False
    return True


def exact(stream, length):
    data = stream.read(length)
    if len(data) != length:
        raise Xp3Error('Truncated XP3 resource')
    return data


def inflate(data, length):
    decoder = zlib.decompressobj()
    result = decoder.decompress(data, length + 1)
    if len(result) != length or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
        raise Xp3Error('XP3 compressed size mismatch')
    return result


def chunks(data):
    cursor = 0
    while cursor < len(data):
        if cursor + 12 > len(data):
            raise Xp3Error('Truncated XP3 index chunk')
        kind, length = struct.unpack_from('<4sQ', data, cursor)
        cursor += 12
        if length > len(data) - cursor:
            raise Xp3Error('XP3 index chunk outside its container')
        yield kind, data[cursor:cursor + length]
        cursor += length


def offset(path):
    with Path(path).open('rb') as stream:
        head = stream.read(len(MAGIC))
        if head == MAGIC:
            return 0
        if not head.startswith(b'MZ'):
            raise Xp3Error('Not a standard XP3 archive')
        stream.seek(0)
        position, carry = 0, b''
        while block := stream.read(1024 * 1024):
            data = carry + block
            origin = position - len(carry)
            start = 0
            while (found := data.find(MAGIC, start)) >= 0:
                if (origin + found) % 16 == 0:
                    return origin + found
                start = found + 1
            carry = data[-(len(MAGIC) - 1):]
            position += len(block)
    raise Xp3Error('Executable has no standard XP3 overlay')


@dataclass(frozen=True)
class Entry:
    name: str
    size: int
    checksum: int
    segments: tuple
    flags: int


def index(path):
    path = Path(path)
    base, size = offset(path), path.stat().st_size
    entries, seen, indices = [], set(), set()
    with path.open('rb') as stream:
        stream.seek(base + len(MAGIC))
        while True:
            pointer = struct.unpack('<Q', exact(stream, 8))[0] + base
            if pointer in indices or not base + 19 <= pointer < size:
                raise Xp3Error('XP3 index pointer is invalid or cyclic')
            indices.add(pointer)
            stream.seek(pointer)
            flag = exact(stream, 1)[0]
            if flag & ~0x81:
                raise Xp3Error('Unsupported XP3 index encoding')
            packed = struct.unpack('<Q', exact(stream, 8))[0]
            length = struct.unpack('<Q', exact(stream, 8))[0] if flag & 1 else packed
            if max(length, packed) > INDEX_LIMIT or stream.tell() + packed > size:
                raise Xp3Error('Invalid XP3 index length')
            raw = exact(stream, packed)
            raw = inflate(raw, length) if flag & 1 else raw
            next_pointer = stream.tell()
            for kind, item in chunks(raw):
                if kind != b'File':
                    continue
                fields = {}
                for key, data in chunks(item):
                    if key in fields:
                        raise Xp3Error('Duplicate XP3 file metadata')
                    fields[key] = data
                if not all(key in fields for key in (b'info', b'segm', b'adlr')):
                    raise Xp3Error('Missing XP3 file metadata')
                info, segment_data = fields[b'info'], fields[b'segm']
                if len(info) < 22 or len(segment_data) % 28 or len(fields[b'adlr']) != 4:
                    raise Xp3Error('Malformed XP3 file metadata')
                file_flag, original, archived, chars = struct.unpack_from('<IQQH', info)
                if len(info) != 22 + chars * 2:
                    raise Xp3Error('XP3 name length mismatch')
                name = safe_relative(info[22:].decode('utf-16-le'))
                if name.casefold() in seen:
                    raise Xp3Error('XP3 filenames collide on Windows: ' + name)
                seen.add(name.casefold())
                segments = []
                for pos in range(0, len(segment_data), 28):
                    method, start, original_size, packed_size = struct.unpack_from('<IQQQ', segment_data, pos)
                    if method not in (0, 1) or start + base < base + 19 or start + base + packed_size > size:
                        raise Xp3Error('Invalid XP3 segment bounds or compression')
                    if method == 0 and original_size != packed_size:
                        raise Xp3Error('Raw XP3 segment length mismatch')
                    segments.append((method, start + base, original_size, packed_size))
                if sum(part[2] for part in segments) != original or sum(part[3] for part in segments) != archived:
                    raise Xp3Error('XP3 file/segment lengths disagree')
                entries.append(Entry(name, original, struct.unpack('<I', fields[b'adlr'])[0], tuple(segments), file_flag))
            if not flag & 0x80:
                break
            stream.seek(next_pointer)
    names = {item.name.casefold() for item in entries}
    if any(parent.as_posix().casefold() in names for item in entries for parent in Path(item.name).parents if str(parent) != '.'):
        raise Xp3Error('XP3 file/directory collision')
    return base, entries


def unpack(path, output, helpers, *, names=None):
    _, entries = index(path)
    requested = None if names is None else set(names)
    if requested is not None and requested - {entry.name for entry in entries}:
        raise ValueError('Requested XP3 member is missing')
    for entry in entries:
        if requested is not None and entry.name not in requested:
            continue
        helpers.safe_member(entry.name)
        destination(output, entry.name)
    output.mkdir(parents=True)
    with Path(path).open('rb') as stream:
        for entry in entries:
            if requested is not None and entry.name not in requested:
                continue
            target = destination(output, entry.name)
            target.parent.mkdir(parents=True, exist_ok=True)
            checksum = 1
            with target.open('xb') as writer:
                for data in payload_chunks(stream, entry):
                    writer.write(data); checksum = zlib.adler32(data, checksum)
            if checksum & 0xffffffff != entry.checksum:
                error = Xp3Error('XP3 resource checksum differs; a game-specific extraction filter is required: ' + entry.name)
                error.code = 'XP3_EXTRACTION_FILTER'
                raise error
    return entries


def payload_chunks(stream, entry):
    for method, start, length, packed in entry.segments:
        stream.seek(start)
        if method:
            if max(length, packed) > INDEX_LIMIT:
                raise Xp3Error('XP3 compressed segment exceeds the decoded segment limit')
            yield inflate(exact(stream, packed), length)
        else:
            remaining = packed
            while remaining:
                data = exact(stream, min(remaining, 1024 * 1024))
                yield data
                remaining -= len(data)


def member_inventory(path):
    """Read back every payload without needing a representable filesystem name."""
    _, entries = index(path)
    result = []
    with Path(path).open('rb') as stream:
        for entry in entries:
            digest, checksum, size = hashlib.sha256(), 1, 0
            for data in payload_chunks(stream, entry):
                digest.update(data); checksum = zlib.adler32(data, checksum); size += len(data)
            if size != entry.size or checksum & 0xffffffff != entry.checksum:
                error = Xp3Error('XP3 resource checksum differs; a game-specific extraction filter is required: ' + entry.name)
                error.code = 'XP3_EXTRACTION_FILTER'
                raise error
            result.append({'path': entry.name, 'size': size, 'sha256': digest.hexdigest()})
    return sorted(result, key=lambda row: row['path'])


def repack(original, output, replacements, *, members=None, additions=None):
    """Replace selected members; copy all other compressed payloads without extraction."""
    base, entries = index(original)
    known = {entry.name for entry in entries}
    if set(replacements) - known:
        raise Xp3Error('Replacement names are not in the original archive')
    selected = known if members is None else set(members)
    if selected - known or set(replacements) - selected:
        raise Xp3Error('Rebuilt membership is not a subset of the original archive')
    entries = [entry for entry in entries if entry.name in selected]
    additions = {safe_relative(name): value for name, value in (additions or {}).items()}
    all_names = [entry.name for entry in entries] + list(additions)
    folded = {name.casefold() for name in all_names}
    if len(folded) != len(all_names) or any(parent.as_posix().casefold() in folded
            for name in all_names for parent in Path(name).parents if str(parent) != '.'):
        raise Xp3Error('Additional XP3 members collide with existing paths')
    entries.extend(Entry(name, 0, 1, (), 0) for name in additions)
    sources = {**replacements, **additions}
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with Path(original).open('rb') as reader, output.open('xb') as writer:
        if not sources and selected == known:
            while block := reader.read(1024 * 1024):
                writer.write(block)
            return {'base': base, 'files': len(entries), 'replaced': 0}
        remaining = base
        while remaining:
            block = exact(reader, min(remaining, 1024 * 1024))
            writer.write(block); remaining -= len(block)
        writer.write(MAGIC + b'\0' * 8)
        files = []
        for entry in entries:
            segments, original_size, packed_size = [], 0, 0
            replacement = sources.get(entry.name)
            checksum = entry.checksum
            if replacement is not None:
                checksum = 1
                with Path(replacement).open('rb') as source:
                    while data := source.read(1024 * 1024):
                        compressed = zlib.compress(data, 6)
                        method = int(len(compressed) < len(data))
                        payload = compressed if method else data
                        segments.append(struct.pack('<IQQQ', method, writer.tell() - base, len(data), len(payload)))
                        writer.write(payload)
                        original_size += len(data); packed_size += len(payload); checksum = zlib.adler32(data, checksum)
            else:
                for method, start, length, packed in entry.segments:
                    segments.append(struct.pack('<IQQQ', method, writer.tell() - base, length, packed))
                    reader.seek(start)
                    remaining = packed
                    while remaining:
                        block = exact(reader, min(remaining, 1024 * 1024))
                        writer.write(block); remaining -= len(block)
                    original_size += length; packed_size += packed
            if not segments:
                segments.append(struct.pack('<IQQQ', 0, writer.tell() - base, 0, 0))
            encoded = entry.name.encode('utf-16-le')
            info = struct.pack('<IQQH', entry.flags, original_size, packed_size, len(encoded) // 2) + encoded
            files.append(chunk(b'File', chunk(b'info', info) + chunk(b'segm', b''.join(segments)) + chunk(b'adlr', struct.pack('<I', checksum & 0xffffffff))))
        pointer = writer.tell() - base
        raw = b''.join(files)
        compressed = zlib.compress(raw, 6)
        if len(compressed) < len(raw):
            writer.write(b'\1' + struct.pack('<QQ', len(compressed), len(raw)) + compressed)
        else:
            writer.write(b'\0' + struct.pack('<Q', len(raw)) + raw)
        writer.seek(base + len(MAGIC)); writer.write(struct.pack('<Q', pointer))
    _, rebuilt = index(output)
    if [(entry.name, entry.flags) for entry in rebuilt] != [(entry.name, entry.flags) for entry in entries]:
        raise Xp3Error('Rebuilt archive membership or flags changed')
    return {'base': base, 'files': len(entries), 'replaced': len(replacements)}


def chunk(kind, data):
    return struct.pack('<4sQ', kind, len(data)) + data


def pack(output, entries, prefix=b'', compress=True):
    """Write complete resources, retaining an executable prefix for a PEXP3 carrier."""
    prepared, seen = [], set()
    for name, source in entries:
        name = safe_relative(name)
        if name.casefold() in seen:
            raise Xp3Error('Duplicate packed XP3 path: ' + name)
        seen.add(name.casefold()); prepared.append((name, source))
    if any(parent.as_posix().casefold() in seen for name, _ in prepared for parent in Path(name).parents if str(parent) != '.'):
        raise Xp3Error('Packed XP3 file/directory collision')
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    with Path(output).open('xb') as stream:
        stream.write(prefix)
        stream.write(b'\0' * (-len(prefix) % 16))
        base = stream.tell()
        stream.write(MAGIC + b'\0' * 8)
        files = []
        for name, source in sorted(prepared):
            encoded = name.encode('utf-16-le')
            if len(encoded) // 2 > 65535:
                raise Xp3Error('XP3 resource name is too long')
            segments, original, archived, checksum = [], 0, 0, 1
            with Path(source).open('rb') as reader:
                while data := reader.read(1024 * 1024):
                    packed = zlib.compress(data, 6) if compress else data
                    method = int(len(packed) < len(data))
                    if not method:
                        packed = data
                    segments.append(struct.pack('<IQQQ', method, stream.tell() - base, len(data), len(packed)))
                    original += len(data); archived += len(packed); checksum = zlib.adler32(data, checksum)
                    stream.write(packed)
            if not segments:
                # The native stream constructor reads Segments[0], even for an empty file.
                segments.append(struct.pack('<IQQQ', 0, stream.tell() - base, 0, 0))
            info = struct.pack('<IQQH', 0, original, archived, len(encoded) // 2) + encoded
            files.append(chunk(b'File', chunk(b'info', info) + chunk(b'segm', b''.join(segments)) + chunk(b'adlr', struct.pack('<I', checksum & 0xffffffff))))
        pointer = stream.tell() - base
        raw = b''.join(files)
        compressed = zlib.compress(raw, 6)
        if compress and len(compressed) < len(raw):
            stream.write(b'\1' + struct.pack('<QQ', len(compressed), len(raw)) + compressed)
        else:
            stream.write(b'\0' + struct.pack('<Q', len(raw)) + raw)
        stream.seek(base + len(MAGIC)); stream.write(struct.pack('<Q', pointer))
    return {'base': base, 'files': len(prepared)}
