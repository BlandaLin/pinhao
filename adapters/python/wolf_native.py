"""WOLF native adapter using the MIT-licensed WolfTL command-line codec."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

import rpgmaker as native
import text_formats
from rgss_archive import destination


def executable(root):
    configured = os.environ.get('PINHAO_WOLFTL')
    paths = [Path(configured)] if configured else []
    paths.extend((Path(root) / 'local' / 'dependencies' / 'wolftl' / 'WolfTL.exe',
                  Path(__file__).parent / 'vendor' / 'wolftl' / 'WolfTL.exe'))
    return next((path.resolve() for path in paths if path.is_file()), None)


def archive_executable(root):
    configured = os.environ.get('PINHAO_UBERWOLF')
    paths = [Path(configured)] if configured else []
    paths.extend((Path(root) / 'local' / 'dependencies' / 'uberwolf' / 'UberWolfCli.exe',
                  Path(__file__).parent / 'vendor' / 'uberwolf' / 'UberWolfCli.exe'))
    return next((path.resolve() for path in paths if path.is_file()), None)


def archives(game):
    result = []
    for folder in (Path(game), Path(game) / 'Data'):
        for path in sorted(folder.glob('*.wolf')):
            if path.is_file():
                result.append(path)
    return result


def unpack_source(game, output, exe, helpers):
    output.mkdir(parents=True)
    inputs = []
    # Some Pro keys are discovered from static executable/resource metadata.
    # These files are copied for inspection; only UberWolfCli is ever executed.
    for name in ('Game.exe', 'GamePro.exe'):
        if (game / name).is_file():
            shutil.copyfile(game / name, output / name)
    for path in archives(game):
        relative = path.relative_to(game).as_posix()
        target = destination(output, relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        inputs.append(target)
    # Existing loose overrides remain authoritative in a previously unpacked edition.
    if (game / 'Data').is_dir():
        for rel, path in helpers.files_in(game / 'Data'):
            if path.suffix.lower() == '.wolf' or helpers.excluded(rel):
                continue
            target = destination(output / 'Data', rel)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
    # Upstream's self-spawn converts argv[0] with the active ANSI locale. Keep it
    # ASCII while CreateProcessW receives the full Unicode executable separately.
    result = subprocess.run([exe.name, *map(str, inputs)], executable=str(exe), cwd=output,
                            capture_output=True, timeout=900,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        detail = (result.stderr or result.stdout).decode('utf-8', errors='replace')[-1200:]
        raise ValueError('UberWolf archive decoding failed: ' + detail)
    for path in inputs:
        if not path.with_suffix('').is_dir():
            raise ValueError('UberWolf did not decode archive: ' + path.name)
        # These are private copies created above, never the original archives.
        if not path.resolve().is_relative_to(output.resolve()):
            raise ValueError('Archive staging path escaped the working directory')
        path.unlink()
    for _ in helpers.files_in(output):
        pass
    if not (output / 'Data' / 'BasicData' / 'Game.dat').is_file():
        raise ValueError('WOLF archive did not produce Data/BasicData/Game.dat')
    return output


def tool(exe, data, output, mode):
    help_result = subprocess.run([str(exe), '--help'], capture_output=True, timeout=30)
    modern = b'--create' in help_result.stdout
    command = ([str(exe), str(data), str(output), '--' + mode] if modern
               else [str(exe), str(data), str(output), mode])
    result = subprocess.run(command, capture_output=True, timeout=900,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        detail = (result.stderr or result.stdout).decode('utf-8', errors='replace')[-1500:]
        raise ValueError('WolfTL native ' + mode + ' failed: ' + detail)
    if mode == 'create' and not (output / 'dump').is_dir():
        raise ValueError('WolfTL did not create the native export tree')
    if mode == 'patch' and not (output / 'patched' / 'data').is_dir():
        raise ValueError('WolfTL did not produce native patched Data')


def resources(game):
    data = Path(game) / 'Data'
    for folder, suffixes in (('BasicData', ('.dat', '.project')), ('MapData', ('.mps',))):
        for path in sorted((data / folder).glob('*')):
            if path.is_file() and path.suffix.lower() in suffixes:
                yield path.relative_to(game).as_posix(), path


def add_database(collector, file, doc):
    # Only fields whose schema explicitly labels display names/descriptions/messages
    # are writable. Editor labels, resources, variable keys and expressions stay fixed.
    display = re.compile(r'(?:名前|名称|説明|文章|メッセージ|表示名|^name$|^description$|^message$)', re.I)
    excluded = re.compile(r'(?:ファイル|画像|音声|パス|変数|コモン|filename|path|variable|script)', re.I)
    for type_index, category in enumerate(doc.get('types', [])):
        if not isinstance(category, dict):
            continue
        for row_index, row in enumerate(category.get('data', [])):
            if not isinstance(row, dict):
                continue
            for field_index, field in enumerate(row.get('data', [])):
                if not isinstance(field, dict):
                    continue
                label = field.get('name', '')
                value = field.get('value')
                if isinstance(value, str) and display.search(label) and not excluded.search(label):
                    collector.add(file, ['types', type_index, 'data', row_index, 'data', field_index, 'value'],
                                  value, 'database_display', {'type_index': type_index, 'record': row_index,
                                                              'field': field_index, 'field_label': label}, 'wolf')


def extract(game, work, exe, helpers, batch_size=120):
    game, work = Path(game), Path(work)
    source_files = {rel: helpers.digest_file(path) for rel, path in resources(game)}
    packed = archives(game)
    for path in packed:
        source_files[path.relative_to(game).as_posix()] = helpers.digest_file(path)
    if not source_files:
        raise ValueError('WOLF native Data must be unpacked before extraction')
    with tempfile.TemporaryDirectory(prefix='pinhao-wolf-export-', dir=work.parent) as temp:
        source = game
        if packed:
            unpacker = archive_executable(helpers.ROOT)
            if not unpacker:
                raise ValueError('UberWolf archive codec is required')
            source = unpack_source(game, Path(temp) / 'native-source', unpacker, helpers)
        exported = Path(temp) / 'export'
        tool(exe, source / 'Data', exported, 'create')
        collector = text_formats.Collector(exported / 'dump', 'WOLF', 'json', batch_size)
        for path in sorted((exported / 'dump').rglob('*.json')):
            file, doc = collector.document(path)
            text_formats.wolf_entries(doc, collector, file)
            if file.startswith('db/') and isinstance(doc, dict):
                add_database(collector, file, doc)
            elif file == 'Game.json' and isinstance(doc, dict):
                for key in ('TitlePlus', 'StartUpMsg', 'TitleMsg'):
                    if isinstance(doc.get(key), str):
                        collector.add(file, [key], doc[key], 'system_text', {'field': key}, 'wolf')
                collector.review.append({'file': file, 'field': 'Title', 'kind': 'game_title_save_identity', 'editable': False})
        report = collector.finish(work)
        if packed:
            saved_source = work / 'native-source'
            if not source.resolve().is_relative_to(Path(temp).resolve()) or not saved_source.resolve().is_relative_to(work.resolve()):
                raise ValueError('Invalid native staging move')
            shutil.move(str(source), str(saved_source))
            source = saved_source
    native_files = {rel: helpers.digest_file(path) for rel, path in resources(source)}
    for rel, path in resources(source):
        dest = destination(work / 'native-baseline', rel)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, dest)
    fingerprint = native.sha(native.serialized(source_files))
    metadata = {'schema': 'pinhao-native-source-v1', 'engine': 'WOLF', 'root': '.',
                'sourceFiles': source_files, 'sourceFingerprint': fingerprint, 'packed': bool(packed),
                'nativeFiles': native_files, 'nativeSource': str(source) if packed else None,
                'additionalSourceRoots': [str((work / 'baseline').resolve())],
                'archives': [path.relative_to(game).as_posix() for path in packed],
                'codec': 'WolfTL', 'codecSha256': helpers.digest_file(exe)}
    helpers.json_write(work / 'technical' / 'product-source.json', metadata)
    images = [{'file': rel, 'status': 'unreviewed_image'} for rel, path in helpers.files_in(source)
              if path.suffix.lower() in ('.png', '.jpg', '.bmp', '.webp') and not helpers.excluded(rel)]
    helpers.json_write(work / 'image-inventory.json', images)
    helpers.json_write(work / 'dynamic-candidates.json', [])
    manifest, sheets = native.load_work(work)
    rows = [{**row, 'legacyId': row['id'], 'file': manifest['units'][row['id']]['file']}
            for sheet in sheets.values() for row in sheet['units']]
    return {**report, 'engine': 'WOLF', 'workDir': str(work), 'workspaceDir': str(work),
            'manifestPath': str(work / 'manifest.json'), 'sourceFingerprint': fingerprint,
            'units': rows, 'reviewItems': native.read(work / 'review-required.json'),
            'dynamicCandidates': [], 'images': images,
            'capabilities': {'extract': True, 'nativeBuild': True, 'assemble': True, 'font': True,
                             'oldDefaultNames': False, 'dynamicCandidates': False, 'runtimeVerified': False}}


def check_native_baseline(work, helpers):
    metadata = native.read(work / 'technical' / 'product-source.json')
    for rel, expected in metadata.get('nativeFiles', metadata['sourceFiles']).items():
        if helpers.digest_file(destination(work / 'native-baseline', rel)) != expected:
            raise ValueError('WOLF native baseline changed: ' + rel)
    return metadata


def verify_dump(expected, actual):
    expected_names = {path.relative_to(expected).as_posix() for path in expected.rglob('*.json')}
    actual_names = {path.relative_to(actual).as_posix() for path in actual.rglob('*.json')}
    if expected_names != actual_names:
        raise ValueError('WOLF native re-export files differ from the accepted display projection')
    for rel in sorted(expected_names):
        before, after = native.read(expected / rel), native.read(actual / rel)
        if before != after:
            losses = []
            def inspect(left, right):
                if isinstance(left, str) and isinstance(right, str) and left != right:
                    replaced = left.encode('cp932', errors='replace').decode('cp932')
                    if replaced == right and replaced != left:
                        losses.extend(char for char in left if char.encode('cp932', errors='replace') == b'?')
                elif isinstance(left, dict) and isinstance(right, dict):
                    for key in left.keys() & right.keys():
                        inspect(left[key], right[key])
                elif isinstance(left, list) and isinstance(right, list):
                    for source, target in zip(left, right):
                        inspect(source, target)
            inspect(before, after)
            if losses:
                error = ValueError('WOLF current resource codec replaced characters outside CP932: ' + ''.join(sorted(set(losses)))[:40] + '; use a Unicode-capable resource route for this version: ' + rel)
                error.code = 'WOLF_TEXT_ENCODING'
                raise error
            raise ValueError('WOLF native re-export changed protected structure: ' + rel)


def native_projection(work, editable, folder, exe, helpers, font=None):
    projected = folder / 'projection'
    report = native.build(work, editable, projected)
    native.verify(work, editable, projected)
    patch_root = folder / 'patch'
    dump = patch_root / 'dump'
    dump.mkdir(parents=True)
    manifest, _ = native.load_work(work)
    for rel in manifest['files']:
        dest = destination(dump, rel)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(projected / rel, dest)
    if font:
        game = native.read(dump / 'Game.json')
        game['MainFont'] = helpers.font_family(font)
        helpers.json_write(dump / 'Game.json', game)
    tool(exe, work / 'native-baseline' / 'Data', patch_root, 'patch')
    patched = patch_root / 'patched' / 'data'
    verified = folder / 'verified'
    tool(exe, patched, verified, 'create')
    verify_dump(dump, verified / 'dump')
    return patched, report


def roundtrip(work, exe, helpers):
    metadata = check_native_baseline(work, helpers)
    with tempfile.TemporaryDirectory(prefix='pinhao-wolf-roundtrip-', dir=work.parent) as temp:
        native_projection(work, work / 'technical' / 'row-baseline', Path(temp), exe, helpers)
    manifest, _ = native.load_work(work)
    # WolfTL decrypts and recompresses native resources. Equality is proved by a full
    # native re-export; unchanged delivery still uses the original bytes verbatim.
    return {'engine': 'WOLF', 'units': len(manifest['units']), 'files': len(metadata.get('nativeFiles', metadata['sourceFiles'])),
            'nativeSemanticRoundtrip': True, 'byteIdentical': False,
            'status': 'native_roundtrip_structurally_equal', 'runtimeVerified': False}


def build(work, editable, output, exe, helpers, font=None):
    metadata = check_native_baseline(work, helpers)
    manifest, _, validation = native.validate(work, editable)
    with tempfile.TemporaryDirectory(prefix='pinhao-wolf-build-', dir=work.parent) as temp:
        patched, _ = native_projection(work, editable, Path(temp), exe, helpers, font)
        output.mkdir(parents=True)
        for rel, path in helpers.files_in(patched):
            target = destination(output / 'Data', rel)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
        if validation['changed'] == 0 and not font:
            for rel in metadata.get('nativeFiles', metadata['sourceFiles']):
                shutil.copyfile(destination(work / 'native-baseline', rel), destination(output, rel))
    files = {rel: helpers.digest_file(path) for rel, path in helpers.files_in(output)}
    report = {**validation, 'engine': 'WOLF', 'files': len(files), 'files_sha256': files,
              'manifest_sha256': helpers.digest_file(work / 'manifest.json'),
              'status': 'native_built_and_reexport_verified', 'runtimeVerified': False,
              'nativeSemanticRoundtrip': True}
    if font:
        report['font'] = {'family': helpers.font_family(font), 'file': 'PinHaoChinese' + font.suffix.lower()}
    helpers.json_write(output / 'build-report.json', report)
    return {**report, 'buildDir': str(output), 'outputDir': str(output)}


def install_font(game_root, built, exe, font, helpers, inventory):
    # Data already contains the accepted native build. Patch its Game.dat in a fresh
    # temporary export, then verify every exported field before replacing that file.
    with tempfile.TemporaryDirectory(prefix='pinhao-wolf-font-', dir=game_root.parent) as temp:
        patch_root = Path(temp) / 'patch'
        tool(exe, game_root / 'Data', patch_root, 'create')
        game = native.read(patch_root / 'dump' / 'Game.json')
        family = helpers.font_family(font)
        game['MainFont'] = family
        helpers.json_write(patch_root / 'dump' / 'Game.json', game)
        tool(exe, game_root / 'Data', patch_root, 'patch')
        patched = patch_root / 'patched' / 'data'
        verified = Path(temp) / 'verified'
        tool(exe, patched, verified, 'create')
        verify_dump(patch_root / 'dump', verified / 'dump')
        shutil.copyfile(patched / 'BasicData' / 'Game.dat', game_root / 'Data' / 'BasicData' / 'Game.dat')
    target = game_root / ('PinHaoChinese' + font.suffix.lower())
    shutil.copyfile(font, target)
    inventory['font'] = {'family': family, 'file': target.name, 'sha256': helpers.digest_file(target)}
