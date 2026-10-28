"""Read RPA2/RPA3 indexes with restricted pickle globals; scripts-only default."""
import io
import pickle
import zlib
from pathlib import Path

from rgss_archive import destination, safe_relative


def literal_bytes(value, encoding):
    if not isinstance(value, str) or encoding not in ('latin1', 'latin-1'):
        raise ValueError('Unsupported pickle byte conversion')
    return value.encode('latin-1')


class DataUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        # Python 3 protocol-2 byte literals use this one data-only conversion.
        if (module, name) == ('_codecs', 'encode'): return literal_bytes
        raise ValueError('Executable pickle global rejected: ' + module + '.' + name)

    def persistent_load(self, pid):
        raise ValueError('Persistent pickle reference rejected')


def read_index(path):
    size = path.stat().st_size
    with path.open('rb') as stream:
        line = stream.readline(128)
        fields = line.strip().split()
        if len(fields) not in (2, 3) or fields[0] not in (b'RPA-2.0', b'RPA-3.0'):
            raise ValueError('Only standard RPA2/RPA3 supported')
        if (fields[0] == b'RPA-3.0') != (len(fields) == 3): raise ValueError('Invalid RPA header')
        offset = int(fields[1], 16); key = int(fields[2], 16) if len(fields) == 3 else 0
        if not len(line) <= offset < size: raise ValueError('Invalid RPA index offset')
        stream.seek(offset)
        compressed = stream.read(32 * 1024 * 1024 + 1)
    if len(compressed) > 32 * 1024 * 1024: raise ValueError('RPA index too large for starter profile')
    decoder = zlib.decompressobj()
    raw = decoder.decompress(compressed, 64 * 1024 * 1024 + 1)
    if len(raw) > 64 * 1024 * 1024 or decoder.unconsumed_tail or not decoder.eof or decoder.unused_data:
        raise ValueError('Oversized/incomplete RPA index')
    index = DataUnpickler(io.BytesIO(raw), encoding='bytes').load()
    if not isinstance(index, dict): raise ValueError('RPA index must be a dictionary')
    entries, seen = [], set()
    for name, pieces in index.items():
        if isinstance(name, bytes): name = name.decode('utf-8')
        if not isinstance(name, str): raise ValueError('Invalid RPA resource name')
        name = safe_relative(name)
        if name.casefold() in seen: raise ValueError('Duplicate RPA path')
        seen.add(name.casefold())
        if not isinstance(pieces, list) or not pieces: raise ValueError('Invalid RPA resource pieces')
        validated = []
        for piece in pieces:
            if not isinstance(piece, tuple) or len(piece) not in (2, 3): raise ValueError('Invalid RPA piece')
            start, length = piece[:2]
            if type(start) is not int or type(length) is not int: raise ValueError('Invalid RPA range')
            start, length = start ^ key, length ^ key
            prefix = piece[2] if len(piece) == 3 else b''
            if isinstance(prefix, str): prefix = prefix.encode('latin-1')
            if not isinstance(prefix, bytes) or start < len(line) or length < 0 or start + length > offset:
                raise ValueError('RPA payload outside data region')
            validated.append((start, length, prefix))
        entries.append((name, validated))
    return entries


def unpack(archive, output, all_resources=False):
    archive, output = Path(archive).resolve(), Path(output).resolve()
    if output.exists() or output.is_relative_to(archive.parent): raise ValueError('Use a fresh directory outside original archive location')
    entries = read_index(archive)
    selected = [e for e in entries if all_resources or Path(e[0]).suffix.lower() in ('.rpy', '.rpyc')]
    if not selected: raise ValueError('No RenPy script resources found')
    for name, _ in selected: destination(output, name)
    output.mkdir(parents=True)
    written = 0
    with archive.open('rb') as stream:
        for name, pieces in selected:
            path = destination(output, name); path.parent.mkdir(parents=True, exist_ok=True)
            with path.open('xb') as target:
                for start, remaining, prefix in pieces:
                    target.write(prefix); written += len(prefix); stream.seek(start)
                    while remaining:
                        chunk = stream.read(min(remaining, 65536))
                        if not chunk: raise ValueError('Truncated RPA payload')
                        target.write(chunk); written += len(chunk); remaining -= len(chunk)
    return {'files': len(selected), 'bytes': written, 'all_resources': all_resources,
            'status': 'unpacked_not_decompiled_not_runtime_tested'}
