"""Read standard RPG Maker plugin manifests without executing game JavaScript."""
import json
import re


OWNED_PLUGINS = frozenset(('PinHaoLocalization', 'PinhaoAssist', 'PinHaoNameIdentity'))
LEGACY_MARKERS = {
    'PinHaoLocalization': 'PinHao localization runtime',
    'PinhaoAssist': 'PinHao optional assistance registration',
}
TOKENS = re.compile(r'''"(?:\\[\s\S]|[^"\\\r\n])*"|'(?:\\[\s\S]|[^'\\\r\n])*'|`(?:\\[\s\S]|[^`\\])*`|//[^\r\n]*|/\*[\s\S]*?\*/''')
DECLARATION = re.compile(r'(?<![\w$])(?:var|let|const)\s+\$plugins\s*=\s*')
REFERENCE = re.compile(r'(?<![\w$])\$plugins(?![\w$])')


class PluginManifestError(ValueError):
    pass


def _constant(value):
    raise ValueError('Non-JSON numeric constant: ' + value)


DECODER = json.JSONDecoder(parse_constant=_constant)


def _mask(source):
    def blank(match):
        value = match.group()
        masked = re.sub(r'[^\r\n]', ' ', value)
        # A template interpolation can execute code, unlike an ordinary string.
        if value.startswith('`') and '${' in value and '$plugins' in value:
            masked = list(masked)
            for reference in REFERENCE.finditer(value):
                masked[reference.start():reference.end()] = reference.group()
            return ''.join(masked)
        return masked
    return TOKENS.sub(blank, source).replace('\ufeff', ' ')


def _rows(value):
    if not isinstance(value, list) or any(not isinstance(row, dict) or not isinstance(row.get('name'), str)
                                          or not isinstance(row.get('status'), bool) for row in value):
        raise PluginManifestError('plugins.js must contain standard plugin descriptors with name and status')
    return value


def _put(rows, descriptor, first=False):
    remaining = [row for row in rows if row['name'] != descriptor['name']]
    return [descriptor, *remaining] if first else [*remaining, descriptor]


def _top_level(mask, position):
    stack = []
    for character in mask[:position]:
        if character in '([{':
            stack.append(character)
        elif character in ')]}':
            if not stack or stack.pop() != {')': '(', ']': '[', '}': '{'}[character]:
                return False
    return not stack


def _manifest(source):
    mask = _mask(source)
    matches = list(DECLARATION.finditer(mask))
    if len(matches) != 1 or mask[:matches[0].start()].strip():
        raise PluginManifestError('plugins.js requires one top-level standard static $plugins declaration')
    match = matches[0]
    try:
        rows, consumed = DECODER.raw_decode(source[match.end():])
    except ValueError as error:
        raise PluginManifestError('plugins.js $plugins array is not standard JSON') from error
    rows = _rows(rows)
    start, end = match.end(), match.end() + consumed
    terminator = re.match(r'[ \t\r\n]*;', source[end:])
    if not terminator:
        raise PluginManifestError('plugins.js static declaration must end with a semicolon')
    spans = [(match.start(), end + terminator.end())]
    legacy = []
    for name, marker in LEGACY_MARKERS.items():
        header = re.compile(r'(?m)^[ \t]*// ' + re.escape(marker) + r'[ \t]*\r?\n'
                            + r'[ \t]*(?P<code>\$plugins)\s*=\s*\$plugins\.filter\(function\(plugin\)\s*'
                            + r'\{\s*return plugin\.name !== "' + re.escape(name)
                            + r'";\s*\}\);\s*\$plugins\.push\(')
        for found in header.finditer(source):
            prior = mask[:found.start()].rstrip()
            if (mask[found.start('code'):found.start('code') + 8] != '$plugins'
                    or not _top_level(mask, found.start('code')) or not prior.endswith((';', '}'))):
                continue
            try:
                descriptor, length = DECODER.raw_decode(source[found.end():])
            except ValueError:
                continue
            suffix = re.match(r'\);[ \t]*(?:\r?\n|$)', source[found.end() + length:])
            if not suffix or not isinstance(descriptor, dict) or descriptor.get('name') != name:
                continue
            _rows([descriptor])
            finish = found.end() + length + suffix.end()
            if name == 'PinhaoAssist':
                closing = re.match(r'// PinHao optional assistance end[ \t]*(?:\r?\n|$)', source[finish:])
                if closing:
                    finish += closing.end()
            legacy.append((found.start(), finish, descriptor))
    for begin, finish, descriptor in sorted(legacy):
        spans.append((begin, finish))
        rows = _put(rows, descriptor)
    outside, raw_outside = list(mask), list(source)
    for begin, finish in spans:
        outside[begin:finish] = ' ' * (finish - begin)
        raw_outside[begin:finish] = ' ' * (finish - begin)
    outside = ''.join(outside)
    # Regex literals are outside this JSON reader's grammar; never let their quotes hide a mutation.
    unknown = REFERENCE.search(outside) or '/' in outside and REFERENCE.search(''.join(raw_outside))
    unresolved = ['plugins.js has an unsupported $plugins reference outside its static declaration'] if unknown else []
    return {'plugins': rows, 'unresolved': unresolved, 'array': (start, end), 'legacy': legacy}


def inspect_plugins(source):
    """Return known descriptors and explicit unresolved reasons; never execute JS."""
    try:
        parsed = _manifest(source)
        return {key: parsed[key] for key in ('plugins', 'unresolved')}
    except PluginManifestError as error:
        return {'plugins': [], 'unresolved': [str(error)]}


def register_plugin(source, descriptor, *, first=False):
    """Normalize known legacy blocks and register one exact allowlisted own plugin."""
    _rows([descriptor])
    if descriptor['name'] not in OWNED_PLUGINS:
        raise PluginManifestError('Only explicitly owned PinHao plugins may be registered')
    parsed = _manifest(source)
    if parsed['unresolved']:
        raise PluginManifestError('; '.join(parsed['unresolved']))
    rows = _put(parsed['plugins'], descriptor, first)
    newline = '\r\n' if '\r\n' in source else '\n'
    replacement = json.dumps(rows, ensure_ascii=True, indent=2, allow_nan=False).replace('\n', newline)
    edits = [(*parsed['array'], replacement), *((begin, end, '') for begin, end, _ in parsed['legacy'])]
    for begin, end, text in sorted(edits, reverse=True):
        source = source[:begin] + text + source[end:]
    return source
