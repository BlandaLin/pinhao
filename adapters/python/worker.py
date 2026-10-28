"""Native game resource worker. One JSON request on stdin, one JSON result on stdout."""
from __future__ import annotations

import contextlib
import copy
import errno
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import struct
import sys
import tempfile
import zipfile
import zlib

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
TOOLKIT = os.environ.get('PINHAO_TOOLKIT') or str(ROOT / 'kits' / 'workbench-tutorial' / 'toolkit')
sys.path.insert(0, TOOLKIT)
import rpgmaker as native
import wolf_native
import lcf_native
import source_native
import rgss_scripts
import godot_native
import kirikiri_native
import yukar_native
import unity_native
import asset_overlay
import adapter_overlay
import assist_catalog
import mobile_export
import assist_legacy
import assist_managed
import archive_tools
import native_review
import assist_install_rgss
import font_inspection
import private_paths
import native_environment
from rgss_archive import archive_entries, destination, safe_relative, unpack
from ruby_marshal import Reader, RString, long_bytes, structure

NATIVE_ENGINES = ('MV', 'MZ', 'VX Ace', 'VX', 'XP')
DEVICE_NAME = re.compile(r'^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', re.I)


class WorkerError(ValueError):
    def __init__(self, code, message, *, diagnostic=None, artifacts=None, attemptId=None, rejectedTranslations=None):
        super().__init__(message)
        self.code = code
        self.diagnostic = diagnostic
        self.artifacts = artifacts
        self.attemptId = attemptId
        self.rejectedTranslations = rejectedTranslations


def path_arg(args, *keys):
    for key in keys:
        value = args.get(key)
        if isinstance(value, str) and value.strip():
            return clean_path(Path(value).expanduser().absolute()).resolve()
    raise WorkerError('INVALID_ARGUMENT', 'Missing path: ' + keys[0])


def linked(path):
    return path.is_symlink() or getattr(path, 'is_junction', lambda: False)()


def clean_path(path):
    path = Path(path)
    for entry in (path, *path.parents):
        if linked(entry):
            raise WorkerError('SYMLINK', 'Symbolic links and junctions require a regular copied directory')
    return path


def fresh(path, protected=()):
    path = clean_path(path)
    if path.exists():
        raise WorkerError('OUTPUT_EXISTS', 'Choose a new output directory')
    for root in protected:
        root = Path(root).resolve()
        if path.is_relative_to(root) or root.is_relative_to(path):
            raise WorkerError('OUTPUT_OVERLAP', 'Output and source directories must be separate')
    return path


def files_in(root):
    root = clean_path(root)
    if not root.is_dir():
        raise WorkerError('DIRECTORY_MISSING', 'Directory does not exist')
    seen = set()
    for base, dirs, files in os.walk(root, followlinks=False):
        for name in sorted(dirs + files):
            path = Path(base) / name
            if linked(path):
                raise WorkerError('SYMLINK', 'Game/package contains a symbolic link or junction')
            rel = path.relative_to(root).as_posix()
            folded = rel.casefold()
            if folded in seen:
                raise WorkerError('PATH_COLLISION', 'Paths collide on Windows: ' + rel)
            seen.add(folded)
        dirs.sort()
        for name in sorted(files):
            path = Path(base) / name
            if not path.is_file():
                raise WorkerError('SPECIAL_FILE', 'Only regular files are supported')
            yield path.relative_to(root).as_posix(), path


def digest_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def json_write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(native.serialized(value))


def capabilities(engine, available=True):
    return {'extract': available, 'nativeBuild': available, 'assemble': available,
            'font': engine in NATIVE_ENGINES or engine in ('TyranoScript', 'KiriKiri/KAG', "Ren'Py", 'Godot', 'Pixel Game Maker MV', unity_native.ENGINE, *yukar_native.ENGINES),
            'oldDefaultNames': engine in NATIVE_ENGINES,
            'dynamicCandidates': engine in NATIVE_ENGINES,
            'runtimeVerified': False}


def assistance_info(game, engine):
    if engine in NATIVE_ENGINES:
        return {'supported': True, 'engine': engine, 'modes': ['live'], 'detail': '实时角色、物品、开关变量与移动探索'}
    if engine == "Ren'Py":
        supported = (game / 'game').is_dir() and (game / 'renpy').is_dir()
        return {'supported': supported, 'engine': engine, 'modes': ['live'] if supported else [],
                'detail': '命名变量与持久数据实时辅助' if supported else '选择带有 Ren’Py 运行器的完整游戏目录'}
    if engine in ('RPG Maker 2000/2003', 'WOLF'):
        ready = assist_legacy.available(engine, sys.modules[__name__])
        return {'supported': ready, 'engine': engine, 'modes': ['save'] if ready else [],
                'detail': '原生存档数值、开关与变量，修改前自动备份' if ready else '准备对应原生存档编解码工具'}
    if engine in assist_managed.ENGINES:
        return assist_managed.capabilities(game)
    import assist_script
    return assist_script.capabilities(game, sys.modules[__name__])


def probe(args):
    game = clean_path(path_arg(args, 'gameDir'))
    info = native.probe(game)
    if info['archives'] and info['engine'] in ('packed_RGSS', 'VX Ace', 'VX', 'XP'):
        if len(info['archives']) != 1:
            raise WorkerError('AMBIGUOUS_ARCHIVE', 'Choose a game directory containing one RGSS resource archive')
        if len(info['archives']) == 1:
            _, entries = archive_entries(game / info['archives'][0])
            for engine, ext in (('VX Ace', '.rvdata2'), ('VX', '.rvdata'), ('XP', '.rxdata')):
                if any(name.casefold() == 'data/system' + ext for name, *_ in entries):
                    if info['engine'] not in ('packed_RGSS', engine):
                        raise WorkerError('AMBIGUOUS_ENGINE', 'Loose and packed resources target different engines')
                    info.update(engine=engine, support='packed_native_text_roundtrip', extension=ext,
                                data_dir='Data', packed=True)
                    break
    if info['engine'] == 'unknown':
        if (game / 'RPG_RT.ldb').is_file():
            info.update(engine='RPG Maker 2000/2003', support='external_native_tool_required',
                        dependency='liblcf / lcf2xml', dependencyUrl='https://github.com/EasyRPG/liblcf')
            if lcf_native.executable(ROOT):
                info['support'] = 'native_via_liblcf'
        elif wolf_native.archives(game) or (game / 'Data' / 'BasicData' / 'Game.dat').is_file():
            info.update(engine='WOLF', support='external_native_tool_required',
                        dependency='WolfTL / WolfDec', dependencyUrl='https://github.com/Sinflower/WolfTL')
            if wolf_native.executable(ROOT) and ((game / 'Data' / 'BasicData' / 'Game.dat').is_file()
                                                or wolf_native.archives(game) and wolf_native.archive_executable(ROOT)):
                info['support'] = 'native_via_wolftl'
        else:
            source_info = godot_native.probe(game) or yukar_native.probe(game) or unity_native.probe(game) or source_native.probe(game)
            if source_info:
                info.update(source_info)
    dependency_diagnostic = native_environment.probe_diagnostic(info)
    if dependency_diagnostic:
        info['diagnostic'] = dependency_diagnostic
    available = info['support'] in ('standard_text_roundtrip', 'packed_native_text_roundtrip', 'native_via_wolftl', 'native_via_liblcf', source_native.READY, godot_native.READY, yukar_native.READY, unity_native.READY)
    if info['engine'] == unity_native.ENGINE:
        available = unity_native.available()
        if not available:
            info['diagnostic'] = native_environment.diagnostic('dependency', 'probe', info['engine'],
                dependencyId='unitypy', state='invalid', expectedVersion='1.23.0',
                detail='The fixed UnityPy dependency could not be loaded')
    info['capabilities'] = capabilities(info['engine'], available)
    assist = assistance_info(game, info['engine'])
    info['capabilities'].update(assist=bool(assist['supported']), assistModes=assist.get('modes', []), assistDetail=assist.get('detail', ''))
    if info['engine'] == 'WOLF':
        info['capabilities']['font'] = available
    info['name'] = game.name
    return info


