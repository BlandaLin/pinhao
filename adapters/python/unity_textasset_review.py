"""Language selection through the existing native review lifecycle."""
import hashlib
from pathlib import Path

import rpgmaker as core
import text_formats as formats
import unity_textasset_policy as policy
from rgss_archive import destination


KINDS = {'csv_language_selection_required', 'json_language_selection_required'}
VERSION = 'pinhao-unity-textasset-language-v1'


def locales(name, text):
    if text.lstrip().startswith(('{', '[')):
        value = core.parse_json(text.encode('utf-8'))
        found = set()
        def visit(item):
            if isinstance(item, dict):
                if any(key.lower() in ('key', 'id') and isinstance(val, (str, int)) for key, val in item.items()):
                    found.update(policy.LANGUAGES[key.lower()] for key in item if key.lower() in policy.LANGUAGES)
                for child in item.values():
                    visit(child)
            elif isinstance(item, list):
                for child in item:
                    visit(child)
        visit(value)
        return sorted(found)
    delimiter = '\t' if Path(name).suffix.lower() == '.tsv' else ','
    import csv
    import io
    header = next(csv.reader(io.StringIO(text), delimiter=delimiter), [])
    return sorted({policy.LANGUAGES[key.lower()] for key in header if key.lower() in policy.LANGUAGES})


def groups(source, metadata, helpers, file=None):
    import unity_native as unity
    issues = metadata.get('nativeReviewCatalog', metadata.get('issues', []))
    selected = {(item['file'], item['object']) for item in issues if item.get('kind') in KINDS
                and (file is None or item.get('file') == file)}
    loaded, result = {}, []
    for carrier, key in sorted(selected):
        path = destination(source, carrier)
        expected = metadata['nativeFilesSha256'].get(carrier)
        if not expected or helpers.digest_file(path) != expected:
            raise helpers.WorkerError('SOURCE_CHANGED', 'TextAsset language source changed: ' + carrier)
        if carrier not in loaded:
            loaded[carrier] = unity.objects(unity.load_carrier(path)[1])
        obj = loaded[carrier][key]
        tree = obj.parse_as_dict()
        raw = tree['m_Script'].encode('utf-8', 'surrogateescape')
        text, _, _ = formats.decode_source(raw)
        fields = []
        for language in locales(tree['m_Name'], text):
            _, entries, issue = unity.text_asset_entries(tree['m_Name'], tree['m_Script'], source_language=language)
            chosen = [entry for entry in entries if entry.get('language') == language]
            if chosen and issue is None:
                fields.append({'path': ['language', language], 'count': len(chosen),
                               'examples': [{'value': entry['source'][:240], 'path': entry['path'],
                                             'truncated': len(entry['source']) > 240} for entry in chosen[:3]]})
        identity = [VERSION, carrier, key]
        group_id = 'native-review-v1:' + core.sha(carrier.encode())[:16] + ':' + core.sha(core.serialized(identity))[:24]
        evidence = core.sha(core.serialized([VERSION, carrier, key, expected, core.sha(obj.get_raw_data()), fields]))
        decision = metadata.get('nativeReviewDecisions', {}).get(group_id)
        result.append({'id': group_id, 'groupId': group_id, 'file': carrier, 'candidateType': 'textasset-language',
                       'script': {'className': 'TextAsset', 'namespace': '', 'assembly': ''},
                       'objectCount': 1, '_objects': {key: {'tree': tree}}, 'fields': fields,
                       'evidenceHash': evidence, 'status': 'accepted' if decision and decision['evidenceHash'] == evidence else 'pending',
                       'detail': 'Choose exactly one source language field. Key and other language columns remain unchanged; this is not permission to translate arbitrary JSON fields.'})
    return result


def validate_selection(group, fields):
    allowed = {tuple(field['path']) for field in group['fields']}
    if len(fields) != 1 or tuple(fields[0]['path']) not in allowed or fields[0].get('displaySites'):
        raise ValueError('Choose exactly one actual TextAsset source language field; no displaySites')


def extend(work, manifest, metadata, group, decision, collector, updated_files, existing_paths):
    import unity_native as unity
    language = decision['fields'][0]['path'][1]
    key, obj = next(iter(group['_objects'].items()))
    tree = obj['tree']
    binding, entries, issue = unity.text_asset_entries(tree['m_Name'], tree['m_Script'], source_language=language)
    if issue:
        raise ValueError('Selected TextAsset language cannot be parsed: ' + issue)
    virtual = '__unity_text__/' + hashlib.sha256((group['file'] + '\0' + key).encode()).hexdigest()[:24] + '.json'
    content = updated_files.setdefault(virtual, core.read(destination(work / 'baseline', virtual)) if virtual in manifest['files'] else {'entries': []})
    record = {'carrier': group['file'], 'object': key, 'type': 'TextAsset', 'binding': binding}
    previous = metadata['recordMap'].get(virtual)
    comparable = {**record, 'binding': {name: value for name, value in binding.items() if name != 'sourceLanguage'}}
    old = {**previous, 'binding': {name: value for name, value in previous['binding'].items() if name != 'sourceLanguage'}} if previous else None
    if previous and old != comparable:
        raise ValueError('TextAsset language selection conflicts with an existing native binding')
    metadata['recordMap'][virtual] = record
    for entry in entries:
        target_key = (group['file'], key, tuple(entry['path']))
        if target_key in existing_paths:
            continue
        index = len(content['entries'])
        content['entries'].append(entry)
        existing_paths[target_key] = (virtual, index)
        collector.add(virtual, ['entries', index, 'source'], entry['source'], entry['kind'],
                      {'carrier': group['file'], 'object': key, 'asset': tree['m_Name'], 'field': entry['path'],
                       'type': 'TextAsset', **{name: entry[name] for name in ('language', 'key') if name in entry}}, 'formatted')
