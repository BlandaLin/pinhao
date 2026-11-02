"""Bounded, source-position-preserving Godot display provenance.

Only local/static values and unique local functions are followed. Unknown uses
block automatic acceptance; they remain evidence for the technical Agent.
"""
from __future__ import annotations

import ast
from dataclasses import dataclass
import re


@dataclass(frozen=True)
class Ref:
    root: tuple
    path: tuple = ()


class Trace:
    def __init__(self, documents, scan, value_at, display, calls):
        self.documents = {file: text for _, file, text in documents}
        self.scan, self.value_at = scan, value_at
        self.lexed = {file: scan(text) for file, text in self.documents.items() if file.endswith('.gd')}
        self.display, self.calls = display, calls
        self.roots, self.uses, self.hints = {}, {}, []
        self.functions, self.typed, self.dead_maps, self.globals, self.memo = {}, {}, {}, {}, {}
        self.shadowed = {}
        self.stack = []
        for path, file, text in documents:
            if str(path).lower().endswith('.json'):
                try:
                    tree = ast.parse(text, mode='eval').body
                    self.roots[(file, 'json')] = self.tree(tree, file, text, 0)
                except (ValueError, SyntaxError, RecursionError):
                    pass
            elif str(path).lower().endswith('.gd'):
                self.prepare(file, text)
        # A class/static member escaping into another script is not a proven
        # local display-only value. Leave it to cross-resource investigation.
        for file, values in self.globals.items():
            for name, refs in values.items():
                for other, text in self.documents.items():
                    if other != file and other.endswith('.gd'):
                        _, code = self.lexed[other]
                        use = re.search(r'\.\s*' + re.escape(name) + r'\b', code)
                        if use:
                            self.mark(refs, 'cross_script_member_use', other, use.start())

    def position(self, expression, node, end=False):
        line = (node.end_lineno if end else node.lineno) - 1
        column = node.end_col_offset if end else node.col_offset
        lines = expression.splitlines(keepends=True)
        return sum(len(item) for item in lines[:line]) + len(lines[line].encode('utf-8')[:column].decode('utf-8'))

    def tree(self, node, file, expression, offset):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            start = offset + self.position(expression, node)
            parsed = self.value_at(self.documents[file], start)
            if not parsed or parsed[1] != offset + self.position(expression, node, True):
                raise ValueError('Unsupported literal')
            return (file, start, parsed[1], parsed[0])
        if isinstance(node, (ast.List, ast.Tuple)):
            return [self.tree(item, file, expression, offset) for item in node.elts]
        if isinstance(node, ast.Dict):
            keys = [key.value if isinstance(key, ast.Constant) else None for key in node.keys]
            if any(not isinstance(key, (str, int)) for key in keys) or len(set(keys)) != len(keys):
                raise ValueError('Ambiguous static dictionary')
            return {key: self.tree(value, file, expression, offset) for key, value in zip(keys, node.values)}
        if isinstance(node, ast.Constant) or isinstance(node, ast.Name) and node.id in ('null', 'true', 'false'):
            return None
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)) and isinstance(node.operand, ast.Constant) and isinstance(node.operand.value, (int, float)):
            return None
        raise ValueError('Not a static container')

    def leaves(self, value):
        if isinstance(value, tuple):
            return [value]
        if isinstance(value, dict):
            return [leaf for item in value.values() for leaf in self.leaves(item)]
        if isinstance(value, list):
            return [leaf for item in value for leaf in self.leaves(item)]
        return []

    def values(self, ref):
        values = [self.roots.get(ref.root)]
        for key in ref.path:
            next_values = []
            for value in values:
                if key == '*':
                    if isinstance(value, list):
                        next_values.extend(value)
                elif isinstance(value, dict) and key in value:
                    next_values.append(value[key])
                elif isinstance(value, list) and isinstance(key, int) and 0 <= key < len(value):
                    next_values.append(value[key])
            values = next_values
        return values

    def resolve(self, ref):
        return [leaf for value in self.values(ref) for leaf in self.leaves(value)]

    def mark(self, refs, kind, file, offset):
        evidence = {'file': file, 'line': self.documents[file].count('\n', 0, offset) + 1,
                    'kind': kind, 'offset': offset}
        for ref in refs:
            for value in self.values(ref):
                precision = 'value' if isinstance(value, tuple) else 'container'
                for leaf in self.leaves(value):
                    self.uses.setdefault(leaf[:3], []).append({**evidence, 'precision': precision})

    def prepare(self, file, text):
        _, masked = self.lexed[file]
        # Keep physical line boundaries even inside multiline literals.
        code = ''.join(original if original in '\r\n' else mask for original, mask in zip(text, masked))
        lines = list(re.finditer(r'[^\n]*\n|[^\n]+$', text))
        functions, scopes, parameters = {}, [], []
        for number, line in enumerate(lines):
            head = re.match(r'([ \t]*)(?:static\s+)?func\s+(\w+)\s*\(([^\n]*)\)\s*(?:->[^:]+)?\s*:', code[line.start():line.end()])
            if not head:
                continue
            params = [part.strip().split(':')[0].split('=')[0].strip() for part in head[3].split(',') if part.strip()]
            if any(not re.fullmatch(r'[A-Za-z_]\w*', param) for param in params) or len(set(params)) != len(params):
                continue
            finish = number + 1
            while finish < len(lines):
                raw = code[lines[finish].start():lines[finish].end()]
                if raw.strip() and len(raw) - len(raw.lstrip()) <= len(head[1]):
                    break
                finish += 1
            functions.setdefault(head[2], []).append((params, lines[number + 1:finish]))
            scopes.append((line.start(), lines[finish].start() if finish < len(lines) else len(text)))
            parameters.extend((param, *scopes[-1]) for param in params)
        self.functions[file] = {name: values[0] for name, values in functions.items() if len(values) == 1}
        self.typed[file] = []
        controls = r'Label|RichTextLabel|Button|LineEdit|TextEdit|Window|AcceptDialog|Control|PanelContainer'
        for match in re.finditer(r'\bvar\s+(\w+)\s*(?::\s*(' + controls + r')\b|:?\s*=\s*(' + controls + r')\.new\s*\()', code):
            scope = next(((start, end) for start, end in scopes if start <= match.start() < end), (0, len(text)))
            self.typed[file].append((match[1], *scope, match[2] or match[3]))
        self.shadowed[file] = parameters
        for match in re.finditer(r'\bvar\s+(\w+)\b', code):
            scope = next(((start, end) for start, end in scopes if start <= match.start() < end), (0, len(text)))
            if not any(name == match[1] and (begin, end) == scope for name, begin, end, _ in self.typed[file]):
                self.shadowed[file].append((match[1], *scope))
        for match in re.finditer(r'\b(\w+)\.(' + self.display + r')\s*=(?!=)\s*([^\n]+)', text):
            if not self.receiver(file, match[1], match.start(), match[2]) or code[match.start()] != text[match.start()]:
                continue
            for getter in re.finditer(r'\b(\w+)\.get\(\s*(["\x27])([^"\x27\n]+)\2', match[3]):
                self.hints.append({'field': getter[3], 'file': file,
                                   'line': text.count('\n', 0, match.start()) + 1,
                                   'property': match[2], 'qualification': 'source_unresolved'})
        self.dead_maps[file] = set()
        for match in re.finditer(r'\bvar\s+(\w+)\s*:?\s*=\s*\{\s*\}', code):
            name = match[1]
            reads = [code[item.start():code.find('\n', item.start()) if '\n' in code[item.start():] else len(code)]
                     for item in re.finditer(r'\b' + re.escape(name) + r'\b', code)]
            if all(re.match(re.escape(name) + r'\s*(?::?\s*=\s*\{|\[[^\n]+\]\s*=(?!=))', use) for use in reads):
                self.dead_maps[file].add(name)
        self.run_lines(file, lines, {}, top_only=True)

    def expression(self, raw, file, offset, env):
        leading = len(raw) - len(raw.lstrip())
        expression = raw.strip()
        if not expression:
            return set()
        try:
            node = ast.parse(expression, mode='eval').body
        except (SyntaxError, RecursionError):
            # Exact indexed reads still provide safe negative-use evidence in
            # unsupported lambdas, casts and Godot-specific expressions.
            refs = set()
            covered = []
            pattern = r'\b([A-Za-z_]\w*)((?:\s*\[\s*(?:\d+|"[^"\n]*"|\x27[^\x27\n]*\x27)\s*\])+)' 
            for match in re.finditer(pattern, raw):
                value = self.expression(match[0], file, offset + match.start(), env)
                refs.update(value)
                covered.append(match.span())
            _, masked = self.scan(raw)
            for match in re.finditer(r'\b\w+\b', masked):
                if not any(a <= match.start() < b for a, b in covered):
                    refs.update(env.get(match[0], set()))
            self.mark(refs, 'unresolved_use', file, offset)
            return set()
        return self.eval(node, expression, file, offset + leading, env)

    def eval(self, node, expression, file, offset, env):
        if isinstance(node, ast.Name):
            return env.get(node.id, set())
        if isinstance(node, (ast.Constant, ast.List, ast.Tuple, ast.Dict)):
            try:
                tree = self.tree(node, file, expression, offset)
            except ValueError:
                return set()
            key = (file, offset + self.position(expression, node))
            self.roots[key] = tree
            return {Ref(key)}
        if isinstance(node, ast.Subscript):
            base = self.eval(node.value, expression, file, offset, env)
            key = node.slice.value if isinstance(node.slice, ast.Constant) and isinstance(node.slice.value, (str, int)) else '*'
            if key == '*':
                self.mark(self.eval(node.slice, expression, file, offset, env), 'logic_index', file, offset)
            return {Ref(ref.root, ref.path + (key,)) for ref in base}
        if isinstance(node, ast.Call):
            name = node.func.id if isinstance(node.func, ast.Name) else node.func.attr if isinstance(node.func, ast.Attribute) else ''
            if name == 'parse_string' and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) and node.func.value.id == 'JSON' and len(node.args) == 1:
                inner = node.args[0]
                if isinstance(inner, ast.Call) and isinstance(inner.func, ast.Attribute) and inner.func.attr == 'get_file_as_string' and isinstance(inner.func.value, ast.Name) and inner.func.value.id == 'FileAccess' and len(inner.args) == 1 and isinstance(inner.args[0], ast.Constant):
                    source = inner.args[0].value
                    if isinstance(source, str) and source.startswith('res://') and (source[6:], 'json') in self.roots:
                        return {Ref((source[6:], 'json'))}
            args = [self.eval(arg, expression, file, offset, env) for arg in node.args]
            if isinstance(node.func, ast.Attribute):
                base = self.eval(node.func.value, expression, file, offset, env)
                receiver = node.func.value.id if isinstance(node.func.value, ast.Name) else ''
                property_name = 'tooltip_text' if name == 'set_tooltip' else 'placeholder_text' if name == 'set_placeholder' else 'text'
                if name in self.calls and self.receiver(file, receiver, offset, property_name):
                    for number, arg in enumerate(args):
                        self.mark(arg, 'display_call:' + name if number in self.calls[name] else 'logic_argument', file, offset)
                    return set()
                if name == 'get' and node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, (str, int)):
                    return {Ref(ref.root, ref.path + (node.args[0].value,)) for ref in base} | (args[1] if len(args) > 1 else set())
                if name in ('strip_edges', 'to_upper', 'to_lower', 'capitalize') and not args:
                    return base
                if name in ('size', 'is_empty') and not args:
                    return set()
                if not (isinstance(node.func.value, ast.Name) and node.func.value.id == 'self'):
                    self.mark(base | set().union(*args), 'unresolved_call:' + name, file, offset)
                    return set()
            if name in ('str', 'String') and name not in self.functions.get(file, {}) and len(args) == 1:
                return args[0]
            if any(args) and name in self.functions.get(file, {}) and (file, name) not in self.stack and len(self.stack) < 8:
                params, lines = self.functions[file][name]
                if len(args) <= len(params):
                    key = (file, name, tuple(frozenset(arg) for arg in args))
                    if key in self.memo:
                        return self.memo[key]
                    self.stack.append((file, name))
                    value = self.run_lines(file, lines, {**self.globals.get(file, {}), **dict(zip(params, args))})
                    self.stack.pop()
                    self.memo[key] = value
                    return value
            self.mark(set().union(*args), 'unresolved_call:' + name, file, offset)
            return set()
        if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Mod)):
            return self.eval(node.left, expression, file, offset, env) | self.eval(node.right, expression, file, offset, env)
        if isinstance(node, ast.IfExp):
            self.mark(self.eval(node.test, expression, file, offset, env), 'logic_condition', file, offset)
            return self.eval(node.body, expression, file, offset, env) | self.eval(node.orelse, expression, file, offset, env)
        refs = set().union(*(self.eval(child, expression, file, offset, env) for child in ast.iter_child_nodes(node)))
        self.mark(refs, 'logic_condition' if isinstance(node, (ast.Compare, ast.BoolOp, ast.UnaryOp)) else 'unresolved_expression', file, offset)
        return set()

    def run_lines(self, file, lines, env, top_only=False):
        text = self.documents[file]
        result, loops = set(), []
        cursor = 0
        while cursor < len(lines):
            line = lines[cursor]
            raw = line[0]
            stripped = raw.strip()
            indent = len(raw) - len(raw.lstrip())
            if not stripped or stripped.startswith('#'):
                cursor += 1
                continue
            if top_only and re.match(r'(?:static\s+)?func\b', stripped):
                cursor += 1
                while cursor < len(lines) and (not lines[cursor][0].strip() or len(lines[cursor][0]) - len(lines[cursor][0].lstrip()) > indent):
                    cursor += 1
                continue
            if loops and indent <= loops[-1][0]:
                while loops and indent <= loops[-1][0]:
                    _, name, old = loops.pop()
                    if old is None:
                        env.pop(name, None)
                    else:
                        env[name] = old
            loop = re.match(r'\s*for\s+(\w+)\s+in\s+(.+):\s*$', raw)
            if loop:
                refs = self.expression(loop[2], file, line.start() + loop.start(2), env)
                loops.append((indent, loop[1], env.get(loop[1])))
                env[loop[1]] = {Ref(ref.root, ref.path + ('*',)) for ref in refs}
                cursor += 1
                continue
            assignment = re.match(r'\s*(?:(?:const|var)\s+)?([\w.$]+(?:\[[^\n]*?\])?)\s*(?::\s*[^=\n]+)?\s*:?=(?!=)\s*', raw)
            if assignment:
                start = line.start() + assignment.end()
                end = line.end()
                # A static initializer may span physical lines; the existing
                # string scanner retains exact positions for the whole value.
                expr = text[start:end]
                if expr.lstrip().startswith(('[', '{')):
                    while cursor + 1 < len(lines):
                        try:
                            ast.parse(expr.strip(), mode='eval')
                            break
                        except SyntaxError:
                            cursor += 1
                            end = lines[cursor].end()
                            expr = text[start:end]
                refs = self.expression(expr, file, start, env)
                target = assignment[1]
                sink = re.fullmatch(r'(?:self\.)?(\w+)\.(' + self.display + ')', target)
                if sink and self.receiver(file, sink[1], line.start(), sink[2]):
                    self.mark(refs, 'display_property:' + sink[2], file, line.start())
                elif re.fullmatch(r'\w+', target):
                    # A second assignment merges possible values instead of
                    # silently selecting a branch or later writer.
                    env[target] = env.get(target, set()) | refs
                elif target.split('[')[0] in self.dead_maps[file]:
                    pass
                else:
                    self.mark(refs, 'unresolved_write', file, line.start())
            elif stripped.startswith('return '):
                begin = raw.index('return') + 7
                result.update(self.expression(raw[begin:], file, line.start() + begin, env))
            else:
                self.expression(raw.strip().removesuffix(':'), file, line.start() + len(raw) - len(raw.lstrip()), env)
            cursor += 1
        if top_only:
            self.globals[file] = dict(env)
            for name, (params, body) in self.functions[file].items():
                self.stack.append((file, name))
                returned = self.run_lines(file, body, {**env, **{param: set() for param in params}})
                self.stack.pop()
                _, code = self.lexed[file]
                local_calls = [use for use in re.finditer(r'\b' + re.escape(name) + r'\s*\(', code)
                               if not re.search(r'\bfunc\s*$', code[max(0, use.start() - 20):use.start()])]
                if not local_calls:
                    self.mark(returned, 'unresolved_return', file, body[0].start() if body else 0)
        return result

    def accepted(self, file):
        selected = []
        for root in self.roots.values():
            for origin in self.leaves(root):
                if origin[0] != file:
                    continue
                uses = self.uses.get(origin[:3], [])
                if uses and all(use['kind'].startswith('display_') for use in uses):
                    selected.append((*origin[1:], uses))
        return list({(item[0], item[1]): item for item in selected}.values())

    def blocked(self, file, start, end):
        # An opaque container transfer prevents a new display-only inference,
        # but does not prove each existing format-selected scalar is a logic key.
        return any(not use['kind'].startswith('display_') and use['precision'] == 'value'
                   for use in self.uses.get((file, start, end), []))

    def receiver(self, file, name, offset, property_name):
        for label, begin, end, kind in self.typed[file]:
            if name == label and begin <= offset < end:
                if any(shadow == name and a <= offset < b and (a > begin or b < end or (a, b) == (begin, end))
                       for shadow, a, b in self.shadowed[file]):
                    continue
                code = self.lexed[file][1][begin:end]
                # Type evidence is valid only while every local write still
                # constructs the same built-in control. Branches, aliases and
                # unknown factories must not keep an earlier .new() authority.
                writes = list(re.finditer(r'(?m)^[ \t]*(?:var\s+)?(?:self\.)?' + re.escape(name)
                                          + r'\s*(?::[^=\n]*)?\s*:?=(?!=)\s*([^\n]*)', code))
                if any(not re.match(re.escape(kind) + r'\.new\s*\(\s*\)\s*(?:#.*)?$', write[1].strip()) for write in writes):
                    return False
                aliases = {name}
                for _ in range(4):
                    added = {alias[1] for alias in re.finditer(r'(?m)^[ \t]*(?:var\s+)?(\w+)\s*:?=\s*(\w+)\s*$', code)
                             if alias[2] in aliases}
                    if added <= aliases:
                        break
                    aliases.update(added)
                if any(re.search(r'\b' + re.escape(alias) + r'(?:\.set_script\s*\(|\.script\s*=|\.set\s*\(\s*\0)', code)
                       for alias in aliases):
                    return False
                if property_name in ('tooltip_text', 'hint_tooltip'):
                    return True
                if property_name == 'text' and kind in ('Label', 'RichTextLabel', 'Button', 'LineEdit', 'TextEdit'):
                    return True
                if property_name == 'title' and kind in ('Window', 'AcceptDialog'):
                    return True
                if property_name == 'placeholder_text' and kind in ('LineEdit', 'TextEdit'):
                    return True
        return False

    def evidence(self, file, start, end, field=None):
        body = {}
        uses = self.uses.get((file, start, end), [])
        if uses:
            body['sourceUses'] = list({(use['file'], use['offset'], use['kind']): use for use in uses}.values())
        hints = [hint for hint in self.hints if hint['field'] == field]
        if hints:
            body['consumerHints'] = list({(hint['file'], hint['line'], hint['property']): hint for hint in hints}.values())
        return body


def analyze(documents, scan, value_at, display, calls):
    # JSON roots must be available before scripts that load them are analyzed.
    ordered = sorted(documents, key=lambda document: not str(document[0]).lower().endswith('.json'))
    return Trace(ordered, scan, value_at, display, calls)