def catalog(args):
    engines = []
    for ident, name in (('mv', 'RPG Maker MV'), ('mz', 'RPG Maker MZ'), ('vxace', 'RPG Maker VX Ace'),
                        ('vx', 'RPG Maker VX'), ('xp', 'RPG Maker XP')):
        engines.append({'id': ident, 'name': name, 'extract': True, 'build': True,
                        'assist': True, 'assistModes': ['live'], 'detail': '原生文本提取、独立成品构建、中文字体、默认人名及实时游玩辅助'})
    for ident, name, present, detail in (
        ('rpg2000', 'RPG Maker 2000/2003', bool(lcf_native.executable(ROOT)), 'LCF原生回写与代码页校验，中文运行环境单独配置'),
        ('wolf', 'WOLF RPG Editor', bool(wolf_native.executable(ROOT)), 'WOLF原生回写与完整复核，归档自动解包' if wolf_native.archive_executable(ROOT) else 'WOLF原生回写与完整复核，读取已解包Data')):
        engines.append({'id': ident, 'name': name, 'extract': present, 'build': present,
                        'assist': assist_legacy.available(name.replace('WOLF RPG Editor', 'WOLF'), sys.modules[__name__]),
                        'assistModes': ['save'] if assist_legacy.available(name.replace('WOLF RPG Editor', 'WOLF'), sys.modules[__name__]) else [],
                        'detail': (detail + '；原生存档辅助') if present else '安装对应原生编解码依赖'})
    for ident, name, detail in (
        ('tyrano', 'TyranoScript', 'KS完整段落、显示名与界面回写；ASAR自动解包、中文字体与独立成品'),
        ('kirikiri', 'KiriKiri/KAG', 'XP3与嵌入EXE资源重建、KS原生回写、Unicode与KAG3中文字体'),
        ('renpy', "Ren\'Py", 'RPYC静态反编译、RPA2/3与标准补丁顺序、对白及动态标记回写、中文字体'),
        ('godot', 'Godot', 'PCK与嵌入EXE、编译场景与脚本恢复、动态文字目录、中文字体与独立资源包'),
        ('pgmm', 'Pixel Game Maker MV', 'project.json文本资源回写与独立成品'),
        ('sgb', 'SMILE GAME BUILDER', 'Windows/.NET运行器的SGB资源包、数据库及显示事件命令回写、独立成品'),
        ('bakin', 'RPG Developer Bakin', 'RBPACK资源包、原生数据库与显示事件命令回写、独立成品')):
        if ident in ('sgb', 'bakin'):
            assisted = assist_managed.available()
        elif ident == 'renpy':
            assisted = True
        else:
            import assist_script
            assisted = assist_script.available(name)
        engines.append({'id': ident, 'name': name, 'extract': True, 'build': True, 'assist': assisted,
                        'assistModes': ['live'] if assisted else [], 'detail': detail + ('；实时命名变量辅助' if assisted else '')})
    unity_ready = unity_native.available()
    engines.append({'id': 'unity', 'name': unity_native.ENGINE, 'extract': unity_ready, 'build': unity_ready,
                    'assist': assist_managed.available(), 'assistModes': ['live'] if assist_managed.available() else [],
                    'detail': 'SerializedFile 与 UnityFS 原生文字回写；Unity Mono 实时字段辅助' if unity_ready else '准备固定 UnityPy 原生资源工具'})
    return {'engines': engines, 'dependencyHealth': native_environment.catalog_health()}


def source_info(game, work, info, native_source):
    manifest, _ = native.load_work(work)
    if info.get('packed'):
        source_files = {name: digest_file(game / name) for name in info['archives']}
        for rel, path in files_in(game):
            if rel.casefold().startswith('data/') and path.suffix.lower() in ('.rxdata', '.rvdata', '.rvdata2'):
                source_files[rel] = digest_file(path)
    else:
        source_files = {str(PurePosixPath(info.get('root', '.')) / file): meta['sha256']
                        for file, meta in manifest['files'].items()}
    fingerprint = native.sha(native.serialized(source_files))
    metadata = {'schema': 'pinhao-native-source-v1', 'engine': info['engine'],
                'root': info.get('root', '.'), 'sourceFiles': source_files,
                'sourceFingerprint': fingerprint, 'packed': bool(info.get('packed')),
                'nativeSource': str(native_source) if info.get('packed') else None,
                'archives': info.get('archives', [])}
    json_write(work / 'technical' / 'product-source.json', metadata)
    return fingerprint


