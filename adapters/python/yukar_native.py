"""SGB/Bakin native catalog codecs and independently runnable resource builds."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile

import rpgmaker as core
import text_formats as formats
from rgss_archive import destination
import yukar_archive as containers
import asset_overlay
import adapter_overlay

ENGINES = ('SMILE GAME BUILDER', 'RPG Developer Bakin')
READY = 'native_yukar_catalog_roundtrip'


def probe(game):
    game = Path(game)
    for rel, engine in (('data.sgbpack', ENGINES[0]), ('data.rbpack', ENGINES[1]), ('data/data.rbpack', ENGINES[1])):
        if (game / rel).is_file():
            return {'engine': engine, 'root': '.', 'support': READY, 'packed': True, 'archives': [rel]}
    if (game / 'common.dll').is_file() and (game / 'sgb_rpgplayer.exe').is_file() and any(game.rglob('*.sgr')):
        return {'engine': ENGINES[0], 'root': '.', 'support': READY, 'packed': False, 'archives': []}
    if (game / 'data' / 'common.dll').is_file() and any((game / 'data').rglob('*.rbr')):
        return {'engine': ENGINES[1], 'root': '.', 'support': READY, 'packed': False, 'archives': []}
    return None


def assembly_arch(path):
    raw = Path(path).read_bytes()
    if raw[:2] != b'MZ' or len(raw) < 64:
        raise ValueError('Native catalog codec is not a managed PE assembly')
    offset = struct.unpack_from('<I', raw, 60)[0]
    machine = struct.unpack_from('<H', raw, offset + 4)[0]
    if machine == 0x8664:
        return 'x64'
    sections, optional_size = struct.unpack_from('<H', raw, offset + 6)[0], struct.unpack_from('<H', raw, offset + 20)[0]
    optional = offset + 24
    directories = optional + (112 if struct.unpack_from('<H', raw, optional)[0] == 0x20b else 96)
    cli_rva = struct.unpack_from('<I', raw, directories + 14 * 8)[0]
    for index in range(sections):
        section = optional + optional_size + index * 40
        virtual_size, rva, size, pointer = struct.unpack_from('<IIII', raw, section + 8)
        if rva <= cli_rva < rva + max(virtual_size, size):
            flags = struct.unpack_from('<I', raw, pointer + cli_rva - rva + 16)[0]
            return 'x86' if flags & 2 else 'x64'
    raise ValueError('Native catalog codec has no CLR header')


def helper(cache, assembly):
    if os.name != 'nt':
        raise ValueError('SGB/Bakin catalog codecs require the Windows .NET Framework runtime')
    template = Path(__file__).parent / 'templates' / 'YukarResources.cs'
    arch = assembly_arch(assembly)
    digest = hashlib.sha256(template.read_bytes()).hexdigest()[:16]
    output = cache / ('YukarResources-' + arch + '-' + digest + '.exe')
    if output.is_file():
        return output
    compiler = Path(os.environ.get('WINDIR', r'C:\Windows')) / 'Microsoft.NET' / 'Framework64' / 'v4.0.30319' / 'csc.exe'
    if not compiler.is_file():
        compiler = compiler.parent.parent.parent / 'Framework' / 'v4.0.30319' / 'csc.exe'
    if not compiler.is_file():
        raise ValueError('Windows .NET Framework C# compiler is unavailable')
    cache.mkdir(parents=True, exist_ok=True)
    result = subprocess.run([str(compiler), '/nologo', '/platform:' + arch, '/reference:System.Web.Extensions.dll',
                             '/out:' + str(output), str(template)], capture_output=True, timeout=90,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        raise ValueError('Native catalog helper compilation failed: ' + result.stdout.decode(errors='replace')[-1600:])
    return output


def catalog_job(cache, assembly, resources):
    runner = helper(cache, assembly)
    with tempfile.TemporaryDirectory(prefix='catalog-', dir=cache) as folder:
        input_path, output_path = Path(folder) / 'input.json', Path(folder) / 'output.json'
        input_path.write_text(json.dumps({'assembly': str(assembly), 'resources': resources}, ensure_ascii=False), encoding='utf-8')
        # Native Catalog.load discovers the format from its cwd. Keep that discovery
        # beside common.dll, not recursively scanning the application's working tree.
        result = subprocess.run([str(runner), str(input_path), str(output_path)], cwd=assembly.parent,
                                capture_output=True, timeout=300,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode or not output_path.is_file():
            raise ValueError('Native catalog serialization failed: ' + (result.stderr or result.stdout).decode(errors='replace')[-1800:])
        return json.loads(output_path.read_text(encoding='utf-8'))['resources']


def read_archive(raw, engine):
    return containers.sgb_read(raw) if engine == ENGINES[0] else containers.bakin_read(raw)


def write_archive(layout, entries, engine):
    return containers.sgb_write(layout, entries) if engine == ENGINES[0] else containers.bakin_write(layout, entries)


def extract(game, work, info, helpers, args):
    source = helpers.fresh(work.parent / (work.name + '-native-source'), (game, work))
    source.mkdir(parents=True)
    for rel, path in helpers.files_in(game):
        if path.suffix.lower() in ('.dll', '.config') and not helpers.excluded(rel):
            target = destination(source, rel)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
    resources = []
    archive_members = []
    for archive in info['archives']:
        _, members = read_archive((game / archive).read_bytes(), info['engine'])
        prefix = str(Path(archive).parent).replace('\\', '/')
        for name, raw, _ in members:
            rel = str(Path(prefix) / name).replace('\\', '/')
            helpers.safe_member(rel)
            archive_members.append(rel)
            path = destination(source, rel)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
    if not info['packed']:
        for rel, path in helpers.files_in(game):
            if path.suffix.lower() in ('.sgr', '.rbr') and not helpers.excluded(rel):
                target = destination(source, rel)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, target)
    codecs = [path for rel, path in helpers.files_in(source) if path.name.lower() == 'common.dll']
    if len(codecs) != 1:
        raise helpers.WorkerError('NATIVE_CODEC_MISSING', 'Choose a complete game containing one native common.dll catalog codec')
    assembly = codecs[0]
    for rel, path in helpers.files_in(source):
        if path.suffix.lower() in ('.sgr', '.rbr') and 'resourceitem' not in path.stem.lower() and not helpers.excluded(rel):
            resources.append({'name': rel, 'file': str(path)})
    if not resources:
        raise helpers.WorkerError('NATIVE_TEXT_UNAVAILABLE', 'Resource archive contains no native catalog records')
    cache = work.parent / (work.name + '-native-tools')
    records = catalog_job(cache, assembly, resources)
    if not records:
        raise helpers.WorkerError('NATIVE_TEXT_UNAVAILABLE', 'Native catalog contains no readable resource records')
    collector = formats.Collector(source, info['engine'], 'json', int(args.get('batchSize', 120)))
    record_map = {}
    review_items = []
    for record in records:
        for pending in record.get('unsupportedRecords', []):
            review_items.append({'kind': 'native_record_roundtrip_failed', 'category': 'extraction-failure',
                                 'file': record['file'], 'object': pending['item'], 'status': 'pending',
                                 'detail': pending['reason'], 'candidateCount': pending['candidateCount'],
                                 'fields': pending['paths'], 'originalPreserved': True})
        document = {'entries': record['entries']}
        virtual = 'native-text/' + record['file'] + '.json'
        target = destination(source, virtual)
        core.write(target, document)
        file, document = collector.document(target)
        record_map[file] = record['file']
        for index, entry in enumerate(document['entries']):
            protected, _, _ = formats.protected(entry['source'], 'yukar')
            if not core.TOKEN.sub('', protected).strip():
                continue
            collector.add(file, ['entries', index, 'source'], entry['source'], entry['kind'],
                          {'resource': record['file'], 'item': entry['item'], 'field': entry['path'], 'command': entry['command']}, 'yukar')
    if not collector.units and args.get('allowEmpty') is not True:
        raise helpers.WorkerError('NATIVE_TEXT_UNAVAILABLE', 'Native catalog contains no supported display fields')
    report = collector.finish(work, allow_empty=args.get('allowEmpty') is True)
    manifest, sheets = core.load_work(work)
    files = {rel: helpers.digest_file(path) for rel, path in helpers.files_in(game)
             if rel in info['archives'] or path.suffix.lower() in ('.dll', '.rbr', '.sgr') and not helpers.excluded(rel)}
    fingerprint = core.sha(core.serialized(files))
    metadata = {'schema': 'pinhao-native-yukar-v1', 'engine': info['engine'], 'root': '.',
                'sourceFiles': files, 'sourceFingerprint': fingerprint, 'packed': info['packed'],
                'nativeSource': str(source), 'archives': info['archives'], 'recordMap': record_map,
                'assembly': assembly.relative_to(source).as_posix(), 'cache': str(cache),
                'nochangeNativeFiles': len(records), 'archiveMembers': archive_members,
                'reviewItems': review_items,
                'nativeFilesSha256': {rel: helpers.digest_file(path) for rel, path in helpers.files_in(source)
                                      if path.suffix.lower() in ('.dll', '.sgr', '.rbr')}}
    helpers.json_write(work / 'technical' / 'product-source.json', metadata)
    images = [{'file': rel, 'kind': 'image_candidate', 'writable': False} for rel, path in helpers.files_in(source)
              if path.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp') and not helpers.excluded(rel)]
    helpers.json_write(work / 'image-inventory.json', images)
    helpers.json_write(work / 'dynamic-candidates.json', [])
    rows = [{**row, 'legacyId': row['id'], 'file': manifest['units'][row['id']]['file']} for sheet in sheets.values() for row in sheet['units']]
    return {**report, 'engine': info['engine'], 'workDir': str(work), 'workspaceDir': str(work),
            'manifestPath': str(work / 'manifest.json'), 'sourceFingerprint': fingerprint, 'units': rows,
            'reviewItems': review_items, 'dynamicCandidates': [], 'images': images, 'capabilities': helpers.capabilities(info['engine'])}


def build(work, editable, output, helpers):
    report = core.build(work, editable, output)
    core.verify(work, editable, output)
    metadata = core.read(work / 'technical' / 'product-source.json')
    source = Path(metadata['nativeSource'])
    for rel, expected in metadata['nativeFilesSha256'].items():
        if helpers.digest_file(destination(source, rel)) != expected:
            raise helpers.WorkerError('SOURCE_CHANGED', 'Native catalog source or codec changed: ' + rel)
    resources = []
    for virtual, rel in metadata['recordMap'].items():
        original = core.read(work / 'baseline' / virtual)['entries']
        translated = core.read(output / virtual)['entries']
        updates = {entry['path']: entry['source'] for before, entry in zip(original, translated) if entry['source'] != before['source']}
        resources.append({'name': rel, 'file': str(source / rel), 'output': str(output / rel), 'updates': updates})
    catalog_job(Path(metadata['cache']), source / metadata['assembly'], resources)
    hashes = {rel: helpers.digest_file(output / rel) for rel in metadata['recordMap'].values()}
    report['files_sha256'].update(hashes)
    report['nativeFiles'] = len(hashes)
    helpers.json_write(output / 'build-report.json', report)
    return {**report, 'engine': metadata['engine'], 'buildDir': str(output), 'outputDir': str(output), 'runtimeVerified': False}


def assemble(args, helpers):
    game = helpers.path_arg(args, 'gameDir')
    work = helpers.path_arg(args, 'workspaceDir', 'workDir')
    built = helpers.path_arg(args, 'buildDir')
    output = helpers.fresh(helpers.path_arg(args, 'outputDir', 'outDir'), (game, work, built))
    metadata = core.read(work / 'technical' / 'product-source.json')
    helpers.source_unchanged(game, metadata)
    report = core.read(built / 'build-report.json')
    if report['manifest_sha256'] != helpers.digest_file(work / 'manifest.json'):
        raise helpers.WorkerError('WRONG_BUILD', 'Native build belongs to another revision')
    for rel, expected in report['files_sha256'].items():
        if helpers.digest_file(destination(built, rel)) != expected:
            raise helpers.WorkerError('BUILD_CHANGED', 'Native build changed: ' + rel)
    inventory = {'copied': 0, 'excluded': [], 'warnings': [], 'runtimeVerified': False,
                 'sourceFingerprint': metadata['sourceFingerprint'], 'engine': metadata['engine']}
    output.mkdir(parents=True)
    helpers.copy_tree(game, output, inventory)
    font = helpers.path_arg(args, 'fontPath') if args.get('fontPath') else None
    if font:
        helpers.font_family(font)
    overlays = dict(asset_overlay.entries(args, helpers))
    applied_images = set()
    text_overlays = dict(adapter_overlay.entries(args, helpers))
    applied_text = set()
    for archive in metadata['archives']:
        raw = (game / archive).read_bytes()
        layout, entries = read_archive(raw, metadata['engine'])
        prefix = Path(archive).parent
        updated, changed, fonts = [], False, []
        for name, value, zip_info in entries:
            rel = (prefix / name).as_posix()
            if helpers.excluded(name) or helpers.excluded(rel):
                inventory['excluded'].append(rel)
                changed = True
                continue
            replacement = built / rel
            new = replacement.read_bytes() if rel in metadata['recordMap'].values() else value
            if rel in overlays:
                asset_overlay.check_baseline(args, rel, hashlib.sha256(value).hexdigest(), helpers)
                new = overlays[rel].read_bytes()
                applied_images.add(rel)
            if rel in text_overlays:
                adapter_overlay.check_baseline(args, rel, hashlib.sha256(new).hexdigest(), helpers)
                new = text_overlays[rel].read_bytes()
                applied_text.add(rel)
            if font and Path(name).name.lower() == 'font.ttf':
                new = font.read_bytes()
                fonts.append(rel)
            changed = changed or new != value
            updated.append((name, new, zip_info))
        data = write_archive(layout, updated, metadata['engine']) if changed else raw
        destination(output, archive).write_bytes(data)
        # Independent decoder readback checks every payload, not only edited text records.
        _, actual = read_archive(data, metadata['engine'])
        if {name: value for name, value, _ in actual} != {name: value for name, value, _ in updated}:
            raise helpers.WorkerError('NATIVE_READBACK', 'Repacked resource readback mismatch')
        if fonts:
            inventory['font'] = {'family': helpers.font_family(font), 'files': fonts, 'sha256': helpers.digest_file(font)}
    if not metadata['packed']:
        for rel in metadata['recordMap'].values():
            target = destination(output, rel)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(built / rel, target)
        if font:
            fonts = [rel for rel, path in helpers.files_in(game) if path.name.lower() == 'font.ttf' and not helpers.excluded(rel)]
            for rel in fonts:
                shutil.copyfile(font, destination(output, rel))
            if fonts:
                inventory['font'] = {'family': helpers.font_family(font), 'files': fonts, 'sha256': helpers.digest_file(font)}
    remaining = [row for row in args.get('assetOverlayFiles', []) if row['file'] not in applied_images]
    if remaining:
        asset_overlay.apply(output, {**args, 'assetOverlayFiles': remaining}, helpers, inventory)
    if overlays:
        inventory['imageFiles'] = len(overlays)
    remaining_text = [row for row in args.get('adapterOverlayFiles', [])
                      if helpers.safe_member(row['file']) not in applied_text]
    if remaining_text:
        adapter_overlay.apply(output, {**args, 'adapterOverlayFiles': remaining_text}, helpers, inventory, baseline_root=built)
    if text_overlays:
        inventory['adapterFiles'] = len(text_overlays)
    if font and 'font' not in inventory:
        inventory['warnings'].append('Native game does not contain a replaceable font.ttf resource')
    launchers = [rel for rel, _ in helpers.files_in(output) if rel.lower().endswith('.exe') and '/' not in rel]
    launch = next((rel for rel in launchers if rel.lower() == 'sgb_rpgplayer.exe'), None)
    launch = launch or next((rel for rel in launchers if not any(word in rel.lower() for word in ('systeminfo', 'crash', 'setup', 'config'))), None)
    inventory.update(status='assembled_structurally_checked', nativeFiles=len(metadata['recordMap']), launchers=launchers)
    helpers.json_write(output / 'PinHao-build-report.json', inventory)
    if args.get('share', True):
        (output / '使用说明-拼好汉化.txt').write_text('本汉化成果由拼好汉化免费分享。\n切勿付费购买此资源；如已付款，请联系交易平台申请退款。\n启动原游戏程序即可游玩，汉化文字已回写原生资源。\n感谢原作者与参与制作的同好，祝游玩愉快。\n', encoding='utf-8')
    return {**inventory, 'outputDir': str(output), 'reportPath': str(output / 'PinHao-build-report.json'),
            'launchPath': str(output / launch) if launch else None}
