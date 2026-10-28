"""Inspect and bind native display fields while preserving the source workbench."""
from __future__ import annotations

import copy
import hashlib
from pathlib import Path
import shutil

import rpgmaker as core
import text_formats as formats
from rgss_archive import destination
import unity_native
import unity_semantics

SCHEMA = 'pinhao-native-field-review-v1'


def context(args, helpers):
    work = helpers.clean_path(helpers.path_arg(args, 'workspaceDir', 'workDir'))
    manifest, originals = core.load_work(work)
    if manifest['engine'] != unity_native.ENGINE:
        raise helpers.WorkerError('NATIVE_REVIEW_UNSUPPORTED',
                                  'Native field review is not available for ' + manifest['engine'])
    metadata = core.read(work / 'technical/product-source.json')
    if metadata.get('schema') != 'pinhao-native-unity-v1':
        raise helpers.WorkerError('NATIVE_REVIEW_UNSUPPORTED', 'Unity native metadata is required')
    source = helpers.clean_path(Path(metadata['nativeSource']).resolve())
    return work, manifest, originals, metadata, source


def page_integer(args, key, default, minimum, maximum):
    value = args.get(key, default)
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(key + ' must be an integer in ' + str(minimum) + '..' + str(maximum))
    return value


def review_groups(source, metadata, helpers, file=None):
    serialized = [] if file in metadata.get('assemblyFilesSha256', {}) else unity_native.review_groups(source, metadata, helpers, file)
    return serialized + unity_semantics.code_groups(source, metadata, helpers, file)


def accepted_display_groups(source, metadata, helpers, known=()):
    accepted = {ident: decision for ident, decision in metadata.get('nativeReviewDecisions', {}).items()
                if decision['disposition'] == 'display'}
    groups = {group['groupId']: group for group in known if group['groupId'] in accepted}
    files = {decision['file'] for ident, decision in accepted.items() if ident not in groups}
    for file in sorted(files):
        for group in review_groups(source, metadata, helpers, file):
            if group['groupId'] in accepted:
                groups.setdefault(group['groupId'], group)
    return list(groups.values())


def coverage_issues(metadata, groups):
    accepted = metadata.get('nativeReviewDecisions', {})
    reviewed = [(group, accepted[group['groupId']]) for group in groups
                if group['groupId'] in accepted and accepted[group['groupId']]['evidenceHash'] == group['evidenceHash']]
    covered = {(group['file'], key) for group, _ in reviewed for key in group['_objects']}
    issues = [item for item in metadata.get('issues', [])
              if (item.get('file'), item.get('object')) not in covered
              or item.get('kind') not in unity_native.REVIEW_KINDS | {'unity_display_consumer_pending', unity_semantics.CODE_REVIEW_KIND}]
    for group, decision in reviewed:
        if decision['disposition'] != 'display':
            continue
        if group.get('fieldUses', {}).get('available') is not True:
            group['status'] = 'pending'
            issues.append({'file': group['file'], 'object': next(iter(group['_objects'])),
                           'count': len(group['_objects']),
                           'groupId': group['groupId'], 'script': group['script'],
                           'kind': 'unity_display_consumer_pending', 'category': 'native-schema',
                           'detail': 'Display consumer evidence is unavailable; existing bindings remain available but coverage is not complete'})
            continue
        fields = {tuple(field['path']): set(field.get('displaySites', [])) for field in decision['fields']}
        readable = {tuple(field['path']) for field in group['fields']}
        pending = 0
        for usage in group.get('fieldUses', {}).get('fields', []):
            field = tuple(usage['path'])
            if field not in readable:
                continue
            for safe in (True, False):
                remaining = [use['siteId'] for use in usage.get('uses', []) if use.get('display')
                             and (use.get('displayOnly') is True) == safe
                             and (not safe or use['siteId'] not in fields.get(field, set()))]
                if not remaining:
                    continue
                pending += len(remaining) if safe else 0
                issues.append({'file': group['file'], 'object': next(iter(group['_objects'])),
                               'count': len(group['_objects']),
                               'groupId': group['groupId'], 'script': group['script'],
                               'kind': 'unity_display_consumer_pending', 'category': 'native-schema' if safe else 'info',
                               'field': usage['path'], 'remainingSites': remaining,
                               'detail': (str(len(remaining)) + ' proven display consumers remain unselected; existing localized consumers remain available'
                                          if safe else 'Mixed or unresolved consumers retain original text; only proven display consumers may be localized')})
        if pending:
            group['status'] = 'pending'
        group['remainingDisplaySites'] = pending
        if group.get('unsupportedTemplates'):
            group['status'] = 'pending'
            issues.append({'file': group['file'], 'object': next(iter(group['_objects'])), 'groupId': group['groupId'],
                           'group': group['groupId'], 'script': group['script'], 'count': len(group['_objects']),
                           'kind': unity_semantics.CODE_REVIEW_KIND, 'category': 'native-schema',
                           'detail': str(group['unsupportedTemplates']) + ' runtime templates remain unsupported; complete literal sentences remain available'})
    return issues