def extract(args):
    native.reset_work_cache()
    game = clean_path(path_arg(args, 'gameDir'))
    work = fresh(path_arg(args, 'workspaceDir', 'workDir'), (game,))
    info = probe({'gameDir': str(game)})
    if not info['capabilities']['extract']:
        diagnostic = info.get('diagnostic')
        if diagnostic and diagnostic.get('category') == 'dependency':
            code = 'NATIVE_DEPENDENCY_MISSING' if diagnostic.get('state') == 'missing' else 'NATIVE_DEPENDENCY_INVALID'
            raise WorkerError(code, diagnostic.get('detail') or 'Required native dependency is unavailable', diagnostic=diagnostic)
        raise WorkerError('ENGINE_ADAPTER_REQUIRED', info['engine'] + ': ' + info['support'], diagnostic=diagnostic)
    # Inspect the complete input tree before creating a working copy.
    for _ in files_in(game):
        pass
    if info['engine'] == 'Godot':
        return godot_native.extract(game, work, info, sys.modules[__name__], args)
    if info['engine'] == unity_native.ENGINE:
        return unity_native.extract(game, work, info, sys.modules[__name__], args)
    if info['engine'] in yukar_native.ENGINES:
        return yukar_native.extract(game, work, info, sys.modules[__name__], args)
    if info['engine'] in source_native.ENGINES:
        return source_native.extract(game, work, info, sys.modules[__name__], args)
    if info['engine'] == 'WOLF':
        return wolf_native.extract(game, work, wolf_native.executable(ROOT), sys.modules[__name__],
                                   batch_size=int(args.get('batchSize', 120)))
    if info['engine'] == 'RPG Maker 2000/2003':
        return lcf_native.extract(game, work, lcf_native.executable(ROOT), sys.modules[__name__], args)
    source = game
    if info.get('packed'):
        source = fresh(work.parent / (work.name + '-native-source'), (game, work))
        unpack(game / info['archives'][0], source, all_resources=True)
        # A loose data override is retained when a previous unpacked edition ships
        # alongside its archive. The independent result contains loose data only.
        for rel, path in files_in(game):
            if rel.casefold().startswith('data/') and path.suffix.lower() in ('.rxdata', '.rvdata', '.rvdata2'):
                target = destination(source, rel)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, target)
    report = native.extract(source, work, batch_size=int(args.get('batchSize', 120)))
    fingerprint = source_info(game, work, info, source)
    scripts = rgss_scripts.prepare(work, source, sys.modules[__name__])
    manifest, sheets = native.load_work(work)
    rows = [{**row, 'legacyId': row['id'], 'file': manifest['units'][row['id']]['file']}
            for sheet in sheets.values() for row in sheet['units']]
    review = native.read(work / 'review-required.json') + scripts['reviewItems']
    dynamic = dynamic_candidates(source, work)
    images = native.read(work / 'image-inventory.json')
    return {**report, 'engine': info['engine'], 'workDir': str(work), 'workspaceDir': str(work),
            'manifestPath': str(work / 'manifest.json'), 'sourceFingerprint': fingerprint,
            'units': rows, 'reviewItems': review, 'dynamicCandidates': dynamic, 'images': images,
            'additionalSourceRoots': scripts['sourceRoots'],
            'capabilities': info['capabilities']}


@contextlib.contextmanager
def prepared_editable(work, translations, *, capture_baseline=False, materialize=True):
    snapshot = {} if capture_baseline else None
    manifest, sheets = native.load_work(work, snapshot=snapshot)
    if translations is None:
        current = native.read_editable(work, manifest)
        yield work / 'editable', native.validate_sheets(manifest, sheets, current), snapshot
        return
    if not isinstance(translations, list):
        raise WorkerError('INVALID_TRANSLATIONS', 'translations must be an array')
    changes, rejected = {}, []
    # Validate the existing base outside the submitted-text rejection boundary.
    current = native.read_editable(work, manifest)
    native.validate_sheets(manifest, sheets, current)
    for change in translations:
        if not isinstance(change, dict):
            raise WorkerError('INVALID_TRANSLATIONS', 'Translation record must be an object')
        ident = change.get('legacyId', change.get('id'))
        if not isinstance(ident, str) or ident not in manifest['units']:
            raise WorkerError('UNKNOWN_ID', 'Unknown native unit ID')
        if ident in changes:
            raise WorkerError('DUPLICATE_ID', 'Repeated translation ID: ' + ident)
        if not isinstance(change.get('translation'), str) or not isinstance(change.get('notes', ''), str):
            raise WorkerError('INVALID_TRANSLATIONS', 'translation and notes must be strings')
        try:
            native.restore(change['translation'], manifest['units'][ident])
        except ValueError as error:
            if len(rejected) < 256:
                rejected.append({'legacyId': ident, 'reason': str(error)[:1024]})
        changes[ident] = change
    if rejected:
        raise WorkerError('NATIVE_TEXT_REJECTED', 'Submitted translations failed native text validation',
                          rejectedTranslations=rejected)
    # Current editable is the base, so omitted IDs retain previously accepted work.
    for sheet in current.values():
        for row in sheet['units']:
            if row['id'] in changes:
                row['translation'] = changes[row['id']]['translation']
                row['notes'] = changes[row['id']].get('notes', row['notes'])
    validated = native.validate_sheets(manifest, sheets, current)
    if not materialize:
        yield None, validated, snapshot
        return
    with tempfile.TemporaryDirectory(prefix='pinhao-edit-', dir=work.parent) as folder:
        edit = Path(folder) / 'editable'
        for name, sheet in current.items():
            json_write(edit / name, sheet)
        yield edit, validated, snapshot


def validate(args):
    native.reset_work_cache()
    work = clean_path(path_arg(args, 'workspaceDir', 'workDir'))
    with prepared_editable(work, args.get('translations', args.get('units')), materialize=False) as (_, validated, _):
        return validated[2]


def roundtrip(args):
    native.reset_work_cache()
    work = clean_path(path_arg(args, 'workspaceDir', 'workDir'))
    snapshot = {}
    manifest, sheets = native.load_work(work, snapshot=snapshot)
    if manifest['engine'] in (unity_native.ENGINE, 'WOLF', 'RPG Maker 2000/2003'):
        snapshot.clear()
    if manifest['engine'] == unity_native.ENGINE:
        return unity_native.roundtrip(work, sys.modules[__name__])
    if manifest['engine'] == 'WOLF':
        exe = wolf_native.executable(ROOT)
        if not exe:
            raise WorkerError('CODEC_MISSING', 'WolfTL native codec is required')
        return wolf_native.roundtrip(work, exe, sys.modules[__name__])
    if manifest['engine'] == 'RPG Maker 2000/2003':
        exe = lcf_native.executable(ROOT)
        if not exe:
            raise WorkerError('CODEC_MISSING', 'liblcf native codec is required')
        return lcf_native.roundtrip(work, exe, sys.modules[__name__])
    with tempfile.TemporaryDirectory(prefix='pinhao-roundtrip-', dir=work.parent) as temp:
        output = Path(args.get('outputDir', args.get('outDir', str(Path(temp) / 'data')))).resolve()
        validated = native.validate_sheets(manifest, sheets, sheets)
        native.build(work, work / 'technical' / 'row-baseline', output,
                     validated=validated, snapshot=snapshot, verify_output=True)
        if any((output / file).read_bytes() != snapshot['baseline_files'][file]
               for file in manifest['files']):
            raise WorkerError('ROUNDTRIP_MISMATCH', 'No-change native bytes differ')
    return {'engine': manifest['engine'], 'files': len(manifest['files']),
            'units': len(manifest['units']), 'byteIdentical': True,
            'status': 'nochange_byte_identical', 'runtimeVerified': False}


