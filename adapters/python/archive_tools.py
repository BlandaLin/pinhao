"""Managed, repeatable archive transforms for the technical Agent."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import struct
import tempfile
import zipfile

import godot_native
import asar_native
import xp3_archive
from rgss_archive import archive_entries, advance, destination, take

VERSION = 'pinhao-archive-tools-v2'


def inventory(root, host):
    return [{'path': name, 'size': path.stat().st_size, 'sha256': host.digest_file(path)}
            for name, path in host.files_in(root)]


def kind_for(path, requested=None):
    kind = str(requested or Path(path).suffix).lower().lstrip('.')
    return {'rgssad': 'rgss', 'rgss2a': 'rgss', 'rgss3a': 'rgss'}.get(kind, kind)


def receipt_path(output):
    return output.with_name(output.name + '.pinhao-archive.json')


def reusable(output, identity, host, directory):
    receipt = receipt_path(output)
    if not output.exists() and not receipt.exists():
        return None
    host.clean_path(receipt)
    try:
        saved = json.loads(receipt.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise host.WorkerError('ARTIFACT_CONFLICT', 'Choose an empty archive tool output location')
    if saved.get('identity') != identity:
        raise host.WorkerError('ARTIFACT_CONFLICT', 'Archive tool inputs changed; choose a new output location')
    actual = inventory(output, host) if directory else host.digest_file(output)
    if actual != saved.get('content'):
        raise host.WorkerError('ARTIFACT_CHANGED', 'Archive tool output changed; preserve it and choose a new output location')
    return {**saved['result'], 'reused': True}


def publish_receipt(output, identity, content, result, host):
    receipt = receipt_path(output)
    temporary = receipt.with_suffix('.tmp')
    host.json_write(temporary, {'identity': identity, 'content': content, 'result': result})
    os.replace(temporary, receipt)


def unpack_to(source, output, kind, host, *, names=None):
    if kind == 'zip':
        return host.unzip_command({'filePath': str(source), 'outputDir': str(output), **({'files': list(names)} if names is not None else {})})
    if kind == 'xp3':
        return xp3_archive.unpack(source, output, host, names=names)
    if kind == 'rgss':
        # Every member is needed for a complete container, including graphics and audio.
        _, entries = archive_entries(source)
        requested = None if names is None else set(names)
        if requested is not None and requested - {entry[0] for entry in entries}:
            raise host.WorkerError('ARCHIVE_MEMBER_MISSING', 'Requested RGSS member is missing')
        for name, *_ in entries:
            host.safe_member(name)
        output.mkdir(parents=True)
        with source.open('rb') as stream:
            for name, offset, remaining, key in entries:
                if requested is not None and name not in requested:
                    continue
                target = destination(output, name)
                target.parent.mkdir(parents=True, exist_ok=True)
                stream.seek(offset)
                with target.open('xb') as writer:
                    while remaining:
                        block = bytearray(take(stream, min(65536, remaining)))
                        for index in range(0, len(block), 4):
                            for shift in range(min(4, len(block) - index)):
                                block[index + shift] ^= (key >> (8 * shift)) & 255
                            key = advance(key)
                        writer.write(block)
                        remaining -= len(block)
        return entries
    if kind == 'pck':
        return godot_native.unpack(source, output, host, names=names)
    if kind == 'asar':
        return asar_native.unpack(source, output, host, names=names)
    raise host.WorkerError('UNSUPPORTED_ARCHIVE', 'Choose a ZIP, XP3, RGSS or Godot PCK archive')


def unpack(args, host):
    source = host.path_arg(args, 'archive', 'filePath', 'sourcePath')
    output = host.path_arg(args, 'outputDir', 'outDir')
    kind = kind_for(source, args.get('format'))
    identity = {'tool': VERSION, 'operation': 'unpack', 'format': kind, 'archiveHash': host.digest_file(source)}
    selected = args.get('files')
    if selected is not None:
        if not isinstance(selected, list) or not selected or any(not isinstance(name, str) for name in selected):
            raise host.WorkerError('INVALID_ARGUMENT', 'Selected archive members need relative file paths')
        selected = sorted({host.safe_member(name) for name in selected})
        if len({name.casefold() for name in selected}) != len(selected):
            raise host.WorkerError('PATH_COLLISION', 'Selected archive members collide on Windows')
        identity['selectedFiles'] = selected
    if kind == 'asar':
        requested = None if selected is None else set(selected)
        identity['unpackedFiles'] = {name: host.digest_file(host.clean_path(destination(Path(str(source) + '.unpacked'), name)))
                                    for name, offset, _ in asar_native.index(source)
                                    if offset is None and (requested is None or name in requested)}
    prior = reusable(output, identity, host, True)
    if prior:
        return prior
    host.fresh(output, (source,))
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.pinhao-unpack-', dir=output.parent) as temporary:
        staged = Path(temporary) / 'members'
        opaque = []
        if kind == 'xp3':
            _, entries = xp3_archive.index(source)
            requested = {entry.name for entry in entries} if selected is None else set(selected)
            if requested - {entry.name for entry in entries}:
                raise host.WorkerError('ARCHIVE_MEMBER_MISSING', 'Requested XP3 member is missing')
            opaque = [{'path': entry.name, 'size': entry.size, 'adler32': entry.checksum,
                       'disposition': 'retained-in-original-archive'}
                      for entry in entries if entry.name in requested and not xp3_archive.filesystem_member(entry.name)]
            selected = sorted(requested - {row['path'] for row in opaque})
        unpack_to(source, staged, kind, host, names=selected)
        members = inventory(staged, host)
        os.replace(staged, output)
    result = {'format': kind, 'outputDir': str(output), 'archiveHash': identity['archiveHash'],
              'members': members, 'files': len(members), 'toolVersion': VERSION, 'reused': False}
    if kind == 'xp3':
        result.update({'opaqueMembers': opaque, 'archiveMembers': len(entries),
                       'completeFilesystemView': not opaque and len(members) == len(entries)})
    publish_receipt(output, identity, members, result, host)
    return result


def pack_rgss(source, output, host):
    entries = list(host.files_in(source))
    with output.open('xb') as stream:
        stream.write(b'RGSSAD\0\x01')
        key = 0xDEADCAFE
        for name, path in entries:
            encoded = host.safe_member(name).encode('utf-8')
            stream.write(struct.pack('<I', len(encoded) ^ key))
            key = advance(key)
            scrambled = bytearray(encoded)
            for index in range(len(scrambled)):
                scrambled[index] ^= key & 255
                key = advance(key)
            stream.write(scrambled)
            stream.write(struct.pack('<I', path.stat().st_size ^ key))
            key = advance(key)
            payload_key = key
            with path.open('rb') as reader:
                while data := reader.read(65536):
                    block = bytearray(data)
                    for index in range(0, len(block), 4):
                        for offset in range(min(4, len(block) - index)):
                            block[index + offset] ^= (payload_key >> (8 * offset)) & 255
                        payload_key = advance(payload_key)
                    stream.write(block)


def pack_to(source, output, kind, original, host):
    if kind == 'zip':
        with zipfile.ZipFile(output, 'x', zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
            for name, path in host.files_in(source):
                archive.write(path, host.safe_member(name))
    elif kind == 'rgss':
        if original and archive_entries(original)[0] != 1:
            raise host.WorkerError('REPACK_UNSUPPORTED', 'RGSS version 1 supports native repacking; retain the original version 3 archive')
        pack_rgss(source, output, host)
    elif kind == 'xp3':
        prefix = b''
        if original:
            start, _ = xp3_archive.index(original)
            with original.open('rb') as stream:
                prefix = stream.read(start)
        xp3_archive.pack(output, host.files_in(source), prefix=prefix)
    elif kind == 'pck':
        if not original:
            raise host.WorkerError('REPACK_REFERENCE', 'Choose the original PCK to preserve its format and engine version')
        index = godot_native.pack_index(original, host.safe_member)
        executable = godot_native.executable(host.ROOT)
        if not executable:
            raise host.WorkerError('CODEC_MISSING', 'Prepare the fixed Godot resource tools')
        godot_native.run(executable, ['--pck-create=' + str(source), '--output=' + str(output),
                                     '--pck-version=' + str(index['format']),
                                     '--pck-engine-version=' + '.'.join(map(str, index['version']))])
    else:
        raise host.WorkerError('UNSUPPORTED_ARCHIVE', 'Choose ZIP, XP3, RGSS version 1 or Godot PCK')


def repack(args, host):
    source = host.path_arg(args, 'inputDir', 'sourceDir')
    output = host.path_arg(args, 'outputFile', 'filePath')
    original = host.path_arg(args, 'originalArchive', 'reference') if args.get('originalArchive') or args.get('reference') else None
    kind = kind_for(output, args.get('format'))
    incoming = inventory(source, host)
    identity = {'tool': VERSION, 'operation': 'repack', 'format': kind, 'members': incoming,
                'originalHash': host.digest_file(original) if original else None}
    prior = reusable(output, identity, host, False)
    if prior:
        return prior
    host.fresh(output, (source, *([original] if original else [])))
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.pinhao-repack-', dir=output.parent) as temporary:
        root = Path(temporary)
        members_root = root / 'members'
        staged = root / ('archive.' + ('rgssad' if kind == 'rgss' else kind))
        if kind == 'xp3' and original:
            # Original payloads stay in their carrier; only changed members are copied.
            baseline = {row['path']: row for row in xp3_archive.member_inventory(original)}
            expected_by_name = {**baseline, **{row['path']: row for row in incoming}}
            files = dict(host.files_in(source))
            replacements = {name: path for name, path in files.items()
                            if name in baseline and baseline[name] != expected_by_name[name]}
            additions = {name: path for name, path in files.items() if name not in baseline}
            xp3_archive.repack(original, staged, replacements, additions=additions)
            expected = sorted(expected_by_name.values(), key=lambda row: row['path'])
            if xp3_archive.member_inventory(staged) != expected:
                raise host.WorkerError('ARCHIVE_READBACK', 'Repacked XP3 member readback differs from the complete resource set')
            os.replace(staged, output)
        else:
            if original:
                unpack_to(original, members_root, kind, host)
            else:
                members_root.mkdir()
            for name, path in host.files_in(source):
                target = destination(members_root, host.safe_member(name))
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, target)
            expected = inventory(members_root, host)
            pack_to(members_root, staged, kind, original, host)
            checked = root / 'checked'
            unpack_to(staged, checked, kind, host)
            if inventory(checked, host) != expected:
                raise host.WorkerError('ARCHIVE_READBACK', 'Repacked archive member readback differs from the complete resource set')
            os.replace(staged, output)
    sha256 = host.digest_file(output)
    result = {'format': kind, 'outputFile': str(output), 'filePath': str(output), 'sha256': sha256,
              'members': expected, 'files': len(expected), 'memberReadback': True, 'toolVersion': VERSION, 'reused': False}
    publish_receipt(output, identity, sha256, result, host)
    return result
