"""Durable native investigation evidence, separate from a verified text workbench."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import uuid


def filesystem_path(path):
    """Keep logical artifact names portable while Windows I/O supports deep workspaces."""
    if os.name != 'nt':
        return Path(path)
    value = os.path.abspath(path)
    if not value.startswith('\\\\?\\'):
        value = '\\\\?\\UNC\\' + value[2:] if value.startswith('\\\\') else '\\\\?\\' + value
    return Path(value)


class NativeAttempt:
    def __init__(self, work, engine, helpers, codec):
        self.helpers = helpers
        self.work = Path(work)
        self.id = 'native-attempt-' + str(uuid.uuid4())
        self.root = helpers.clean_path(self.work.parent / (self.work.name + '-native-attempts') / self.id)
        filesystem_path(self.root).mkdir(parents=True)
        self.resources = {}
        self.document = {'protocol': 'pinhao-native-attempt-1', 'attemptId': self.id,
                         'engine': engine, 'phase': 'extract', 'status': 'running',
                         'codec': codec, 'resources': [], 'logs': [], 'resourceEvents': 'resource-events.jsonl'}
        self.save()

    def save(self):
        self.document['resources'] = list(self.resources.values())
        target = self.root / 'attempt.json'
        temporary = target.with_suffix('.json.tmp')
        filesystem_path(temporary).write_text(json.dumps(self.document, ensure_ascii=False, allow_nan=False), encoding='utf-8')
        filesystem_path(temporary).replace(filesystem_path(target))

    def resource(self, key, **fields):
        self.resources[key] = {**self.resources.get(key, {'resourceId': key}), **fields}
        # Large packs append progress instead of rewriting the complete member table per item.
        with filesystem_path(self.root / 'resource-events.jsonl').open('a', encoding='utf-8') as stream:
            stream.write(json.dumps(self.resources[key], ensure_ascii=False, allow_nan=False) + '\n')

    def log(self, name, value):
        # Names are adapter-owned labels, never resource paths from a game archive.
        if Path(name).name != name or name in ('.', '..'):
            raise ValueError('Invalid native diagnostic log name')
        raw = value if isinstance(value, bytes) else str(value).encode('utf-8')
        filesystem_path(self.root / name).write_bytes(raw)
        self.document['logs'].append({'file': name, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)})
        self.save()

    def material(self, key, text):
        name = 'material-' + hashlib.sha256(key.encode()).hexdigest() + '.rpy'
        raw = text.encode('utf-8')
        filesystem_path(self.root / name).write_bytes(raw)
        return {'file': name, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}

    def recovered_files(self, source):
        source = Path(source)
        if not source.is_dir():
            return
        for rel, path in self.helpers.files_in(source):
            if path.suffix.lower() not in ('.gd', '.tscn', '.tres', '.json', '.godot', '.cfg'):
                continue
            target = self.root / 'recovered' / rel
            filesystem_path(target.parent).mkdir(parents=True, exist_ok=True)
            raw = filesystem_path(path).read_bytes()
            filesystem_path(target).write_bytes(raw)
            self.resource('recovered:' + rel, file=rel, phase='recover', status='extracted_unverified',
                          material={'file': target.relative_to(self.root).as_posix(),
                                    'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)})

    def finish(self, status):
        self.document['status'] = status
        journal = self.root / 'resource-events.jsonl'
        if filesystem_path(journal).is_file():
            self.document['logs'].append({'file': journal.name, 'sha256': self.helpers.digest_file(filesystem_path(journal)),
                                          'bytes': filesystem_path(journal).stat().st_size})
        self.save()
        return {'attemptId': self.id, 'status': status, 'artifacts': [{
            'artifactId': self.id, 'kind': 'native-attempt',
            'relativePath': self.root.relative_to(self.work.parent).as_posix(),
            'sha256': self.helpers.digest_file(filesystem_path(self.root / 'attempt.json'))}]}

    def fail(self, error, phase='extract'):
        self.document['phase'] = phase
        self.document['error'] = {'code': getattr(error, 'code', None) or 'NATIVE_WORKER_ERROR', 'message': str(error)}
        result = self.finish('partial' if any(row.get('status') == 'extracted_unverified' for row in self.resources.values()) else 'failed')
        error.attemptId = self.id
        error.artifacts = result['artifacts']
        if not getattr(error, 'diagnostic', None):
            error.diagnostic = {'category': 'native', 'phase': phase, 'engine': self.document['engine']}


def recovered_script(path, cache_dir, decompile, codec):
    """Cache only successful decoding, keyed by input bytes and exact decoder identity."""
    path, cache_dir = Path(path), Path(cache_dir)
    raw_hash = hashlib.sha256(filesystem_path(path).read_bytes()).hexdigest()
    key = hashlib.sha256((codec + '\0' + raw_hash).encode()).hexdigest()
    target = cache_dir / (key + '.json')
    try:
        cached = json.loads(filesystem_path(target).read_text(encoding='utf-8'))
        if (cached.get('inputSha256') == raw_hash and cached.get('codec') == codec
                and hashlib.sha256(cached['text'].encode('utf-8')).hexdigest() == cached['textSha256']):
            return cached['text'], cached['metadata'], cached['warnings'], True, raw_hash
    except FileNotFoundError:
        pass
    text, metadata, warnings = decompile(path)
    filesystem_path(cache_dir).mkdir(parents=True, exist_ok=True)
    cached = {'inputSha256': raw_hash, 'codec': codec, 'text': text, 'metadata': {'version': metadata.get('version')},
              'warnings': [str(item) for item in warnings], 'textSha256': hashlib.sha256(text.encode('utf-8')).hexdigest()}
    temporary = target.with_name(target.name + '.' + str(uuid.uuid4()) + '.tmp')
    filesystem_path(temporary).write_text(json.dumps(cached, ensure_ascii=False, allow_nan=False), encoding='utf-8')
    filesystem_path(temporary).replace(filesystem_path(target))
    return text, metadata, warnings, False, raw_hash
