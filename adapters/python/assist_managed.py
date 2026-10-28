"""Install the self-authored frame-thread field bridge into managed output copies."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
from assist_transaction import InstallTransaction

ENGINES = ('Unity', 'SMILE GAME BUILDER', 'RPG Developer Bakin')


def tools():
    return Path(os.environ.get('PINHAO_MANAGED_TOOLS') or Path(__file__).resolve().parents[2] / 'local/dependencies/managed')


def available():
    base = tools()
    return os.name == 'nt' and all((base / name).is_file() for name in ('Pinhao.ManagedPatch.exe', 'Mono.Cecil.dll', 'net20/Pinhao.ManagedAssist.dll', 'net40/Pinhao.ManagedAssist.dll'))


def _run(arguments):
    process = subprocess.run([str(tools() / 'Pinhao.ManagedPatch.exe'), *map(str, arguments)], capture_output=True,
                             timeout=45, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if process.returncode:
        raise ValueError(process.stderr.decode('utf-8', 'replace').strip()[:600])
    return json.loads(process.stdout.decode('utf-8-sig'))


def runtime(game, engine=None):
    game = Path(game)
    data = sorted(path for path in game.iterdir() if path.is_dir() and path.name.lower().endswith('_data'))
    if engine is None:
        if data and ((game / 'UnityPlayer.dll').is_file() or (game / 'GameAssembly.dll').is_file() or any((root / 'globalgamemanagers').is_file() for root in data)):
            engine = 'Unity'
        elif (game / 'data/bakinengine.dll').is_file() or (game / 'bakinengine.dll').is_file():
            engine = ENGINES[2]
        elif (game / 'sgb_rpgplayer.exe').is_file():
            engine = ENGINES[1]
    result = {'supported': False, 'engine': engine, 'modes': [], 'detail': '选择 Unity Mono、SGB 或 Bakin 的 Windows 托管运行器'}
    if engine not in ENGINES:
        return result
    if engine == 'Unity' and (game / 'GameAssembly.dll').is_file():
        return {**result, 'runtime': 'IL2CPP', 'detail': 'Unity IL2CPP 使用原生运行器；当前实时字段桥面向 Unity Mono'}
    if not available():
        return {**result, 'detail': '准备固定的 Mono.Cecil 与拼好托管辅助组件'}
    if engine == 'Unity':
        candidates = [path for root in data for path in sorted((root / 'Managed').glob('Assembly-CSharp*.dll'))]
    elif engine == ENGINES[1]:
        candidates = [game / 'sgb_rpgplayer.exe', game / 'Yukar.Engine.dll']
    else:
        candidates = [game / 'data/bakinengine.dll', game / 'bakinengine.dll']
    selected, failures = [], []
    for path in candidates:
        if not path.is_file():
            continue
        if path.is_symlink() or getattr(path, 'is_junction', lambda: False)():
            raise ValueError('Choose a managed game with regular assembly files')
        try:
            inspected = _run(['probe', path, engine])
            if inspected['signed']:
                failures.append('已签名程序集需要独立适配：' + path.name)
            elif inspected['hooks']:
                selected.append({'file': path.relative_to(game).as_posix(), **inspected})
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            failures.append(str(error))
    if not selected:
        return {**result, 'runtime': 'Mono/.NET', 'detail': failures[0] if failures else '当前托管程序集缺少已绑定的帧更新入口', 'assemblies': []}
    return {**result, 'supported': True, 'runtime': 'Mono/.NET', 'modes': ['live'], 'transport': 'file',
            'detail': '游戏线程中的具名字段读写：布尔、数字、文字、列表与字典；修改前保存原值', 'assemblies': selected}


def capabilities(game):
    value = runtime(Path(game))
    return {key: value[key] for key in ('supported', 'engine', 'modes', 'detail')}


def install(args, helpers):
    game = helpers.clean_path(helpers.path_arg(args, 'gameDir', 'outputDir'))
    for _ in helpers.files_in(game):
        pass
    report = runtime(game, args.get('engine'))
    if not report['supported']:
        return report
    def prepare_and_commit(transaction):
        prepared = []
        with tempfile.TemporaryDirectory(prefix='pinhao-managed-install-', dir=game.parent) as temporary:
            for index, item in enumerate(report['assemblies']):
                original = helpers.clean_path(game / item['file'])
                helper = tools() / item['framework'] / 'Pinhao.ManagedAssist.dll'
                replacement = Path(temporary) / ('assembly' + str(index) + original.suffix)
                if item['injected']:
                    replacement = original
                else:
                    _run(['patch', original, report['engine'], helper, replacement])
                    checked = _run(['probe', replacement, report['engine']])
                    if not checked['injected'] or checked['hooks'] != item['hooks']:
                        raise helpers.WorkerError('MANAGED_PATCH', 'Managed frame bridge readback mismatch')
                prepared.append((original, replacement, helper))
            for original, replacement, helper in prepared:
                transaction.copy(helper, original.parent / 'Pinhao.ManagedAssist.dll')
                if original != replacement:
                    transaction.copy(replacement, original)
            if report['engine'] != 'Unity':
                transaction.copy(prepared[0][2], game / 'Pinhao.ManagedAssist.dll')
            return {**report, 'actions': ['setNamedVariable'], 'backup': 'PINHAO_ASSIST_BACKUP_DIR',
                    'patchedFiles': [item['file'] for item in report['assemblies']]}
    return InstallTransaction(game, helpers).run(prepare_and_commit)
