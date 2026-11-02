"""Read-only RGSS script views and checked reinsertion into their Marshal slots."""
from pathlib import Path
import hashlib
import re
import zlib

from ruby_marshal import Reader, RString
from rgss_archive import destination
import adapter_overlay
import rgss_display

PREFIX = '__pinhao_rgss__/scripts/'
ENGINES = {'XP', 'VX', 'VX Ace'}


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def inflate(raw):
    decoder = zlib.decompressobj()
    text = decoder.decompress(raw, 64 * 1024 * 1024 + 1)
    if len(text) > 64 * 1024 * 1024 or decoder.unconsumed_tail or decoder.unused_data or not decoder.eof:
        raise ValueError('Incomplete or oversized RGSS script body')
    return text


def decode(raw):
    for encoding in ('utf-8-sig', 'cp932'):
        try:
            text = raw.decode(encoding)
            if '\0' in text:
                raise ValueError('RGSS script body contains binary data')
            return text, 'utf-8-sig' if raw.startswith(b'\xef\xbb\xbf') else 'utf-8' if encoding == 'utf-8-sig' else encoding
        except UnicodeError:
            continue
    raise ValueError('RGSS script text encoding is unavailable')


def prepare(work, resource_root, helpers):
    manifest, _ = helpers.native.load_work(work)
    if manifest['engine'] not in ENGINES:
        return {'reviewItems': [], 'sourceRoots': []}
    metadata_file = work / 'technical/product-source.json'
    metadata = helpers.native.read(metadata_file)
    view = work.parent / (work.name + '-rgss-source')
    records, issues, carriers = [], [], {}
    for file in manifest['files']:
        if Path(file).stem != 'Scripts':
            continue
        path = destination(resource_root, file)
        raw = path.read_bytes()
        reader = Reader(raw)
        if not isinstance(reader.root, list):
            raise ValueError('RGSS Scripts must be a native slot array')
        carriers[file] = digest(raw)
        for index, row in enumerate(reader.root):
            if (not isinstance(row, list) or len(row) != 3 or type(row[0]) is not int
                    or not isinstance(row[1], RString) or not isinstance(row[2], RString)):
                issues.append({'file': file, 'kind': 'rgss_script_source_adapter_required', 'slot': index,
                               'detail': 'Unsupported native script slot shape', 'editable': False})
                continue
            payload = row[2]
            try:
                raw_source = inflate(payload.raw)
                text, encoding = decode(raw_source)
                if not text.strip():
                    continue
                name = decode(row[1].raw)[0] if isinstance(row[1], RString) else str(row[1])
            except (ValueError, zlib.error) as error:
                issues.append({'file': file, 'kind': 'rgss_script_source_adapter_required', 'slot': index,
                               'detail': str(error), 'editable': False})
                continue
            label = re.sub(r'[^A-Za-z0-9._-]+', '-', name).strip('-._')[:24]
            virtual = PREFIX + f'{index:06d}' + ('-' + label if label else '') + '.rb'
            target = destination(view, virtual)
            target.parent.mkdir(parents=True, exist_ok=True)
            materialized = text.encode('utf-8')
            with target.open('xb') as stream:
                stream.write(materialized)
            records.append({'file': virtual, 'carrier': file, 'slot': index,
                            'objectIndex': payload.index, 'scriptId': row[0], 'scriptName': name,
                            'encoding': encoding, 'sourceSha256': digest(raw_source),
                            'compressedSha256': digest(payload.raw), 'viewSha256': digest(materialized)})
    metadata['rgssScriptSources'] = {'schema': 'pinhao-rgss-script-views-v1', 'root': str(view),
                                   'carriers': carriers, 'scripts': records, 'issues': issues}
    roots = [str(view)] if records else []
    metadata['additionalSourceRoots'] = roots
    helpers.json_write(metadata_file, metadata)
    helpers.json_write(work / 'technical/rgss-script-sources.json', metadata['rgssScriptSources'])
    added = register_native_units(work, metadata['rgssScriptSources'], helpers)
    return {'reviewItems': issues, 'sourceRoots': roots, 'scripts': len(records), 'nativeDisplayUnits': added}


def protect_literal(source, native):
    pattern = re.compile(r'%(?:[1-9]\d*\$)?[-+# 0]*(?:\d+|\*)?(?:\.(?:\d+|\*))?[bBdiouxXeEfgGscp]|%%|' + native.CONTROL.pattern)
    controls, tokens = {}, []
    def replace(match):
        token = '{{CTRL%04d}}' % (len(controls) + 1)
        controls[token] = match[0]
        tokens.append(token)
        return token
    value = pattern.sub(replace, source)
    if native.TOKEN.findall(value) != tokens or '{{' in native.TOKEN.sub('', value) or '}}' in native.TOKEN.sub('', value):
        raise ValueError('Reserved control marker in Ruby display literal')
    return value, controls, tokens


