"""Original-object span bindings for statically qualified delimiter readers."""
import re

import text_formats as formats


def entries(original, contract, readable):
    if contract.get('displayQualified') is not True or contract.get('builderQualified') is not True:
        raise ValueError('A delimiter grammar alone is not display authorization')
    count, delimiter = contract['skipFields'], contract['delimiter']
    if type(count) is not int or not 1 <= count <= 32 or not isinstance(delimiter, str) or len(delimiter) != 1 or delimiter in '\r\n':
        raise ValueError('Unsupported delimiter reader contract')
    raw = original.encode('utf-8', 'surrogateescape')
    text, encoding, bom = formats.decode_source(raw)
    result, offset = [], 0
    for number, match in enumerate(re.finditer(r'[^\n]*(?:\n|$)', text), 1):
        line = match[0]
        if not line:
            continue
        body = line[:-2] if line.endswith('\r\n') else line[:-1] if line.endswith('\n') else line
        if not body:
            offset += len(line)
            continue
        cursor = 0
        for _ in range(count):
            position = body.find(delimiter, cursor)
            if position < 0:
                raise ValueError('Delimiter row lacks its proven technical prefix at physical line ' + str(number))
            cursor = position + 1
        value = body[cursor:]
        if readable(value):
            result.append({'path': [offset + cursor, offset + len(body)], 'source': value, 'kind': 'dialogue',
                           'key': body.split(delimiter, 1)[0], 'line': number})
        offset += len(line)
    evidence = {key: contract[key] for key in ('assemblyFile', 'assemblySha256', 'methodToken',
                                                'methodEvidenceSha256', 'proof', 'resourceKey')}
    return {'format': 'txt', 'encoding': encoding, 'bom': bom, 'readerEvidence': evidence}, result, None


def resource_paths(loaded):
    """Use dereferenced member identity, never a bare pathID or TextAsset name."""
    result = {}
    for carrier, (environment, top) in loaded.items():
        from unity_native import objects
        indexed = objects(top)
        by_identity = {(id(obj.assets_file), obj.path_id): key for key, obj in indexed.items()}
        for path, pointer in getattr(environment, 'container', {}).items():
            try:
                obj = pointer.deref()
            except (ValueError, FileNotFoundError, AttributeError):
                continue
            key = by_identity.get((id(obj.assets_file), obj.path_id))
            if key:
                result.setdefault((carrier, key), []).append(path)
    return result
