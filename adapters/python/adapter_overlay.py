"""Verified text overlays enter native assembly after its immutable build stage."""
import json
from pathlib import Path
import re
import shutil

from rgss_archive import destination


TEXT_EXTENSIONS = {'.json', '.gd', '.tscn', '.tres', '.csv', '.txt', '.ks', '.tjs',
                   '.rpy', '.js', '.mjs', '.cjs', '.html', '.htm', '.css', '.po',
                   '.cfg', '.ini', '.xml', '.yaml', '.yml', '.twee', '.tw', '.rb',
                   '.gdshader', '.shader'}
HASH = re.compile(r'[0-9a-f]{64}')


def text_bytes(data, name, helpers):
    codecs = ['utf-16'] if data.startswith((b'\xff\xfe', b'\xfe\xff')) else ['utf-8-sig', 'cp932']
    text = None
    for codec in codecs:
        try:
            text = data.decode(codec)
            break
        except UnicodeError:
            continue
    if text is None or any(ord(char) < 32 and char not in '\t\r\n' for char in text):
        raise helpers.WorkerError('ADAPTER_OVERLAY', 'Adapter overlay requires a text resource: ' + name)
    if Path(name).suffix.lower() == '.json':
        try:
            json.loads(text)
        except (ValueError, RecursionError) as error:
            raise helpers.WorkerError('ADAPTER_OVERLAY', 'Adapter overlay JSON is invalid: ' + name) from error


def entries(args, helpers):
    rows = args.get('adapterOverlayFiles', [])
    if not isinstance(rows, list):
        raise helpers.WorkerError('ADAPTER_OVERLAY', 'Adapter overlays require resource records')
    if not rows:
        return []
    root = helpers.clean_path(helpers.path_arg(args, 'adapterOverlayDir'))
    planned, seen = [], set()
    for row in rows:
        if (not isinstance(row, dict) or set(row) != {'file', 'sha256', 'sourceHash'}
                or not isinstance(row['file'], str)
                or any(not isinstance(row[key], str) or not HASH.fullmatch(row[key]) for key in ('sha256', 'sourceHash'))):
            raise helpers.WorkerError('ADAPTER_OVERLAY', 'Adapter overlay needs file, sha256 and sourceHash')
        name = helpers.safe_member(row['file'])
        if Path(name).suffix.lower() not in TEXT_EXTENSIONS or name.casefold() in seen:
            raise helpers.WorkerError('ADAPTER_OVERLAY', 'Adapter overlay needs unique supported text resources')
        seen.add(name.casefold())
        path = helpers.clean_path(destination(root, name))
        if not path.is_file() or helpers.digest_file(path) != row['sha256']:
            raise helpers.WorkerError('ADAPTER_OVERLAY', 'Adapter overlay changed: ' + name)
        text_bytes(path.read_bytes(), name, helpers)
        planned.append((name, path))
    return planned


def check_baseline(args, name, digest, helpers):
    expected = next((row['sourceHash'] for row in args.get('adapterOverlayFiles', [])
                     if helpers.safe_member(row['file']) == name), None)
    if expected is None or digest != expected:
        raise helpers.WorkerError('ADAPTER_OVERLAY', 'Current native resource differs from the adapter baseline: ' + name)


def apply(root, args, helpers, inventory, baseline_root=None, allow_recovered_source=False):
    """sourceHash describes native-built logical bytes, then the current staged resource."""
    planned = entries(args, helpers)
    targets = []
    for name, source in planned:
        target = helpers.clean_path(destination(root, name))
        native = helpers.clean_path(destination(baseline_root, name)) if baseline_root else None
        baseline = native if native and native.is_file() else target
        if not baseline.is_file() or not target.is_file() and not allow_recovered_source:
            raise helpers.WorkerError('ADAPTER_OVERLAY', 'Current native text resource is missing: ' + name)
        if native and native.is_file() and target == native:
            raise helpers.WorkerError('ADAPTER_OVERLAY', 'Adapter overlay requires an independent native assembly')
        digest = helpers.digest_file(baseline)
        check_baseline(args, name, digest, helpers)
        if target.is_file() and helpers.digest_file(target) != digest:
            raise helpers.WorkerError('ADAPTER_OVERLAY', 'Native assembly resource changed before adapter overlay: ' + name)
        targets.append((source, target))
    for source, target in targets:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        name = target.relative_to(root).as_posix()
        expected = next(row['sha256'] for row in args['adapterOverlayFiles']
                        if helpers.safe_member(row['file']) == name)
        if helpers.digest_file(target) != expected:
            raise helpers.WorkerError('ADAPTER_OVERLAY', 'Adapter overlay changed during assembly: ' + name)
    if planned:
        inventory['adapterFiles'] = len(planned)
    return [name for name, _ in planned]
