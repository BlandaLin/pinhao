"""Checked PNG overlays are applied before native resource-container assembly."""
from pathlib import Path
import re
import shutil

from rgss_archive import destination


def entries(args, helpers):
    rows = args.get('assetOverlayFiles', [])
    if not rows:
        return []
    root = helpers.path_arg(args, 'assetOverlayDir')
    planned, seen = [], set()
    for row in rows:
        name = helpers.safe_member(row['file'])
        if Path(name).suffix.lower() != '.png' or name.casefold() in seen:
            raise helpers.WorkerError('ASSET_OVERLAY', 'Native image overlay needs unique PNG resources')
        seen.add(name.casefold())
        if row.get('sourceHash') is not None and not re.fullmatch(r'[0-9a-f]{64}', row['sourceHash'] if isinstance(row['sourceHash'], str) else ''):
            raise helpers.WorkerError('ASSET_OVERLAY', 'Native image overlay has an invalid source baseline: ' + name)
        path = helpers.clean_path(destination(root, name))
        if not path.is_file() or helpers.digest_file(path) != row['sha256']:
            raise helpers.WorkerError('ASSET_OVERLAY', 'Native image overlay changed: ' + name)
        with path.open('rb') as stream:
            if stream.read(8) != b'\x89PNG\r\n\x1a\n':
                raise helpers.WorkerError('ASSET_OVERLAY', 'Native image overlay is not a PNG: ' + name)
        planned.append((name, path))
    return planned


def check_baseline(args, name, digest, helpers):
    expected = next((row.get('sourceHash') for row in args.get('assetOverlayFiles', []) if row['file'] == name), None)
    if expected is not None and digest != expected:
        raise helpers.WorkerError('ASSET_OVERLAY', 'Original image resource changed since OCR: ' + name)


def apply(root, args, helpers, inventory):
    planned = entries(args, helpers)
    targets = []
    for name, source in planned:
        target = helpers.clean_path(destination(root, name))
        if not target.is_file():
            raise helpers.WorkerError('ASSET_OVERLAY', 'Original image resource is missing: ' + name)
        check_baseline(args, name, helpers.digest_file(target), helpers)
        targets.append((source, target))
    for source, target in targets:
        shutil.copyfile(source, target)
    if planned:
        inventory['imageFiles'] = len(planned)


def for_resource_root(args, prefix, helpers):
    if prefix in ('', '.') or not args.get('assetOverlayFiles'):
        return args
    prefix = helpers.safe_member(prefix).rstrip('/')
    rows = []
    for row in args['assetOverlayFiles']:
        name = helpers.safe_member(row['file'])
        if not name.startswith(prefix + '/'):
            raise helpers.WorkerError('ASSET_OVERLAY', 'Image overlay belongs to a different resource root')
        rows.append({**row, 'file': name[len(prefix) + 1:]})
    return {**args, 'assetOverlayDir': str(destination(helpers.path_arg(args, 'assetOverlayDir'), prefix)), 'assetOverlayFiles': rows}