def build(args):
    native.reset_work_cache()
    work = clean_path(path_arg(args, 'workspaceDir', 'workDir'))
    output = fresh(path_arg(args, 'outputDir', 'outDir'), (work,))
    with prepared_editable(work, args.get('translations', args.get('units')),
                           capture_baseline=True) as (editable, validated, snapshot):
        manifest = validated[0]
        if manifest['engine'] in (unity_native.ENGINE, *yukar_native.ENGINES, 'WOLF', 'RPG Maker 2000/2003'):
            snapshot.clear()
        if manifest['engine'] == unity_native.ENGINE:
            return unity_native.build(work, editable, output, sys.modules[__name__])
        if manifest['engine'] in yukar_native.ENGINES:
            return yukar_native.build(work, editable, output, sys.modules[__name__])
        if manifest['engine'] == 'WOLF':
            exe = wolf_native.executable(ROOT)
            if not exe:
                raise WorkerError('CODEC_MISSING', 'WolfTL native codec is required')
            font = path_arg(args, 'fontPath') if args.get('fontPath') else None
            return wolf_native.build(work, editable, output, exe, sys.modules[__name__], font)
        if manifest['engine'] == 'RPG Maker 2000/2003':
            exe = lcf_native.executable(ROOT)
            if not exe:
                raise WorkerError('CODEC_MISSING', 'liblcf native codec is required')
            return lcf_native.build(work, editable, output, exe, sys.modules[__name__])
        report = native.build(work, editable, output, validated=validated,
                              snapshot=snapshot, verify_output=True)
    return {**report, 'buildDir': str(output), 'outputDir': str(output), 'runtimeVerified': False}


def excluded(rel):
    return private_paths.excluded(rel)


def source_unchanged(game, metadata):
    for rel, expected in metadata['sourceFiles'].items():
        path = destination(game, rel)
        if not path.is_file() or digest_file(path) != expected:
            raise WorkerError('SOURCE_CHANGED', 'Original native resources changed; extract a new revision: ' + rel)


def materialize_source(args):
    game = clean_path(path_arg(args, 'gameDir'))
    work = clean_path(path_arg(args, 'workspaceDir', 'workDir'))
    metadata = native.read(work / 'technical' / 'product-source.json')
    if metadata.get('archiveFormat') != 'asar':
        return {'archived': False, 'materialized': 0, 'sourceRoot': metadata.get('nativeSource') or str(game)}
    files = args.get('files')
    if not isinstance(files, list) or not files or any(not isinstance(file, str) for file in files):
        raise WorkerError('INVALID_ARGUMENT', 'Source materialization needs relative files')
    source = clean_path(Path(metadata['nativeSource']).resolve())
    if not source.is_relative_to(work.parent) or source.is_relative_to(game) or game.is_relative_to(source):
        raise WorkerError('OUTPUT_OVERLAP', 'Materialized source must belong to the independent workbench')
    result = source_native.asar_native.materialize(game, source, metadata, files, sys.modules[__name__])
    return {**result, 'archived': True, 'sourceRoot': str(source)}


# Explicit opt-in hard links are taken only for media that no later stage rewrites in place. Image
# and text resources stay real copies because post-assembly stages (image redraw,
# script display text) write into these paths and a shared inode would also change
# the original game.
LINKABLE_SUFFIXES = frozenset({
    '.ogg', '.m4a', '.mp3', '.wav', '.opus', '.flac', '.aac', '.wma', '.mka',
    '.rpgmvo', '.rpgmvm', '.webm', '.ogv', '.mp4', '.mkv', '.avi', '.mov', '.mpg',
    '.mpeg', '.exe', '.dll', '.node', '.so', '.dylib', '.pak', '.ttf', '.otf',
    '.ttc', '.woff', '.woff2'})


def device_of(path):
    """Filesystem device of the nearest existing ancestor."""
    for candidate in (Path(path), *Path(path).parents):
        try:
            return os.stat(candidate).st_dev
        except OSError:
            continue
    return None


def same_content(source, dest, source_info=None, dest_info=None):
    """True when dest already holds the source bytes, checked without writing."""
    try:
        src, dst = source_info or os.stat(source), dest_info or os.stat(dest)
    except OSError:
        return False
    if not stat.S_ISREG(dst.st_mode) or src.st_size != dst.st_size:
        return False
    if (src.st_dev, src.st_ino) == (dst.st_dev, dst.st_ino):
        return True
    return digest_file(source) == digest_file(dest)


def require_copy_space(output, required_bytes):
    if required_bytes <= 0:
        return
    for directory in (Path(output), *Path(output).parents):
        if directory.exists():
            available = shutil.disk_usage(directory).free
            if required_bytes > available:
                raise WorkerError('DISK_SPACE', f'复制游戏资源所需空间不足：需要约 {required_bytes:,} 字节，'
                                  f'当前可用 {available:,} 字节。请释放空间或选择其他成品位置：{output}')
            return


def copy_tree(source, output, inventory, prefix='', omit_archives=False, omitted=(), resource_root='.',
              hardlink=False, link_exclude=(), progress=None, replacement_files=(), reserve_bytes=0):
    """Plan one enumerated copy, then check space before writing independent files."""
    source, output = Path(source), Path(output)
    source_root, output_root = source.resolve(), output.resolve()
    if output_root.is_relative_to(source_root) or source_root.is_relative_to(output_root):
        raise WorkerError('OUTPUT_OVERLAP', 'Output and source directories must be separate')
    entries = list(files_in(source))
    total = len(entries)
    for name in ('copied', 'linked', 'skipped'):
        inventory.setdefault(name, 0)
    linking = bool(hardlink) and device_of(source) == device_of(output)
    planned = []
    for index, (rel, path) in enumerate(entries, 1):
        full = str(PurePosixPath(prefix) / rel) if prefix else rel
        relative = rel[len(resource_root) + 1:] if resource_root != '.' and rel.startswith(resource_root + '/') else rel
        if excluded(rel) or excluded(relative) or rel in omitted or omit_archives and path.suffix.casefold() in ('.rgssad', '.rgss2a', '.rgss3a'):
            inventory['excluded'].append(full)
            continue
        if full in replacement_files:
            inventory['skipped'] += 1
            continue
        dest = destination(output, full)
        source_info = path.stat()
        try:
            dest_info = dest.stat()
        except FileNotFoundError:
            dest_info = None
        may_link = linking and full not in link_exclude and path.suffix.casefold() in LINKABLE_SUFFIXES
        if dest_info and same_content(path, dest, source_info, dest_info) and (dest_info.st_nlink <= 1 or may_link):
            inventory['skipped'] += 1
            continue
        planned.append((index, path, dest, source_info.st_size, may_link))
    del entries
    require_copy_space(output, reserve_bytes + sum(size for _, _, _, size, may_link in planned if not may_link))
    remaining_bytes = reserve_bytes + sum(size for _, _, _, size, _ in planned)
    for index, path, dest, size, may_link in planned:
        dest.parent.mkdir(parents=True, exist_ok=True)
        # Replacing the directory entry also breaks older shared hardlinks before any write.
        dest.unlink(missing_ok=True)
        if linking and may_link:
            try:
                os.link(path, dest)
                inventory['linked'] += 1
                remaining_bytes -= size
                if progress is not None:
                    progress(index, total)
                continue
            except OSError:
                # Different volume, exFAT/FAT, or a filesystem without hard links.
                linking = False
                require_copy_space(output, remaining_bytes)
        shutil.copyfile(path, dest)
        inventory['copied'] += 1
        remaining_bytes -= size
        if progress is not None:
            progress(index, total)


