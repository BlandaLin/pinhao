"""Conservative source/interchange profiles, not arbitrary binary game patchers."""
import ast
import collections
import csv
import html
import io
import re
from pathlib import Path

import rpgmaker as core
from rgss_archive import destination

LITERAL = r'''(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')'''
KS_TAG = r'''\[(?:[^\[\]\r\n"']|"[^"\r\n]*"|'[^'\r\n]*'|\[[^\]\r\n]*\])*\]'''
EXTRA = {
    'renpy': r'\[\[|\]\]|\{\{|\}\}|\{[^{}\r\n]*\}|\[[^\[\]\r\n]*\]',
    'ks': KS_TAG,
    'twine': r'<<script\b[\s\S]*?<</script>>|<script\b[\s\S]*?</script\s*>|<style\b[\s\S]*?</style\s*>|<<(?:(?!>>)[^"\x27]|"(?:\\.|[^"\\])*"|\x27(?:\\.|[^\x27\\])*\x27)*>>|\[\[[\s\S]*?\]\]|\([^\r\n]*?:[^\r\n]*?\)|<[^>\r\n]*>|\$[A-Za-z_]\w*(?:\.\w+)*|\b_[A-Za-z]\w*',
    'formatted': r'\{[^{}\r\n]*\}|<[^>\r\n]*>',
    'wolf': r'\\font\[3\][\s\S]*?\\font\[0\]|@\d+',
    'yukar': r'\{\{|\}\}|\{\d+(?:\s*,\s*-?\d+)?(?::[^{}\r\n]+)?\}',
    'plain': r'(?!)',
}


def control_pattern(syntax):
    return re.compile(EXTRA[syntax] + '|' + core.CONTROL.pattern + r'|\t', re.I if syntax == 'twine' else 0)


def check_plain(text, syntax):
    if control_pattern(syntax).search(text): raise ValueError('New engine syntax is not permitted')
    if syntax == 'renpy' and any(c in text for c in '{}[]'):
        raise ValueError('New RenPy tag/interpolation delimiter')
    if syntax == 'ks' and any(c in text for c in '[]'):
        raise ValueError('New KAG/Tyrano tag delimiter')
    if syntax == 'twine' and ('<<' in text or '>>' in text or '[[' in text or ']]' in text):
        raise ValueError('New Twine macro/link delimiter')


def protected(text, syntax):
    controls, tokens = {}, []
    def replace(match):
        token = '{{CTRL%04d}}' % (len(controls) + 1)
        controls[token] = match[0]; tokens.append(token)
        return token
    result = control_pattern(syntax).sub(replace, text)
    if core.TOKEN.findall(result) != tokens or '{{' in core.TOKEN.sub('', result) or '}}' in core.TOKEN.sub('', result):
        raise ValueError('Reserved placeholder syntax in source')
    return result, controls, tokens


def decode_source(raw, encoding=None):
    for marker, codec in ((b'\xff\xfe', 'utf-16-le'), (b'\xfe\xff', 'utf-16-be'), (b'\xef\xbb\xbf', 'utf-8')):
        if raw.startswith(marker): return raw[len(marker):].decode(codec), codec, marker.hex()
    codec = encoding or 'utf-8'
    return raw.decode(codec), codec, ''


