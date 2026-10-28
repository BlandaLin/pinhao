"""Godot PCK recovery and independent native-pack assembly via GDRETools."""
from __future__ import annotations

import ast
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tempfile

import rpgmaker as core
import text_formats as formats
from rgss_archive import destination, safe_relative
import asset_overlay
import adapter_overlay
from native_attempt import NativeAttempt

READY = 'native_godot_pack_roundtrip'
ROOT = Path(__file__).resolve().parents[2]
MAGIC = b'GDPC'
DISPLAY = r'text|title|placeholder_text|tooltip_text|hint_tooltip|dialog_text|item_\d+/text|tab_\d+/title'
DISPLAY_FIELDS = {'text', 'title', 'body', 'description', 'desc', 'caption', 'label',
                  'tooltip', 'hint', 'dialogue', 'dialog', 'message', 'prompt',
                  'say', 'pages', 'paragraphs', 'short', 'plea', 'summary'}
DISPLAY_CALLS = {'set_text': (0,), 'append_text': (0,), 'add_text': (0,),
                 'add_item': (0,), 'add_check_item': (0,), 'add_radio_check_item': (0,),
                 'set_item_text': (1,), 'set_tab_title': (1,), 'set_placeholder': (0,),
                 'set_tooltip': (0,), 'say': (0,), 'show_message': (0,), 'show_dialogue': (0,)}


def executable(root=ROOT):
    configured = os.environ.get('PINHAO_GDRE')
    paths = [Path(configured)] if configured else []
    paths.extend((Path(root) / 'local/dependencies/gdre/gdre_tools.exe',
                  Path(__file__).parent / 'vendor/gdre/gdre_tools.exe',
                  Path(__file__).parents[1] / 'dependencies/gdre/gdre_tools.exe'))
    return next((path.resolve() for path in paths if path.is_file()), None)