def register_native_units(work, layout, helpers):
    """Append checked literal bindings to the existing native manifest, not a side workbench."""
    if not layout['scripts']:
        return 0
    sources = []
    for row in layout['scripts']:
        raw = destination(Path(layout['root']), row['file']).read_bytes()
        if digest(raw) != row['viewSha256']:
            raise ValueError('RGSS source view changed during extraction')
        sources.append({**row, 'text': raw.decode('utf-8')})
    selections = rgss_display.display_constants(sources)
    if not selections:
        return 0
    manifest = helpers.native.read(work / 'manifest.json')
    rows = []
    for selected in selections:
        try:
            source, controls, tokens = protect_literal(selected['source'], helpers.native)
        except ValueError:
            continue
        if not helpers.native.TOKEN.sub('', source).strip():
            continue
        ident = 'Scripts:static:%s:%s:%s' % (selected['carrier'], selected['slot'], selected['constant'])
        if ident in manifest['units']:
            raise ValueError('Repeated native Ruby display identity')
        binding = {key: selected[key] for key in ('carrier', 'slot', 'objectIndex', 'sourceSha256', 'encoding', 'constant', 'start', 'end', 'literal')}
        binding['schema'] = 'pinhao-rgss-display-literal-1'
        binding['sourceFile'] = selected['file']
        binding['viewSha256'] = selected['viewSha256']
        context = {'script': selected['scriptName'], 'slot': selected['slot'], 'field': selected['constant'],
                   'source_file': selected['file'], 'displayConsumers': selected['consumers']}
        manifest['units'][ident] = {'id': ident, 'file': selected['carrier'],
            'targets': ['rgss:%s:%s' % (selected['slot'], selected['constant'])], 'source': source,
            'controls': controls, 'tokens': tokens, 'kind': 'script_display', 'contexts': [context], 'rgss_script': binding}
        rows.append({'id': ident, 'source': source, 'translation': source, 'source_preview': selected['source'],
                     'kind': 'script_display', 'tokens': tokens, 'context': context, 'notes': ''})
    for offset in range(0, len(rows), 120):
        name = 'Scripts_display_%03d.json' % (offset // 120 + 1)
        if name in manifest['sheets']:
            raise ValueError('Repeated native Ruby display sheet')
        sheet = {'schema': 'rpgmaker-ai-units-v1', 'units': rows[offset:offset + 120]}
        helpers.native.write(work / 'editable' / name, sheet)
        helpers.native.write(work / 'technical' / 'row-baseline' / name, sheet)
        manifest['sheets'][name] = helpers.native.sha(helpers.native.serialized(sheet))
    helpers.json_write(work / 'manifest.json', manifest)
    (work / 'technical/manifest.sha256').write_text(helpers.native.sha(helpers.native.serialized(manifest)) + '\n', encoding='ascii')
    targets_path = work / 'technical/native-targets.json'
    if targets_path.is_file():
        targets = helpers.native.read(targets_path)
        targets['manifestSha256'] = helpers.native.sha(helpers.native.serialized(manifest))
        for row in rows:
            unit = manifest['units'][row['id']]
            targets['units'][unit['id']] = {key: unit[key] for key in ('id', 'file', 'source', 'controls', 'kind', 'targets', 'rgss_script')}
        helpers.json_write(targets_path, targets)
        (work / 'technical/native-targets.sha256').write_text(helpers.native.sha(helpers.native.serialized(targets)) + '\n', encoding='ascii')
    report_path = work / 'extraction-report.json'
    report = helpers.native.read(report_path)
    report.update(units=len(manifest['units']), sheets=len(manifest['sheets']), nativeScriptDisplayUnits=len(rows))
    helpers.json_write(report_path, report)
    helpers.native.reset_work_cache()
    return len(rows)


def build_native_files(raw_files, manifest, values, patch_raw_strings):
    """Render only sealed, consumer-qualified literals into their original compressed slots."""
    groups = {}
    for ident, unit in manifest['units'].items():
        binding = unit.get('rgss_script')
        if not binding:
            continue
        if binding.get('schema') != 'pinhao-rgss-display-literal-1' or unit['file'] != binding['carrier']:
            raise ValueError('Unknown native Ruby display binding')
        parts = values[ident]
        if not isinstance(parts, list) or len(parts) != 1:
            raise ValueError('Ruby literal must remain a complete single unit')
        groups.setdefault(binding['carrier'], {}).setdefault(binding['slot'], []).append((unit, parts[0]))
    prepared = {}
    for file, slots in groups.items():
        raw = raw_files[file]
        reader = Reader(raw)
        changes = {}
        for slot, updates in slots.items():
            row = reader.root[slot]
            payload = row[2]
            if sum(isinstance(item, list) and len(item) == 3 and item[2] is payload for item in reader.root) != 1:
                raise ValueError('Shared compressed Ruby slot requires an explicit joint binding')
            original_raw = inflate(payload.raw)
            original, encoding = decode(original_raw)
            edits = []
            for unit, translation in updates:
                binding = unit['rgss_script']
                if payload.index != binding['objectIndex'] or digest(original_raw) != binding['sourceSha256'] or encoding != binding['encoding']:
                    raise ValueError('Native Ruby script baseline differs')
                start, end, token = binding['start'], binding['end'], binding['literal']
                if not isinstance(start, int) or not isinstance(end, int) or not 0 <= start < end <= len(original) or original[start:end] != token:
                    raise ValueError('Native Ruby literal position differs')
                value = rgss_display.literal_value(token)
                if translation != value:
                    edits.append((start, end, rgss_display.render_literal(translation, token)))
            result, boundary = original, len(original)
            for start, end, replacement in sorted(edits, reverse=True):
                if end > boundary:
                    raise ValueError('Overlapping Ruby display literals')
                result = result[:start] + replacement + result[end:]
                boundary = start
            if edits:
                try:
                    encoded = result.encode(encoding)
                except UnicodeError as error:
                    raise ValueError('Translation is not representable in the original Ruby script encoding') from error
                changes[payload.index] = zlib.compress(encoded)
        if not changes:
            continue
        after = patch_raw_strings(reader, changes)
        check = Reader(after)
        if len(check.strings) != len(reader.strings) or any(actual.raw != changes.get(before.index, before.raw)
                for before, actual in zip(reader.strings, check.strings)):
            raise ValueError('Ruby native write changed non-target strings')
        prepared[file] = after
    return prepared


def apply(game_root, work, args, helpers, inventory):
    """Consume only verified virtual-script overlays; ordinary overlays keep their path."""
    rows = args.get('adapterOverlayFiles', [])
    selected = [row for row in rows if helpers.safe_member(row['file']).startswith(PREFIX)]
    if not selected:
        return args
    metadata = helpers.native.read(work / 'technical/product-source.json')
    layout = metadata.get('rgssScriptSources')
    if not layout or layout.get('schema') != 'pinhao-rgss-script-views-v1':
        raise helpers.WorkerError('RGSS_SCRIPT_SOURCE', 'RGSS script overlay has no native source mapping')
    view = helpers.clean_path(Path(layout['root']).resolve())
    workspace = work.parent.resolve()
    if not view.is_relative_to(workspace):
        raise helpers.WorkerError('RGSS_SCRIPT_SOURCE', 'RGSS script view must remain in its project workspace')
    known = {row['file']: row for row in layout['scripts']}
    staged = dict(adapter_overlay.entries({**args, 'adapterOverlayFiles': selected}, helpers))
    replacements = {}
    expected_sources = {}
    for row in selected:
        name = helpers.safe_member(row['file'])
        info = known.get(name)
        if info is None:
            raise helpers.WorkerError('RGSS_SCRIPT_SOURCE', 'Unknown native RGSS script view: ' + name)
        baseline = destination(view, name).read_bytes()
        if digest(baseline) != info['viewSha256'] or row['sourceHash'] != info['viewSha256']:
            raise helpers.WorkerError('RGSS_SCRIPT_SOURCE', 'RGSS script source baseline changed: ' + name)
        text = staged[name].read_bytes().decode('utf-8')
        try:
            raw_source = text.encode(info['encoding'])
        except UnicodeError as error:
            raise helpers.WorkerError('RGSS_SCRIPT_ENCODING', 'Translation is not representable in the original Ruby script encoding: ' + name) from error
        if digest(raw_source) == info['sourceSha256']:
            continue
        key = info['carrier']
        replacements.setdefault(key, {})[info['objectIndex']] = zlib.compress(raw_source)
        expected_sources.setdefault(key, {})[info['slot']] = raw_source
    for carrier, changes in replacements.items():
        target = destination(game_root, carrier)
        before = target.read_bytes()
        if digest(before) != layout['carriers'][carrier]:
            raise helpers.WorkerError('RGSS_SCRIPT_WRITE_CONFLICT',
                'Scripts no longer matches the adapter baseline. Combine native text and script adapter edits in one carrier build, then revalidate before retrying: ' + carrier,
                diagnostic={'category': 'conflict', 'carrier': carrier, 'expectedSha256': layout['carriers'][carrier],
                            'actualSha256': digest(before), 'resolution': 'joint-carrier-build'})
        reader = Reader(before)
        after = helpers.patch_raw_strings(reader, changes)
        actual = Reader(after)
        for slot, expected in expected_sources[carrier].items():
            if inflate(actual.root[slot][2].raw) != expected:
                raise helpers.WorkerError('RGSS_SCRIPT_READBACK', 'Native compressed script readback differs: ' + carrier)
        target.write_bytes(after)
    inventory['rgssScriptFiles'] = len(selected)
    inventory['rgssScriptCarriers'] = len(replacements)
    return {**args, 'adapterOverlayFiles': [row for row in rows if row not in selected]}