def font_family(path):
    try:
        return font_inspection.Font(clean_path(path)).family()
    except (ValueError, struct.error) as error:
        raise WorkerError('FONT_FORMAT', str(error)) from error


def font_coverage(args):
    font = path_arg(args, 'fontPath')
    parsed = font_inspection.Font(font)
    return {'family': parsed.family(), 'sha256': digest_file(font), **parsed.coverage(args.get('texts', []))}


def name_mappings(work, build_dir):
    manifest, _ = native.load_work(work)
    mappings = {}
    documents = {}
    for ident, unit in manifest['units'].items():
        if unit['kind'] not in ('database_name', 'database_nickname', 'database_profile', 'database_description'):
            continue
        if Path(unit['file']).stem != 'Actors' or len(unit['targets']) != 1:
            continue
        original = native.restore(unit['source'], unit)[0]
        if unit['file'] not in documents:
            raw = (build_dir / unit['file']).read_bytes()
            documents[unit['file']] = native.parse_json(raw) if manifest['backend'] == 'json' else Reader(raw)
        document = documents[unit['file']]
        if manifest['backend'] == 'json':
            target = unit['targets'][0]
            translated = native.at(document, target)
            actor, field = target
        else:
            strings = {value.index: value for value in document.strings}
            translated = strings[unit['targets'][0]].text()
            context = unit['contexts'][0]
            actor, field = context['record'], context['field']
        if original != translated and original:
            mappings.setdefault(str(actor), {})[field] = {'source': original, 'target': translated}
    return mappings


def install_js_runtime(game_root, work, build_dir, font, inventory, args):
    template = Path(__file__).parent / 'templates' / 'localization.js'
    config = {'font': None, 'names': name_mappings(work, build_dir), 'wrapMessages': args.get('wrapMessages', True)}
    if font:
        family = font_family(font)
        suffix = font.suffix.lower()
        dest = game_root / 'fonts' / ('PinHaoChinese' + suffix)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(font, dest)
        config['font'] = {'family': family, 'file': 'PinHaoChinese' + suffix}
        inventory['font'] = {'family': family, 'file': dest.relative_to(game_root).as_posix(), 'sha256': digest_file(dest)}
    if not config['font'] and not config['names'] and not config['wrapMessages']:
        return
    plugins = game_root / 'js' / 'plugins.js'
    if not plugins.is_file():
        inventory['warnings'].append('plugins.js missing; font/name runtime was not installed')
        return
    script = template.read_text(encoding='utf-8').replace('__PINHAO_CONFIG__', json.dumps(config, ensure_ascii=False))
    runtime = game_root / 'js' / 'plugins' / 'PinHaoLocalization.js'
    runtime.parent.mkdir(parents=True, exist_ok=True)
    runtime.write_text(script, encoding='utf-8')
    marker = '// PinHao localization runtime'
    original = plugins.read_text(encoding='utf-8-sig')
    if marker in original:
        original = original[:original.index(marker)].rstrip() + '\n'
    descriptor = json.dumps({'name': 'PinHaoLocalization', 'status': True,
                             'description': 'Chinese font, message layout and default-name display', 'parameters': {}})
    registration = ('$plugins = $plugins.filter(function(plugin) { return plugin.name !== "PinHaoLocalization"; });\n'
                    '$plugins.push(' + descriptor + ');\n')
    plugins.write_text(original + '\n' + marker + '\n' + registration, encoding='utf-8')
    inventory['runtime'] = 'js/plugins/PinHaoLocalization.js'
    inventory['oldDefaultNames'] = sum(len(row) for row in config['names'].values())


def ruby_literal(value):
    if value is None:
        return 'nil'
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, dict):
        return '{' + ','.join(ruby_literal(key) + '=>' + ruby_literal(item) for key, item in value.items()) + '}'
    if isinstance(value, (list, tuple)):
        return '[' + ','.join(ruby_literal(item) for item in value) + ']'
    if isinstance(value, str):
        # Ruby interpolation must remain literal in names supplied by the workbench.
        return re.sub(r'#(?=[{@$])', r'\\#', json.dumps(value, ensure_ascii=False))
    return str(value)


def patch_raw_strings(reader, replacements):
    spans = [(value.start, value.end, long_bytes(len(replacements[value.index])) + replacements[value.index])
             for value in reader.strings if value.index in replacements]
    if len(spans) != len(replacements):
        raise WorkerError('SCRIPT_SLOT', 'Native script slot was not found')
    output, pos = [], 0
    for start, end, replacement in sorted(spans):
        output.extend((reader.raw[pos:start], replacement))
        pos = end
    output.append(reader.raw[pos:])
    raw = b''.join(output)
    if structure(Reader(raw).root) != structure(reader.root, replacements):
        raise WorkerError('SCRIPT_STRUCTURE', 'Script container changed beyond the selected payload')
    return raw


def install_rgss_runtime(game_root, work, build_dir, font, inventory):
    manifest, _ = native.load_work(work)
    config = {'font': None, 'names': name_mappings(work, build_dir)}
    if font:
        family = font_family(font)
        dest = game_root / 'Fonts' / ('PinHaoChinese' + font.suffix.lower())
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(font, dest)
        config['font'] = {'family': family, 'file': dest.relative_to(game_root).as_posix()}
        inventory['font'] = {'family': family, 'file': dest.relative_to(game_root).as_posix(), 'sha256': digest_file(dest)}
    if not config['font'] and not config['names']:
        return
    ext = {'VX Ace': '.rvdata2', 'VX': '.rvdata', 'XP': '.rxdata'}[manifest['engine']]
    scripts = game_root / 'Data' / ('Scripts' + ext)
    if not scripts.is_file():
        inventory['warnings'].append('Scripts container missing; font/name runtime was not installed')
        return
    reader = Reader(scripts.read_bytes())
    candidates = []
    for row in reader.root:
        if not isinstance(row, list) or len(row) < 3 or not isinstance(row[2], RString):
            continue
        try:
            text = zlib.decompress(row[2].raw)
        except zlib.error:
            continue
        if text.strip():
            candidates.append((row[1].text() if isinstance(row[1], RString) else '', row[2], text))
    if not candidates:
        raise WorkerError('SCRIPT_SLOT', 'No executable RGSS script slot found')
    _, value, text = next((row for row in reversed(candidates) if row[0].strip().lower() == 'main'), candidates[-1])
    bootstrap = rgss_bootstrap('PinHaoLocalization.rb')
    for previous in (b"load 'PinHaoLocalization.rb'\n", b"load File.expand_path('PinHaoLocalization.rb')\n"):
        if text.startswith(previous):
            text = text[len(previous):]
    if not text.startswith(bootstrap):
        scripts.write_bytes(patch_raw_strings(reader, {value.index: zlib.compress(bootstrap + text)}))
    source = (Path(__file__).parent / 'templates' / 'localization.rb').read_text(encoding='utf-8')
    source = source.replace('__PINHAO_CONFIG__', ruby_literal(config))
    (game_root / 'PinHaoLocalization.rb').write_text(source, encoding='utf-8')
    inventory['runtime'] = 'PinHaoLocalization.rb'
    inventory['oldDefaultNames'] = sum(len(row) for row in config['names'].values())


