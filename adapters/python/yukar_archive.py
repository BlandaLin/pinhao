"""SGB and Bakin resource containers, preserving the engine's two encoding layers.

Bakin container documentation: https://github.com/HNIdesu/BakinExtractor (MIT).
The SGBDAT layout is documented by Luigi Auriemma's sgbpack.bms.
"""
from __future__ import annotations

import hashlib
import io
from pathlib import PurePosixPath
import struct
import zipfile
import zlib

KEY1 = bytes((0, 8, 7, 3, 5, 12, 11, 10, 9, 1, 2, 14, 4, 13, 6, 15))
KEY2 = bytes((2, 14, 4, 10, 6, 11, 3, 0, 9, 15, 7, 1, 13, 8, 12, 5))
ZIP_HEADER = b'PK\x03\x04\x14\x00\x00\x00'
RAW_SUFFIXES = ('.cg', '.cgh', '.dlp_d', '.exe', '.dll', '.dlp', '.webm')
MAX_MEMBER = 1024 * 1024 * 1024


def crypt(data, key, start=0, encode=False):
    result = bytearray(data)
    sign = 1 if encode else -1
    for index in range(16):
        offset = (index + start) % 16
        shift = sign * offset * key[offset]
        result[index::16] = data[index::16].translate(bytes((value + shift) % 256 for value in range(256)))
    return bytes(result)


def valid_name(name):
    name = name.replace('\\', '/')
    path = PurePosixPath(name)
    if not name or name.startswith('/') or any(part in ('', '.', '..') or ':' in part for part in path.parts):
        raise ValueError('Unsafe resource path: ' + name)
    return path.as_posix()


def zip_read(raw, encrypted=False):
    entries, seen = [], set()
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        for entry in archive.infolist():
            name = valid_name(entry.filename.rstrip('/'))
            if name.casefold() in seen:
                raise ValueError('Duplicate resource: ' + name)
            seen.add(name.casefold())
            if entry.is_dir():
                continue
            if entry.file_size > MAX_MEMBER or entry.flag_bits & 1:
                raise ValueError('Unsupported resource size/encryption: ' + name)
            value = archive.read(entry)
            if encrypted:
                key = KEY1 if name.lower().endswith(RAW_SUFFIXES) else KEY2
                value = crypt(value, key)
            entries.append((name, value, entry))
    return entries