class Collector:
    def __init__(self, root, engine, backend, batch_size):
        self.root, self.engine, self.backend, self.batch_size = Path(root), engine, backend, batch_size
        self.files, self.meta, self.units, self.rows, self.review = {}, {}, {}, [], []
        self.counts, self.targets = collections.Counter(), set()

    def document(self, path, encoding=None):
        rel = path.relative_to(self.root).as_posix()
        raw = path.read_bytes(); self.files[rel] = raw
        if self.backend == 'spans':
            text, codec, bom = decode_source(raw, encoding)
            self.meta[rel] = {'encoding': codec, 'bom': bom}
            return rel, text
        return rel, core.parse_json(raw)

    def add(self, file, target, source, kind, context, syntax='plain', initial=None):
        if not isinstance(source, str) or not source.strip(): return
        value, controls, tokens = protected(source, syntax)
        if not core.TOKEN.sub('', value).strip(): return
        key = (file, tuple(target) if isinstance(target, list) else (target['start'], target['end']))
        if key in self.targets: raise ValueError('Repeated source target')
        self.targets.add(key)
        self.counts[file] += 1
        ident = file + ':%05d' % self.counts[file]
        current = value
        if initial is not None and initial.strip():
            current, current_controls, current_tokens = protected(initial, syntax)
            if current_controls != controls or current_tokens != tokens:
                raise ValueError('Existing translation has different controls; inspect before extracting: ' + ident)
        unit = {'id': ident, 'file': file, 'targets': [target], 'source': value, 'initial_value': current,
                'kind': kind, 'syntax': syntax, 'controls': controls, 'tokens': tokens, 'contexts': [context]}
        core.restore(current, unit)
        self.units[ident] = unit
        self.rows.append({'id': ident, 'kind': kind, 'source': value, 'translation': current,
                          'source_preview': source, 'tokens': tokens, 'context': context, 'notes': ''})

    def finish(self, output, allow_empty=False):
        output = core.fresh(output, (self.root,))
        if not self.units and not allow_empty: raise ValueError('No supported display text; inspect plan/review instead')
        if not 1 <= self.batch_size <= 500: raise ValueError('batch-size must be 1..500')
        grouped, sheets = collections.defaultdict(list), {}
        for row in self.rows: grouped[self.units[row['id']]['file']].append(row)
        for index, (file, rows) in enumerate(sorted(grouped.items()), 1):
            for offset in range(0, len(rows), self.batch_size):
                name = 'file%03d_batch%03d.json' % (index, offset // self.batch_size + 1)
                sheets[name] = {'schema': 'rpgmaker-ai-units-v1', 'units': rows[offset:offset + self.batch_size]}
        manifest = {'schema': 'rpgmaker-ai-work-v1', 'tool_version': core.VERSION, 'engine': self.engine,
                    'backend': self.backend, 'version': 'unknown', 'game_root_hint': '.', 'units': self.units,
                    'files': {f: {'sha256': core.sha(raw), 'bytes': len(raw), **self.meta.get(f, {})} for f, raw in self.files.items()},
                    'sheets': {n: core.sha(core.serialized(s)) for n, s in sheets.items()}}
        output.mkdir(parents=True)
        for folder in ('baseline', 'editable', 'technical/row-baseline'):
            (output / folder).mkdir(parents=True, exist_ok=True)
        for file, raw in self.files.items():
            path = destination(output / 'baseline', file); path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(raw)
        for name, sheet in sheets.items():
            core.write(output / 'editable' / name, sheet)
            core.write(output / 'technical' / 'row-baseline' / name, sheet)
        core.write(output / 'manifest.json', manifest)
        (output / 'technical' / 'manifest.sha256').write_text(core.sha(core.serialized(manifest)) + '\n', encoding='ascii')
        report = {'engine': self.engine, 'files': len(self.files), 'units': len(self.units), 'sheets': len(sheets),
                  'review_items': len(self.review), 'status': 'interchange_or_source_extracted_not_runtime_tested'}
        core.write(output / 'review-required.json', self.review)
        core.write(output / 'extraction-report.json', report)
        return report


def span(start, end, render='plain', **extra):
    return {'start': start, 'end': end, 'render': render, **extra}


def ks_entries(text, collector, file, speaker_names=True):
    pending, start, speaker, label, blocked = [], None, 'unknown', '', None
    def flush():
        nonlocal pending, start
        if pending:
            raw = ''.join(pending); end = start + len(raw.rstrip('\r\n'))
            if raw.strip(): collector.add(file, span(start, end), text[start:end], 'paragraph', {'speaker': speaker, 'label': label, 'line': text.count('\n', 0, start) + 1}, 'ks')
        pending, start = [], None
    for match in re.finditer(r'[^\n]*\n|[^\n]+$', text):
        raw, stripped = match[0], match[0].strip()
        offset = match.start() + len(raw) - len(raw.lstrip())
        if blocked:
            if (blocked == 'comment' and stripped == '*/') or re.fullmatch(r'(?:\[end' + blocked + r'\]|@end' + blocked + r')', stripped, re.I): blocked = None
            continue
        if stripped == '/*': flush(); blocked = 'comment'; continue
        if not stripped or stripped.startswith(';'): flush(); continue
        if stripped.startswith('*'): flush(); label = stripped.split('|', 1)[0]; continue
        if stripped.startswith('#'):
            flush(); name = stripped[1:].split(':', 1)[0].strip(); speaker = name or 'unknown'
            if name and speaker_names:
                begin = offset + 1 + len(stripped[1:]) - len(stripped[1:].lstrip())
                collector.add(file, span(begin, begin + len(name), 'ks_name'), name, 'speaker_name', {'label': label}, 'plain')
            elif name:
                collector.review.append({'file': file, 'line': text.count('\n', 0, offset) + 1,
                                         'kind': 'speaker_reference_id', 'reference': name})
            continue
        directive = re.match(r'(?:@|\[)(iscript|html)\b', stripped, re.I)
        if directive:
            flush(); blocked = 'script' if directive[1].lower() == 'iscript' else 'html'
            collector.review.append({'file': file, 'line': text.count('\n', 0, offset) + 1, 'kind': 'opaque_' + blocked})
            continue
        # Only whole-line commands are parsed for explicit display attributes.
        command = stripped.startswith('@') or bool(re.fullmatch(KS_TAG, stripped))
        if command:
            flush()
            inner = stripped[1:-1] if stripped.startswith('[') else stripped[1:]
            attrs = re.finditer(r'(\w+)\s*=\s*("(?:[^"\r\n]*)"|\x27(?:[^\x27\r\n]*)\x27)', inner)
            for attr in attrs:
                if attr[1] not in ('text', 'jname', 'placeholder', 'title'): continue
                literal, name = attr[2], attr[1]
                value = literal[1:-1]
                if value.startswith(('&', '%')):
                    collector.review.append({'file': file, 'line': text.count('\n', 0, offset) + 1, 'kind': 'dynamic_display_attribute'})
                    continue
                a = offset + 1 + attr.start(2) + 1
                collector.add(file, span(a, a + len(value), 'ks_attr', quote=literal[0]), value, 'display_attribute', {'attribute': name, 'label': label}, 'plain')
            collector.review.append({'file': file, 'line': text.count('\n', 0, offset) + 1, 'kind': 'command_attributes_not_exhaustively_supported'})
            continue
        if stripped.startswith('_') and collector.engine == 'TyranoScript':
            flush()
            # Tyrano consumes exactly one escape prefix before emitting prose.
            begin, end = offset + 1, match.start() + len(raw.rstrip('\r\n'))
            collector.add(file, span(begin, end), text[begin:end], 'paragraph',
                          {'speaker': speaker, 'label': label, 'line': text.count('\n', 0, offset) + 1,
                           'escapedPrefix': '_'}, 'ks')
            continue
        if start is None: start = match.start()
        pending.append(raw)
    flush()
    if blocked: raise ValueError('Unsupported/unclosed embedded block: ' + file)


def renpy_entries(text, collector, file, language):
    block, old, previous = None, None, None
    lines = list(re.finditer(r'[^\n]*\n|[^\n]+$', text))
    say = re.compile(r'(?P<prefix>(?:[A-Za-z_]\w*(?:\s+[A-Za-z_]\w*)*\s+)?)(?P<literal>' + LITERAL + r')\s*(?:nointeract)?\s*$')
    for line in lines:
        stripped = line[0].strip()
        header = re.fullmatch(r'translate\s+' + re.escape(language) + r'\s+(\w+)\s*:', stripped)
        if header:
            block = header[1]; old = previous = None
            if block in ('python', 'style'):
                collector.review.append({'file': file, 'kind': 'translation_python_or_style'})
            continue
        if stripped and not line[0][0].isspace() and not stripped.startswith('#'):
            block = None
        if block is None or block in ('python', 'style'): continue
        if stripped.startswith('#'):
            comment = say.fullmatch(stripped.lstrip('#').strip())
            if comment: previous = ast.literal_eval(comment['literal'])
            continue
        match = say.fullmatch(stripped)
        if not match:
            if stripped: collector.review.append({'file': file, 'line': text.count('\n', 0, line.start()) + 1, 'kind': 'unsupported_translation_statement'})
            continue
        prefix, literal = match['prefix'].strip(), match['literal']
        value = ast.literal_eval(literal)
        if block == 'strings':
            if prefix == 'old': old = value; continue
            if prefix != 'new' or old is None: raise ValueError('Unpaired old/new translation in ' + file)
            source = old; old = None
        else:
            if prefix in ('old', 'new', 'text', 'textbutton', 'image', 'define', 'default', 'return'):
                collector.review.append({'file': file, 'kind': 'unsupported_translation_statement'}); continue
            source = previous if previous is not None else value
            previous = None
        start = line.start() + line[0].index(stripped) + match.start('literal')
        collector.add(file, span(start, start + len(literal), 'quoted'), source, 'native_translation',
                      {'language': language, 'translate_id': block, 'speaker': prefix or 'narrator', 'target_was_empty': not value}, 'renpy', initial=value)


def twee_entries(text, collector, file):
    headers = list(re.finditer(r'^::\s+([^\r\n]+)(?:\r?\n|$)', text, re.M))
    if not headers: raise ValueError('No Twee passage headers')
    for i, header in enumerate(headers):
        name = header[1].strip()
        end = headers[i + 1].start() if i + 1 < len(headers) else len(text)
        if name.split()[0] == 'StoryData':
            data = __import__('json').loads(text[header.end():end])
            if data.get('format') not in (None, 'SugarCube'): raise ValueError('Only plain/SugarCube Twee profile is supported; use format-specific adaptation')
        if re.search(r'\[(?:[^\]]*\b)?(?:script|stylesheet|widget|init)\b', name) or name.split()[0] in ('StoryData', 'StoryTitle', 'StoryStylesheet', 'StoryScript'):
            collector.review.append({'file': file, 'passage': name, 'kind': 'non_prose_passage'}); continue
        body = text[header.end():end]
        if re.search(r'\([A-Za-z][\w-]*\s*:|\[(?:[<>]?img|audio)\[', body): raise ValueError('Harlowe/image macro needs explicit format adaptation')
        collector.add(file, span(header.end(), end), body, 'passage', {'passage_header': name}, 'twine')
        if '[[' in body or '<<' in body or '(' in body:
            collector.review.append({'file': file, 'passage': name, 'kind': 'protected_links_and_macro_string_labels'})


def twine_html_entries(text, collector, file):
    stories = list(re.finditer(r'<tw-storydata\b[^>]*>([\s\S]*?)</tw-storydata\s*>', text, re.I))
    if len(stories) != 1: raise ValueError('Expected exactly one Twine2 storydata section')
    story = stories[0]
    format_name = re.search(r'\bformat="([^"]+)"', text[story.start():story.start(1)])
    if format_name and format_name[1] != 'SugarCube': raise ValueError('Only SugarCube Twine2 HTML is supported')
    for passage in re.finditer(r'<tw-passagedata\b(?P<attrs>[^>]*)>(?P<body>[\s\S]*?)</tw-passagedata\s*>', story[1], re.I):
        attrs = dict(re.findall(r'(\w+)="([^"]*)"', passage['attrs']))
        tags = set(html.unescape(attrs.get('tags', '')).split())
        if tags & {'script', 'stylesheet', 'widget', 'init'}:
            collector.review.append({'file': file, 'kind': 'non_prose_passage', 'pid': attrs.get('pid')}); continue
        a = story.start(1) + passage.start('body'); b = story.start(1) + passage.end('body')
        body = html.unescape(passage['body'])
        if re.search(r'\([A-Za-z][\w-]*\s*:|\[(?:[<>]?img|audio)\[', body): raise ValueError('Unsupported Twine format-specific macro')
        collector.add(file, span(a, b, 'html_body'), body, 'passage',
                      {'pid': attrs.get('pid'), 'name': html.unescape(attrs.get('name', ''))}, 'twine')
        if '[[' in body or '<<' in body: collector.review.append({'file': file, 'kind': 'protected_links_and_macro_string_labels'})


def po_entries(text, collector, file):
    blocks = list(re.finditer(r'(?:[^\n]+\n?)+', text))
    for block in blocks:
        fields = {}
        for match in re.finditer(r'^(msgctxt|msgid_plural|msgid|msgstr(?:\[\d+\])?)\s+("(?:\\.|[^"\\])*"(?:\r?\n"(?:\\.|[^"\\])*")*)', block[0], re.M):
            literals = re.findall(r'"(?:\\.|[^"\\])*"', match[2])
            fields[match[1]] = (''.join(ast.literal_eval(s) for s in literals), block.start() + match.start(2), block.start() + match.end(2))
        if 'msgid' not in fields or not fields['msgid'][0]: continue
        for key, (value, start, end) in fields.items():
            if not key.startswith('msgstr'): continue
            source = fields['msgid_plural'][0] if key not in ('msgstr', 'msgstr[0]') and 'msgid_plural' in fields else fields['msgid'][0]
            collector.add(file, span(start, end, 'quoted'), source, 'gettext_translation',
                          {'msgctxt': fields.get('msgctxt', ('',))[0], 'plural_slot': key, 'target_was_empty': not value}, 'formatted', initial=value)
        if '#, fuzzy' in block[0]: collector.review.append({'file': file, 'kind': 'fuzzy_flag_requires_import_review'})


def csv_cells(text):
    rows, row, pos = [], [], 0
    while pos < len(text):
        start = pos
        if text[pos] == '"':
            pos += 1
            while pos < len(text):
                if text[pos] == '"':
                    if pos + 1 < len(text) and text[pos + 1] == '"': pos += 2; continue
                    pos += 1; break
                pos += 1
            else: raise ValueError('Unclosed CSV field')
            if pos < len(text) and text[pos] not in ',\r\n': raise ValueError('Unsupported CSV spacing/delimiter')
        else:
            while pos < len(text) and text[pos] not in ',\r\n': pos += 1
        raw = text[start:pos]
        value = next(csv.reader(io.StringIO(raw), strict=True), [''])[0]
        row.append((value, start, pos))
        if pos == len(text): rows.append(row); break
        if text[pos] == ',':
            pos += 1
            if pos == len(text): row.append(('', pos, pos)); rows.append(row)
            continue
        pos += 2 if text[pos:pos + 2] == '\r\n' else 1
        rows.append(row); row = []
    return rows


def csv_entries(text, collector, file, source_language, language):
    rows = csv_cells(text)
    if not rows: raise ValueError('Empty CSV')
    header = [c[0] for c in rows[0]]
    if len(set(header)) != len(header) or source_language not in header or language not in header:
        raise ValueError('CSV needs unique existing source/target language columns')
    source_index, target_index = header.index(source_language), header.index(language)
    if source_index == target_index or min(source_index, target_index) == 0: raise ValueError('Do not translate CSV keys/source column')
    keys = set()
    for index, row in enumerate(rows[1:], 1):
        if len(row) != len(header): raise ValueError('CSV column count mismatch')
        if row[0][0] in keys: raise ValueError('Duplicate CSV localization key')
        keys.add(row[0][0])
        value, start, end = row[target_index]
        collector.add(file, span(start, end, 'csv'), row[source_index][0], 'csv_translation',
                      {'key': row[0][0], 'row': index, 'language': language, 'source_language': source_language}, 'formatted', initial=value)


def pgmm_entries(obj, collector, file):
    if not isinstance(obj.get('textList'), list) or not isinstance(obj.get('gameInformation'), dict): raise ValueError('Unexpected PGMM project schema')
    ids = set()
    def walk(items, path, folders):
        for i, item in enumerate(items):
            base = path + [i]
            if item.get('folder'): walk(item.get('children', []), base + ['children'], folders + [item.get('name', '')]); continue
            if item['id'] in ids: raise ValueError('Duplicate PGMM resource ID')
            ids.add(item['id'])
            for locale, text in item['text'].items():
                collector.add(file, base + ['text', locale], text, 'resource_text',
                              {'resource_id': item['id'], 'resource_name': item.get('name'), 'locale': locale, 'folders': folders}, 'plain')
    walk(obj['textList'], ['textList'], [])
    collector.add(file, ['gameInformation', 'title'], obj['gameInformation'].get('title', ''), 'game_title', {}, 'plain')
    collector.review.append({'file': file, 'kind': 'fonts_images_runtime_executable_separate'})


def wolf_entries(obj, collector, file):
    def walk(value, path):
        if isinstance(value, dict):
            if isinstance(value.get('code'), int) and isinstance(value.get('stringArgs'), list):
                code = value['code']
                visible = code in (101, 102) or (code == 150 and isinstance(value.get('intArgs'), list) and value['intArgs'] and ((value['intArgs'][0] >> 4) & 7) == 2)
                if visible:
                    for i, text in enumerate(value['stringArgs']): collector.add(file, path + ['stringArgs', i], text, 'wolf_display_command', {'command_code': code, 'command_path': path}, 'wolf')
                else: collector.review.append({'file': file, 'path': path, 'kind': 'non_display_command_not_translated'})
            for key, child in value.items(): walk(child, path + [key])
        elif isinstance(value, list):
            for index, child in enumerate(value): walk(child, path + [index])
    walk(obj, [])
    collector.review.append({'file': file, 'kind': 'database_labels_and_string_variables_require_explicit_selection'})


def extract(game, output, profile, language='schinese', source_language='en', encoding=None, batch_size=120, selection=None):
    root = Path(game).resolve()
    if not root.is_dir(): raise ValueError('Source directory missing')
    backend = 'json' if profile in ('pgmm', 'wolf-export', 'json-selected') else 'spans'
    collector = Collector(root, profile, backend, batch_size)
    if profile in ('tyrano', 'kirikiri'):
        scenario = root / 'data' / 'scenario' if (root / 'data' / 'scenario').is_dir() else root
        for path in sorted(scenario.rglob('*.ks')):
            file, text = collector.document(path, encoding); ks_entries(text, collector, file)
    elif profile == 'renpy-template':
        tl = root / 'game' / 'tl' / language if (root / 'game').is_dir() else root / 'tl' / language
        destination(tl.parent, language)
        for path in sorted(tl.rglob('*.rpy')):
            file, text = collector.document(path, encoding); renpy_entries(text, collector, file, language)
        if not collector.files: raise ValueError('Generate native RenPy tl templates in a game copy first')
    elif profile in ('twee', 'twine-html'):
        patterns = ('*.twee', '*.tw') if profile == 'twee' else ('*.html', '*.htm')
        for pattern in patterns:
            for path in sorted(root.glob(pattern)):
                file, text = collector.document(path, encoding)
                (twee_entries if profile == 'twee' else twine_html_entries)(text, collector, file)
    elif profile == 'gettext-po':
        for path in sorted(root.rglob('*.po')):
            file, text = collector.document(path, encoding); po_entries(text, collector, file)
    elif profile == 'godot-csv':
        for path in sorted(root.glob('*.csv')):
            file, text = collector.document(path, encoding); csv_entries(text, collector, file, source_language, language)
    elif profile == 'pgmm':
        path = root / 'project.json'
        file, obj = collector.document(path); pgmm_entries(obj, collector, file)
        info = root / 'info.json'
        if info.is_file():
            name, doc = collector.document(info)
            if isinstance(doc.get('title'), str):
                if doc['title'] != obj['gameInformation'].get('title', ''): raise ValueError('PGMM project/info titles differ; resolve before extraction')
                collector.add(name, ['title'], doc['title'], 'game_title', {'must_match_project_title': True})
                for unit in collector.units.values():
                    if unit['kind'] == 'game_title': unit['sync_group'] = 'pgmm_game_title'
    elif profile == 'wolf-export':
        for path in sorted(root.rglob('*.json')):
            file, obj = collector.document(path); wolf_entries(obj, collector, file)
    elif profile == 'json-selected':
        if selection is None: raise ValueError('Explicit JSON selection file required; no recursive all-string guessing')
        spec = core.read(selection)
        if not isinstance(spec, dict) or set(spec) != {'schema', 'fields'} or spec['schema'] != 'kickstart-json-selection-v1': raise ValueError('Unsupported JSON selection schema')
        docs = {}
        for field in spec['fields']:
            if set(field) != {'file', 'path', 'kind', 'context'}: raise ValueError('Selection needs file/path/kind/context')
            name = field['file']; path = destination(root, name)
            if path.suffix != '.json': raise ValueError('Selected files must be JSON exports')
            if name not in docs: _, docs[name] = collector.document(path)
            value = core.at(docs[name], field['path'])
            if not isinstance(value, str): raise ValueError('Selection target is not text')
            collector.add(name, field['path'], value, field['kind'], field['context'], 'formatted')
    else: raise ValueError('Unsupported source profile')
    return collector.finish(output)


def render(text, target):
    mode = target['render']
    if mode == 'quoted': return __import__('json').dumps(text, ensure_ascii=False)
    if mode == 'html_body': return html.escape(text, quote=False)
    if mode == 'csv':
        stream = io.StringIO(); csv.writer(stream, quoting=csv.QUOTE_ALL).writerow([text]); return stream.getvalue().rstrip('\r\n')
    if mode in ('ks_attr', 'ks_name'):
        forbidden = '[]\r\n' + (target.get('quote', '') if mode == 'ks_attr' else ':')
        if any(c in text for c in forbidden) or text.startswith(('&', '%', '*', '#', '@', ';')):
            raise ValueError('Unsafe KAG/Tyrano display slot')
    if mode == 'plain' and target.get('ks_guard'):
        if any(line.lstrip().startswith(('#', '*', '@', ';')) for line in text.splitlines()): raise ValueError('New KAG command line in prose')
    return text


def build_spans(work, manifest, values, *, baseline_files=None):
    patches = collections.defaultdict(list)
    for ident, unit in manifest['units'].items():
        parts = values[ident]
        if parts == core.restore(unit.get('initial_value', unit['source']), unit): continue
        if len(parts) != 1 or len(unit['targets']) != 1: raise ValueError('Span profile requires one whole text target')
        target = dict(unit['targets'][0])
        if unit['syntax'] == 'ks' and target['render'] == 'plain': target['ks_guard'] = True
        replacement = render(parts[0], target)
        patches[unit['file']].append((target['start'], target['end'], replacement))
    result = {}
    for file, meta in manifest['files'].items():
        raw = (baseline_files[file] if baseline_files is not None else
               destination(Path(work) / 'baseline', file).read_bytes())
        if not patches[file]: result[file] = raw; continue
        text, codec, bom = decode_source(raw, meta['encoding'])
        cursor, chunks = 0, []
        for start, end, replacement in sorted(patches[file]):
            if start < cursor or not 0 <= start <= end <= len(text): raise ValueError('Overlapping/invalid text spans')
            chunks.extend((text[cursor:start], replacement)); cursor = end
        chunks.append(text[cursor:])
        output_codec = meta.get('target_encoding', codec)
        output_bom = meta.get('target_bom', bom)
        encoded = bytes.fromhex(output_bom) + ''.join(chunks).encode(output_codec)
        # Strict re-decode catches an accidental encoding/BOM change.
        if decode_source(encoded, output_codec)[0] != ''.join(chunks): raise ValueError('Text encoding mismatch')
        result[file] = encoded
    return result
