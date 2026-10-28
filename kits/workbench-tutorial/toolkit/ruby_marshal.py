"""Read Marshal without loading Ruby classes; edit only string byte spans."""
from dataclasses import dataclass, field


@dataclass(eq=False)
class RString:
    raw: bytes
    start: int
    end: int
    index: int
    ivars: dict = field(default_factory=dict)

    def text(self):
        encoding = self.ivars.get('encoding')
        if isinstance(encoding, RString):
            encoding = encoding.raw.decode('ascii')
        return self.raw.decode('ascii' if self.ivars.get('E') is False else encoding or 'utf-8')


@dataclass(eq=False)
class RObject:
    name: str
    attrs: dict = field(default_factory=dict)
    data: object = None


def long_bytes(n):
    if n == 0:
        return b'\0'
    if 0 < n < 123:
        return bytes([n + 5])
    if -124 < n < 0:
        return bytes([(n - 5) & 255])
    for size in range(1, 5):
        if 0 <= n < 1 << (8 * size):
            return bytes([size]) + n.to_bytes(size, 'little')
        if -(1 << (8 * size)) <= n < 0:
            return bytes([256 - size]) + (n & ((1 << (8 * size)) - 1)).to_bytes(size, 'little')
    raise ValueError('Marshal integer out of range')


class Reader:
    def __init__(self, raw):
        self.raw, self.pos, self.objects, self.symbols, self.strings = raw, 2, [], [], []
        if raw[:2] != b'\x04\x08':
            raise ValueError('Not Marshal 4.8')
        self.root = self.read()
        if self.pos != len(raw):
            raise ValueError('Trailing Marshal bytes')

    def take(self, n):
        if n < 0 or self.pos + n > len(self.raw):
            raise ValueError('Invalid Marshal size')
        value = self.raw[self.pos:self.pos + n]
        self.pos += n
        return value

    def long(self):
        c = int.from_bytes(self.take(1), 'little', signed=True)
        if c == 0:
            return 0
        if c > 4:
            return c - 5
        if c < -4:
            return c + 5
        value = int.from_bytes(self.take(abs(c)), 'little')
        return value if c > 0 else value - (1 << (8 * -c))

    def register(self, value):
        self.objects.append(value)
        return value

    def link(self, table):
        index = self.long()
        if not 0 <= index < len(table):
            raise ValueError('Invalid Marshal link')
        return table[index]

    def pairs(self, target):
        count = self.long()
        if count < 0:
            raise ValueError('Invalid Marshal pair count')
        for _ in range(count):
            key = self.read()
            target[key] = self.read()

    def read(self):
        tag = self.take(1)
        if tag == b'0': return None
        if tag == b'T': return True
        if tag == b'F': return False
        if tag == b'i': return self.long()
        if tag == b':':
            value = self.take(self.long()).decode('utf-8')
            self.symbols.append(value)
            return value
        if tag == b';': return self.link(self.symbols)
        if tag == b'@': return self.link(self.objects)
        if tag == b'"':
            start = self.pos
            value = RString(self.take(self.long()), start, self.pos, len(self.objects))
            self.register(value)
            self.strings.append(value)
            return value
        if tag == b'I':
            value, attrs = self.read(), {}
            self.pairs(attrs)
            if isinstance(value, RString): value.ivars.update(attrs)
            elif isinstance(value, RObject): value.attrs.update(attrs)
            else: raise ValueError('Unsupported Marshal instance variables')
            return value
        if tag == b'[':
            result = self.register([])
            count = self.long()
            if count < 0: raise ValueError('Invalid Marshal array size')
            for _ in range(count): result.append(self.read())
            return result
        if tag in (b'{', b'}'):
            result = self.register({})
            self.pairs(result)
            if tag == b'}': self.read()
            return result
        if tag == b'o':
            value = self.register(RObject(self.read()))
            self.pairs(value.attrs)
            return value
        if tag in (b'u', b'U', b'd'):
            value = self.register(RObject(self.read()))
            value.data = self.take(self.long()) if tag == b'u' else self.read()
            return value
        if tag in (b'f', b'l', b'/', b'c', b'm', b'M'):
            if tag == b'l':
                value = RObject('bignum', data=(self.take(1), self.take(self.long() * 2)))
            else:
                value = RObject(tag.decode(), data=self.take(self.long()))
                if tag == b'/': self.take(1)
            return self.register(value)
        if tag in (b'e', b'C'):
            self.read()
            return self.read()
        raise ValueError('Unsupported Marshal tag %r at %d' % (tag, self.pos - 1))

    def patch(self, replacements):
        spans = []
        for string in self.strings:
            if string.index not in replacements: continue
            encoded = replacements[string.index].encode('utf-8')
            if string.ivars.get('E') is False and not encoded.isascii():
                raise ValueError('Chinese cannot replace an ASCII-only Marshal string')
            encoding = string.ivars.get('encoding')
            if encoding is not None and (not isinstance(encoding, RString) or
                                        encoding.raw.lower() not in (b'utf-8', b'utf8')):
                raise ValueError('Only UTF-8 Marshal reinsertion is supported')
            spans.append((string.start, string.end, long_bytes(len(encoded)) + encoded))
        if len(spans) != len(replacements):
            raise ValueError('Unknown Marshal string target')
        result, pos = [], 0
        for start, end, replacement in sorted(spans):
            result.extend((self.raw[pos:start], replacement))
            pos = end
        result.append(self.raw[pos:])
        return b''.join(result)


def structure(value, replacements=None, seen=None):
    seen = {} if seen is None else seen
    replacements = {} if replacements is None else replacements
    if isinstance(value, (RString, RObject, list, dict)):
        identity = id(value)
        if identity in seen: return ('ref', seen[identity])
        seen[identity] = len(seen)
    if isinstance(value, RString):
        return ('string', replacements.get(value.index, value.raw), structure(value.ivars, replacements, seen))
    if isinstance(value, RObject):
        return ('object', value.name, structure(value.attrs, replacements, seen), structure(value.data, replacements, seen))
    if isinstance(value, list): return ('array', tuple(structure(x, replacements, seen) for x in value))
    if isinstance(value, dict): return ('hash', tuple((structure(k, replacements, seen), structure(v, replacements, seen)) for k, v in value.items()))
    return value