def zip_write(entries, encrypted=False):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
        for name, data, info in entries:
            valid_name(name)
            if encrypted:
                key = KEY1 if name.lower().endswith(RAW_SUFFIXES) else KEY2
                data = crypt(data, key, encode=True)
            # Reuse metadata and compression for the engine's original resource members.
            if info is None:
                info = zipfile.ZipInfo(name, (2000, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    return output.getvalue()


def sgb_read(raw):
    if raw.startswith(b'YUKARPKG'):
        return {'kind': 'YUKARPKG', 'header': raw[:8]}, zip_read(ZIP_HEADER + raw[8:])
    if raw.startswith(b'SGBDAT') and len(raw) >= 8 and raw[6:8] != b'\0\0':
        return {'kind': 'SGBDAT', 'header': raw[:8]}, zip_read(ZIP_HEADER + crypt(raw[8:], KEY1, 8), True)
    raise ValueError('Unsupported SGB container header')


def sgb_write(layout, entries):
    encoded = zip_write(entries, layout['kind'] == 'SGBDAT')
    if layout['kind'] == 'SGBDAT':
        encoded = encoded[:8] + crypt(encoded[8:], KEY1, 8, True)
    return layout['header'] + encoded[8:]


class Cursor:
    def __init__(self, raw):
        self.raw, self.pos = raw, 0

    def take(self, size):
        if size < 0 or self.pos + size > len(self.raw):
            raise ValueError('Truncated Bakin container')
        result = self.raw[self.pos:self.pos + size]
        self.pos += size
        return result

    def number(self, fmt):
        return struct.unpack(fmt, self.take(struct.calcsize(fmt)))[0]

    def string(self, encrypted=False):
        length = self.number('<B')
        offset = self.pos
        value = self.take(length)
        return (crypt(value, KEY2, offset) if encrypted else value).decode('utf-8')


def bakin_read(raw):
    cursor = Cursor(raw)
    if cursor.take(6) != b'BKNPAK':
        raise ValueError('Unsupported Bakin container header')
    version = cursor.number('>H')
    if version != 1:
        raise ValueError('Unsupported Bakin container version: ' + str(version))
    table = cursor.number('<Q') + cursor.pos
    modern = cursor.raw[cursor.pos] <= 1
    title = cursor.string() if not modern or cursor.number('<B') else ''
    verify = cursor.number('<I')
    digest = cursor.take(cursor.number('<B'))
    if not any(hashlib.md5(struct.pack('<I', (verify + salt) % (1 << 32))).digest() == digest for salt in (2525, 5252)):
        raise ValueError('Bakin container verification mismatch')
    zip_length = cursor.number('<Q')
    zip_offset = cursor.pos
    payload = ZIP_HEADER + crypt(cursor.take(zip_length - 8), KEY1, zip_offset)
    zipped = zip_read(payload, True)
    if table < cursor.pos or table > len(raw) - 4:
        raise ValueError('Invalid Bakin resource table offset')
    cursor.pos = table
    count = cursor.number('<I')
    if count > 1000000:
        raise ValueError('Invalid Bakin resource count')
    headers, seen = [], {name.casefold() for name, _, _ in zipped}
    for _ in range(count):
        name = valid_name(cursor.string(True))
        packed, original = cursor.number('<Q'), cursor.number('<Q')
        if name.casefold() in seen or original > MAX_MEMBER or packed > MAX_MEMBER:
            raise ValueError('Duplicate or oversized Bakin resource: ' + name)
        seen.add(name.casefold())
        headers.append((name, packed, original))
    resources = []
    for name, packed, original in headers:
        data = cursor.take(packed)
        if packed != original:
            decoder = zlib.decompressobj()
            data = decoder.decompress(data, original + 1)
            if not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
                raise ValueError('Invalid Bakin compressed resource: ' + name)
        if len(data) != original:
            raise ValueError('Bakin resource length mismatch: ' + name)
        resources.append((name, crypt(data, KEY2), None))
    if cursor.pos != len(raw):
        raise ValueError('Trailing Bakin container data requires a format recipe')
    return {'kind': 'BKNPAK', 'modern': modern, 'title': title, 'zipped': [name for name, _, _ in zipped]}, zipped + resources


def bakin_write(layout, entries):
    zipped_names = set(layout['zipped'])
    zipped = [entry for entry in entries if entry[0] in zipped_names]
    resources = [entry for entry in entries if entry[0] not in zipped_names]
    output = bytearray(b'BKNPAK\0\1' + b'\0' * 8)
    title = layout['title'].encode('utf-8')
    if len(title) > 255:
        raise ValueError('Bakin loading title exceeds native length')
    if layout['modern']:
        output += bytes((bool(title),))
    if title or not layout['modern']:
        output += bytes((len(title),)) + title
    output += struct.pack('<I', 0) + b'\x10' + hashlib.md5(struct.pack('<I', 2525)).digest()
    zip_data = zip_write(zipped, True)
    output += struct.pack('<Q', len(zip_data))
    output += crypt(zip_data[8:], KEY1, len(output), True)
    struct.pack_into('<Q', output, 8, len(output) - 16)
    output += struct.pack('<I', len(resources))
    payloads = []
    for name, data, _ in resources:
        encoded_name = name.encode('utf-8')
        if len(encoded_name) > 255:
            raise ValueError('Bakin resource name exceeds native length')
        output += bytes((len(encoded_name),))
        output += crypt(encoded_name, KEY2, len(output), True)
        raw_data = crypt(data, KEY2, encode=True)
        compressed = zlib.compress(raw_data)
        payload = compressed if len(compressed) < len(raw_data) else raw_data
        output += struct.pack('<QQ', len(payload), len(raw_data))
        payloads.append(payload)
    return bytes(output) + b''.join(payloads)