def rgss_bootstrap(filename):
    # RGSS loaders disagree on relative paths and non-ASCII working directories.
    return ("eval(File.open('" + filename + "', 'rb') { |file| file.read }, TOPLEVEL_BINDING, '" + filename + "')\n").encode('ascii')


def assist_install(args):
    root = clean_path(path_arg(args, 'outputDir'))
    if (root / 'game').is_dir() and (root / 'renpy').is_dir():
        from assist_transaction import InstallTransaction
        target = clean_path(root / 'game' / 'zz_pinhao_assist.rpy')
        compiled = clean_path(target.with_suffix('.rpyc'))
        source = Path(__file__).parent / 'templates' / 'assist.rpy'
        def install(transaction):
            transaction.write(target, source.read_bytes())
            transaction.remove(compiled)
            return {'supported': True, 'engine': "Ren'Py", 'transport': 'file'}
        return InstallTransaction(root, sys.modules[__name__]).run(install)
    for engine, ext in [('VX Ace', '.rvdata2'), ('VX', '.rvdata'), ('XP', '.rxdata')]:
        scripts = root / 'Data' / ('Scripts' + ext)
        if not scripts.is_file():
            continue
        clean_path(scripts)
        return assist_install_rgss.install(root, scripts, engine, sys.modules[__name__])
    engine = probe({'gameDir': str(root)})['engine']
    if engine in ('RPG Maker 2000/2003', 'WOLF'):
        capability = assistance_info(root, engine)
        return {**capability, 'supported': False, 'saveSupported': capability['supported']}
    managed = assist_managed.install({**args, 'engine': engine}, sys.modules[__name__])
    if managed['supported'] or managed.get('status', 'unsupported') != 'unsupported':
        return managed
    import assist_script
    return assist_script.install(args, sys.modules[__name__])


def link_exclusions(manifest, build_report, args, root):
    """Output-relative paths that a later stage may rewrite, so they stay real copies."""
    names = set(manifest['files'])
    names.update(build_report.get('files_sha256') or {})
    for key in ('adapterOverlayFiles', 'assetOverlayFiles'):
        rows = args.get(key)
        if isinstance(rows, list):
            names.update(row['file'] for row in rows if isinstance(row, dict) and isinstance(row.get('file'), str) and row['file'])
    prefix = PurePosixPath(root)
    return names | {str(prefix / name) for name in names}


def copy_progress(index, total, every=500):
    if index % every and index != total:
        return
    try:
        print(json.dumps({'progress': {'phase': 'assemble-copy', 'done': index, 'total': total}}),
              file=sys.stderr, flush=True)
    except (OSError, ValueError):
        pass


