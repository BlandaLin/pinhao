"""SFNT metadata and Unicode cmap checks without a rendering dependency."""
from pathlib import Path
import struct


class Font:
    def __init__(self, path):
        self.path = Path(path)
        self.tables = {}
        size = self.path.stat().st_size
        with self.path.open('rb') as stream:
            head = stream.read(12)
            if len(head) != 12 or head[:4] not in (b'\0\1\0\0', b'OTTO', b'true'):
                raise ValueError('Choose a TTF or OTF font file')
            count = struct.unpack_from('>H', head, 4)[0]
            for _ in range(count):
                record = stream.read(16)
                if len(record) != 16:
                    raise ValueError('Truncated font table directory')
                tag, _, offset, length = struct.unpack('>4sIII', record)
                if tag in self.tables or offset < 12 + count * 16 or offset + length > size:
                    raise ValueError('Invalid font table bounds')
                self.tables[tag] = (offset, length)
        if not {b'name', b'cmap', b'maxp', b'head'} <= self.tables.keys() or not ({b'glyf', b'CFF ', b'CFF2'} & self.tables.keys()):
            raise ValueError('Choose a complete font with Unicode character and glyph tables')
        maxp, head = self.table(b'maxp'), self.table(b'head')
        if len(maxp) < 6 or len(head) < 54 or struct.unpack_from('>I', head, 12)[0] != 0x5F0F3CF5:
            raise ValueError('Invalid font glyph metadata')
        self.glyphs = struct.unpack_from('>H', maxp, 4)[0]
        self.cmaps = []
        cmap = self.table(b'cmap')
        if len(cmap) < 4:
            raise ValueError('Truncated Unicode character map')
        for index in range(struct.unpack_from('>H', cmap, 2)[0]):
            pos = 4 + index * 8
            if pos + 8 > len(cmap):
                raise ValueError('Truncated Unicode character map directory')
            platform, encoding, offset = struct.unpack_from('>HHI', cmap, pos)
            if not (platform == 0 or platform == 3 and encoding in (1, 10)):
                continue
            if offset + 4 > len(cmap):
                raise ValueError('Invalid Unicode character map offset')
            kind = struct.unpack_from('>H', cmap, offset)[0]
            if kind not in (4, 12):
                continue
            length_at = offset + (4 if kind == 12 else 2)
            if length_at + (4 if kind == 12 else 2) > len(cmap):
                raise ValueError('Truncated Unicode character map length')
            length = struct.unpack_from('>I' if kind == 12 else '>H', cmap, length_at)[0]
            if length < (16 if kind == 12 else 24) or offset + length > len(cmap):
                raise ValueError('Invalid Unicode character map length')
            subtable = cmap[offset:offset + length]
            if kind == 12 and 16 + struct.unpack_from('>I', subtable, 12)[0] * 12 > length:
                raise ValueError('Truncated Unicode character groups')
            if kind == 4 and 16 + struct.unpack_from('>H', subtable, 6)[0] // 2 * 8 > length:
                raise ValueError('Truncated Unicode character segments')
            self.cmaps.append((kind, subtable))
        if not self.glyphs or not self.cmaps:
            raise ValueError('Choose a font with a supported Unicode character map')

    def table(self, tag):
        offset, length = self.tables[tag]
        with self.path.open('rb') as stream:
            stream.seek(offset)
            return stream.read(length)

    def family(self):
        raw = self.table(b'name')
        if len(raw) < 6:
            raise ValueError('Truncated font family table')
        _, count, strings = struct.unpack_from('>HHH', raw)
        candidates = []
        for index in range(count):
            start = 6 + index * 12
            if start + 12 > len(raw):
                raise ValueError('Truncated font name record')
            platform, _, language, ident, length, offset = struct.unpack_from('>HHHHHH', raw, start)
            if ident not in (1, 16) or strings + offset + length > len(raw):
                continue
            try:
                text = raw[strings + offset:strings + offset + length].decode('utf-16-be' if platform in (0, 3) else 'mac_roman')
            except UnicodeError:
                continue
            if text.strip():
                candidates.append(((ident == 16, language in (0, 1033), platform == 3), text))
        if not candidates:
            raise ValueError('Font family name was not found')
        return max(candidates)[1]

    def contains(self, code):
        for kind, raw in self.cmaps:
            if kind == 12:
                count = struct.unpack_from('>I', raw, 12)[0]
                low, high = 0, count
                while low < high:
                    middle = (low + high) // 2
                    start, end, glyph = struct.unpack_from('>III', raw, 16 + middle * 12)
                    if code < start:
                        high = middle
                    elif code > end:
                        low = middle + 1
                    else:
                        if 0 < glyph + code - start < self.glyphs:
                            return True
                        break
            elif code <= 65535:
                count = struct.unpack_from('>H', raw, 6)[0] // 2
                for index in range(count):
                    end = struct.unpack_from('>H', raw, 14 + index * 2)[0]
                    start = struct.unpack_from('>H', raw, 16 + count * 2 + index * 2)[0]
                    if not start <= code <= end:
                        continue
                    delta = struct.unpack_from('>h', raw, 16 + count * 4 + index * 2)[0]
                    pos = 16 + count * 6 + index * 2
                    offset = struct.unpack_from('>H', raw, pos)[0]
                    if offset:
                        pos += offset + (code - start) * 2
                        if pos + 2 > len(raw):
                            return False
                        glyph = struct.unpack_from('>H', raw, pos)[0]
                        glyph = (glyph + delta) & 65535 if glyph else 0
                    else:
                        glyph = (code + delta) & 65535
                    if 0 < glyph < self.glyphs:
                        return True
        return False

    def coverage(self, texts):
        required = sorted({ord(char) for text in texts for char in text if not char.isspace() and ord(char) >= 32})
        missing = [code for code in required if not self.contains(code)]
        return {'status': 'passed' if not missing else 'missing_glyphs', 'required': len(required),
                'covered': len(required) - len(missing), 'missing': [f'U+{code:04X}' for code in missing],
                'missingPreview': ''.join(map(chr, missing[:80])), 'scope': 'selected_font_unicode_cmap',
                'runtimeFallbackVerified': False}