def inspect(args, helpers):
    work, _, _, metadata, source = context(args, helpers)
    offset = page_integer(args, 'offset', 0, 0, 10000000)
    limit = page_integer(args, 'limit', 20, 1, 100)
    file = args.get('file')
    if args.get('groupId') and file is None:
        catalog = metadata.get('nativeReviewCatalog', metadata.get('issues', []))
        resources = {item['file'] for item in catalog if item.get('file')} | set(metadata.get('assemblyFilesSha256', {}))
        files = {file for file in resources if args['groupId'].startswith('native-review-v1:' + core.sha(file.encode())[:16] + ':')}
        if len(files) != 1:
            raise helpers.WorkerError('NATIVE_REVIEW_GROUP_MISSING', 'Native review group does not exist')
        file = files.pop()
    if args.get('acceptedOnly') is True:
        groups = accepted_display_groups(source, metadata, helpers)
        managed = unity_semantics.code_groups(source, metadata, helpers, file)
        groups = list({group['groupId']: group for group in [*groups, *managed]}.values())
    else:
        groups = review_groups(source, metadata, helpers, file)
    if args.get('groupId'):
        groups = [group for group in groups if group['groupId'] == args['groupId']]
        if not groups:
            raise helpers.WorkerError('NATIVE_REVIEW_GROUP_MISSING', 'Native review group does not exist')
        for group in groups:
            if group.get('candidateType') == 'managed-code' and not args.get('coverageOnly'):
                group['producerElements'] = [{'method': item['method'], 'methodToken': item['methodToken'],
                                              'allocationOffset': item['allocationOffset'], 'literalElements': [
                    {'index': index, 'source': value, 'sourceOffsets': item['sourceOffsets'].get(index, [])}
                    for index, value in enumerate(item['tree']['sentences']) if value]}
                    for item in group['_objects'].values()]
    review = coverage_issues({**metadata, 'issues': unity_semantics.code_issues(metadata, [group for group in groups if group.get('candidateType') == 'managed-code'])}, groups)
    if args.get('coverageOnly') is True:
        return {'schema': SCHEMA, 'engine': metadata['engine'], 'capability': 'supported',
                'workspaceDir': str(work), 'reviewItems': review, 'refreshedGroups': len(groups)}
    public = [unity_native.review_public(group) for group in groups]
    selected = public[offset:offset + limit]
    end = offset + len(selected)
    return {'schema': SCHEMA, 'engine': metadata['engine'], 'capability': 'supported',
            'workspaceDir': str(work), 'groups': selected, 'total': len(public), 'offset': offset,
            'nextOffset': end if end < len(public) else None, 'hasMore': end < len(public)}


def normalized_fields(fields):
    if not isinstance(fields, list) or len(fields) > 256:
        raise ValueError('fields must be an array with at most 256 field paths')
    result, seen = [], set()
    for field in fields:
        if not isinstance(field, dict) or set(field) - {'path', 'kind', 'displaySites'}:
            raise ValueError('A display field contains path and an optional kind')
        path = field.get('path')
        if not isinstance(path, list) or not path or len(path) > 64 or any(
                not isinstance(step, str) and type(step) is not int or isinstance(step, str) and not step
                or type(step) is int and step < 0 for step in path):
            raise ValueError('A field path contains nonempty keys, array indexes or *')
        kind = field.get('kind', 'display_text')
        if kind not in ('display_text', 'ui_text', 'localized_string', 'dialogue', 'speaker_name', 'description', 'message', 'paragraph', 'menu'):
            raise ValueError('Choose a display text field kind')
        key = tuple(path)
        if key in seen:
            raise ValueError('Repeated display field path')
        seen.add(key)
        sites = field.get('displaySites')
        if sites is not None and (not isinstance(sites, list) or not sites or len(sites) > 128
                                  or any(not isinstance(site, str) or not site.startswith('display-site-v1:') or len(site) != 80 for site in sites)
                                  or len(set(sites)) != len(sites)):
            raise ValueError('displaySites contains 1..128 distinct site identifiers returned for this field')
        result.append({'path': path, 'kind': kind, **({'displaySites': sites} if sites is not None else {})})
    return sorted(result, key=lambda field: core.serialized(field['path']))


