"""Bounded static Ruby constants whose observed uses terminate in RGSS display sinks.

This is not a Ruby evaluator. Unsupported literals and unresolved uses stay out of
the automatic selection; source views remain available for the technical Agent.
"""
import re

LITERAL = re.compile(r'''(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')''')
QUALIFIED = re.compile(r'(?<![\w:])([A-Z]\w*(?:::[A-Z]\w*)+)(?![\w:])')


def literal_value(token):
    if not LITERAL.fullmatch(token) or '\n' in token or '\r' in token:
        raise ValueError('Only one-line static Ruby strings are supported')
    quote, body = token[0], token[1:-1]
    if quote == '"' and re.search(r'(?<!\\)#(?:\{|@|\$)', body):
        raise ValueError('Ruby interpolation needs a complete template adapter')
    out, index = [], 0
    escapes = {'n': '\n', 'r': '\r', 't': '\t', '\\': '\\', '"': '"', '#': '#'}
    while index < len(body):
        char = body[index]
        if char != '\\':
            out.append(char)
        else:
            index += 1
            if index >= len(body):
                raise ValueError('Unfinished Ruby escape')
            char = body[index]
            if quote == "'":
                out.append(char if char in ("'", '\\') else '\\' + char)
            elif char in escapes:
                out.append(escapes[char])
            else:
                raise ValueError('Unsupported Ruby escape')
        index += 1
    return ''.join(out)


def render_literal(text, token):
    quote = token[0]
    value = text.replace('\\', '\\\\').replace(quote, '\\' + quote)
    if quote == '"':
        value = re.sub(r'#(?=[{@$])', r'\\#', value)
        value = value.replace('\n', '\\n').replace('\r', '\\r').replace('\t', '\\t')
    elif any(char in text for char in '\r\n\t'):
        raise ValueError('Single-quoted Ruby label cannot gain physical controls')
    result = quote + value + quote
    if literal_value(result) != text:
        raise ValueError('Ruby literal readback differs')
    return result


def mask(text):
    # Preserve offsets/lines while removing comments and ordinary quoted content.
    result, index, block = list(text), 0, False
    for line in text.splitlines(keepends=True):
        start = index
        index += len(line)
        if re.match(r'^=begin\b', line):
            block = True
        if block:
            result[start:index] = ['\n' if char == '\n' else ' ' for char in line]
            if re.match(r'^=end\b', line):
                block = False
            continue
        pos = start
        while pos < index:
            match = LITERAL.match(text, pos)
            if match:
                end = match.end()
                result[pos:end] = ['\n' if char == '\n' else ' ' for char in text[pos:end]]
                pos = end
            elif text[pos] == '#':
                result[pos:index] = ['\n' if char == '\n' else ' ' for char in text[pos:index]]
                break
            else:
                pos += 1
    return ''.join(result)


def unsupported_literal_syntax(text):
    clean = mask(text)
    return bool(re.search(r'<<[-~]?\s*[\x27\"]?[A-Za-z_]\w*|%[qQwWiIxrs]\s*[({\[|]|%(?=[({\[|])|`', clean))


def arguments(text, separators=','):
    parts, start, depth, index = [], 0, 0, 0
    while index < len(text):
        literal = LITERAL.match(text, index)
        if literal:
            index = literal.end()
            continue
        char = text[index]
        if char in '([{':
            depth += 1
        elif char in ')]}':
            depth -= 1
            if depth < 0:
                return []
        elif char in separators and depth == 0:
            parts.append(text[start:index].strip())
            start = index + 1
        index += 1
    return parts + [text[start:].strip()] if depth == 0 else []


def blocks(text, keyword):
    lines = text.splitlines(keepends=True)
    offsets, cursor = [], 0
    for line in lines:
        offsets.append(cursor)
        cursor += len(line)
    clean = mask(text).splitlines()
    result = []
    for index, line in enumerate(clean):
        match = re.match(r'^(\s*)' + keyword + r'\s+(.+?)\s*$', line)
        if not match:
            continue
        indent = len(match[1])
        end = next((n for n in range(index + 1, len(clean))
                    if re.fullmatch(r'\s{' + str(indent) + r'}end\s*', clean[n])), None)
        if end is not None:
            result.append({'header': match[2], 'start': offsets[index],
                           'end': offsets[end] + len(lines[end]),
                           'body': ''.join(lines[index + 1:end])})
    return result


