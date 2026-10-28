"""Prepare an existing MV/MZ build as a JoiPlay RGA using its documented ZIP layout."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import zipfile


RUNNER_FILES = {
    'chrome_100_percent.pak', 'chrome_200_percent.pak', 'resources.pak', 'icudtl.dat',
    'snapshot_blob.bin', 'v8_context_snapshot.bin', 'nw_100_percent.pak', 'nw_200_percent.pak',
    'natives_blob.bin', 'vk_swiftshader_icd.json', 'notification_helper.exe',
}
OWN_REPORTS = {'pinhao-build-report.json', 'pinhao-mobile-report.json', 'game.cfg', '手机游玩说明.txt'}
DESKTOP_REFERENCE = re.compile(r'''require\s*\(\s*["'](?:fs|path|os|child_process|nw\.gui|ffi(?:-napi)?)(?:["'/])|\b(?:process\.(?:env|argv|platform)|Win32API|ActiveXObject)\b''')


def line(value, fallback):
    return ' '.join(str(value or fallback).split()).replace('\x00', '')[:200]


def export(args, helpers):
    source = helpers.clean_path(helpers.path_arg(args, 'sourceDir'))
    output = helpers.fresh(helpers.path_arg(args, 'filePath'), (source,))
    if output.suffix.casefold() != '.rga':
        raise helpers.WorkerError('MOBILE_EXTENSION', '请使用 .rga 保存 JoiPlay 游戏包')
    info = helpers.probe({'gameDir': str(source)})
    if info['engine'] not in ('MV', 'MZ') or args.get('engine', info['engine']) != info['engine']:
        raise helpers.WorkerError('MOBILE_ENGINE', 'JoiPlay 手机包当前接入 RPG Maker MV 和 MZ 成品')
    game_root = source / info.get('root', '.')
    entry = game_root / 'index.html'
    if not entry.is_file():
        raise helpers.WorkerError('MOBILE_ENTRY', '请为当前成品补齐 index.html 游戏入口')
    entry_name = entry.relative_to(source).as_posix()
    entries, excluded = [], []
    for relative, file in helpers.files_in(source):
        parts = PurePosixPath(relative).parts
        basename = parts[-1].casefold()
        runner = len(parts) == 1 and (basename in RUNNER_FILES or file.suffix.casefold() in ('.exe', '.dll', '.pdb'))
        if helpers.excluded(relative) or runner or basename in OWN_REPORTS:
            excluded.append(relative)
            continue
        helpers.safe_member(relative)
        entries.append((relative, file))
    warnings, review = [], []
    enabled = None
    manifest = game_root / 'js/plugins.js'
    if manifest.is_file():
        text = manifest.read_text(encoding='utf-8-sig')
        match = re.search(r'\$plugins\s*=\s*', text)
        if match:
            try:
                rows, _ = json.JSONDecoder().raw_decode(text[match.end():].lstrip())
                if isinstance(rows, list):
                    enabled = {row.get('name') for row in rows if isinstance(row, dict) and row.get('status') is True}
            except ValueError:
                pass
    for file in sorted((game_root / 'js/plugins').glob('*.js')):
        if file.stem.startswith('PinHao') or enabled is not None and file.stem not in enabled:
            continue
        if DESKTOP_REFERENCE.search(file.read_text(encoding='utf-8-sig', errors='replace')):
            relative = file.relative_to(source).as_posix()
            review.append({'file': relative, 'kind': 'desktop-api-reference'})
            warnings.append(f'插件 {file.name} 引用了桌面接口，请在手机上检查对应功能')
    title = line(args.get('name'), source.name)
    ident = 'PinHao' + hashlib.sha256(str(args.get('projectId', title)).encode('utf-8')).hexdigest()[:24]
    config = f'title={title}\nid={ident}\nexecFile={entry_name}\nversion=1\ntype=html\n'
    report = {'format': 'JoiPlay RGA', 'engine': info['engine'], 'entryFile': entry_name,
              'files': len(entries), 'desktopFilesExcluded': excluded, 'reviewItems': review,
              'warnings': warnings, 'phoneRuntimeVerified': False}
    instructions = (
        f'{title} · JoiPlay 手机游玩包\n\n'
        '在 Android 手机上安装 JoiPlay，通过游戏包导入功能选择此 .rga 文件。\n'
        f'也可用 ZIP 解压工具打开此包，在 JoiPlay 中添加 {entry_name}。\n'
        '中文文字、游戏资源和内嵌字体已随包整理；存档在手机上由运行器管理。\n'
        '请在手机试玩启动、字体、触控、音频与存读档，插件检查见 PinHao-mobile-report.json。\n'
        'JoiPlay 官方项目：https://github.com/joiplay/rga\n\n'
        '本汉化成果免费分享，切勿付费购买；如已付款，请联系交易平台申请退款。\n'
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    created = False
    try:
        with zipfile.ZipFile(output, 'x', zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
            created = True
            for relative, file in entries:
                archive.write(file, relative)
            archive.writestr('game.cfg', config.encode('utf-8'))
            archive.writestr('PinHao-mobile-report.json', json.dumps(report, ensure_ascii=False, indent=2).encode('utf-8'))
            archive.writestr('手机游玩说明.txt', instructions.encode('utf-8'))
        with zipfile.ZipFile(output) as archive:
            if archive.testzip() is not None:
                raise helpers.WorkerError('MOBILE_CRC', '手机包完整性检查失败，请重新导出')
    except Exception:
        if created:
            output.unlink(missing_ok=True)
        raise
    return {'filePath': str(output), 'files': len(entries) + 3, 'bytes': output.stat().st_size,
            'sha256': helpers.digest_file(output), 'warnings': warnings, 'entryFile': entry_name}