def decision_for(group, value, helpers):
    if not isinstance(value, dict) or set(value) - {'groupId', 'evidenceHash', 'disposition', 'fields', 'reason', 'file'}:
        raise ValueError('A native review decision contains groupId, evidenceHash, disposition, fields and reason')
    if value.get('evidenceHash') != group['evidenceHash']:
        raise helpers.WorkerError('NATIVE_REVIEW_STALE', 'Native review evidence changed; inspect this group again')
    if value.get('file', group['file']) != group['file']:
        raise ValueError('Native review decision carrier differs from its group')
    disposition = value.get('disposition')
    if disposition not in ('display', 'non-display'):
        raise ValueError('disposition must be display or non-display')
    reason = value.get('reason')
    if not isinstance(reason, str) or not reason.strip() or len(reason) > 4000:
        raise ValueError('A native review decision requires a reason of at most 4000 characters')
    fields = normalized_fields(value.get('fields', []))
    if disposition == 'display' and not fields:
        raise ValueError('A display decision requires at least one field path')
    if disposition == 'non-display' and fields:
        raise ValueError('A non-display decision has no display fields')
    if disposition == 'non-display' and group.get('candidateType') == 'managed-code' and group.get('hasDisplayEvidence', group.get('verifiedDisplayInputs')):
        raise helpers.WorkerError('NATIVE_CODE_DISPLAY_REQUIRED', 'This method family produces complete sentences for a proven display input. Select fields with kind dialogue and their displaySites, or investigate the remaining adapter; it is not non-display')
    readable = {tuple(field['path']) for field in group.get('fields', [])}
    if disposition == 'non-display' and any(
            tuple(usage['path']) in readable and any(use.get('display') is True for use in usage.get('uses', []))
            for usage in group.get('fieldUses', {}).get('fields', [])):
        raise helpers.WorkerError('NATIVE_FIELD_DISPLAY_REQUIRED',
                                  'Readable fields have actual display consumers. Select their safe displaySites or leave unresolved consumers pending; this group is not non-display')
    if group.get('status') == 'blocked':
        raise helpers.WorkerError('NATIVE_REVIEW_SCHEMA_REQUIRED', group['detail'])
    for field in fields:
        unity_semantics.bind_field(group, field, helpers)
    return {'groupId': group['groupId'], 'file': group['file'], 'evidenceHash': group['evidenceHash'],
            'disposition': disposition, 'fields': fields, 'reason': reason}


