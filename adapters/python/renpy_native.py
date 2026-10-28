"""Recover standard compiled Ren'Py scripts without executing their pickle globals."""
from __future__ import annotations

import ast
import collections
import contextlib
import hashlib
import importlib.util
import io
from pathlib import Path
import pickletools
import re
import shutil
import struct
import sys
import tempfile
import textwrap
import zlib

from native_attempt import recovered_script

HEADER = b'RENPY RPC2'
MAX_SCRIPT = 128 * 1024 * 1024
UPSTREAM_COMMIT = '3ae8334ed71a05535927dcc559663d3aca51215b'
_DECOMPILER = None


def _decompiler():
    global _DECOMPILER
    if _DECOMPILER is None:
        package = Path(__file__).parent / 'vendor' / 'unrpyc' / 'decompiler'
        spec = importlib.util.spec_from_file_location('_pinhao_unrpyc', package / '__init__.py',
                                                     submodule_search_locations=[str(package)])
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        _DECOMPILER = module
    return _DECOMPILER


def _inflate(raw):
    decoder = zlib.decompressobj()
    result = decoder.decompress(raw, MAX_SCRIPT + 1)
    if len(result) > MAX_SCRIPT or decoder.unconsumed_tail or not decoder.eof or decoder.unused_data:
        raise ValueError('Oversized or incomplete compiled RenPy script')
    return result


def _slots(raw):
    if not raw.startswith(HEADER):
        return {1: raw}
    cursor, entries = len(HEADER), {}
    while cursor + 12 <= len(raw):
        slot, offset, length = struct.unpack_from('<III', raw, cursor)
        cursor += 12
        if slot == 0:
            break
        if slot in entries or slot > 1024 or length <= 0 or offset + length > len(raw):
            raise ValueError('Invalid compiled RenPy slot table')
        entries[slot] = (offset, length)
    else:
        raise ValueError('Unterminated compiled RenPy slot table')
    ranges = sorted(entries.values())
    if any(offset < cursor for offset, _ in ranges) or any(a + size > b for (a, size), (b, _) in zip(ranges, ranges[1:])):
        raise ValueError('Overlapping compiled RenPy slots')
    if 1 not in entries:
        raise ValueError('Compiled RenPy script has no source AST slot')
    return {slot: raw[offset:offset + length] for slot, (offset, length) in entries.items()}


def inspect_rpyc(path):
    path = Path(path)
    if not 0 < path.stat().st_size <= MAX_SCRIPT:
        raise ValueError('Compiled RenPy script size is unsupported')
    raw = path.read_bytes()
    slots = _slots(raw)
    payload = _inflate(slots[1])
    python2 = any(op.name in ('BINSTRING', 'SHORT_BINSTRING', 'STRING') for op, _, _ in pickletools.genops(payload))
    return {'format': 'rpyc2' if raw.startswith(HEADER) else 'rpyc1', 'slots': sorted(slots),
            'python2': python2, 'sha256': hashlib.sha256(raw).hexdigest()}


def _load_ast(payload):
    decompiler = _decompiler()
    magic, compat = decompiler.renpycompat.magic, decompiler.renpycompat

    class ScriptUnpickler(magic.SafeUnpickler):
        def find_class(self, module, name):
            if (module, name) in (('collections', 'OrderedDict'), ('collections', 'defaultdict')):
                return getattr(collections, name)
            if (module, name) == ('_codecs', 'encode'):
                def literal_bytes(value, encoding, errors='strict'):
                    if not isinstance(value, str) or encoding not in ('latin1', 'latin-1') or errors != 'strict':
                        raise ValueError('Unsupported pickle byte conversion')
                    return value.encode('latin-1')
                return literal_bytes
            containers = {'set': set, 'frozenset': frozenset, 'list': list, 'tuple': tuple,
                          'dict': dict, 'str': str, 'unicode': str, 'bytes': bytes}
            if module in ('builtins', '__builtin__') and name in containers:
                return containers[name]
            if module.startswith('renpy.') and re.fullmatch(r'[A-Za-z_]\w*', name):
                return compat.CLASS_FACTORY(name, module)
            raise ValueError('Executable compiled-script pickle global rejected: ' + module + '.' + name)

        def persistent_load(self, value):
            raise ValueError('Persistent compiled-script pickle reference rejected')

        def get_extension(self, code):
            raise ValueError('Compiled-script pickle extension rejected')

    # Reject these even when the process already has a pickle extension cached.
    for opcode, _, _ in pickletools.genops(payload):
        if opcode.name in ('EXT1', 'EXT2', 'EXT4', 'PERSID', 'BINPERSID'):
            raise ValueError('Compiled-script pickle extension/reference rejected')
    document = ScriptUnpickler(io.BytesIO(payload), compat.CLASS_FACTORY, encoding='ASCII', errors='strict').load()
    if not isinstance(document, tuple) or len(document) != 2 or not isinstance(document[0], dict) or not isinstance(document[1], list):
        raise ValueError('Compiled RenPy script must contain metadata and an AST list')
    return document