def assemble(args):
    native.reset_work_cache()
    game = clean_path(path_arg(args, 'gameDir'))
    work = clean_path(path_arg(args, 'workspaceDir', 'workDir'))
    built = clean_path(path_arg(args, 'buildDir'))
    output = fresh(path_arg(args, 'outputDir', 'outDir'), (game, work, built))
    manifest, _ = native.load_work(work)
    if manifest['engine'] == 'Godot':
        return godot_native.assemble(args, sys.modules[__name__])
    if manifest['engine'] == unity_native.ENGINE:
        return unity_native.assemble(args, sys.modules[__name__])
    if manifest['engine'] in yukar_native.ENGINES:
        return yukar_native.assemble(args, sys.modules[__name__])
    metadata = native.read(work / 'technical' / 'product-source.json')
    source_unchanged(game, metadata)
    build_report = native.read(built / 'build-report.json')
    if build_report['manifest_sha256'] != digest_file(work / 'manifest.json'):
        raise WorkerError('WRONG_BUILD', 'Build belongs to another workbench revision')
    for rel, expected in build_report['files_sha256'].items():
        if digest_file(destination(built, rel)) != expected:
            raise WorkerError('BUILD_CHANGED', 'Built resource changed: ' + rel)
    inventory = {'copied': 0, 'linked': 0, 'skipped': 0, 'excluded': [], 'warnings': [], 'runtimeVerified': False,
                 'sourceFingerprint': metadata['sourceFingerprint'], 'engine': manifest['engine']}
    font = clean_path(Path(args['fontPath']).resolve()) if args.get('fontPath') else None
    if font:
        font_family(font)
    if metadata.get('archiveFormat') == 'nwjs-zip':
        return source_native.nwjs_native.assemble(game, work, built, output, metadata, manifest,
                                                 font, inventory, sys.modules[__name__], args)
    output.mkdir(parents=True)
    omitted = list(metadata['archives']) if metadata['packed'] else []
    if manifest['engine'] == 'TyranoScript' and metadata['packed']:
        omitted.extend(rel for rel, _ in files_in(game) if rel.startswith('resources/app.asar.unpacked/'))
    if manifest['engine'] == "Ren'Py":
        omitted.extend(str(Path(metadata['root']) / file).replace('\\', '/') + 'c' for file in manifest['files'] if file.endswith('.rpy'))
    keep_copies = link_exclusions(manifest, build_report, args, metadata['root'])
    hardlink = bool(args.get('hardLink', False))
    xp3 = metadata.get('archiveFormat') == 'xp3'
    overlay = build_report['files_sha256'] if manifest['engine'] in ('WOLF', 'RPG Maker 2000/2003') else manifest['files']
    replacements = set() if xp3 else {str(PurePosixPath(metadata['root']) / rel) for rel in overlay}
    reserve_bytes = 0 if xp3 else sum(destination(built, rel).stat().st_size for rel in overlay)
    copy_tree(game, output, inventory, omit_archives=metadata['packed'], omitted=omitted,
              resource_root=metadata['root'], hardlink=hardlink, link_exclude=keep_copies, progress=copy_progress,
              replacement_files=replacements, reserve_bytes=reserve_bytes)
    if metadata.get('archiveFormat') == 'asar':
        inventory['asarPackage'] = source_native.asar_native.assemble(game, output, metadata, overlay, inventory, sys.modules[__name__])
    elif metadata['packed'] and not xp3:
        copy_tree(Path(metadata['nativeSource']), output, inventory, omitted=omitted,
                  resource_root=metadata['root'], hardlink=hardlink, link_exclude=keep_copies, progress=copy_progress,
                  replacement_files=replacements, reserve_bytes=reserve_bytes)
    game_root = output / metadata['root']
    for rel in (() if xp3 else overlay):
        dest = destination(game_root, rel)
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists() and dest.stat().st_nlink > 1:
            # Never write through a link that is still shared with the original game.
            dest.unlink()
        shutil.copyfile(destination(built, rel), dest)
    if not xp3:
        args = rgss_scripts.apply(game_root, work, args, sys.modules[__name__], inventory)
        adapter_overlay.apply(game_root, args, sys.modules[__name__], inventory, baseline_root=built)
    if xp3:
        kirikiri_native.assemble(game, Path(metadata['nativeSource']), built, metadata, manifest, output, font, inventory, sys.modules[__name__], args)
    elif manifest['engine'] in ('MV', 'MZ'):
        install_js_runtime(game_root, work, built, font, inventory, args)
    elif manifest['engine'] == 'WOLF':
        if font:
            exe = wolf_native.executable(ROOT)
            if not exe:
                raise WorkerError('CODEC_MISSING', 'WolfTL native codec is required')
            wolf_native.install_font(game_root, built, exe, font, sys.modules[__name__], inventory)
    elif manifest['engine'] == 'RPG Maker 2000/2003':
        inventory['encoding'] = build_report['encoding']
        inventory['warnings'].extend(build_report.get('warnings', []))
        if font:
            inventory['warnings'].append('LCF uses a runtime bitmap font; the selected TTF was not installed')
    elif manifest['engine'] in source_native.ENGINES:
        image_args = asset_overlay.for_resource_root(args, metadata['root'], sys.modules[__name__]) if metadata['packed'] else args
        asset_overlay.apply(game_root, image_args, sys.modules[__name__], inventory)
        source_native.install_font(game_root, manifest['engine'], font, inventory, sys.modules[__name__])
        if metadata.get('archiveFormat') == 'pgmm-enc':
            source_native.pgmm_native.finalize(game_root, metadata['archiveLayouts'], sys.modules[__name__], inventory)
        inventory['warnings'].append('Native source resources checked; game launch and layout acceptance pending')
    else:
        install_rgss_runtime(game_root, work, built, font, inventory)
    launchers = [rel for rel, _ in files_in(output) if rel.lower().endswith('.exe') and '/' not in rel]
    preferred = ('game.exe', 'gamepro.exe', 'game64.exe', 'game32.exe', 'rpg_rt.exe')
    ranked = sorted(launchers, key=lambda rel: preferred.index(rel.lower()) if rel.lower() in preferred else len(preferred))
    launch = next((rel for rel in ranked if rel.lower() in preferred), None)
    if launch is None:
        launch = next((rel for rel in ranked if not re.search(r'config|crash|install|unins|setup|redist|^nw\.exe$', rel, re.I)), None)
    if manifest['engine'] == 'Godot':
        launch = None
        inventory['sourceOnly'] = True
        inventory['pendingChecks'] = [{'kind': 'Godot工程导出', 'status': 'pending',
                                      'message': '使用匹配版本的Godot打开project.godot，验证汉化场景并重新导出游戏'}]
    inventory['launchers'] = launchers
    inventory['status'] = 'assembled_source_project' if manifest['engine'] == 'Godot' else 'assembled_structurally_checked'
    inventory['nativeFiles'] = len(manifest['files'])
    json_write(output / 'PinHao-build-report.json', inventory)
    if args.get('share', True):
        usage = ('本目录包含回写后的 Godot 源码工程。\n'
                 '请使用匹配版本的 Godot 打开 project.godot，验证汉化场景并导出游戏。\n'
                 if manifest['engine'] == 'Godot' else '启动原游戏程序即可游玩，汉化文字已内嵌。\n')
        (output / '使用说明-拼好汉化.txt').write_text(
            '本汉化成果由拼好汉化免费分享。\n'
            '切勿付费购买此资源；如已付款，请联系交易平台申请退款。\n' + usage +
            '感谢原作者与参与翻译、校对及技术整理的同好，祝游玩愉快。\n', encoding='utf-8')
    return {**inventory, 'outputDir': str(output), 'reportPath': str(output / 'PinHao-build-report.json'),
            'launchPath': str(output / launch) if launch else None}


SCRIPT_ESCAPES = {'a': '\a', 'b': '\b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t', 'v': '\v', '\\': '\\', '"': '"', "'": "'"}
SCRIPT_OCTAL = re.compile(r'[0-7]{1,3}')
SCRIPT_HEX_WIDTH = {'x': 2, 'u': 4, 'U': 8}


def decode_script_literal(literal):
    """Decode one quoted JavaScript literal into the value the host decoder reports."""
    quote = next((item for item in ('"""', "'''", '"', "'")
                  if literal.startswith(item) and literal.endswith(item)), None)
    if quote is None or len(literal) < len(quote) * 2:
        return None
    body, value, cursor = literal[len(quote):-len(quote)], [], 0
    while cursor < len(body):
        if body.startswith(quote, cursor):
            return None
        char = body[cursor]
        if char != '\\':
            value.append(char)
            cursor += 1
            continue
        cursor += 1
        if cursor >= len(body):
            return None
        escaped = body[cursor]
        if escaped in SCRIPT_ESCAPES:
            value.append(SCRIPT_ESCAPES[escaped])
            cursor += 1
            continue
        if escaped == '\n':
            cursor += 1
            continue
        if escaped == '\r' and body[cursor + 1:cursor + 2] == '\n':
            cursor += 2
            continue
        if escaped in '01234567':
            digits = SCRIPT_OCTAL.match(body[cursor:])[0]
            value.append(chr(int(digits, 8)))
            cursor += len(digits)
            continue
        width = SCRIPT_HEX_WIDTH.get(escaped)
        if width:
            digits = body[cursor + 1:cursor + 1 + width]
            if len(digits) != width or not re.fullmatch(r'[0-9a-fA-F]+', digits):
                return None
            code = int(digits, 16)
            if code > 0x10ffff:
                return None
            value.append(chr(code))
            cursor += 1 + width
            continue
        if escaped == 'N':
            return None
        value.append('\\' + escaped)
        cursor += 1
    plain = ''.join(value)
    if any('\ud800' <= item <= '\udfff' for item in plain):
        # Host strings are UTF-16; join valid escape pairs so the text stays encodable as UTF-8.
        try:
            plain = plain.encode('utf-16', 'surrogatepass').decode('utf-16')
        except UnicodeError:
            return None
    return plain


