"""Optional real-engine smoke: pass an official kr2_232r2 SDK directory."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'adapters/python'))
import worker
import xp3_archive


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--sdk', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--embedded', action='store_true')
    args = parser.parse_args()
    folder = worker.fresh(args.output.resolve())
    folder.mkdir(parents=True)
    sdk = args.sdk.resolve()
    resource = folder / 'resources'
    shutil.copytree(sdk / 'kag3/template', resource)
    shutil.copyfile(resource / 'system/Config.~new', resource / 'system/Config.tjs')
    config = resource / 'system/Config.tjs'
    config.write_bytes(b'\xff\xfe' + config.read_bytes().decode('cp932').replace('global.config_version = ""',
                       'global.config_version = "3.32 stable rev. 2"').encode('utf-16-le'))
    # The scene itself records the engine's displayed history and active font.
    (resource / 'scenario/first.ks').write_bytes(b'\xff\xfe' + (
        '[nowait]\nようこそ\n[endnowait]\n[iscript]\n'
        'var proof = [kag.historyLayer.currentLine, kag.fore.messages[0].fontFace];\n'
        'proof.save(System.exePath + "runtime-proof.txt");\n'
        'System.exit();\n[endscript]\n').encode('utf-16-le'))
    font = ROOT / 'local/runtime/fonts/LXGWWenKai-Regular.ttf'
    os.environ['PINHAO_KAG_ADDFONT'] = str(sdk / 'kirikiri2/plugin/addFont.dll')
    game = folder / 'original'
    game.mkdir()
    if args.embedded:
        xp3_archive.pack(game / 'Game.exe', list(worker.files_in(resource)), prefix=(sdk / 'kirikiri2/krkr.eXe').read_bytes())
    else:
        shutil.copyfile(sdk / 'kirikiri2/krkr.eXe', game / 'Game.exe')
        xp3_archive.pack(game / 'data.xp3', list(worker.files_in(resource)))
    before = {rel: worker.digest_file(path) for rel, path in worker.files_in(game)}
    work, built, output = [folder / name for name in ('work', 'built', 'localized')]
    result = worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
    roundtrip = worker.roundtrip({'workspaceDir': str(work)})
    row = next(row for row in result['units'] if 'ようこそ' in row['source'])
    target = row['source'].replace('ようこそ', '欢迎来到拼好汉化')
    worker.build({'workspaceDir': str(work), 'outputDir': str(built), 'translations': [{'id': row['id'], 'translation': target}]})
    assembly = worker.assemble({'gameDir': str(game), 'workspaceDir': str(work), 'buildDir': str(built), 'outputDir': str(output), 'fontPath': str(font)})
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    process = subprocess.Popen([assembly['launchPath']], cwd=output, startupinfo=startup)
    try:
        process.wait(timeout=25)
    except subprocess.TimeoutExpired:
        process.kill(); process.wait()
        raise RuntimeError('KAG neutral runtime did not complete; inspect its engine log')
    assert process.returncode == 0, process.returncode
    proof = (output / 'runtime-proof.txt').read_text(encoding='utf-16')
    assert '欢迎来到拼好汉化' in proof, proof
    assert 'LXGW WenKai' in proof, proof
    assert before == {rel: worker.digest_file(path) for rel, path in worker.files_in(game)}
    report = {'engine': 'KiriKiri2/KAG3', 'archive': 'PEXP3' if args.embedded else 'XP3', 'runtimeExit': process.returncode,
              'roundtrip': roundtrip, 'runtimeProof': proof, 'originalUnchanged': True,
              'font': assembly['font'], 'units': len(result['units'])}
    worker.json_write(folder / 'result.json', report)
    print(json.dumps(report, ensure_ascii=True))


if __name__ == '__main__':
    main()
