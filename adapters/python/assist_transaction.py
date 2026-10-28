"""Rollback only files touched by an optional assistance installation."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile


def sha(path):
    if not path.exists():
        return None
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def atomic_copy(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    handle, name = tempfile.mkstemp(prefix='.pinhao-assist-', dir=target.parent)
    os.close(handle)
    try:
        shutil.copyfile(source, name)
        os.replace(name, target)
    finally:
        Path(name).unlink(missing_ok=True)


class InstallTransaction:
    def __init__(self, root, helpers):
        self.root, self.helpers = Path(root), helpers
        self.directory = None
        self.files = {}
        self.created_dirs = []

    def record(self, target, after):
        target = self.helpers.clean_path(Path(target))
        target.relative_to(self.root)
        if target not in self.files:
            before = sha(target)
            backup = self.directory / str(len(self.files))
            if before is not None:
                shutil.copyfile(target, backup)
                if sha(backup) != before:
                    raise OSError('Assistance rollback copy differs')
            self.files[target] = {'before': before, 'after': before, 'backup': backup}
        record = self.files[target]
        if sha(target) != record['after']:
            raise self.helpers.WorkerError('ASSIST_INSTALL_CONFLICT', 'Assistance files changed during installation')
        record['after'] = after
        self.receipt('installing')
        parent = target.parent
        missing = []
        while not parent.exists():
            missing.append(parent)
            parent = parent.parent
        for parent in reversed(missing):
            parent.mkdir()
            self.created_dirs.append(parent)
        return target

    def receipt(self, state):
        value = {'schema': 'pinhao-assist-rollback-1', 'state': state, 'files': [
            {'file': path.relative_to(self.root).as_posix(), 'before': item['before'], 'after': item['after']}
            for path, item in self.files.items()]}
        (self.directory / 'receipt.json').write_text(json.dumps(value, indent=2), encoding='utf-8')
        return value

    def copy(self, source, target):
        expected = sha(Path(source))
        target = self.record(target, expected)
        atomic_copy(source, target)
        if sha(target) != expected:
            raise OSError('Assistance installed file readback differs')

    def write(self, target, raw):
        staged = self.directory / 'next'
        staged.write_bytes(raw)
        self.copy(staged, target)

    def remove(self, target):
        self.record(target, None).unlink(missing_ok=True)

    def rollback(self):
        if self.directory is None:
            return {'schema': 'pinhao-assist-rollback-1', 'state': 'restored', 'files': []}
        for target, item in reversed(list(self.files.items())):
            current = sha(target)
            if current not in (item['before'], item['after']):
                raise self.helpers.WorkerError('ASSIST_INSTALL_RECOVERY_REQUIRED', 'An assistance file changed; preserve the recovery directory: ' + str(self.directory))
            if current != item['before']:
                if item['before'] is None:
                    target.unlink(missing_ok=True)
                else:
                    atomic_copy(item['backup'], target)
            if sha(target) != item['before']:
                raise OSError('Assistance rollback readback differs')
        for directory in reversed(self.created_dirs):
            directory.rmdir()
        return self.receipt('restored')

    def run(self, action):
        try:
            self.directory = Path(tempfile.mkdtemp(prefix='pinhao-assist-rollback-'))
            result = action(self)
        except Exception as error:
            try:
                proof = self.rollback()
            except Exception as recovery:
                raise self.helpers.WorkerError('ASSIST_INSTALL_RECOVERY_REQUIRED', 'Assistance recovery needs attention; preserve: ' + str(self.directory)) from recovery
            if self.directory is not None:
                shutil.rmtree(self.directory)
            return {'supported': False, 'status': 'install_failed', 'restored': True,
                    'detail': '游玩辅助安装未完成，本次触及的文件已恢复并核对；可不启用辅助继续游玩。',
                    'installationError': {'code': getattr(error, 'code', type(error).__name__), 'message': str(error)},
                    'recovery': proof}
        else:
            shutil.rmtree(self.directory)
            return {**result, 'status': 'installed' if result.get('supported') else 'unsupported'}