def dynamic_candidates(source, work):
    info = native.probe(source)
    root = Path(source) / info['root']
    candidates = []
    # Candidate inventory is separate from writable fields: keys, paths and expressions
    # remain intact until a technical adapter defines an exact display binding.
    literal = re.compile(r'''(?P<quote>["'])(?P<text>(?:\\.|[^\\\r\n])*?)(?P=quote)''')
    kana = re.compile('[\u3040-\u30ff]')
    for folder in (root / 'js' / 'plugins',):
        for path in sorted(folder.glob('*.js')):
            if path.stat().st_size > 8 * 1024 * 1024:
                continue
            text = path.read_text(encoding='utf-8-sig', errors='replace')
            for match in literal.finditer(text):
                value = match['text']
                if kana.search(value) and len(value) <= 2000:
                    # Python string indexes are code points, which is exactly what the host
                    # span format needs; the span covers both quotes so byte ranges and the
                    # extracted literal body can be compared after UTF-8 conversion.
                    decoded = decode_script_literal(match[0])
                    candidates.append({'file': path.relative_to(root).as_posix(),
                                       'line': text.count('\n', 0, match.start()) + 1,
                                       'source': value if decoded is None else decoded,
                                       'target': {'start': match.start(), 'end': match.end(), 'render': 'quoted'},
                                       'kind': 'script_literal_candidate',
                                       'writable': False, 'status': 'adapter_review'})
    json_write(work / 'dynamic-candidates.json', candidates)
    return candidates


def zip_command(args):
    source = clean_path(path_arg(args, 'sourceDir'))
    output = fresh(path_arg(args, 'filePath', 'outputPath'), (source,))
    entries = [(rel, path) for rel, path in files_in(source)
               if not (args.get('release') or args.get('excludeSaves')) or not excluded(rel)]
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
        for rel, path in entries:
            safe_member(rel)
            archive.write(path, rel)
    return {'filePath': str(output), 'files': len(entries), 'bytes': output.stat().st_size,
            'sha256': digest_file(output)}


def safe_member(name):
    clean = safe_relative(name)
    for part in PurePosixPath(clean).parts:
        if DEVICE_NAME.match(part) or any(ord(c) < 32 or c in '<>"|?*' for c in part):
            raise WorkerError('UNSAFE_ARCHIVE_PATH', 'Unsafe Windows package path')
    return clean


def unzip_command(args):
    source = clean_path(path_arg(args, 'filePath', 'sourcePath'))
    output = fresh(path_arg(args, 'outputDir', 'outDir'))
    planned, seen = [], set()
    with zipfile.ZipFile(source, 'r') as archive:
        for member in archive.infolist():
            name = member.filename.rstrip('/') if member.is_dir() else member.filename
            rel = safe_member(name)
            folded = rel.casefold()
            if folded in seen:
                raise WorkerError('PATH_COLLISION', 'Duplicate package path: ' + rel)
            seen.add(folded)
            mode = member.external_attr >> 16
            if stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise WorkerError('SYMLINK', 'Archive contains a special file')
            planned.append((rel, member))
        file_paths = {rel.casefold() for rel, member in planned if not member.is_dir()}
        if any(parent.as_posix().casefold() in file_paths
               for rel, _ in planned for parent in PurePosixPath(rel).parents if str(parent) != '.'):
            raise WorkerError('PATH_COLLISION', 'Archive file/directory collision')
        requested = args.get('files')
        if requested is not None:
            if not isinstance(requested, list) or not requested or any(not isinstance(name, str) for name in requested):
                raise WorkerError('INVALID_ARGUMENT', 'Selected ZIP members need relative file paths')
            requested = {safe_member(name) for name in requested}
            if requested - {rel for rel, member in planned if not member.is_dir()}:
                raise WorkerError('ARCHIVE_MEMBER_MISSING', 'Requested ZIP member is missing')
            planned = [(rel, member) for rel, member in planned if rel in requested and not member.is_dir()]
        output.mkdir(parents=True)
        for rel, member in planned:
            target = destination(output, rel)
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(member) as src, target.open('xb') as dest:
                shutil.copyfileobj(src, dest, length=1024 * 1024)
    return {'outputDir': str(output), 'files': sum(not item.is_dir() for _, item in planned)}


COMMANDS = {'catalog': catalog, 'probe': probe, 'extract': extract, 'validate': validate, 'roundtrip': roundtrip, 'assistInstall': assist_install,
            'materialize_source': materialize_source,
            'fontCoverage': font_coverage,
            'assistUninstall': lambda args: assist_install_rgss.uninstall(args, sys.modules[__name__]),
            'native_unpack': lambda args: archive_tools.unpack(args, sys.modules[__name__]),
            'native_repack': lambda args: archive_tools.repack(args, sys.modules[__name__]),
            'native_review': lambda args: native_review.inspect(args, sys.modules[__name__]),
            'native_adapt': lambda args: native_review.adapt(args, sys.modules[__name__]),
            'assistInfo': lambda args: assistance_info(clean_path(path_arg(args, 'gameDir')), args['engine']),
            'assistSaveRead': lambda args: assist_legacy.load(args, sys.modules[__name__]),
            'assistSaveWrite': lambda args: assist_legacy.write(args, sys.modules[__name__]),
            'assistSaveBackups': lambda args: assist_legacy.backups(args, sys.modules[__name__]),
            'assistSaveRestore': lambda args: assist_legacy.restore(args, sys.modules[__name__]),
            'assistCatalog': lambda args: assist_catalog.scan(args, sys.modules[__name__]),
            'mobileZip': lambda args: mobile_export.export(args, sys.modules[__name__]),
            'build': build, 'assemble': assemble, 'zip': zip_command, 'unzip': unzip_command}


def main():
    try:
        if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
            raise WorkerError('UNKNOWN_COMMAND', 'Choose: ' + ', '.join(COMMANDS))
        args = json.load(sys.stdin, object_pairs_hook=native.unique_keys)
        if not isinstance(args, dict):
            raise WorkerError('INVALID_ARGUMENT', 'Request must be an object')
        result = COMMANDS[sys.argv[1]](args)
        print(json.dumps({'ok': True, 'result': result}, ensure_ascii=False, allow_nan=False))
        return 0
    except Exception as error:
        code = getattr(error, 'code', None) or (errno.errorcode.get(error.errno) if isinstance(error, OSError) else None) or 'NATIVE_WORKER_ERROR'
        print(json.dumps({'ok': False, 'error': {'code': code,
                                              'message': str(error), **native_environment.error_details(error),
                                              **({'rejectedTranslations': error.rejectedTranslations}
                                                 if code == 'NATIVE_TEXT_REJECTED' and isinstance(error, WorkerError) else {})}}, ensure_ascii=False))
        return 2


if __name__ == '__main__':
    sys.exit(main())