def extend_rows(work, manifest, metadata, plans, helpers):
    collector = formats.Collector(work / 'baseline', metadata['engine'], 'json', 120)
    existing_paths, counts = {}, {}
    for ident, unit in manifest['units'].items():
        counts[unit['file']] = max(counts.get(unit['file'], 0), int(ident.rsplit(':', 1)[1]))
    collector.counts.update(counts)
    for file, record in metadata['recordMap'].items():
        if record.get('binding', {}).get('format') not in ('fields', 'unity-display-site'):
            continue
        for index, entry in enumerate(core.read(destination(work / 'baseline', file))['entries']):
            existing_paths[(record['carrier'], record['object'], tuple(entry['path']))] = (file, index)
    updated_files = {}
    for group, decision in plans:
        if decision['disposition'] != 'display':
            continue
        additions = unity_native.review_entries(group, [unity_semantics.bind_field(group, field, helpers) for field in decision['fields']])
        for item in additions:
            entry, obj_key = item['entry'], item['object']
            target_key = (group['file'], obj_key, tuple(entry['path']))
            if target_key in existing_paths:
                file, index = existing_paths[target_key]
                baseline = updated_files.setdefault(file, core.read(destination(work / 'baseline', file)))
                baseline['entries'][index]['displayBinding'] = entry['displayBinding']
                metadata['recordMap'][file]['binding'] = {'format': 'unity-display-site'}
                continue
            virtual = '__unity_review__/' + hashlib.sha256((group['file'] + '\0' + obj_key).encode()).hexdigest()[:24] + '.json'
            if virtual not in updated_files:
                old = core.read(destination(work / 'baseline', virtual)) if virtual in manifest['files'] else {'entries': []}
                updated_files[virtual] = old
                collector.counts[virtual] = counts.get(virtual, 0)
            entries = updated_files[virtual]['entries']
            index = len(entries)
            entries.append(entry)
            existing_paths[target_key] = (virtual, index)
            record = {'carrier': group['file'], 'object': obj_key, 'type': 'ManagedMethod' if group.get('candidateType') == 'managed-code' else 'MonoBehaviour',
                      'binding': {'format': 'unity-display-site'}, 'reviewGroup': group['groupId']}
            if item.get('schema'):
                schema_hash = core.sha(core.serialized(item['schema']))
                metadata.setdefault('nativeReviewSchemas', {})[schema_hash] = item['schema']
                record['reviewSchema'] = schema_hash
            previous = metadata['recordMap'].get(virtual)
            if previous and previous != record:
                raise ValueError('Native review object binding changed')
            metadata['recordMap'][virtual] = record
            collector.add(virtual, ['entries', index, 'source'], entry['source'], entry['kind'],
                          {'carrier': group['file'], 'object': obj_key, 'asset': item['name'],
                           'field': entry['path'], 'type': record['type'], 'reviewGroup': group['groupId'],
                           **({'scene': item['name'], 'method': item['name'], 'arrayField': group['arrayField'],
                               'elementIndex': entry['path'][-1], **entry.get('codeOrigin', {})}
                              if group.get('candidateType') == 'managed-code' else {})}, 'formatted')
            if group.get('candidateType') == 'managed-code':
                sites = sorted(use['siteId'] for usage in group['fieldUses']['fields']
                               for use in usage['uses'] if use.get('displayOnly') is True)
                collector.units[collector.rows[-1]['id']]['sync_group'] = 'unity-display-' + core.sha(core.serialized([
                    entry['displayBinding']['assemblyFile'], sites, entry['source']]))[:24]
    collector.files.update({file: core.serialized(value) for file, value in updated_files.items()})
    return collector


def write_extension(output, manifest, collector):
    for file, raw in collector.files.items():
        target = destination(output / 'baseline', file)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
        manifest['files'][file] = {'sha256': core.sha(raw), 'bytes': len(raw)}
    manifest['units'].update(collector.units)
    for offset in range(0, len(collector.rows), collector.batch_size):
        rows = collector.rows[offset:offset + collector.batch_size]
        name = 'native-review-' + core.sha(core.serialized([row['id'] for row in rows]))[:24] + '.json'
        if name in manifest['sheets']:
            raise ValueError('Native review sheet collision')
        sheet = {'schema': 'rpgmaker-ai-units-v1', 'units': rows}
        manifest['sheets'][name] = core.sha(core.serialized(sheet))
        core.write(output / 'editable' / name, sheet)
        core.write(output / 'technical/row-baseline' / name, sheet)
    (output / 'manifest.json').write_bytes(core.serialized(manifest))
    (output / 'technical/manifest.sha256').write_text(core.sha(core.serialized(manifest)) + '\n', encoding='ascii')


