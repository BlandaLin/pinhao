"""Bounded reader grammar evidence; syntax proof is not display-use authorization."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

VERSION = 'pinhao-unity-tail-reader-v1'


def _integer(item):
    op = item['op']
    if op == 'ldc.i4.m1':
        return -1
    if re.fullmatch(r'ldc\.i4\.[0-8]', op):
        return int(op[-1])
    if op in ('ldc.i4', 'ldc.i4.s'):
        return int(item['operand'])
    return None


def _local(item, store=False):
    prefix = 'stloc' if store else 'ldloc'
    op = item['op']
    if re.fullmatch(prefix + r'\.[0-3]', op):
        return int(op[-1])
    if op in (prefix, prefix + '.s'):
        value = item['operand']
        return int(str(value).replace('V_', ''))
    return None


def _call(item, suffix):
    return item['op'] in ('call', 'callvirt') and str(item.get('operand', '')).endswith(suffix)


def _literal(item):
    value = item.get('operand')
    if item['op'] != 'ldstr':
        return None
    # Retained redacted inspection reports can be checked without restoring prose.
    return value.get('value') if isinstance(value, dict) else value


def _split_delimiter(code, index):
    if _call(code[index], 'System.String::Split(System.Char,System.StringSplitOptions)'):
        start = index - 4
        if start >= 0 and _literal(code[start]) is not None and _integer(code[start + 1]) == 0 and _call(code[start + 2], 'System.String::get_Chars(System.Int32)') and _integer(code[start + 3]) == 0:
            return start, _literal(code[start])
    if _call(code[index], 'System.String::Split(System.Char[])'):
        start = index - 8
        if start >= 0 and _integer(code[start]) == 1 and code[start + 1]['op'] == 'newarr' and code[start + 1]['operand'] == 'System.Char' and _local(code[start + 2], True) is not None:
            temporary = _local(code[start + 2], True)
            value = _integer(code[start + 5])
            if _local(code[start + 3]) == temporary and _integer(code[start + 4]) == 0 and value is not None and 0 <= value <= 65535 and code[start + 6]['op'] == 'stelem.i2' and _local(code[start + 7]) == temporary:
                return start, chr(value)
        start = index - 6
        if start >= 0 and _integer(code[start]) == 1 and code[start + 1]['op'] == 'newarr' and code[start + 1]['operand'] == 'System.Char' and code[start + 2]['op'] == 'dup' and _integer(code[start + 3]) == 0 and code[start + 5]['op'] == 'stelem.i2':
            value = _integer(code[start + 4])
            if value is not None and 0 <= value <= 65535:
                return start, chr(value)
    return None


def _tail_loops(instructions):
    """Recognize the complete loop, not merely Split/Append co-occurrence."""
    code = instructions
    for p in range(max(0, len(code) - 36)):
        array, start = _local(code[p]), _integer(code[p + 1])
        if array is None or start is None or not 1 <= start <= 32 or code[p + 2]['op'] != 'ldelem.ref':
            continue
        target = _local(code[p + 3], True)
        if target is None:
            continue
        # Seed tail with fields[N], then append delimiter and fields[N+1..Length).
        seed = code[p:p + 14]
        if not (_local(seed[4]) == array and seed[5]['op'] == 'ldlen' and seed[6]['op'] == 'conv.i4'
                and _integer(seed[7]) == start + 2 and seed[8]['op'] in ('blt', 'blt.s')
                and _local(seed[10]) == target and _call(seed[11], '::Set(System.String)')
                and _integer(seed[12]) == start + 1):
            continue
        builder, counter = _local(seed[9]), _local(seed[13], True)
        if builder is None or counter is None:
            continue
        q = p + 14
        # Compiler emits a forward branch to the loop comparison.
        if code[q]['op'] not in ('br', 'br.s'):
            continue
        body = code[q + 1:q + 23]
        if len(body) != 22:
            continue
        delimiter = _literal(body[1])
        if not (isinstance(delimiter, str) and len(delimiter) == 1 and delimiter not in '\r\n"'
                and _local(body[0]) == builder and _call(body[2], '::Append(System.String)')
                and _local(body[3]) == array and _local(body[4]) == counter and body[5]['op'] == 'ldelem.ref'
                and _call(body[6], '::Append(System.String)') and body[7]['op'] == 'pop'
                and _local(body[8]) == counter and _integer(body[9]) == 1 and body[10]['op'] == 'add'
                and _local(body[11], True) == counter and _local(body[12]) == counter
                and _local(body[13]) == array and body[14]['op'] == 'ldlen' and body[15]['op'] == 'conv.i4'
                and body[16]['op'] in ('blt', 'blt.s') and body[16]['operand'] == body[0]['offset']
                and code[q]['operand'] == body[12]['offset'] and _local(body[17]) == builder
                and _call(body[18], 'System.Object::ToString()') and _local(body[19], True) == target):
            continue
        if code[p + 8]['operand'] != body[20]['offset']:
            continue
        # A direct split result must define this exact array before the seed.
        definitions = [n for n in range(p) if _local(code[n], True) == array]
        if not definitions:
            continue
        split = definitions[-1] - 1
        parsed = _split_delimiter(code, split) if split >= 0 else None
        if not parsed or parsed[1] != delimiter:
            continue
        yield {'skipFields': start, 'delimiter': delimiter, 'arrayLocal': array, 'bodyLocal': target,
               'splitOffset': code[split]['offset'], 'tailOffset': code[p]['offset'],
               'endOffset': body[19]['offset'], 'builderLocal': builder,
               'builderType': str(seed[11]['operand']).split(' ', 1)[1].split('::')[0]}


def _safe_builders(methods):
    safe = set()
    for name in {method['type'] for method in methods}:
        group = [m for m in methods if m['type'] == name]
        by_name = {key: [m for m in group if m['name'] == key and not m.get('hasExceptionHandlers')]
                   for key in ('.ctor', 'Set', 'Append', 'ToString')}
        if any(len(value) != 1 for value in by_name.values()):
            continue
        setter, append, to_string = (by_name[key][0]['instructions'] for key in ('Set', 'Append', 'ToString'))
        constructor = by_name['.ctor'][0]['instructions']
        if [i['op'] for i in constructor] != ['ldarg.0', 'call', 'ret'] or not _call(constructor[1], 'System.Object::.ctor()'):
            continue
        if [i['op'] for i in setter] != ['ldarg.0', 'ldarg.1', 'stfld', 'ret']:
            continue
        field = setter[2]['operand']
        if not str(field).startswith('System.String '):
            continue
        if [i['op'] for i in append] not in (['ldarg.0', 'dup', 'ldfld', 'ldarg.1', 'call', 'stfld', 'ldarg.0', 'ret'],
                                            ['ldarg.0', 'ldarg.0', 'ldfld', 'ldarg.1', 'call', 'stfld', 'ldarg.0', 'ret']):
            continue
        if append[2]['operand'] != field or append[5]['operand'] != field or not _call(append[4], 'System.String::Concat(System.String,System.String)'):
            continue
        if [i['op'] for i in to_string] == ['ldarg.0', 'ldfld', 'ret'] and to_string[1]['operand'] == field:
            safe.add(name)
    return safe


def _direct_display(code, loop):
    """Qualify only one contiguous Resources.Load/TextAsset/row/display chain."""
    p = next(n for n, item in enumerate(code) if item['offset'] == loop['splitOffset'])
    parsed = _split_delimiter(code, p)
    row = _local(code[parsed[0] - 1]) if parsed and parsed[0] else None
    if row is None:
        return None
    definitions = [n for n in range(p) if _local(code[n], True) == row]
    if not definitions:
        return None
    d = definitions[-1]
    if d < 3 or code[d - 1]['op'] != 'ldelem.ref':
        return None
    rows = _local(code[d - 3])
    if rows is None or _local(code[d - 2]) is None:
        return None
    definitions = [n for n in range(d - 3) if _local(code[n], True) == rows]
    if not definitions:
        return None
    s = definitions[-1]
    counter = _local(code[d - 2])
    if not (s + 4 == d - 3 and _integer(code[s + 1]) == 0
            and _local(code[s + 2], True) == counter and code[s + 3]['op'] in ('br', 'br.s')):
        return None
    # Fixed API and exact data path; no custom loaders, arbitrary helper calls or alias guesses.
    parsed_lines = _split_delimiter(code, s - 1)
    if not parsed_lines or parsed_lines[1] != '\n':
        return None
    chain = code[max(0, parsed_lines[0] - 3):parsed_lines[0]]
    if len(chain) != 3 or not (isinstance(_literal(chain[0]), str)
            and _call(chain[1], 'UnityEngine.Resources::Load<UnityEngine.TextAsset>(System.String)')
            and _call(chain[2], 'UnityEngine.TextAsset::get_text()')):
        return None
    resource = _literal(chain[0])
    if not resource or resource.startswith(('/', '\\')) or '..' in resource.replace('\\', '/').split('/'):
        return None
    end = next(n for n, item in enumerate(code) if item['offset'] == loop['endOffset'])
    # The reconstructed value must go directly into one supported UI setter.
    # Receiver loads may precede it, but no other operation may read the tail.
    rest = code[end + 1:]
    uses = [n for n, item in enumerate(rest) if _local(item) == loop['bodyLocal']]
    if len(uses) != 1:
        return None
    n = uses[0]
    if n + 1 >= len(rest):
        return None
    sink = rest[n + 1]
    accepted = ('UnityEngine.UI.Text', 'TMPro.TMP_Text', 'TMPro.TextMeshPro', 'TMPro.TextMeshProUGUI')
    if not any(_call(sink, name + '::set_text(System.String)') for name in accepted):
        return None
    after = rest[n + 2:]
    if len(after) != 10 or not (_local(after[0]) == counter and _integer(after[1]) == 1
            and after[2]['op'] == 'add' and _local(after[3], True) == counter
            and _local(after[4]) == counter and _local(after[5]) == rows and after[6]['op'] == 'ldlen'
            and after[7]['op'] == 'conv.i4' and after[8]['op'] in ('blt', 'blt.s')
            and after[8]['operand'] == code[d - 3]['offset'] and after[9]['op'] == 'ret'
            and code[s + 3]['operand'] == after[4]['offset']):
        return None
    if any(item['op'] not in ('ret', 'nop', 'br', 'br.s', 'ldloc', 'ldloc.s', 'ldloc.0', 'ldloc.1',
                               'ldloc.2', 'ldloc.3', 'ldarg.0', 'ldarg.1', 'ldarg.2', 'ldarg.3', 'ldfld')
           for item in rest[:n]):
        return None
    # Reject additional array/row consumers or alternate entries into the proved loops.
    tail_start = next(k for k, item in enumerate(code) if item['offset'] == loop['tailOffset'])
    allowed_array = {tail_start, tail_start + 4, tail_start + 18, tail_start + 28}
    if {k for k, item in enumerate(code) if _local(item) == loop['arrayLocal']} != allowed_array:
        return None
    if {k for k, item in enumerate(code) if _local(item) == row} != {parsed[0] - 1}:
        return None
    if {k for k, item in enumerate(code) if _local(item) == loop['bodyLocal']} != {tail_start + 10, end + 1 + n}:
        return None
    if {k for k, item in enumerate(code) if _local(item) == loop['builderLocal']} != {tail_start + 9, tail_start + 15, tail_start + 32}:
        return None
    definitions = [k for k, item in enumerate(code) if _local(item, True) == loop['builderLocal']]
    if len(definitions) != 1 or definitions[0] == 0:
        return None
    creation = code[definitions[0] - 1]
    if creation['op'] != 'newobj' or creation['operand'] != 'System.Void ' + loop['builderType'] + '::.ctor()':
        return None
    allowed_branch = {s + 3, tail_start + 8, tail_start + 14, tail_start + 31,
                      end + 1 + n + 2 + 8}
    if {k for k, item in enumerate(code) if item['op'].startswith(('br', 'blt', 'bge', 'ble', 'bgt', 'beq', 'bne', 'leave', 'switch'))} != allowed_branch:
        return None
    return {'resourceKey': resource, 'allLines': True, 'loaderOffset': chain[1]['offset'], 'sinkOffset': sink['offset'],
            'sink': sink['operand'], 'proof': 'direct-resources-textasset-line-tail-to-ui'}


def match_resource(report, container_path):
    """Return a unique qualified contract for an actual Unity Resources container key."""
    path = str(container_path).replace('\\', '/').lower()
    candidates = []
    for contract in report.get('contracts', []):
        if contract.get('displayQualified') is not True or contract.get('proof') != 'direct-resources-textasset-line-tail-to-ui':
            continue
        key = contract['resourceKey'].replace('\\', '/').strip('/').lower()
        if re.search(r'(?:^|/)resources/' + re.escape(key) + r'(?:\.[^/]+)?$', path):
            candidates.append(contract)
    # Conflicting readers never choose a delimiter/count by traversal order.
    signatures = {(item['delimiter'], item['skipFields']) for item in candidates}
    return candidates[0] if len(signatures) == 1 else None


def inspect_report(report):
    """Extract parser contracts from a fresh hash-bound IL report (not decisions)."""
    digest = report.get('assemblySha256')
    if not re.fullmatch('[a-f0-9]{64}', digest or ''):
        raise ValueError('Reader evidence requires an assembly SHA-256')
    contracts = []
    safe_builders = _safe_builders(report.get('builderMethods', []))
    for method in report.get('methods', []):
        code = method.get('instructions', [])
        for loop in _tail_loops(code):
            grammar = loop['builderType'] in safe_builders
            display = _direct_display(code, loop) if grammar and not method.get('hasExceptionHandlers') else None
            if display:
                # A second static use of the same loading key is mixed/unknown, not authorization.
                uses = [(other['method'], item['offset']) for other in report.get('methods', [])
                        for item in other.get('instructions', []) if _literal(item) == display['resourceKey']]
                expected_literal = next(item['offset'] for item in code if _literal(item) == display['resourceKey'])
                if uses != [(method['method'], expected_literal)]:
                    display = None
            payload = json.dumps(code, sort_keys=True, ensure_ascii=True, separators=(',', ':')).encode()
            contracts.append({**loop, 'method': method['method'], 'methodToken': method.get('token'),
                              'assemblySha256': digest, 'methodEvidenceSha256': hashlib.sha256(payload).hexdigest(),
                              'grammar': 'split-tail-rejoin', 'grammarQualified': grammar, 'builderQualified': grammar,
                              'displayQualified': bool(display), **(display or {}),
                              'detail': ('Direct resource reader and UI consumer proved' if display else
                                         'Tail-loop syntax candidate; builder, resource loading and display consumers need qualification')})
    return {'schema': VERSION, 'assemblySha256': digest, 'contracts': contracts}


def inspect(assembly, executable):
    assembly = Path(assembly)
    before = hashlib.sha256(assembly.read_bytes()).hexdigest()
    result = subprocess.run([str(executable), str(assembly)], capture_output=True, encoding='utf-8-sig',
                            timeout=90, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        raise ValueError('TextAsset reader inspection failed: ' + result.stderr[-500:])
    report = json.loads(result.stdout)
    if report.get('schema') != 'pinhao-unity-textasset-il-v1' or report.get('assemblySha256') != before:
        raise ValueError('TextAsset reader evidence source mismatch')
    if hashlib.sha256(assembly.read_bytes()).hexdigest() != before:
        raise ValueError('TextAsset reader source changed')
    return inspect_report(report)


def discover(game, assemblies, executable=None):
    """Inspect only hash-declared snapshot assemblies, once per extraction scope."""
    root = Path(__file__).resolve().parents[2]
    choices = [Path(executable)] if executable else []
    if os.environ.get('PINHAO_MANAGED_TOOLS'):
        choices.append(Path(os.environ['PINHAO_MANAGED_TOOLS']) / 'Pinhao.UnityTextAsset.exe')
    choices.extend((root / 'local/dependencies/managed/Pinhao.UnityTextAsset.exe',
                    Path(__file__).parent.parent / 'dependencies/managed/Pinhao.UnityTextAsset.exe'))
    tool = next((path for path in choices if path.is_file()), None)
    contracts, pending = [], []
    for relative, expected in sorted(assemblies.items()):
        path = Path(game).joinpath(*relative.replace('\\', '/').split('/'))
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError('TextAsset reader source changed: ' + relative)
        if tool is None:
            pending.append({'assemblyFile': relative, 'detail': 'Fixed TextAsset reader inspection tool unavailable'})
            continue
        try:
            report = inspect(path, tool)
            contracts.extend({**item, 'assemblyFile': relative} for item in report['contracts'])
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            pending.append({'assemblyFile': relative, 'detail': str(error)[:300]})
    return {'schema': VERSION, 'contracts': contracts, 'pending': pending}
