"""Transactional installation and exact restoration of the RGSS bootstrap."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import tempfile
import zlib

from ruby_marshal import Reader, RString


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def atomic_write(path, raw):
    handle, name = tempfile.mkstemp(prefix='.pinhao-', dir=path.parent)
    try:
        with os.fdopen(handle, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def load_receipt(root, host):
    directory = host.clean_path(root / '.pinhao-assist-install')
    receipt = host.clean_path(directory / 'receipt.json')
    if not directory.exists():
        return directory, None
    try:
        value = json.loads(receipt.read_text(encoding='utf-8'))
        if value['schema'] != 'pinhao-rgss-assist-v1':
            raise ValueError()
        host.safe_member(value['scripts'])
        if value['scripts'] not in ('Data/Scripts.rxdata', 'Data/Scripts.rvdata', 'Data/Scripts.rvdata2'):
            raise ValueError()
    except (OSError, ValueError, KeyError):
        raise host.WorkerError('ASSIST_BACKUP_CONFLICT', 'Preserve the assistance backup and choose a fresh game build')
    return directory, value


def original_files(directory, receipt, host):
    originals = {}
    for name in ('scripts', 'ruby'):
        record = receipt[name + 'Backup']
        path = host.clean_path(directory / (name + '.original'))
        raw = path.read_bytes() if record is not None else None
        if raw is not None and digest(raw) != record:
            raise host.WorkerError('ASSIST_BACKUP_CHANGED', 'The assistance backup changed; preserve this build for recovery')
        originals[name] = raw
    return originals


def restore(paths, originals):
    for name, path in paths.items():
        if originals[name] is None:
            path.unlink(missing_ok=True)
        else:
            atomic_write(path, originals[name])
        actual = path.read_bytes() if path.exists() else None
        if actual != originals[name]:
            raise OSError('Assistance restoration readback differs')


def install(root, scripts, engine, host):
    target = host.clean_path(root / 'PinHaoAssist.rb')
    directory, receipt = load_receipt(root, host)
    before = scripts.read_bytes()
    ruby = target.read_bytes() if target.exists() else None
    source = (Path(__file__).parent / 'templates/assist.rb').read_text(encoding='utf-8').replace('__PINHAO_ENGINE__', engine).encode('utf-8')
    if receipt:
        originals = original_files(directory, receipt, host)
        if receipt['state'] == 'installing':
            for name, raw in (('scripts', before), ('ruby', ruby)):
                allowed = {receipt[name + 'Backup'], receipt[name + 'Installed'], receipt.get(name + 'Previous')}
                if (digest(raw) if raw is not None else None) not in allowed:
                    raise host.WorkerError('ASSIST_INSTALL_CONFLICT', 'Game scripts changed during assistance installation; preserve this build')
            restore({'scripts': scripts, 'ruby': target}, originals)
            before, ruby = originals['scripts'], originals['ruby']
        elif receipt['state'] == 'removed':
            if digest(before) != receipt['scriptsBackup'] or (digest(ruby) if ruby is not None else None) != receipt['rubyBackup']:
                raise host.WorkerError('ASSIST_INSTALL_CONFLICT', 'Game scripts changed after assistance restoration; choose a fresh build')
        elif digest(before) != receipt['scriptsInstalled'] or ruby is None or digest(ruby) != receipt['rubyInstalled']:
            raise host.WorkerError('ASSIST_INSTALL_CONFLICT', 'Game scripts changed after assistance installation; preserve the edits before restoring assistance')
        elif ruby == source:
            return {'supported': True, 'engine': engine, 'transport': 'file'}
    elif ruby is not None and b'module PinHaoAssist' not in ruby:
        raise host.WorkerError('ASSIST_INSTALL_CONFLICT', 'A different PinHaoAssist.rb exists; preserve it before installing assistance')
    reader = Reader(before)
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
        raise host.WorkerError('SCRIPT_SLOT', 'No executable RGSS script slot found')
    _, value, text = next((row for row in reversed(candidates) if row[0].strip().lower() == 'main'), candidates[-1])
    bootstrap = host.rgss_bootstrap('PinHaoAssist.rb')
    old_prefixes = (bootstrap, b"load 'PinHaoAssist.rb'\n", b"load './PinHaoAssist.rb'\n", b"load File.expand_path('PinHaoAssist.rb')\n")
    had_bootstrap = False
    for previous in old_prefixes:
        if text.startswith(previous):
            had_bootstrap = True
            text = text[len(previous):]
            break
    installed = host.patch_raw_strings(reader, {value.index: zlib.compress(bootstrap + text)})
    if not receipt:
        # Migrate previous installs to a removable bootstrap while retaining every other script.
        clean = host.patch_raw_strings(reader, {value.index: zlib.compress(text)}) if had_bootstrap else before
        originals = {'scripts': clean, 'ruby': None if ruby and b'module PinHaoAssist' in ruby else ruby}
        directory.mkdir()
        if had_bootstrap:
            atomic_write(directory / 'scripts.legacy', before)
            if ruby is not None:
                atomic_write(directory / 'ruby.legacy', ruby)
        for name, raw in originals.items():
            if raw is not None:
                atomic_write(directory / (name + '.original'), raw)
        receipt = {'schema': 'pinhao-rgss-assist-v1', 'scripts': scripts.relative_to(root).as_posix(),
                   'scriptsBackup': digest(originals['scripts']), 'rubyBackup': digest(originals['ruby']) if originals['ruby'] is not None else None}
    receipt.update(state='installing', scriptsInstalled=digest(installed), rubyInstalled=digest(source),
                   scriptsPrevious=digest(before), rubyPrevious=digest(ruby) if ruby is not None else None)
    atomic_write(directory / 'receipt.json', json.dumps(receipt, indent=2).encode('utf-8'))
    try:
        atomic_write(target, source)
        atomic_write(scripts, installed)
        receipt['state'] = 'installed'
        atomic_write(directory / 'receipt.json', json.dumps(receipt, indent=2).encode('utf-8'))
    except Exception as error:
        try:
            for path, original, applied in ((scripts, before, installed), (target, ruby, source)):
                current = path.read_bytes() if path.exists() else None
                if current not in (original, applied):
                    raise host.WorkerError('ASSIST_INSTALL_RECOVERY_REQUIRED', 'An assistance file changed; preserve the installation record')
            restore({'scripts': scripts, 'ruby': target}, {'scripts': before, 'ruby': ruby})
        except Exception as recovery:
            raise host.WorkerError('ASSIST_INSTALL_RECOVERY_REQUIRED', 'Assistance recovery needs attention; preserve the build and .pinhao-assist-install record') from recovery
        return {'supported': False, 'status': 'install_failed', 'restored': True,
                'detail': '游玩辅助安装未完成，本次触及的文件已恢复并核对；可不启用辅助继续游玩。',
                'installationError': {'code': getattr(error, 'code', type(error).__name__), 'message': str(error)},
                'recovery': {'schema': 'pinhao-rgss-assist-v1', 'state': 'restored', 'files': [
                    {'file': scripts.relative_to(root).as_posix(), 'before': digest(before)},
                    {'file': 'PinHaoAssist.rb', 'before': digest(ruby) if ruby is not None else None}]}}
    return {'supported': True, 'engine': engine, 'transport': 'file'}


def uninstall(args, host):
    root = host.path_arg(args, 'outputDir')
    directory, receipt = load_receipt(root, host)
    if receipt is None:
        return {'removed': False, 'reason': 'installation_record_missing'}
    scripts, target = host.clean_path(root / receipt['scripts']), host.clean_path(root / 'PinHaoAssist.rb')
    originals = original_files(directory, receipt, host)
    if receipt['state'] == 'removed':
        return {'removed': True, 'restored': True}
    if host.digest_file(scripts) != receipt['scriptsInstalled'] or not target.is_file() or host.digest_file(target) != receipt['rubyInstalled']:
        raise host.WorkerError('ASSIST_INSTALL_CONFLICT', 'Game scripts changed after assistance installation; preserve the edits before restoring assistance')
    current = {'scripts': scripts.read_bytes(), 'ruby': target.read_bytes()}
    try:
        restore({'scripts': scripts, 'ruby': target}, originals)
        receipt['state'] = 'removed'
        atomic_write(directory / 'receipt.json', json.dumps(receipt, indent=2).encode('utf-8'))
    except Exception:
        restore({'scripts': scripts, 'ruby': target}, current)
        raise
    return {'removed': True, 'restored': True}
