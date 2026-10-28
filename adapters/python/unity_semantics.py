"""Bound native fields to evidence-backed display consumers without changing identity values."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess

VERSION = 'pinhao-unity-display-sites-v2'
_REPORTS = {}
CODE_VERSION = 'pinhao-unity-code-text-v1'
CODE_REVIEW_KIND = 'managed_code_display_schema_required'
_CODE_REPORTS = {}
METADATA_VERSION = 'pinhao-unity-event-metadata-v1'
_METADATA_REPORTS = {}


def code_groups(source, metadata, helpers, file=None):
    """Discover complete runtime-produced strings, never isolated ldstr fragments."""
    import rpgmaker as core
    from unity_native import readable
    assemblies = metadata.get('assemblyFilesSha256', {})
    referenced = {item.get('script', {}).get('assembly') for item in
                  metadata.get('nativeReviewCatalog', metadata.get('issues', []))}
    files = [file] if file in assemblies else [] if file is not None else [
        name for name in assemblies if PurePosixPath(name).name in referenced]
    groups = []
    for relative in sorted(files):
        expected = assemblies[relative]
        assembly = Path(source).joinpath(*PurePosixPath(relative).parts)
        if helpers.digest_file(assembly) != expected:
            raise helpers.WorkerError('SOURCE_CHANGED', 'Managed dialogue source assembly changed: ' + relative)
        key = (expected, CODE_VERSION)
        if key not in _CODE_REPORTS:
            report = run(['inspect-code', assembly])
            if report.get('schema') != CODE_VERSION or report.get('assemblySha256') != expected:
                raise ValueError('Managed dialogue evidence differs from its source assembly')
            _CODE_REPORTS[key] = report
        buckets = {}
        for method in _CODE_REPORTS[key].get('groups', []):
            sites = [dict(site) for site in method.get('displaySites', [])]
            identity = (method['arrayField'], tuple(sorted(site['siteId'] for site in sites)))
            bucket = buckets.setdefault(identity, {'methods': [], 'sites': sites})
            bucket['methods'].append(method)
        for (array_field, site_ids), bucket in buckets.items():
            identity = {'candidateType': 'managed-code', 'arrayField': array_field,
                        'displaySites': list(site_ids), 'codeSemanticsVersion': CODE_VERSION}
            group_id = 'native-review-v1:' + core.sha(relative.encode())[:16] + ':' + core.sha(core.serialized(identity))[:24]
            objects, examples, count, unsupported = {}, [], 0, 0
            for method in bucket['methods']:
                object_key = 'method:' + str(method['methodToken']) + ':array:' + str(method['allocationOffset'])
                elements = method.get('elements', [])
                values = [''] * (max((item['index'] for item in elements), default=-1) + 1)
                for item in elements:
                    if item.get('supported') is True and isinstance(item.get('source'), str):
                        values[item['index']] = item['source']
                        if readable(item['source']):
                            count += 1
                            if len(examples) < 3:
                                examples.append({'object': object_key,
                                                 'path': ['sentences', item['index']], 'value': item['source'][:240],
                                                 'truncated': len(item['source']) > 240})
                    else:
                        unsupported += 1
                objects[object_key] = {
                    'tree': {'m_Name': method['method'], 'sentences': values}, 'nodes': None,
                    'rawHash': core.sha(core.serialized(method)),
                    'method': method['method'], 'methodToken': method['methodToken'],
                    'allocationOffset': method['allocationOffset'],
                    'sourceOffsets': {item['index']: item.get('sourceOffsets', []) for item in elements}}
            evidence = {'protocol': CODE_VERSION, 'file': relative, 'assemblySha256': expected,
                        'identity': identity, 'objects': {name: obj['rawHash'] for name, obj in objects.items()}}
            group = {'id': group_id, 'groupId': group_id, 'file': relative, 'candidateType': 'managed-code',
                     'codeSemanticsVersion': CODE_VERSION, 'methodCount': len(objects), 'arrayField': array_field,
                     'script': {'assembly': PurePosixPath(relative).name, 'namespace': '',
                                'className': array_field.rsplit('::', 1)[0].rsplit(' ', 1)[-1]},
                     'methods': [{'method': item['method'], 'methodToken': item['methodToken'],
                                  'allocationOffset': item['allocationOffset'],
                                  'elementCount': len(item.get('elements', []))} for item in bucket['methods']],
                     '_objects': objects, '_fieldMap': {}, '_errors': [], 'objectCount': len(objects),
                     'fields': [{'path': ['sentences', '*'], 'count': count, 'examples': examples}] if count else [],
                     'unsupportedTemplates': unsupported, 'evidenceHash': core.sha(core.serialized(evidence)),
                     'verifiedDisplayInputs': bool(count and any(site.get('displayOnly') is True for site in bucket['sites'])),
                     'hasDisplayEvidence': any(site.get('display') is True for site in bucket['sites']),
                     'fieldUses': {'available': True, 'assemblyFile': relative, 'assemblySha256': expected,
                                   'fields': [{'path': ['sentences', '*'], 'uses': bucket['sites']}]},
                     'status': 'pending' if count or unsupported else 'no-text',
                     'detail': 'Runtime-produced complete sentences require proven presentation-store bindings; unsupported templates remain pending'}
            decision = metadata.get('nativeReviewDecisions', {}).get(group_id)
            if decision and decision['evidenceHash'] == group['evidenceHash']:
                group.update(status='accepted', decision=decision)
            groups.append(group)
    return groups


def code_issues(metadata, groups):
    ids = {group['groupId'] for group in groups}
    issues = [item for item in metadata.get('issues', [])
              if item.get('kind') != CODE_REVIEW_KIND or item.get('groupId') not in ids]
    issues.extend({'file': group['file'], 'object': next(iter(group['_objects'])), 'groupId': group['groupId'],
                   'group': group['groupId'], 'script': group['script'], 'kind': CODE_REVIEW_KIND,
                   'category': 'native-schema', 'count': group['objectCount'], 'detail': group['detail']}
                  for group in groups)
    return issues


def executable():
    root = Path(__file__).resolve().parents[2]
    candidates = [Path(os.environ['PINHAO_UNITY_DISPLAY'])] if os.environ.get('PINHAO_UNITY_DISPLAY') else []
    if os.environ.get('PINHAO_MANAGED_TOOLS'):
        candidates.append(Path(os.environ['PINHAO_MANAGED_TOOLS']) / 'Pinhao.UnityDisplay.exe')
    candidates.extend((root / 'local/dependencies/managed/Pinhao.UnityDisplay.exe',
                       Path(__file__).parent.parent / 'dependencies/managed/Pinhao.UnityDisplay.exe'))
    found = next((path for path in candidates if path.is_file()), None)
    if found is None:
        raise ValueError('Prepare the fixed Pinhao managed display tools before reviewing field semantics')
    return found


def run(arguments):
    result = subprocess.run([str(executable()), *map(str, arguments)], capture_output=True, encoding='utf-8-sig',
                            timeout=90, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        raise ValueError('Unity display consumer validation failed: ' + result.stderr[-800:])
    return json.loads(result.stdout)


def inspect_fields(source, metadata, carrier, script):
    name = script.get('assembly', '')
    if name and not name.lower().endswith('.dll'):
        name += '.dll'
    relative = (PurePosixPath(carrier).parts[0] + '/Managed/' + name) if name and Path(name).name == name else ''
    expected = metadata.get('assemblyFilesSha256', {}).get(relative)
    if not expected:
        return {'available': False, 'detail': 'Field-use evidence requires the source managed assembly', 'fields': []}
    assembly = Path(source).joinpath(*PurePosixPath(relative).parts)
    if hashlib.sha256(assembly.read_bytes()).hexdigest() != expected:
        raise ValueError('Unity display source assembly changed')
    type_name = '.'.join(part for part in (script.get('namespace'), script.get('className')) if part)
    key = (expected, type_name, VERSION)
    if key not in _REPORTS:
        try:
            report = run(['inspect', assembly, type_name])
            if report.get('assemblySha256') != expected:
                raise ValueError('Field-use evidence differs from the source assembly')
            _REPORTS[key] = {**report, 'available': True, 'assemblyFile': relative, 'version': VERSION}
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            return {'available': False, 'detail': str(error), 'fields': []}
    return _REPORTS[key]


def metadata_fields(source, metadata, carrier, script):
    """Prove exact engine metadata paths; unresolved declarations remain readable candidates."""
    name = script.get('assembly', script.get('m_AssemblyName', ''))
    if name and not name.lower().endswith('.dll'):
        name += '.dll'
    root = PurePosixPath(carrier).parts[0]
    relative = root + '/Managed/' + name if name and Path(name).name == name else ''
    hashes = metadata.get('assemblyFilesSha256', {})
    expected = hashes.get(relative)
    if not expected:
        return []
    type_name = '.'.join(part for part in (script.get('namespace', script.get('m_Namespace')),
                                          script.get('className', script.get('m_ClassName'))) if part)
    dependencies = {PurePosixPath(path).name: digest for path, digest in hashes.items()
                    if PurePosixPath(path).parts[0] == root}
    key = (expected, type_name, METADATA_VERSION, tuple(sorted(dependencies.items())))
    if key not in _METADATA_REPORTS:
        try:
            assembly = Path(source).joinpath(*PurePosixPath(relative).parts)
            if hashlib.sha256(assembly.read_bytes()).hexdigest() != expected:
                raise ValueError('Unity metadata source assembly changed')
            report = run(['inspect-metadata', assembly, type_name])
            if report.get('schema') != METADATA_VERSION or report.get('assemblySha256') != expected or report.get('typeName') != type_name:
                raise ValueError('Unity metadata declaration differs from its source assembly')
            if any(dependencies.get(name) != digest for name, digest in report.get('dependencyAssemblies', {}).items()):
                raise ValueError('Unity metadata dependency declarations differ from the source snapshot')
            fields = report.get('metadataFields', [])
            _METADATA_REPORTS[key] = [dict(field, version=METADATA_VERSION, assemblyFile=relative,
                                          assemblySha256=expected, dependencyAssemblies=report['dependencyAssemblies'])
                                      for field in fields if isinstance(field.get('path'), list)
                                      and field.get('rule') == 'unity-event-serialized-type-identity'
                                      and field['path'] and field['path'][-1] == 'm_TypeName']
        except (OSError, ValueError, subprocess.SubprocessError):
            _METADATA_REPORTS[key] = []
    return _METADATA_REPORTS[key]


def bind_field(group, field, helpers):
    report = group.get('fieldUses', {})
    usage = next((item for item in report.get('fields', []) if item.get('path') == field['path']), None)
    sites = field.get('displaySites', [])
    if not report.get('available') or usage is None:
        raise helpers.WorkerError('NATIVE_FIELD_SEMANTICS_PENDING', 'Field use is not established; inspect the managed field references or create a display adapter')
    allowed = {item['siteId'] for item in usage.get('uses', []) if item.get('displayOnly') is True}
    if not sites or any(site not in allowed for site in sites):
        raise helpers.WorkerError('NATIVE_DISPLAY_SITES_REQUIRED', 'Choose displaySites from this field use report with displayOnly:true; source identity fields cannot be rewritten')
    return {**field, 'displayBinding': {'format': 'unity-display-site', 'assemblyFile': report['assemblyFile'],
            'assemblySha256': report['assemblySha256'], 'sites': sites, 'version': VERSION}}


def build(source, output, updates, helpers):
    by_assembly = {}
    for entry, translation in updates:
        binding = entry.get('displayBinding')
        if not binding or binding.get('format') != 'unity-display-site' or binding.get('version') != VERSION:
            raise helpers.WorkerError('NATIVE_FIELD_SEMANTICS_PENDING', 'Reviewed custom fields require verified display-site bindings; preserve source identity and adapt their display consumer')
        relative = binding['assemblyFile']
        bucket = by_assembly.setdefault(relative, {'assemblySha256': binding['assemblySha256'], 'bindings': {}})
        if bucket['assemblySha256'] != binding['assemblySha256']:
            raise ValueError('Display bindings disagree on their source assembly')
        for site in binding['sites']:
            key = (site, entry['source'])
            item = {'siteId': site, 'source': entry['source'], 'translation': translation}
            if key in bucket['bindings'] and bucket['bindings'][key] != item:
                raise ValueError('Conflicting translations for the same display site and original identity')
            bucket['bindings'][key] = item
    reports = []
    for relative, plan in sorted(by_assembly.items()):
        original = Path(source).joinpath(*PurePosixPath(relative).parts)
        if helpers.digest_file(original) != plan['assemblySha256']:
            raise ValueError('Display source assembly changed before build')
        target = Path(output).joinpath(*PurePosixPath(relative).parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        plan_file = Path(output) / ('display-plan-' + hashlib.sha256(relative.encode()).hexdigest()[:20] + '.json')
        helpers.json_write(plan_file, {**plan, 'bindings': list(plan['bindings'].values())})
        report = run(['patch', original, plan_file, target])
        if report.get('originalBusinessIlUnchanged') is not True or report.get('outputSha256') != helpers.digest_file(target):
            raise ValueError('Managed display patch readback did not preserve original business instructions')
        reports.append({**report, 'file': relative, 'sourceIdentifiersUnchanged': True})
        plan_file.unlink()
    return reports
