"""Read-only RGSS script views and checked reinsertion into their Marshal slots."""
from pathlib import Path
import hashlib
import re
import zlib

from ruby_marshal import Reader, RString
from rgss_archive import destination
import adapter_overlay

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
    return {'reviewItems': issues, 'sourceRoots': roots, 'scripts': len(records)}


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
            raise helpers.WorkerError('RGSS_SCRIPT_SOURCE', 'Native Scripts changed before its verified overlays: ' + carrier)
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