def decompile(path):
    path = Path(path)
    if not 0 < path.stat().st_size <= MAX_SCRIPT:
        raise ValueError('Compiled RenPy script size is unsupported')
    payload = _inflate(_slots(path.read_bytes())[1])
    metadata, statements = _load_ast(payload)
    stream, messages = io.StringIO(), []
    _decompiler().pprint(stream, statements, _decompiler().Options(log=messages, init_offset=False))
    text = stream.getvalue()
    if not text.strip() or '<<<COULD NOT DECOMPILE:' in text or any('could not decompile' in str(item).lower() for item in messages):
        raise ValueError('Compiled RenPy statements require an additional decompiler recipe')
    return text, metadata, messages


def recover_script(path, name, attempt=None, cache_dir=None, origin='loose'):
    codec = 'unrpyc:' + UPSTREAM_COMMIT
    input_hash = None
    try:
        input_hash = hashlib.sha256(Path(path).read_bytes()).hexdigest()
        if cache_dir is None:
            text, metadata, warnings = decompile(path)
            reused = False
        else:
            text, metadata, warnings, reused, input_hash = recovered_script(path, cache_dir, decompile, codec)
        if attempt:
            material = attempt.material(origin + '\0' + name, text)
            attempt.resource(origin + ':' + name, file=name, origin=origin, phase='decompile',
                             status='extracted_unverified', inputSha256=input_hash, codec=codec,
                             material=material, reused=reused)
        return text, metadata, warnings
    except Exception as error:
        if attempt:
            attempt.resource(origin + ':' + name, file=name, origin=origin, phase='decompile', status='failed',
                             inputSha256=input_hash,
                             error={'code': getattr(error, 'code', None) or 'RENPY_DECOMPILE_FAILED', 'message': str(error)})
        raise


def recover_sources(root, attempt=None, cache_dir=None):
    """Recover missing RPY files in an already copied/unpacked game directory."""
    root = Path(root)
    pending, messages, failures = [], [], []
    for path in sorted((root / 'game').rglob('*.rpyc')):
        rel = path.relative_to(root).as_posix()
        if path.with_suffix('.rpy').exists() or '/cache/' in rel or '/saves/' in rel:
            continue
        try:
            text, metadata, warnings = recover_script(path, rel, attempt, cache_dir)
            details = inspect_rpyc(path)
        except Exception as error:
            failures.append(error)
            continue
        pending.append((path.with_suffix('.rpy'), text, {**details, 'file': rel,
                        'sourceSha256': hashlib.sha256(text.encode('utf-8')).hexdigest(),
                        'scriptVersion': metadata.get('version')}))
        messages.extend({'file': rel, 'message': str(message)} for message in warnings)
    # Investigation evidence is durable, but an incomplete script tree is not publishable.
    if failures:
        raise failures[0]
    for path, text, _ in pending:
        path.write_text(text, encoding='utf-8', newline='\n')
    return {'decompiled': [details for _, _, details in pending], 'warnings': messages,
            'tool': {'name': 'unrpyc', 'commit': UPSTREAM_COMMIT}}