def adapt(args, helpers):
    work, manifest, originals, metadata, source = context(args, helpers)
    core.validate_sheets(manifest, originals, core.read_editable(work, manifest))
    output = helpers.fresh(helpers.path_arg(args, 'outputDir', 'outDir'), (work, source))
    decisions = args.get('decisions')
    if not isinstance(decisions, list) or not decisions or len(decisions) > 100:
        raise ValueError('decisions must contain 1..100 native field reviews')
    by_id, files, seen = {}, set(), set()
    catalog = metadata.get('nativeReviewCatalog', metadata.get('issues', []))
    for value in decisions:
        ident = value.get('groupId') if isinstance(value, dict) else None
        if not isinstance(ident, str) or ident in seen:
            raise ValueError('Native decisions require distinct groupId values')
        seen.add(ident)
    # The group catalog includes prior decisions so repeated commits remain verifiable.
    for issue in catalog:
        file = issue.get('file')
        if file and any(ident.startswith('native-review-v1:' + core.sha(file.encode())[:16] + ':') for ident in seen):
            files.add(file)
    files.update(file for file in metadata.get('assemblyFilesSha256', {})
                 if any(ident.startswith('native-review-v1:' + core.sha(file.encode())[:16] + ':') for ident in seen))
    for file in sorted(files):
        for group in review_groups(source, metadata, helpers, file):
            if group['groupId'] in seen:
                by_id[group['groupId']] = group
    if seen != set(by_id):
        raise helpers.WorkerError('NATIVE_REVIEW_GROUP_MISSING', 'Native review group does not exist')
    plans = [(by_id[value['groupId']], decision_for(by_id[value['groupId']], value, helpers)) for value in decisions]
    accepted = metadata.setdefault('nativeReviewDecisions', {})
    for group, decision in plans:
        previous = accepted.get(group['groupId'])
        same_evidence = previous and previous['evidenceHash'] == decision['evidenceHash']
        if same_evidence and previous['disposition'] != decision['disposition']:
            raise ValueError('A native review disposition conflicts with an accepted decision')
        if same_evidence and decision['disposition'] == 'display':
            fields = {tuple(field['path']): field for field in previous['fields']}
            for field in decision['fields']:
                old = fields.get(tuple(field['path']))
                if old and old['kind'] != field['kind']:
                    raise ValueError('A native display field kind conflicts with its accepted binding')
                if old and old.get('displaySites'):
                    field = {**field, 'displaySites': sorted(set(old['displaySites']) | set(field.get('displaySites', [])))}
                fields[tuple(field['path'])] = field
            decision['fields'] = normalized_fields(list(fields.values()))
        accepted[group['groupId']] = decision
    collector = extend_rows(work, manifest, metadata, plans, helpers)
    managed = unity_semantics.code_groups(source, metadata, helpers)
    metadata['issues'] = unity_semantics.code_issues(metadata, managed)
    metadata.setdefault('nativeReviewCatalog', copy.deepcopy(metadata.get('issues', [])))
    catalog_ids = {item.get('groupId') for item in metadata['nativeReviewCatalog']}
    metadata['nativeReviewCatalog'].extend(item for item in unity_semantics.code_issues({}, managed) if item['groupId'] not in catalog_ids)
    coverage_groups = {group['groupId']: group for group, _ in plans}
    coverage_groups.update({group['groupId']: group for group in managed})
    coverage_groups.update({group['groupId']: group for group in accepted_display_groups(source, metadata, helpers, coverage_groups.values())})
    metadata['issues'] = coverage_issues(metadata, coverage_groups.values())
    for rel, path in helpers.files_in(work):
        target = destination(output, rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
    write_extension(output, manifest, collector)
    helpers.json_write(output / 'technical/product-source.json', metadata)
    helpers.json_write(output / 'review-required.json', metadata['issues'])
    report = core.read(output / 'extraction-report.json')
    report.update(units=len(manifest['units']), files=len(manifest['files']), sheets=len(manifest['sheets']),
                  review_items=len(metadata['issues']), addedUnits=len(collector.units))
    helpers.json_write(output / 'extraction-report.json', report)
    updated, sheets = core.load_work(output)
    rows = [{**row, 'legacyId': row['id'], 'file': updated['units'][row['id']]['file']}
            for sheet in core.read_editable(output, updated).values() for row in sheet['units']]
    core.validate_sheets(updated, sheets, core.read_editable(output, updated))
    return {**report, 'engine': metadata['engine'], 'workspaceDir': str(output), 'workDir': str(output),
            'manifestPath': str(output / 'manifest.json'), 'sourceFingerprint': metadata['sourceFingerprint'],
            'units': rows, 'reviewItems': metadata['issues'],
            'nativeReviewDecisions': list(accepted.values()),
            'dynamicCandidates': core.read(output / 'dynamic-candidates.json'),
            'images': core.read(output / 'image-inventory.json'), 'capabilities': helpers.capabilities(metadata['engine'])}
