"""Structural language-column identity; filenames never authorize arbitrary strings."""
from collections import Counter

import text_formats as formats


LANGUAGES = {'ja': 'ja', 'jp': 'ja', 'japanese': 'ja', 'en': 'en', 'english': 'en',
             'zh': 'zh', 'zh-cn': 'zh-hans', 'zh-hans': 'zh-hans'}


def language_columns(keys, source_language=None):
    columns = {key: LANGUAGES[key.lower()] for key in keys if key.lower() in LANGUAGES}
    if not columns:
        return [], None
    if len(set(columns.values())) != len(columns):
        return [], 'duplicate_language_columns'
    if source_language is not None:
        language = LANGUAGES.get(source_language.lower(), source_language.lower())
        selected = [key for key, locale in columns.items() if locale == language]
        return selected, None if selected else 'source_language_missing'
    if len(columns) > 1:
        return [], 'language_selection_required'
    return list(columns), None


def json_entries(value, display_keys, resource_keys, readable, source_language=None):
    entries, issues = [], []

    def visit(item, path=(), allowed=False):
        if isinstance(item, dict):
            identity = any(key.lower() in ('key', 'id') and isinstance(val, (str, int))
                           for key, val in item.items())
            languages, issue = language_columns(item, source_language) if identity else ([], None)
            if issue:
                issues.append('json_' + issue)
            explicit = any(key.lower() in display_keys - {'name'} for key in item)
            for key, child in item.items():
                normalized = key.lower()
                if normalized in resource_keys:
                    continue
                if key in languages and isinstance(child, str):
                    if readable(child):
                        entries.append({'path': list(path + (key,)), 'source': child,
                                        'kind': 'localized_string', 'language': LANGUAGES[normalized],
                                        'key': next(val for name, val in item.items() if name.lower() in ('key', 'id'))})
                    continue
                child_allowed = normalized in display_keys and (normalized != 'name' or explicit)
                visit(child, path + (key,), child_allowed)
        elif isinstance(item, list):
            for index, child in enumerate(item):
                visit(child, path + (index,), allowed)
        elif allowed and readable(item):
            entries.append({'path': list(path), 'source': item, 'kind': 'localized_string'})

    visit(value)
    return entries, next(iter(issues), None)


def csv_entries(text, delimiter, display_keys, readable, source_language=None):
    # csv_cells retains exact source ranges. TSV gets its own scan rather than replacing tabs
    # before parsing, which would corrupt quoted field contents and their offsets.
    if delimiter != ',':
        return None
    rows = formats.csv_cells(text)
    if not rows:
        return None
    headers = [cell[0] for cell in rows[0]]
    if len({key.lower() for key in headers}) != len(headers):
        return {'format': 'csv-spans'}, [], 'csv_unique_display_headers_required'
    if any(len(row) != len(headers) for row in rows[1:]):
        return {'format': 'csv-spans'}, [], 'csv_row_width_mismatch'
    keys = [index for index, key in enumerate(headers) if key.lower() in ('key', 'id')]
    languages, issue = language_columns(headers, source_language) if len(keys) == 1 else ([], None)
    named_display = any(key.lower() in display_keys - {'name'} for key in headers)
    columns = [index for index, key in enumerate(headers)
               if key.lower() in display_keys - {'name'} or key.lower() == 'name' and named_display or key in languages]
    if issue and not columns:
        return {'format': 'csv-spans'}, [], 'csv_' + issue
    entries = []
    for row_index, row in enumerate(rows[1:], 1):
        for index in columns:
            value, start, end = row[index]
            if not readable(value):
                continue
            entry = {'path': [row_index, index], 'span': [start, end], 'source': value, 'kind': 'table_cell'}
            if len(keys) == 1:
                entry['key'] = row[keys[0]][0]
            if headers[index] in languages:
                entry['language'] = LANGUAGES[headers[index].lower()]
            entries.append(entry)
    counts = Counter(row[keys[0]][0] for row in rows[1:]) if len(keys) == 1 else {}
    binding = {'format': 'csv-spans', 'delimiter': delimiter,
               'duplicateKeys': sorted(key for key, count in counts.items() if count > 1),
               'sourceLanguage': source_language}
    return binding, entries, ('csv_' + issue if issue else None) or (None if entries else 'csv_display_headers_required')