def display_constants(sources, diagnostics=None):
    """sources: [{file, text, ...}]; returns exact literal selections and evidence."""
    definitions, declarations, documents, classes, methods, mutations = {}, {}, [], {}, [], {}
    for source in sources:
        text = source['text']
        clean = mask(text)
        references = {}
        for ref in QUALIFIED.finditer(clean):
            references.setdefault(ref[0], []).append(ref.span())
        interpolation = {ref[0] for literal in LITERAL.finditer(text) if '#{' in literal[0]
                         for ref in QUALIFIED.finditer(literal[0])}
        reflective = set(re.findall(r'\b([A-Z]\w*(?:::[A-Z]\w*)*)\.(?:const_get|const_set|remove_const|module_eval|class_eval|send|public_send)\b', clean))
        exposed = set(re.findall(r'\b(?:include|extend)\s+([A-Z]\w*(?:::[A-Z]\w*)*)\b', clean))
        exposed.update(re.findall(r'(?m)^\s*(?:[A-Za-z_]\w*|@[A-Za-z_]\w*)\s*=\s*([A-Z]\w*(?:::[A-Z]\w*)*)\s*$', clean))
        doc = {**source, 'clean': clean, 'references': references, 'interpolation': interpolation,
               'reflective': reflective, 'exposed': exposed, 'modules': blocks(text, 'module'),
               'unsupportedSyntax': unsupported_literal_syntax(text)}
        documents.append(doc)
        scopes = blocks(text, 'class')
        for scope in scopes:
            named = re.match(r'([A-Z]\w*)', scope['header'])
            if named:
                owner = named[1]
                for line in scope['body'].splitlines():
                    code = mask(line).strip()
                    alias = re.match(r'alias\s+:?(\w+[!?=]?)\s', code)
                    if alias:
                        mutations.setdefault(owner, set()).add(alias[1])
                    dynamic = re.match(r'(?:self\.)?(alias_method|define_method|remove_method|undef_method)\s*(?:\(\s*)?(.+)', line.strip())
                    if dynamic:
                        target = re.match(r''':(\w+[!?=]?)|["'](\w+[!?=]?)["']''', dynamic[2])
                        mutations.setdefault(owner, set()).add(next(value for value in target.groups() if value) if target else '*')
                    if re.match(r'(?:prepend|include)\b', code):
                        mutations.setdefault(owner, set()).add('*')
            inheritance = re.fullmatch(r'([A-Z]\w*)\s*<\s*([A-Z]\w*)', scope['header'])
            if inheritance:
                child, base = inheritance.groups()
                classes.setdefault(child, set()).add(base)
        for method in blocks(text, 'def'):
            parents = [scope for scope in scopes if scope['start'] < method['start'] < scope['end'] and re.match(r'[A-Z]\w*', scope['header'])]
            owner = re.match(r'([A-Z]\w*)', min(parents, key=lambda row: row['end'] - row['start'])['header'])[1] if parents else None
            methods.append({**method, 'owner': owner, 'file': source['file']})
        for scope in doc['modules']:
            if not re.fullmatch(r'[A-Z]\w*(?:::[A-Z]\w*)*', scope['header']):
                continue
            if any(other['start'] < scope['start'] < other['end'] for other in doc['modules'] + scopes):
                continue
            prefix = scope['header'] + '::'
            for assignment in re.finditer(r'(?m)^\s*([A-Z]\w*)\s*(?:\|\|=|=(?!=))', clean[scope['start']:scope['end']]):
                name = prefix + assignment[1]
                declarations[name] = declarations.get(name, 0) + 1
            for match in re.finditer(r'(?m)^\s*([A-Z]\w*)\s*=\s*(' + LITERAL.pattern.strip() + r')\s*(?:#[^\r\n]*)?$', text[scope['start']:scope['end']]):
                start = scope['start'] + match.start(2)
                # Declarations inside a method/conditional are not static module constants.
                preceding = clean[scope['start']:start].split('\n', 1)[-1]
                if doc['unsupportedSyntax'] or re.search(r'(?m)^\s*(?:module|def|class|if|unless|case|while|until|for|begin)\b', preceding):
                    continue
                name = prefix + match[1]
                try:
                    value = literal_value(match[2])
                except ValueError:
                    continue
                if not value.strip() or not re.search(r'[^\d\W_]', value):
                    continue
                definitions.setdefault(name, []).append({**source, 'constant': name, 'source': value,
                    'start': start, 'end': scope['start'] + match.end(2), 'literal': match[2],
                    'scopeStart': scope['start'], 'scopeEnd': scope['end']})

    def ancestors(owner):
        seen = []
        while owner and owner not in seen:
            seen.append(owner)
            bases = classes.get(owner, set())
            if len(bases) != 1:
                break
            owner = next(iter(bases))
        return seen

    def window(owner):
        lineage = ancestors(owner)
        return 'Window' in lineage and not any(mutations.get(item, set()) & {'*', 'contents'} for item in lineage) and not any(set(lineage) & doc['reflective'] for doc in documents) and not any(row['owner'] in lineage
            and re.match(r'contents\b', row['header']) for row in methods)

    def method_for(owner, name):
        for ancestor in ancestors(owner):
            if mutations.get(ancestor, set()) & {'*', name}:
                return None
            candidates = [row for row in methods if row['owner'] == ancestor and re.match(name + r'(?:\b|\()', row['header'])]
            if not candidates:
                continue
            return candidates[0] if len(candidates) == 1 else None
        return None

    def wrapper(owner, name):
        method = method_for(owner, name)
        if method is None:
            return False
        body = mask(method['body']).strip()
        if name == 'draw_text':
            return bool(re.fullmatch(r'draw_text\(\*args\)', method['header']) and re.fullmatch(r'(?:self\.)?contents\.draw_text\(\*args\)', body))
        if name == 'add_command':
            # Standard Window_Command stores the label separately from its symbol.
            reader, draw = method_for(owner, 'command_name'), method_for(owner, 'draw_item')
            return bool(re.fullmatch(r'add_command\(name,\s*symbol,\s*enabled\s*=\s*true(?:,\s*ext\s*=\s*nil)?\)', method['header'])
                and re.fullmatch(r'@list\.push\(\{\s*:name\s*=>\s*name\s*,\s*:symbol\s*=>\s*symbol\s*,\s*:enabled\s*=>\s*enabled(?:\s*,\s*:ext\s*=>\s*ext)?\s*\}\)', body)
                and reader and re.fullmatch(r'@list\[index\]\[:name\]', mask(reader['body']).strip())
                and draw and re.search(r'\bdraw_text\([^\n]*command_name\(index\)', mask(draw['body']))
                and wrapper(owner, 'draw_text'))
        return False

    def expression(value, name):
        value = value.strip()
        # Classify every occurrence on its actual argument path. An unrelated
        # format string cannot authorize a resource lookup in a later argument.
        if not any(ref[0] == name for ref in QUALIFIED.finditer(mask(value))):
            return True
        if value == name:
            return True
        call = re.fullmatch(r'(?:sprintf|format)\((.*)\)', value)
        if call:
            args = arguments(call[1])
            return bool(args) and all(expression(arg, name) for arg in args)
        if value.startswith('[') and value.endswith(']'):
            args = arguments(value[1:-1])
            return bool(args) and all(expression(arg, name) for arg in args)
        # Formatting and concatenation keep the constant on the display data path.
        parts = arguments(value, '+%')
        return len(parts) > 1 and all(expression(part, name) for part in parts)

    def sink(line, name, owner):
        line = re.sub(r'\s+#.*$', '', line).strip()
        call = re.fullmatch(r'(\$game_message\.add|(?:self\.)?contents\.draw_text|draw_text|add_command)\((.*)\)', line)
        if not call:
            return False
        method, body = call.groups()
        args = arguments(body)
        if method == '$game_message.add':
            adder = method_for('Game_Message', 'add')
            message_writer = adder and re.fullmatch(r'@texts\.push\(text\)', mask(adder['body']).strip())
            return bool(message_writer) and len(args) == 1 and expression(args[0], name)
        if not window(owner):
            return False
        if method == 'add_command':
            return bool(args) and name in args[0] and expression(args[0], name) and wrapper(owner, method)
        if method == 'draw_text' and not wrapper(owner, method):
            return False
        target = 1 if len(args) in (2, 3) else 4 if len(args) in (5, 6) else None
        return target is not None and name in args[target] and expression(args[target], name)

    selections = []
    for name, values in definitions.items():
        if len(values) != 1 or declarations.get(name) != 1:
            continue
        definition, uses, unresolved = values[0], [], False
        reasons = set()
        bare = name.rsplit('::', 1)[1]
        for doc in documents:
            text, clean = doc['text'], doc['clean']
            # Quoted interpolation, reflection and lexical unqualified reads cannot be proven here.
            namespace = name.rsplit('::', 1)[0]
            if namespace in doc['reflective'] or namespace in doc['exposed']:
                unresolved = True
                reasons.add('reflective-namespace')
                break
            for module in doc['modules']:
                if module['header'] == namespace:
                    own = clean[module['start']:module['end']]
                    own = re.sub(r'(?m)^\s*' + re.escape(bare) + r'\s*=[^\n]*', '', own)
                    if re.search(r'(?<![\w:])' + re.escape(bare) + r'(?![\w])', own):
                        unresolved = True
                        reasons.add('unqualified-use')
            if name in doc['interpolation']:
                unresolved = True
                reasons.add('interpolation')
            for ref_start, ref_end in doc['references'].get(name, []):
                if doc['unsupportedSyntax']:
                    unresolved = True
                    reasons.add('unsupported-source-syntax')
                    continue
                start = text.rfind('\n', 0, ref_start) + 1
                end = text.find('\n', ref_end)
                end = len(text) if end < 0 else end
                contexts = [row for row in methods if row['file'] == doc['file'] and row['start'] < ref_start < row['end']]
                method = min(contexts, key=lambda row: row['end'] - row['start']) if contexts else None
                if method is None or not sink(text[start:end], name, method['owner']):
                    unresolved = True
                    reasons.add('unresolved-consumer')
                    continue
                uses.append({'file': doc['file'], 'line': text.count('\n', 0, ref_start) + 1,
                             'method': method['header'], 'display': 'rgss-static-display-1'})
        if uses and not unresolved:
            selections.append({**definition, 'consumers': uses})
        if diagnostics is not None:
            diagnostics.append({'constant': name, 'file': definition['file'], 'displayUses': len(uses),
                                'selected': bool(uses and not unresolved), 'reasons': sorted(reasons)})
    return selections