def _literal(text, offset):
    match = re.match(r'''(?:[uU])?("""|''' + "'''" + r'''|"|')''', text[offset:])
    if not match:
        return None
    quote = match[1]
    cursor = offset + match.end()
    while cursor < len(text):
        if text[cursor] == '\\':
            cursor += 2
        elif text.startswith(quote, cursor):
            end = cursor + len(quote)
            try:
                value = ast.literal_eval(text[offset:end])
            except (SyntaxError, ValueError):
                value = None
            return (value, end) if isinstance(value, str) else None
        else:
            cursor += 1
    return None


def collect_extra_entries(text, collector, file):
    """Collect explicit translation markers and static Python Character names."""
    import text_formats as formats
    cursor = 0
    while cursor < len(text):
        if text[cursor] == '#':
            newline = text.find('\n', cursor)
            cursor = len(text) if newline < 0 else newline + 1
            continue
        literal = _literal(text, cursor)
        if literal:
            cursor = literal[1]
            continue
        marker = None if cursor and (text[cursor - 1].isalnum() or text[cursor - 1] in '_.') else re.match(
            r'(?P<call>_|_p|__|Character|DynamicCharacter)\s*\(\s*(?:_\s*\(\s*)?', text[cursor:])
        if marker:
            begin = cursor + marker.end()
            value = _literal(text, begin)
            if value:
                source, end = value
                key = (file, (begin, end))
                if key not in collector.targets:
                    kind = 'speaker_name' if marker['call'].endswith('Character') else 'ui_text'
                    collector.add(file, formats.span(begin, end, 'quoted'), source, kind,
                                  {'line': text.count('\n', 0, begin) + 1, 'displayCall': marker['call']}, 'renpy')
                cursor = end
                continue
        cursor += 1


def _archive_reference(node):
    return isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == 'config' and node.attr == 'archives'


def _archive_statements(text):
    """Read archive configuration from init Python and literal RenPy defines."""
    statements, lines, index = [], text.splitlines(), 0
    while index < len(lines):
        line = lines[index]
        header = re.fullmatch(r'\s*init(?:\s+(-?\d+))?\s+python(?:\s+in\s+\w+)?\s*:\s*(?:#.*)?', line)
        if header:
            begin, index = index + 1, index + 1
            indentation = len(line) - len(line.lstrip())
            while index < len(lines) and (not lines[index].strip() or len(lines[index]) - len(lines[index].lstrip()) > indentation):
                index += 1
            body = '\n'.join(lines[begin:index])
            try:
                nodes = ast.parse(textwrap.dedent(body)).body
            except SyntaxError:
                if re.search(r'\bconfig\s*\.\s*archives\b', body):
                    raise ValueError('Archive configuration requires a Python-version-specific recipe') from None
                continue
            for node in nodes:
                if any(_archive_reference(value) for value in ast.walk(node)):
                    statements.append((int(header[1] or 0), begin + node.lineno, node))
            continue
        define = re.match(r'\s*define\s+config\.archives\s*=\s*(.+)', line)
        if define:
            try:
                node = ast.parse('config.archives = ' + define[1]).body[0]
            except SyntaxError:
                raise ValueError('Archive configuration requires a multiline define recipe') from None
            statements.append((0, index + 1, node))
        elif re.match(r'\s*(?:\$\s*)?config\s*\.\s*archives\b', line):
            raise ValueError('Runtime archive reordering requires an explicit engine recipe')
        index += 1
    return statements