def run(exe, args, timeout=600, attempt=None):
    result = subprocess.run([str(exe), '--headless', *args], capture_output=True,
                            timeout=timeout, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    output = (result.stdout + result.stderr).decode('utf-8', errors='replace')
    if attempt:
        attempt.log('gdre-stdout.log', result.stdout)
        attempt.log('gdre-stderr.log', result.stderr)
    if result.returncode:
        raise ValueError('GDRETools failed: ' + output[-2400:])
    return output


def exact(stream, count):
    data = stream.read(count)
    if len(data) != count:
        raise ValueError('Truncated Godot PCK')
    return data


def integer(stream, size=4):
    return int.from_bytes(exact(stream, size), 'little')


def pack_start(stream):
    stream.seek(0, 2)
    size = stream.tell()
    stream.seek(0)
    if stream.read(4) == MAGIC:
        return 0
    if size >= 12:
        stream.seek(size - 12)
        length, magic = struct.unpack('<Q4s', stream.read(12))
        start = size - 12 - length
        if magic == MAGIC and start >= 0:
            stream.seek(start)
            if stream.read(4) == MAGIC:
                return start
    # Signed Windows exports keep their PCK in the PE section before the signature.
    stream.seek(0)
    if stream.read(2) == b'MZ' and size >= 64:
        stream.seek(60)
        pe = integer(stream)
        if pe <= size - 24:
            stream.seek(pe)
            if stream.read(4) == b'PE\0\0':
                stream.seek(pe + 6)
                count = integer(stream, 2)
                stream.seek(pe + 20)
                optional = integer(stream, 2)
                if count <= 96:
                    for index in range(count):
                        stream.seek(pe + 24 + optional + 40 * index)
                        section = exact(stream, 40)
                        if section[:8].rstrip(b'\0') == b'pck':
                            offset = struct.unpack_from('<I', section, 20)[0]
                            for shift in range(8):
                                stream.seek(offset + shift)
                                if stream.read(4) == MAGIC:
                                    return offset + shift
    return None


def pack_index(path, validate_path=safe_relative):
    """Read public PCK directory fields before invoking a recovery executable."""
    with Path(path).open('rb') as stream:
        size = Path(path).stat().st_size
        start = pack_start(stream)
        if start is None:
            raise ValueError('Godot PCK header was not found')
        stream.seek(start + 4)
        version, major, minor, patch = struct.unpack('<4I', exact(stream, 16))
        if version > 4 or major not in (2, 3, 4):
            raise ValueError('Unsupported Godot PCK format or engine version')
        flags, base = (integer(stream), integer(stream, 8)) if version >= 2 else (0, 0)
        if flags & 1:
            raise ValueError('Encrypted Godot directory requires its game-specific key recipe')
        if flags & 4:
            raise ValueError('Sparse Godot bundles require their base-pack recipe')
        if version >= 3 or version == 2 and flags & 2:
            base += start
        if version >= 3:
            directory = integer(stream, 8) + start
            if not start < directory < size:
                raise ValueError('Godot directory is outside its pack')
            stream.seek(directory)
        else:
            exact(stream, 64)
        count = integer(stream)
        if count > size // 36:
            raise ValueError('Invalid Godot PCK entry count')
        entries, seen = [], set()
        for _ in range(count):
            length = integer(stream)
            if length == 0 or length > 65536:
                raise ValueError('Invalid Godot resource path')
            raw = exact(stream, length).rstrip(b'\0')
            name = raw.decode('utf-8')
            if name.startswith('res://'):
                name = name[6:]
            name = validate_path(name)
            if name.casefold() in seen:
                raise ValueError('Duplicate Godot resource path: ' + name)
            seen.add(name.casefold())
            offset_field = stream.tell() - start
            offset, length = struct.unpack('<QQ', exact(stream, 16))
            md5 = exact(stream, 16).hex()
            entry_flags = integer(stream) if version >= 2 else 0
            if entry_flags & ~2:
                raise ValueError('Encrypted or delta Godot resource requires a specific recipe: ' + name)
            if entry_flags & 2:
                continue
            offset += base
            if offset < start or offset + length > size:
                raise ValueError('Godot resource is outside its pack: ' + name)
            entries.append({'file': name, 'offset': offset, 'bytes': length, 'md5': md5, 'offsetField': offset_field})
        files = {entry['file'].casefold() for entry in entries}
        if any(parent.as_posix().casefold() in files for entry in entries
               for parent in Path(entry['file']).parents if str(parent) != '.'):
            raise ValueError('Godot file/directory collision')
        return {'format': version, 'version': [major, minor, patch], 'offset': start, 'entries': entries}


def embed_pack(runtime, pack, output):
    """Attach a standalone pack and update the executable's public PCK metadata."""
    index = pack_index(pack)
    if index['offset']:
        raise ValueError('Embedding requires a standalone PCK')
    with runtime.open('rb') as source:
        previous = pack_start(source)
        end = previous if previous is not None else runtime.stat().st_size
        source.seek(0)
        with output.open('xb') as target:
            remaining = end
            while remaining:
                data = exact(source, min(remaining, 1024 * 1024))
                target.write(data)
                remaining -= len(data)
            target.write(bytes(-end % 8))
            start = target.tell()
            with pack.open('rb') as resource:
                shutil.copyfileobj(resource, target, 1024 * 1024)
            size = target.tell() - start
            target.write(struct.pack('<Q4s', size, MAGIC))
    with output.open('r+b') as target:
        if index['format'] == 2:
            target.seek(start + 20)
            flags = integer(target)
            target.seek(start + 20)
            target.write(struct.pack('<I', flags | 2))
        elif index['format'] < 2:
            for entry in index['entries']:
                target.seek(start + entry['offsetField'])
                target.write(struct.pack('<Q', start + entry['offset']))
        target.seek(0)
        if target.read(2) != b'MZ':
            raise ValueError('Godot Windows output requires a PE runtime')
        target.seek(60)
        pe = integer(target)
        target.seek(pe)
        if exact(target, 4) != b'PE\0\0':
            raise ValueError('Invalid Godot Windows runtime')
        target.seek(pe + 6)
        sections = integer(target, 2)
        target.seek(pe + 20)
        optional_size = integer(target, 2)
        optional = pe + 24
        target.seek(optional)
        kind = integer(target, 2)
        # The original Authenticode signature no longer covers a modified resource pack.
        certificate = optional + (112 if kind == 0x20b else 96) + 8 * 4
        target.seek(certificate)
        target.write(bytes(8))
        for entry in range(sections):
            section = optional + optional_size + 40 * entry
            target.seek(section)
            if exact(target, 8).rstrip(b'\0') == b'pck':
                target.seek(section + 8)
                target.write(struct.pack('<I', 8))
                target.seek(section + 16)
                target.write(struct.pack('<II', size + 12, start))
                break
    return pack_index(output)


def probe(game):
    candidates = []
    for path in sorted(game.glob('*.pck')):
        try:
            index = pack_index(path)
            candidates.append((path, index))
        except ValueError:
            continue
    if not any(any(entry['file'] in ('project.binary', 'project.godot', 'engine.cfb', 'engine.cfg')
                   for entry in index['entries']) for _, index in candidates):
        for path in sorted(game.glob('*.exe')):
            try:
                index = pack_index(path)
                candidates.append((path, index))
            except ValueError:
                continue
    if candidates:
        main = [(path, index) for path, index in candidates
                if any(entry['file'] in ('project.binary', 'project.godot', 'engine.cfb', 'engine.cfg') for entry in index['entries'])]
        if len(main) != 1:
            return {'engine': 'Godot', 'root': '.', 'support': 'godot_pack_selection_required'}
        path, index = main[0]
        return {'engine': 'Godot', 'root': '.', 'support': READY if executable() else 'godot_codec_required',
                'archives': [path.name], 'packed': True, 'archiveFormat': 'godot',
                'additionalArchives': [other.name for other in sorted(game.glob('*.pck')) if other != path],
                'embedded': path.suffix.lower() == '.exe', 'version': '.'.join(map(str, index['version']))}
    if (game / 'project.godot').is_file() or (game / 'engine.cfg').is_file():
        return {'engine': 'Godot', 'root': '.', 'support': READY if executable() else 'godot_codec_required',
                'packed': False, 'archives': [], 'archiveFormat': 'godot'}
    if any(game.glob('*.pck')):
        return {'engine': 'Godot', 'root': '.', 'support': 'godot_invalid_or_encrypted_pack'}
    return None


def unpack(path, output, helpers, *, names=None):
    index = pack_index(path, helpers.safe_member)
    requested = None if names is None else set(names)
    if requested is not None and requested - {entry['file'] for entry in index['entries']}:
        raise ValueError('Requested Godot member is missing')
    output.mkdir(parents=True)
    with path.open('rb') as stream:
        for entry in index['entries']:
            if requested is not None and entry['file'] not in requested:
                continue
            target = destination(output, entry['file'])
            target.parent.mkdir(parents=True, exist_ok=True)
            stream.seek(entry['offset'])
            remaining, md5 = entry['bytes'], hashlib.md5()
            with target.open('xb') as dest:
                while remaining:
                    data = exact(stream, min(remaining, 1024 * 1024))
                    remaining -= len(data)
                    md5.update(data)
                    dest.write(data)
            if md5.hexdigest() != entry['md5']:
                raise ValueError('Godot resource checksum mismatch: ' + entry['file'])
    return index


def legacy_remaps(pack, index, source):
    """Godot 2 stores export aliases in StringArray project settings."""
    entry = next((entry for entry in index.get('entries', []) if entry['file'] == 'engine.cfb'), None)
    if pack and entry:
        with pack.open('rb') as stream:
            stream.seek(entry['offset'])
            raw = exact(stream, entry['bytes'])
        if hashlib.md5(raw).hexdigest() != entry['md5']:
            raise ValueError('Godot 2 configuration checksum mismatch')
    elif (source / 'engine.cfb').is_file():
        raw = (source / 'engine.cfb').read_bytes()
    else:
        text = (source / 'engine.cfg').read_text(encoding='utf-8-sig')
        section, values = '', {}
        for line in text.splitlines():
            if line.startswith('['):
                section = line.strip('[] ')
            if section == 'remap' and '=' in line:
                key, value = line.split('=', 1)
                parsed = ast.literal_eval(value.strip())
                if isinstance(parsed, list) and all(isinstance(item, str) for item in parsed):
                    values[key.strip()] = parsed
        return values
    stream = io.BytesIO(raw)
    if exact(stream, 4) != b'ECFG':
        raise ValueError('Invalid Godot 2 project settings')
    values = {}
    for _ in range(integer(stream)):
        key = exact(stream, integer(stream)).decode('utf-8')
        value = exact(stream, integer(stream))
        if not key.startswith('remap/'):
            continue
        array = io.BytesIO(value)
        if integer(array) != 25:
            raise ValueError('Godot 2 export remap requires a StringArray')
        items = []
        for _ in range(integer(array)):
            length = integer(array)
            items.append(exact(array, length).rstrip(b'\0').decode('utf-8'))
            exact(array, -length % 4)
        if len(items) % 2:
            raise ValueError('Godot 2 export remap has an unpaired path')
        values[key[6:]] = items
    return values


def value_at(text, start):
    quote = next((quote for quote in ('"""', "'''", '"', "'") if text.startswith(quote, start)), None)
    if not quote:
        return None
    cursor = start + len(quote)
    parts, segment = [], start
    while cursor < len(text):
        if text[cursor] == '\\':
            cursor += 3 if text[cursor + 1:cursor + 3] == '\r\n' else 2
        elif text.startswith(quote, cursor):
            end = cursor + len(quote)
            try:
                return ast.literal_eval(''.join(parts) + text[segment:end]), end
            except (ValueError, SyntaxError):
                return None
        elif len(quote) == 1 and text[cursor] in '\r\n':
            # Godot text resources allow physical newlines in ordinary quotes.
            parts.extend((text[segment:cursor], '\\r' if text[cursor] == '\r' else '\\n'))
            cursor += 1
            segment = cursor
        else:
            cursor += 1
    return None


def scene_entries(text, collector, file):
    node = ''
    for line in re.finditer(r'[^\n]*\n|[^\n]+$', text):
        if line[0].startswith('[node '):
            node = line[0].strip()
        display = re.match(r'\s*(' + DISPLAY + r')\s*=\s*', line[0])
        if not display:
            continue
        offset = line.start() + display.end()
        value = value_at(text, offset)
        if value:
            source, end = value
            collector.add(file, formats.span(offset, end, 'quoted'), source, 'ui_text',
                          {'node': node, 'property': display[1], 'line': text.count('\n', 0, offset) + 1}, 'renpy')


def configuration_entries(text, collector, file):
    section = ''
    for line in re.finditer(r'[^\n]*\n|[^\n]+$', text):
        header = re.match(r'\[([^\]]+)\]', line[0])
        if header:
            section = header[1]
        title = re.match(r'\s*(?:config/name|name)\s*=\s*', line[0]) if section == 'application' else None
        if title:
            start = line.start() + title.end()
            value = value_at(text, start)
            if value:
                collector.add(file, formats.span(start, value[1], 'quoted'), value[0], 'game_title',
                              {'section': section, 'property': 'name', 'line': text.count('\n', 0, start) + 1})


def call_arguments(text, start):
    result, cursor, beginning, nesting = [], start, start, []
    while cursor < len(text):
        if text[cursor] in ('"', "'"):
            value = value_at(text, cursor)
            if value is None:
                return None
            cursor = value[1]
            continue
        char = text[cursor]
        if char == ')' and not nesting:
            result.append((beginning, cursor))
            return result
        if char == ',' and not nesting:
            result.append((beginning, cursor))
            beginning = cursor + 1
        elif char in '([{':
            nesting.append(char)
        elif char in ')]}':
            if not nesting or nesting.pop() != {')': '(', ']': '[', '}': '{'}[char]:
                return None
        cursor += 1
    return None


def script_literals(text):
    """Keep source offsets while removing strings and comments from code matching."""
    literals, masked, cursor = [], list(text), 0
    while cursor < len(text):
        quoted = False
        if text[cursor] == '#':
            end = text.find('\n', cursor)
            end = len(text) if end < 0 else end
        elif text[cursor] in ('"', "'"):
            value = value_at(text, cursor)
            if not value:
                cursor += 1
                continue
            literals.append((cursor, value[1], value[0]))
            end = value[1]
            quoted = True
        else:
            cursor += 1
            continue
        masked[cursor:end] = [' ' for _ in text[cursor:end]]
        if quoted:
            masked[cursor] = '\0'
        cursor = end
    return literals, ''.join(masked)


def display_wrappers(scripts):
    """Infer custom helper parameters directly forwarded to a Godot text property."""
    definitions = {}
    for text in scripts:
        _, masked = script_literals(text)
        headers = list(re.finditer(r'^([ \t]*)(?:static\s+)?func\s+(\w+)\s*\(', masked, re.M))
        for index, header in enumerate(headers):
            arguments = call_arguments(masked, header.end())
            if not arguments:
                continue
            following = next((item.start() for item in headers[index + 1:]
                              if len(item[1]) <= len(header[1])), len(text))
            body = masked[arguments[-1][1] + 1:following]
            params = []
            for begin, end in arguments:
                param = re.match(r'\s*(\w+)', masked[begin:end])
                params.append(param[1] if param else '')
            visible = set()
            for number, name in enumerate(params):
                if name and re.search(r'\.(?:' + DISPLAY + r')\s*=\s*' + re.escape(name) + r'\b', body):
                    visible.add(number)
            definitions.setdefault(header[2], []).append(visible)
    return {name: tuple(sorted(set.intersection(*uses))) for name, uses in definitions.items()
            if set.intersection(*uses)}


def expression_end(masked, start):
    nesting = []
    for cursor in range(start, len(masked)):
        char = masked[cursor]
        if not nesting and char in ',\n)]}':
            return cursor
        if char in '([{':
            nesting.append(char)
        elif char in ')]}':
            if not nesting or nesting.pop() != {')': '(', ']': '[', '}': '{'}[char]:
                return cursor
    return len(masked)


def display_value(value):
    return (isinstance(value, str) and bool(value.strip())
            and not re.match(r'^(?:res|user)://|^[a-z]+://|^#[0-9a-fA-F]{3,8}$', value)
            and not re.fullmatch(r'[\w./\\-]+\.(?:png|jpe?g|webp|svg|ogg|wav|mp3|ttf|otf|gd|tscn|tres|cfg)', value, re.I))


def prose_value(value):
    return display_value(value) and (bool(re.search(r'[^\x00-\x7f]', value))
                                     or bool(re.search(r'\b[A-Za-z]+\s+[A-Za-z]+\b', value)))


def script_entries(text, collector, file, messages, wrappers=None):
    literals, masked = script_literals(text)
    selected, catalog_spans = {}, set()

    def select(begin, end, evidence, nested=False):
        # Conditional tests, dictionary keys and lookup indices retain their game identities.
        condition = re.search(r'\bif\b([\s\S]*?)\belse\b', masked[begin:end])
        ignored = []
        if condition:
            ignored.append((begin + condition.start(), begin + condition.end()))
        for call in re.finditer(r'\b(\w+)\s*\(', masked[begin:end]):
            if call[1] in ('str', 'String', 'format', 'join', 'capitalize', 'to_upper', 'to_lower'):
                continue
            arguments = call_arguments(masked, begin + call.end())
            if arguments:
                ignored.append((begin + call.end(), min(end, arguments[-1][1])))
        for start, finish, value in literals:
            if not begin <= start < finish <= end or (start, finish) in catalog_spans:
                continue
            if any(a <= start < b for a, b in ignored):
                continue
            before, after = masked[begin:start], masked[finish:end]
            if re.match(r'\s*:', after) or re.search(r'[\w\]\)]\s*\[\s*$', before):
                continue
            if start and text[start - 1] in '&^':
                continue
            if display_value(value) and (not nested or prose_value(value) or value[:1].isupper()):
                selected.setdefault((start, finish), (value, evidence))

    # Explicit tr() calls become catalog values. Their original message keys stay intact.
    for call in re.finditer(r'\b(tr|tr_n)\s*\(\s*', masked):
        arguments = call_arguments(masked, call.end())
        if not arguments:
            continue
        catalog_spans.update((a, b) for a, b, _ in literals
                             if call.end() <= a < b <= arguments[-1][1])
        def literal(number):
            if number >= len(arguments):
                return None
            begin, finish = arguments[number]
            begin += len(text[begin:finish]) - len(text[begin:finish].lstrip())
            value = value_at(text, begin)
            return value[0] if value and not text[value[1]:finish].strip() else None
        source = literal(0)
        if source is None:
            collector.review.append({'file': file, 'line': text.count('\n', 0, call.start()) + 1,
                                     'kind': 'dynamic_translation_message'})
            continue
        context, plural = '', None
        if call[1] == 'tr_n':
            plural = literal(1)
            if plural is None or len(arguments) < 3:
                continue
        context_index = 3 if call[1] == 'tr_n' else 1
        if len(arguments) > context_index:
            context = literal(context_index)
            if context is None:
                collector.review.append({'file': file, 'line': text.count('\n', 0, call.start()) + 1,
                                         'kind': 'dynamic_translation_context'})
                continue
        key = (source, context, plural)
        messages.setdefault(key, []).append({'file': file, 'line': text.count('\n', 0, call.start()) + 1})
    for display in re.finditer(r'\.(?:' + DISPLAY + r')\s*=(?!=)\s*', masked):
        select(display.end(), expression_end(masked, display.end()), 'display_property')
    calls = {**DISPLAY_CALLS, **(wrappers or display_wrappers([text]))}
    for call in re.finditer(r'\b(\w+)\s*\(', masked):
        if call[1] not in calls or re.search(r'\bfunc\s*$', masked[max(0, call.start() - 20):call.start()]):
            continue
        arguments = call_arguments(masked, call.end())
        if arguments:
            for number in calls[call[1]]:
                if number < len(arguments):
                    select(*arguments[number], 'display_call:' + call[1])
    for start, end, field in literals:
        if field not in DISPLAY_FIELDS or not re.match(r'\s*:', masked[end:]):
            continue
        begin = end + re.match(r'\s*:\s*', masked[end:]).end()
        select(begin, expression_end(masked, begin), 'display_field:' + field,
               nested=masked[begin:begin + 1] in '[{')
    for (start, end), (source, evidence) in sorted(selected.items()):
        collector.add(file, formats.span(start, end, 'quoted'), source, 'script_display',
                      {'line': text.count('\n', 0, start) + 1, 'evidence': evidence}, 'renpy')
    candidates = []
    for start, end, value in literals:
        if (start, end) not in selected and (start, end) not in catalog_spans and prose_value(value):
            if re.match(r'\s*:', masked[end:]):
                continue
            candidates.append({'file': file, 'line': text.count('\n', 0, start) + 1,
                               'kind': 'godot_script_literal_candidate', 'source': value,
                               'target': formats.span(start, end, 'quoted'),
                               'classification': script_candidate_kind(masked, start, end)})
        if isinstance(value, str) and value.startswith('res://') and value.endswith(('.json', '.csv', '.res', '.scn', '.gdc')):
            relative = safe_relative(value[6:])
            if not (collector.root / relative).is_file():
                candidates.append({'file': file, 'line': text.count('\n', 0, start) + 1,
                                   'kind': 'godot_missing_resource', 'resource': relative,
                                   'target': formats.span(start, end, 'quoted')})
    return candidates


def script_candidate_kind(masked, start, end):
    line = masked[masked.rfind('\n', 0, start) + 1:start]
    if re.search(r'\b(?:print|prints|print_debug|printerr|push_warning|push_error|assert)\s*\([^)]*$', line):
        return 'debug_output'
    if (re.search(r'(?:==|!=|\bin)\s*$', line) or re.match(r'\s*(?:==|!=)', masked[end:])
            or re.search(r'\.(?:has|has_method|has_signal|get_node|find_node|compile|connect|emit_signal)\s*\([^)]*$', line)):
        return 'logic_identity'
    return 'display_unresolved'


def json_display_entries(text, collector, file):
    """Bind JSON string leaves to exact spans; keys and structural fields stay unchanged."""
    decoder, leaves = json.JSONDecoder(), []
    whitespace = re.compile(r'\s*')

    def visit(cursor, path, depth=0):
        if depth > 128:
            raise ValueError('Godot JSON nesting exceeds the supported resource depth')
        cursor = whitespace.match(text, cursor).end()
        if cursor >= len(text):
            raise ValueError('Truncated Godot JSON resource')
        if text[cursor] not in '[{':
            value, end = decoder.raw_decode(text, cursor)
            if isinstance(value, str):
                leaves.append((path, cursor, end, value))
            return value, end
        container = text[cursor]
        result = {} if container == '{' else []
        cursor += 1
        while True:
            cursor = whitespace.match(text, cursor).end()
            if text[cursor:cursor + 1] == ('}' if container == '{' else ']'):
                return result, cursor + 1
            if container == '{':
                key, cursor = decoder.raw_decode(text, cursor)
                if not isinstance(key, str) or key in result:
                    raise ValueError('Godot JSON requires unique string keys')
                cursor = whitespace.match(text, cursor).end()
                if text[cursor:cursor + 1] != ':':
                    raise ValueError('Godot JSON object separator is missing')
                value, cursor = visit(cursor + 1, path + [key], depth + 1)
                result[key] = value
            else:
                value, cursor = visit(cursor, path + [len(result)], depth + 1)
                result.append(value)
            cursor = whitespace.match(text, cursor).end()
            if text[cursor:cursor + 1] == ',':
                cursor += 1
                continue
            if text[cursor:cursor + 1] != ('}' if container == '{' else ']'):
                raise ValueError('Godot JSON collection separator is missing')

    # Validate standard JSON before collecting any target, including trailing commas/data.
    json.loads(text)
    value, end = visit(0, [])
    if text[end:].strip():
        raise ValueError('Unexpected data after Godot JSON resource')
    candidates = []
    for path, start, end, source in leaves:
        field = next((part for part in reversed(path) if isinstance(part, str)), '')
        parent = core.at(value, path[:-1]) if path else None
        visible = field in DISPLAY_FIELDS or (field == 'name' and isinstance(parent, dict)
                                              and bool(set(parent) & DISPLAY_FIELDS))
        if visible and display_value(source):
            collector.add(file, formats.span(start, end, 'quoted'), source, 'data_display',
                          {'path': path, 'field': field}, 'renpy')
        elif prose_value(source):
            classification = ('resource_identity' if field in {'path', 'file', 'texture', 'image', 'cg', 'asset', 'script'}
                              else 'logic_identity' if field in {'id', 'trigger', 'type', 'mode', 'condition', 'tags', 'flags'}
                              else 'display_unresolved')
            candidates.append({'file': file, 'kind': 'godot_json_literal_candidate',
                               'source': source, 'path': path, 'target': formats.span(start, end, 'quoted'),
                               'classification': classification})
    return candidates


def message_catalog(source, collector, messages, current=None):
    if not messages:
        return
    path = source / '.pinhao/messages.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    lines, targets, cursor = ['[\n'], [], 2
    for index, ((key, context, plural), locations) in enumerate(sorted(messages.items(), key=lambda item: str(item[0]))):
        initial = (current or {}).get(key, key)
        fields = [('source', key), ('context', context), ('translation', initial)]
        if plural is not None:
            fields.extend((('pluralSource', plural), ('plural', plural)))
        prefix = '  {'
        line = prefix
        for field, value in fields:
            if line != prefix:
                line += ', '
            line += json.dumps(field) + ': '
            start = cursor + len(line)
            literal = json.dumps(value, ensure_ascii=False)
            line += literal
            if field in ('translation', 'plural'):
                targets.append((start, start + len(literal), value, field, locations, context))
        line += '}' + (',' if index + 1 < len(messages) else '') + '\n'
        lines.append(line)
        cursor += len(line)
    lines.append(']\n')
    path.write_bytes(''.join(lines).encode('utf-8'))
    file, _ = collector.document(path)
    for start, end, value, field, locations, context in targets:
        collector.add(file, formats.span(start, end, 'quoted'), value, 'translation_message',
                      {'locations': locations, 'message_context': context, 'plural': field == 'plural'}, 'renpy')


def translation_tables(source, messages, collector):
    values = {}
    for path in sorted(source.rglob('*.csv')):
        rel = path.relative_to(source).as_posix()
        if rel.startswith(('.godot/', '.import/', '.autoconverted/')):
            continue
        try:
            with path.open(encoding='utf-8-sig', newline='') as stream:
                rows = list(csv.reader(stream))
        except (UnicodeError, csv.Error):
            continue
        if not rows or len(rows[0]) < 2 or not all(re.fullmatch(r'[a-z]{2,3}(?:[_-][A-Za-z0-9]+)*', locale) for locale in rows[0][1:]):
            continue
        locales = rows[0]
        preferred = next((index for locale in ('zh_CN', 'zh_Hans', 'zh', 'en', 'en_US', 'ja', 'ja_JP')
                          for index, actual in enumerate(locales[1:], 1) if actual.replace('-', '_') == locale), 1)
        for number, row in enumerate(rows[1:], 2):
            if len(row) != len(locales) or not row[0] or not row[preferred].strip():
                continue
            key, current = row[0], row[preferred]
            if key in values and values[key] != current:
                raise ValueError('Conflicting Godot translation key requires its locale priority recipe: ' + key)
            values[key] = current
            messages.setdefault((key, '', None), []).append({'file': rel, 'line': number, 'locale': locales[preferred]})
    return values


def convert_image(exe, source, target, major, temp):
    script = temp / 'pinhao-texture.gd'
    if not script.is_file():
        shutil.copyfile(Path(__file__).parent / 'templates/godot_texture.gd.txt', script)
    target.parent.mkdir(parents=True, exist_ok=True)
    run(exe, ['--script', str(script), '--', str(source), str(target), str(major)])
    if not target.is_file() or not target.read_bytes().startswith(b'[gd_resource type="ImageTexture"'):
        raise ValueError('Godot image conversion did not produce an ImageTexture')


def is_managed(path):
    try:
        with path.open('rb') as stream:
            if exact(stream, 2) != b'MZ':
                return False
            stream.seek(60)
            pe = integer(stream)
            stream.seek(pe)
            if exact(stream, 4) != b'PE\0\0':
                return False
            stream.seek(pe + 24)
            kind = integer(stream, 2)
            if kind not in (0x10b, 0x20b):
                return False
            stream.seek(pe + 24 + (112 if kind == 0x20b else 96) + 14 * 8)
            return integer(stream) != 0 and integer(stream) != 0
    except (ValueError, OSError):
        return False


def extract(game, work, info, helpers, args):
    attempt = NativeAttempt(work, 'Godot', helpers, {'name': 'GDRETools', 'expectedVersion': '2.7.4'})
    try:
        result = _extract(game, work, info, helpers, args, attempt)
        partial = any(row.get('kind') == 'godot_recovery_partial' for row in result['reviewItems'])
        return {**result, 'nativeAttempt': attempt.finish('partial' if partial else 'complete')}
    except Exception as error:
        attempt.fail(error, 'recover')
        raise


def _extract(game, work, info, helpers, args, attempt):
    exe = executable(helpers.ROOT)
    if not exe:
        raise helpers.WorkerError('CODEC_MISSING', 'GDRETools is required for Godot resources')
    source = helpers.fresh(work.parent / (work.name + '-native-source'), (game, work))
    source_files = {rel: helpers.digest_file(path) for rel, path in helpers.files_in(game) if not helpers.excluded(rel)}
    attempt.document['inputs'] = source_files
    attempt.save()
    pack = game / info['archives'][0] if info.get('packed') else None
    if pack:
        index = pack_index(pack, helpers.safe_member)
        for entry in index['entries']:
            attempt.resource(entry['file'], file=entry['file'], archive=info['archives'][0],
                             phase='recover', status='unexamined')
        try:
            detail = run(exe, ['--recover=' + str(pack), '--output=' + str(source)], attempt=attempt)
        finally:
            log = source / 'gdre_export.log'
            if log.is_file():
                attempt.log('gdre_export.log', helpers.clean_path(log).read_bytes())
            attempt.recovered_files(source)
        for entry in index['entries']:
            rel = entry['file']
            aliases = [rel]
            if Path(rel).suffix.lower() in ('.gdc', '.gde'):
                aliases.append(str(Path(rel).with_suffix('.gd')).replace('\\', '/'))
            elif Path(rel).suffix.lower() in ('.scn', '.res'):
                aliases.append(str(Path(rel).with_suffix('.tscn' if rel.endswith('.scn') else '.tres')).replace('\\', '/'))
            recovered = next((name for name in aliases if (source / name).is_file()), None)
            attempt.resource(rel, status='extracted_unverified' if recovered else 'not_recovered',
                             recoveredFile=recovered, originalPreserved=True)
        configuration = source / ('engine.cfg' if index['version'][0] == 2 else 'project.godot')
        if not configuration.is_file():
            raise helpers.WorkerError('GODOT_RECOVERY_FAILED', 'Godot project configuration was not recovered')
        (source / 'gdre_export.log').unlink(missing_ok=True)
    else:
        shutil.copytree(game, source)
        legacy = not (source / 'project.godot').is_file()
        config = (source / ('engine.cfg' if legacy else 'project.godot')).read_text(encoding='utf-8-sig')
        feature = re.search(r'config/features\s*=\s*(?:PackedStringArray|PoolStringArray)\("(\d+)\.(\d+)', config)
        major, minor = map(int, feature.groups()) if feature else (2, 1) if legacy else (4, 0) if 'config_version=5' in config else (3, 0)
        index = {'format': 2 if major == 4 else 1 if major == 3 else 0, 'version': [major, minor, 0]}
        detail = ''
    for _ in helpers.files_in(source):
        pass
    collector = formats.Collector(source, 'Godot', 'spans', int(args.get('batchSize', 120)))
    configuration = source / ('engine.cfg' if index['version'][0] == 2 else 'project.godot')
    config_file, config_text = collector.document(configuration)
    configuration_entries(config_text, collector, config_file)
    messages, documents, candidates = {}, [], []
    for path in sorted(source.rglob('*')):
        if not path.is_file() or path.suffix.lower() not in ('.tscn', '.tres', '.gd', '.json'):
            continue
        rel = path.relative_to(source).as_posix()
        if rel.startswith(('.godot/', '.import/', '.autoconverted/', '.pinhao/')) or helpers.excluded(rel):
            continue
        file, text = collector.document(path)
        documents.append((path, file, text))
    wrappers = display_wrappers([text for path, _, text in documents if path.suffix.lower() == '.gd'])
    for path, file, text in documents:
        if path.suffix.lower() == '.gd':
            candidates.extend(script_entries(text, collector, file, messages, wrappers))
        elif path.suffix.lower() == '.json':
            try:
                candidates.extend(json_display_entries(text, collector, file))
            except (ValueError, RecursionError) as error:
                collector.review.append({'file': file, 'kind': 'godot_json_resource', 'message': str(error)[:300]})
        else:
            scene_entries(text, collector, file)
    current = translation_tables(source, messages, collector)
    message_catalog(source, collector, messages, current)
    recovery_summary = {name: int(match[1]) for name, pattern in (
        ('failedConversions', r'Failed conversions:\s+(\d+)'),
        ('scriptsNotDecompiled', r'Scripts not decompiled:\s+(\d+)'))
        if (match := re.search(pattern, detail))}
    attempt.document['recoverySummaryCounts'] = recovery_summary
    attempt.save()
    if re.search(r'Failed conversions:\s+[1-9]|Scripts not decompiled:\s+[1-9]', detail):
        collector.review.append({'kind': 'godot_recovery_partial', 'message': 'Some compiled resources need a recovery recipe',
                                 'diagnosticArtifactId': attempt.id})
    managed = [rel for rel, path in helpers.files_in(game)
               if path.suffix.lower() in ('.cs', '.csproj') or path.suffix.lower() == '.dll' and is_managed(path)]
    if managed:
        collector.review.append({'kind': 'godot_managed_code', 'files': managed,
                                 'message': 'Scene and translation resources are writable; managed-only literals retain their assembly'})
    if info.get('additionalArchives'):
        collector.review.append({'kind': 'godot_additional_packs', 'files': info['additionalArchives'],
                                 'message': 'Additional packs retain their original resources and need a separate load-order recipe'})
    report = collector.finish(work, allow_empty=args.get('allowEmpty') is True)
    manifest, sheets = core.load_work(work)
    fingerprint = core.sha(core.serialized(source_files))
    configuration = source / ('engine.cfg' if index['version'][0] == 2 else 'project.godot')
    remaps = legacy_remaps(pack, index, source) if index['version'][0] == 2 else {}
    helpers.json_write(work / 'technical/product-source.json', {
        'schema': 'pinhao-native-source-v1', 'engine': 'Godot', 'root': '.',
        'sourceFiles': source_files, 'sourceFingerprint': fingerprint, 'packed': bool(pack),
        'nativeSource': str(source), 'archives': info.get('archives', []),
        'godot': {'format': index['format'], 'version': index['version'],
                  'configuration': configuration.name,
                  'additionalArchives': info.get('additionalArchives', []),
                  'legacyRemaps': remaps,
                  'embedded': bool(info.get('embedded')), 'configurationSha256': helpers.digest_file(configuration),
                  'messageCatalog': '.pinhao/messages.json' if messages else None,
                  'recoverySummaryCounts': recovery_summary,
                  'recoveryWarnings': len(re.findall(r'Failed conversions:\s+[1-9]|Scripts not decompiled:\s+[1-9]', detail))}})
    rows = [{**row, 'legacyId': row['id'], 'file': manifest['units'][row['id']]['file']}
            for sheet in sheets.values() for row in sheet['units']]
    original_paths = {entry['file'] for entry in index.get('entries', [])}
    aliases = {path[6:] for items in remaps.values() for path in items[::2] if path.startswith('res://')}
    images = [{'file': rel, 'kind': 'image_candidate', 'writable': False}
              for rel, path in helpers.files_in(source) if path.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp')
              and not rel.startswith(('.godot/', '.import/', '.autoconverted/')) and not helpers.excluded(rel)
              and (not pack or rel in original_paths or rel + '.import' in original_paths
                   or rel + '.remap' in original_paths or rel in aliases)]
    helpers.json_write(work / 'image-inventory.json', images)
    resources = []
    unresolved = [item for item in candidates if item.get('classification', 'display_unresolved') == 'display_unresolved']
    candidate_files = {item['file'] for item in unresolved}
    image_files = {item['file'] for item in images}
    for rel, path in helpers.files_in(source):
        if rel.startswith(('.godot/', '.import/', '.autoconverted/', '.pinhao/')) or helpers.excluded(rel):
            continue
        units = collector.counts[rel]
        preserved = path.suffix.lower() in ('.wav', '.ogg', '.mp3', '.flac', '.ttf', '.otf', '.woff', '.woff2',
                                           '.gdshader', '.shader', '.glsl')
        status = ('display_candidates' if rel in candidate_files else 'text_extracted' if units
                  else 'text_scanned' if rel in collector.files else 'image_candidate' if rel in image_files
                  else 'asset_preserved' if preserved else 'format_unclassified')
        resources.append({'file': rel, 'bytes': path.stat().st_size, 'status': status, 'units': units})
    recovered_paths = {row['file'] for row in resources}
    for entry in index.get('entries', []):
        if entry['file'] not in recovered_paths:
            record = attempt.resources[entry['file']]
            resources.append({'file': entry['file'], 'status': 'format_unclassified', 'units': 0,
                              'recoveryStatus': record['status'], 'recoveredFile': record.get('recoveredFile'),
                              'originalPreserved': True, 'diagnosticArtifactId': attempt.id})
    coverage = {'schema': 'pinhao-extraction-coverage-v1', 'engine': 'Godot',
                'resources': resources, 'units': len(rows), 'dynamicCandidates': len(candidates),
                'unresolvedCandidates': len(unresolved),
                'recoverySummaryCounts': recovery_summary,
                'structuralRecoveryWarnings': len(re.findall(r'Failed conversions:\s+[1-9]|Scripts not decompiled:\s+[1-9]', detail))}
    helpers.json_write(work / 'extraction-coverage.json', coverage)
    helpers.json_write(work / 'dynamic-candidates.json', candidates)
    return {**report, 'engine': 'Godot', 'workDir': str(work), 'workspaceDir': str(work),
            'manifestPath': str(work / 'manifest.json'), 'sourceFingerprint': fingerprint,
            'units': rows, 'reviewItems': collector.review, 'dynamicCandidates': candidates, 'images': images,
            'coverage': coverage,
            'capabilities': helpers.capabilities('Godot')}


def config_setting(text, section, key, value, first=False):
    header = re.search(r'^\[' + re.escape(section) + r'\]\s*$', text, re.M)
    line = key + '=' + value + '\n'
    if not header:
        return text.rstrip() + '\n\n[' + section + ']\n\n' + line
    end = re.search(r'^\[', text[header.end():], re.M)
    finish = header.end() + end.start() if end else len(text)
    body = text[header.end():finish]
    body = re.sub(r'^' + re.escape(key) + r'\s*=.*\n?', '', body, flags=re.M)
    body = '\n' + line + body.lstrip('\r\n') if first else body.rstrip() + '\n' + line + '\n'
    return text[:header.end()] + body + text[finish:]


def runtime_script(major, catalog, font_name):
    script = ['extends Node', '', 'var chinese_font', '', 'func _enter_tree():']
    if catalog:
        if major >= 4:
            script.extend(['\tvar rows = JSON.parse_string(FileAccess.get_file_as_string("res://.pinhao/messages.json"))'])
        elif major == 3:
            script.extend(['\tvar file = File.new()', '\tfile.open("res://.pinhao/messages.json", File.READ)',
                           '\tvar rows = JSON.parse(file.get_as_text()).result', '\tfile.close()'])
        else:
            script.extend(['\tvar file = File.new()', '\tfile.open("res://.pinhao/messages.json", File.READ)',
                           '\tvar rows = str2var(file.get_as_text())', '\tfile.close()'])
        script.extend(['\tvar translated = Translation.new()', '\ttranslated.set_locale("zh_CN")', '\tfor row in rows:'])
        if major >= 4:
            script.extend(['\t\tif row.has("plural"):',
                           '\t\t\ttranslated.add_plural_message(row.source, PackedStringArray([row.translation, row.plural]), row.context)',
                           '\t\telse:', '\t\t\ttranslated.add_message(row.source, row.translation, row.context)'])
        else:
            script.append('\t\ttranslated.add_message(row.source, row.translation)')
        script.extend(['\tTranslationServer.add_translation(translated)', '\tTranslationServer.set_locale("zh_CN")'])
    if font_name:
        if major >= 4:
            script.extend(['\tchinese_font = FontFile.new()',
                           '\tchinese_font.data = FileAccess.get_file_as_bytes(' + json.dumps('res://.pinhao/' + font_name) + ')',
                           '\tThemeDB.fallback_font = chinese_font',
                           '\tget_tree().node_added.connect(_apply_font)'])
        else:
            script.extend(['\tvar data = DynamicFontData.new()',
                           '\tdata.set_font_path(' + json.dumps('res://.pinhao/' + font_name) + ')',
                           '\tchinese_font = DynamicFont.new()', '\tchinese_font.set_font_data(data)',
                           '\tchinese_font.set_size(20)',
                           '\tget_tree().connect("tree_changed", self, "_refresh_fonts")' if major == 2
                           else '\tget_tree().connect("node_added", self, "_apply_font")'])
        script.extend(['', 'func _apply_font(node):', '\tif node ' + ('extends' if major == 2 else 'is') + ' Control:',
                       '\t\tfor key in ["font", "normal_font", "bold_font", "italics_font", "bold_italics_font", "mono_font"]:',
                       '\t\t\tnode.' + ('add_theme_font_override' if major >= 4 else 'add_font_override') + '(key, chinese_font)'])
        if major == 2:
            script.extend(['', 'func _exit_tree():', '\tget_tree().disconnect("tree_changed", self, "_refresh_fonts")', '',
                           'func _refresh_fonts():', '\t_visit(get_tree().get_root())', '',
                           'func _visit(node):', '\t_apply_font(node)', '\tfor child in node.get_children():', '\t\t_visit(child)'])
    if not catalog and not font_name:
        script.append('\tpass')
    return '\n'.join(script) + '\n'


def assemble(args, helpers):
    game = helpers.clean_path(helpers.path_arg(args, 'gameDir'))
    work = helpers.clean_path(helpers.path_arg(args, 'workspaceDir', 'workDir'))
    built = helpers.clean_path(helpers.path_arg(args, 'buildDir'))
    output = helpers.fresh(helpers.path_arg(args, 'outputDir', 'outDir'), (game, work, built))
    manifest, _ = core.load_work(work)
    metadata = core.read(work / 'technical/product-source.json')
    helpers.source_unchanged(game, metadata)
    report = core.read(built / 'build-report.json')
    if report['manifest_sha256'] != helpers.digest_file(work / 'manifest.json'):
        raise helpers.WorkerError('WRONG_BUILD', 'Build belongs to another workbench revision')
    for rel, digest in report['files_sha256'].items():
        if helpers.digest_file(destination(built, rel)) != digest:
            raise helpers.WorkerError('BUILD_CHANGED', 'Built Godot resource changed: ' + rel)
    source = helpers.clean_path(Path(metadata['nativeSource']))
    config = source / metadata['godot'].get('configuration', 'project.godot')
    if helpers.digest_file(config) != metadata['godot']['configurationSha256']:
        raise helpers.WorkerError('SOURCE_CHANGED', 'Recovered Godot configuration changed')
    exe = executable(helpers.ROOT)
    if not exe:
        raise helpers.WorkerError('CODEC_MISSING', 'GDRETools is required for Godot resources')
    font = helpers.path_arg(args, 'fontPath') if args.get('fontPath') else None
    if font:
        helpers.font_family(font)
    inventory = {'engine': 'Godot', 'copied': 0, 'excluded': [], 'warnings': [], 'runtimeVerified': False,
                 'sourceFingerprint': metadata['sourceFingerprint'], 'nativeFiles': len(manifest['files'])}
    godot = metadata['godot']
    if godot.get('additionalArchives'):
        inventory['warnings'].append('Additional Godot packs retained unchanged: ' + ', '.join(godot['additionalArchives']))
    inventory['warnings'].extend(item['message'] for item in core.read(work / 'review-required.json')
                                 if item.get('kind') in ('godot_managed_code', 'godot_recovery_partial'))
    pack = game / metadata['archives'][0] if metadata['packed'] else None
    configured_runtime = os.environ.get('PINHAO_GODOT_RUNTIME') if not pack else None
    if not pack and (not configured_runtime or not Path(configured_runtime).is_file()):
        raise helpers.WorkerError('GODOT_RUNTIME_MISSING', 'A matching Godot runtime is required for source-only projects')
    with tempfile.TemporaryDirectory(prefix='pinhao-godot-', dir=work.parent) as temp:
        stage = Path(temp) / 'pack'
        if pack:
            unpack(pack, stage, helpers)
        else:
            stage.mkdir()
            helpers.copy_tree(game, stage, inventory)
        # Only edited source resources replace their compiled/remapped counterparts.
        changed = set()
        for rel, meta in manifest['files'].items():
            if helpers.digest_file(built / rel) == meta['sha256'] and rel != godot['messageCatalog']:
                continue
            target = destination(stage, rel)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(built / rel, target)
            Path(str(target) + '.remap').unlink(missing_ok=True)
            changed.add('res://' + rel)
        adapted = adapter_overlay.apply(stage, args, helpers, inventory, baseline_root=built,
                                        allow_recovered_source=True)
        for rel in adapted:
            Path(str(destination(stage, rel)) + '.remap').unlink(missing_ok=True)
            changed.add('res://' + rel)
        catalog = godot['messageCatalog']
        needs_runtime = bool(catalog or font)
        configuration_file = (stage / config.name if config.name in adapted
                              else built / config.name if (built / config.name).is_file() else config)
        configuration = configuration_file.read_text(encoding='utf-8-sig')
        if godot['version'][0] == 2:
            for key, remaps in godot.get('legacyRemaps', {}).items():
                pairs = [value for index in range(0, len(remaps), 2) if remaps[index] not in changed
                         for value in remaps[index:index + 2]]
                configuration = config_setting(configuration, 'remap', key, json.dumps(pairs, ensure_ascii=False))
        if needs_runtime:
            support = stage / '.pinhao'
            support.mkdir(exist_ok=True)
            font_name = 'font' + font.suffix.lower() if font else None
            if font:
                shutil.copyfile(font, support / font_name)
                inventory['font'] = {'family': helpers.font_family(font), 'file': '.pinhao/' + font_name,
                                     'sha256': helpers.digest_file(font)}
            (support / 'startup.gd').write_text(runtime_script(godot['version'][0], catalog, font_name), encoding='utf-8')
            configuration = config_setting(configuration, 'autoload', 'PinHaoLocalization', '"*res://.pinhao/startup.gd"', first=True)
            inventory['runtime'] = '.pinhao/startup.gd'
        overlays = asset_overlay.entries(args, helpers)
        for rel, _ in overlays:
            target = destination(stage, rel)
            restored = source / rel
            if restored.is_file():
                record = next(row for row in args['assetOverlayFiles'] if row['file'] == rel)
                if record.get('sourceHash') and helpers.digest_file(restored) != record['sourceHash']:
                    raise helpers.WorkerError('ASSET_OVERLAY', 'Recovered Godot image baseline changed: ' + rel)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(restored, target)
        asset_overlay.apply(stage, args, helpers, inventory)
        for rel, png in overlays:
            texture = '.pinhao/images/' + hashlib.sha256(rel.encode('utf-8')).hexdigest()[:20] + '.tres'
            convert_image(exe, png, destination(stage, texture), godot['version'][0], Path(temp))
            if godot['version'][0] == 2:
                original = godot.get('legacyRemaps', {}).get('all', [])
                pairs = [value for index in range(0, len(original), 2) if original[index] not in changed
                         and original[index] not in ['res://' + name for name, _ in overlays]
                         for value in original[index:index + 2]]
                for name, _ in overlays:
                    resource = '.pinhao/images/' + hashlib.sha256(name.encode('utf-8')).hexdigest()[:20] + '.tres'
                    pairs.extend(('res://' + name, 'res://' + resource))
                configuration = config_setting(configuration, 'remap', 'all', json.dumps(pairs, ensure_ascii=False))
            else:
                Path(str(destination(stage, rel)) + '.remap').write_text('[remap]\npath=' + json.dumps('res://' + texture) + '\n', encoding='utf-8')
        if needs_runtime or godot['version'][0] == 2 and overlays or helpers.digest_file(configuration_file) != helpers.digest_file(config):
            (stage / config.name).write_text(configuration, encoding='utf-8')
            (stage / ('engine.cfb' if godot['version'][0] == 2 else 'project.binary')).unlink(missing_ok=True)
        output.mkdir(parents=True)
        helpers.copy_tree(game, output, inventory, omitted=metadata['archives'])
        launchers = [rel for rel, _ in helpers.files_in(output) if '/' not in rel and rel.lower().endswith('.exe')
                     and not re.search(r'console|crash|install|unins|setup|redist', rel, re.I)]
        if pack and godot['embedded']:
            target = output / pack.name
            launch = target
        elif pack:
            target = output / pack.name
            matching = next((name for name in launchers if Path(name).stem.casefold() == pack.stem.casefold()), None)
            launch = output / (matching or launchers[0]) if matching or launchers else None
        else:
            target = output / 'PinHaoGame.pck'
            launch = output / 'PinHaoGame.exe'
            shutil.copyfile(configured_runtime, launch)
        if launch is None:
            raise helpers.WorkerError('GODOT_RUNTIME_MISSING', 'Godot pack has no Windows game executable')
        packed = Path(temp) / 'localized.pck' if pack and godot['embedded'] else target
        for rel, path in helpers.files_in(stage):
            if helpers.excluded(rel):
                path.unlink()
                inventory['excluded'].append(rel)
        run(exe, ['--pck-create=' + str(stage), '--output=' + str(packed),
                  '--pck-version=' + str(godot['format']),
                  '--pck-engine-version=' + '.'.join(map(str, godot['version']))])
        if pack and godot['embedded']:
            embed_pack(pack, packed, target)
        final_index = pack_index(target, helpers.safe_member)
        indexed = {row['file']: row for row in final_index['entries']}
        # Check every packaged payload against the staged bytes, including unchanged assets.
        expected = {rel: helpers.digest_file(path) for rel, path in helpers.files_in(stage)}
        if set(indexed) != set(expected):
            raise helpers.WorkerError('GODOT_PACK_MISMATCH', 'Godot packed file inventory differs')
        with target.open('rb') as stream:
            for rel, digest in expected.items():
                stream.seek(indexed[rel]['offset'])
                remaining, hashed = indexed[rel]['bytes'], hashlib.sha256()
                while remaining:
                    data = exact(stream, min(remaining, 1024 * 1024))
                    remaining -= len(data)
                    hashed.update(data)
                if hashed.hexdigest() != digest:
                    raise helpers.WorkerError('GODOT_PACK_MISMATCH', 'Godot packed payload differs: ' + rel)
    inventory.update(status='assembled_structurally_checked', launchers=[launch.name],
                     pack=target.name, packFormat=godot['format'], godotVersion=godot['version'],
                     sourceOnly=False, packagedFiles=len(indexed))
    helpers.json_write(output / 'PinHao-build-report.json', inventory)
    if args.get('share', True):
        (output / '\u4f7f\u7528\u8bf4\u660e-\u62fc\u597d\u6c49\u5316.txt').write_text(
            '\u672c\u6c49\u5316\u6210\u679c\u7531\u62fc\u597d\u6c49\u5316\u514d\u8d39\u5206\u4eab\u3002\n'
            '\u5207\u52ff\u4ed8\u8d39\u8d2d\u4e70\uff1b\u5982\u5df2\u4ed8\u6b3e\uff0c\u8bf7\u8054\u7cfb\u4ea4\u6613\u5e73\u53f0\u7533\u8bf7\u9000\u6b3e\u3002\n'
            '\u542f\u52a8 ' + launch.name + ' \u5373\u53ef\u6e38\u73a9\u3002\n', encoding='utf-8')
    return {**inventory, 'outputDir': str(output), 'reportPath': str(output / 'PinHao-build-report.json'),
            'launchPath': str(launch)}