def _configured_archives(scripts, default):
    operations = []
    for file, text in sorted(scripts.items()):
        operations.extend((priority, file, line, node) for priority, line, node in _archive_statements(text))
    result = list(default)
    for _, _, _, node in sorted(operations, key=lambda item: item[:3]):
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and _archive_reference(node.targets[0]):
            result = ast.literal_eval(node.value)
        elif isinstance(node, ast.AugAssign) and isinstance(node.op, ast.Add) and _archive_reference(node.target):
            result += ast.literal_eval(node.value)
        elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Attribute) and _archive_reference(node.value.func.value):
            call = node.value
            arguments = [ast.literal_eval(arg) for arg in call.args]
            if call.keywords or call.func.attr not in ('append', 'extend', 'insert', 'remove', 'reverse', 'sort'):
                raise ValueError('Dynamic archive configuration requires an explicit engine recipe')
            getattr(result, call.func.attr)(*arguments)
        else:
            raise ValueError('Conditional/dynamic archive configuration requires an explicit engine recipe')
        if not isinstance(result, list) or any(not isinstance(name, str) or '/' in name or '\\' in name or name in ('.', '..') for name in result):
            raise ValueError('Archive configuration must be a list of archive basenames')
    return result


def merge_archives(game, source, info, helpers, attempt=None, cache_dir=None):
    """Flatten standard RPA resources using RenPy's script and asset priorities."""
    import rpa_archive
    from rgss_archive import destination

    game, source = Path(game), Path(source)
    source.mkdir(parents=True)
    initial = sorted(info.get('archives', []), reverse=True)
    if attempt:
        attempt.document['loadingOrderStatus'] = 'unproven'
        attempt.save()
    archive_names = {Path(file).stem: file for file in initial}
    loose = {'game/' + name[5:]: path for name, path in helpers.files_in(game)
             if name.startswith('game/') and not helpers.excluded(name) and path.suffix.lower() != '.rpa'}
    with contextlib.ExitStack() as stack:
        folders = {}
        for file in initial:
            if attempt:
                attempt.resource(file, file=file, phase='unpack', status='unexamined', inputSha256=helpers.digest_file(game / file))
            temp = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix='pinhao-rpa-', dir=source.parent)))
            folder = temp / 'unpacked'
            for name, _ in rpa_archive.read_index(game / file):
                helpers.safe_member(name)
            rpa_archive.unpack(game / file, folder, all_resources=True)
            folders[file] = {'game/' + name: path for name, path in helpers.files_in(folder)
                             if not helpers.excluded('game/' + name)}
            if attempt:
                attempt.resource(file, phase='unpack', status='inspected', members=len(folders[file]))

        def select(order):
            selected = {}
            for file in order:
                for name, path in folders[file].items():
                    selected.setdefault(name.casefold(), (name, path, file))
            for name, path in loose.items():
                selected[name.casefold()] = (name, path, 'loose')
            return selected

        selected = select(initial)
        scripts, failures = {}, []
        for folded, (name, path, origin) in list(selected.items()):
            if path.suffix.lower() == '.rpy' and (origin == 'loose' or folded + 'c' not in selected):
                scripts[name] = path.read_text(encoding='utf-8-sig')
            elif path.suffix.lower() == '.rpyc':
                source_entry = selected.get(folded[:-1])
                if source_entry and source_entry[2] == 'loose':
                    continue
                try:
                    scripts[name[:-1]], _, _ = recover_script(path, name, attempt, cache_dir, origin)
                except Exception as error:
                    failures.append(error)
        if failures:
            raise failures[0]
        order = _configured_archives(scripts, [Path(file).stem for file in initial])
        resource_order = [archive_names[name] for name in order if name in archive_names]
        if attempt:
            attempt.document.update(loadingOrderStatus='proven-static', initialOrder=initial, resourceOrder=resource_order)
            attempt.save()
        resources = select(resource_order)
        # Script ASTs are loaded before init code changes config.archives.
        resources = {key: item for key, item in resources.items() if Path(item[0]).suffix.lower() not in ('.rpy', '.rpyc')}
        resources.update({key: item for key, item in selected.items() if Path(item[0]).suffix.lower() in ('.rpy', '.rpyc')})
        for folded, (name, path, origin) in list(resources.items()):
            # Archived source never replaces its compiled AST; loose source has loader priority.
            if path.suffix.lower() == '.rpy' and origin != 'loose' and folded + 'c' in resources:
                del resources[folded]
        for name, path, _ in resources.values():
            target = destination(source, name)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
        return {'format': 'rpa', 'initialOrder': initial, 'resourceOrder': resource_order,
                'files': len(resources), 'looseFiles': len(loose)}
