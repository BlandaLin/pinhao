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
from native_attempt import filesystem_path
from rgss_archive import archive_entries, advance, destination, take

VERSION = 'pinhao-archive-tools-v3'


def inventory(root, host):
    return [{'path': name, 'size': filesystem_path(path).stat().st_size, 'sha256': host.digest_file(path)}
            for name, path in host.files_in(root)]


def kind_for(path, requested=None):
    kind = str(requested or Path(path).suffix).lower().lstrip('.')
    return {'rgssad': 'rgss', 'rgss2a': 'rgss', 'rgss3a': 'rgss'}.get(kind, kind)


def receipt_path(output):
    return output.with_name(output.name + '.pinhao-archive.json')


def reusable(output, identity, host, directory):
    receipt = receipt_path(output)
    if not filesystem_path(output).exists() and not filesystem_path(receipt).exists():
        return None
    host.clean_path(receipt)
    try:
        saved = json.loads(filesystem_path(receipt).read_text(encoding='utf-8'))
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
    os.replace(filesystem_path(temporary), filesystem_path(receipt))


def archive_directory(source, kind, host):
    """Read directory metadata without expanding or hashing member payloads."""
    path = filesystem_path(source)
    details = {}
    if kind == 'zip':
        with zipfile.ZipFile(path) as archive:
            rows = [{'path': host.safe_member(entry.filename), 'size': entry.file_size,
                     'storedSize': entry.compress_size, 'crc32': entry.CRC}
                    for entry in archive.infolist() if not entry.is_dir()]
    elif kind == 'xp3':
        _, entries = xp3_archive.index(path)
        rows = [{'path': entry.name, 'size': entry.size, 'adler32': entry.checksum,
                 'storedSize': sum(segment[3] for segment in entry.segments)} for entry in entries]
    elif kind == 'rgss':
        version, entries = archive_entries(path)
        details['archiveVersion'] = version
        rows = [{'path': name, 'size': size} for name, _, size, _ in entries]
    elif kind == 'pck':
        directory = godot_native.pack_index(path, host.safe_member)
        details.update(archiveVersion=directory['format'], engineVersion=directory['version'])
        rows = [{'path': entry['file'], 'size': entry['bytes'], 'md5': entry['md5']}
                for entry in directory['entries']]
    elif kind == 'asar':
        rows = [{'path': name, 'size': size, 'unpacked': offset is None}
                for name, offset, size in asar_native.index(path)]
    else:
        raise host.WorkerError('UNSUPPORTED_ARCHIVE', 'Choose ZIP, XP3, RGSS, Godot PCK or ASAR')
    if len({row['path'].casefold() for row in rows}) != len(rows):
        raise host.WorkerError('PATH_COLLISION', 'Archive members collide on Windows')
    for row in rows:
        row['materializable'] = xp3_archive.filesystem_member(row['path'])
        row['disposition'] = 'available' if row['materializable'] else 'retained-in-original-archive'
    return {'format': kind, 'archiveHash': host.digest_file(source), 'members': sorted(rows, key=lambda row: row['path']),
            'archiveMembers': len(rows), 'toolVersion': VERSION, **details,
            'capabilities': {'index': True, 'select': True,
                             'repack': kind in ('zip', 'xp3', 'pck') or kind == 'rgss' and details['archiveVersion'] == 1,
                             'repackRequiresOriginal': True, 'outputMode': 'members-only' if kind == 'asar' else 'archive',
                             'requiresFixedCodecForRepack': kind == 'pck'}}


def unpack_to(source, output, kind, host, *, names=None):
    if kind == 'zip':
        return host.unzip_command({'filePath': str(source), 'outputDir': str(output), **({'files': list(names)} if names is not None else {})})
    if kind == 'xp3':
        return xp3_archive.unpack(filesystem_path(source), filesystem_path(output), host, names=names)
    if kind == 'rgss':
        # Every member is needed for a complete container, including graphics and audio.
        _, entries = archive_entries(filesystem_path(source))
        requested = None if names is None else set(names)
        if requested is not None and requested - {entry[0] for entry in entries}:
            raise host.WorkerError('ARCHIVE_MEMBER_MISSING', 'Requested RGSS member is missing')
        for name, *_ in entries:
            host.safe_member(name)
        filesystem_path(output).mkdir(parents=True)
        with filesystem_path(source).open('rb') as stream:
            for name, offset, remaining, key in entries:
                if requested is not None and name not in requested:
                    continue
                target = destination(output, name)
                filesystem_path(target.parent).mkdir(parents=True, exist_ok=True)
                stream.seek(offset)
                with filesystem_path(target).open('xb') as writer:
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
        return godot_native.unpack(filesystem_path(source), filesystem_path(output), host, names=names)
    if kind == 'asar':
        return asar_native.unpack(filesystem_path(source), filesystem_path(output), host, names=names)
    raise host.WorkerError('UNSUPPORTED_ARCHIVE', 'Choose a ZIP, XP3, RGSS or Godot PCK archive')


def unpack(args, host):
    source = host.path_arg(args, 'archive', 'filePath', 'sourcePath')
    kind = kind_for(source, args.get('format'))
    if type(args.get('indexOnly', False)) is not bool:
        raise host.WorkerError('INVALID_ARGUMENT', 'indexOnly must be boolean')
    catalog = archive_directory(source, kind, host)
    if args.get('indexOnly'):
        return {**catalog, 'operation': 'index', 'memberPayloadsDecoded': False, 'filesMaterialized': 0}
    output = host.path_arg(args, 'outputDir', 'outDir')
    identity = {'tool': VERSION, 'operation': 'unpack', 'format': kind, 'archiveHash': catalog['archiveHash']}
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
                                    for name, offset, _ in asar_native.index(filesystem_path(source))
                                    if offset is None and (requested is None or name in requested)}
    prior = reusable(output, identity, host, True)
    if prior:
        return prior
    host.fresh(output, (source,))
    filesystem_path(output.parent).mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.pinhao-unpack-', dir=filesystem_path(output.parent)) as temporary:
        # Keep extended Windows paths at the I/O boundary, not in artifact identities.
        staged = output.parent / Path(temporary).name / 'members'
        opaque = []
        if kind == 'xp3':
            _, entries = xp3_archive.index(filesystem_path(source))
            requested = {entry.name for entry in entries} if selected is None else set(selected)
            if requested - {entry.name for entry in entries}:
                raise host.WorkerError('ARCHIVE_MEMBER_MISSING', 'Requested XP3 member is missing')
            opaque = [{'path': entry.name, 'size': entry.size, 'adler32': entry.checksum,
                       'disposition': 'retained-in-original-archive'}
                      for entry in entries if entry.name in requested and not xp3_archive.filesystem_member(entry.name)]
            selected = sorted(requested - {row['path'] for row in opaque})
        unpack_to(source, staged, kind, host, names=selected)
        members = inventory(staged, host)
        os.replace(filesystem_path(staged), filesystem_path(output))
    result = {'format': kind, 'outputDir': str(output), 'archiveHash': identity['archiveHash'],
              'members': members, 'files': len(members), 'toolVersion': VERSION, 'reused': False,
              'archiveMembers': catalog['archiveMembers'], 'selectedFiles': identity.get('selectedFiles'),
              'completeFilesystemView': len(members) == catalog['archiveMembers'],
              'unselectedMembers': catalog['archiveMembers'] - len(members) - len(opaque),
              'capabilities': catalog['capabilities']}
    if kind == 'xp3':
        result.update({'opaqueMembers': opaque, 'archiveMembers': len(entries),
                       'completeFilesystemView': not opaque and len(members) == len(entries)})
    if host.digest_file(source) != identity['archiveHash'] or any(
            host.digest_file(host.clean_path(destination(Path(str(source) + '.unpacked'), name))) != expected
            for name, expected in identity.get('unpackedFiles', {}).items()):
        raise host.WorkerError('SOURCE_CHANGED', 'Archive inputs changed while members were read; preserve this output and use a fresh baseline')
    publish_receipt(output, identity, members, result, host)
    return result


def pack_rgss(source, output, host):
    entries = list(host.files_in(source))
    with filesystem_path(output).open('xb') as stream:
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
            stream.write(struct.pack('<I', filesystem_path(path).stat().st_size ^ key))
            key = advance(key)
            payload_key = key
            with filesystem_path(path).open('rb') as reader:
                while data := reader.read(65536):
                    block = bytearray(data)
                    for index in range(0, len(block), 4):
                        for offset in range(min(4, len(block) - index)):
                            block[index + offset] ^= (payload_key >> (8 * offset)) & 255
                        payload_key = advance(payload_key)
                    stream.write(block)


def pack_to(source, output, kind, original, host):
    if kind == 'zip':
        with zipfile.ZipFile(filesystem_path(output), 'x', zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
            for name, path in host.files_in(source):
                archive.write(filesystem_path(path), host.safe_member(name))
    elif kind == 'rgss':
        if original and archive_entries(filesystem_path(original))[0] != 1:
            raise host.WorkerError('REPACK_UNSUPPORTED', 'RGSS version 1 supports native repacking; retain the original version 3 archive')
        pack_rgss(source, output, host)
    elif kind == 'xp3':
        prefix = b''
        if original:
            start, _ = xp3_archive.index(filesystem_path(original))
            with filesystem_path(original).open('rb') as stream:
                prefix = stream.read(start)
        xp3_archive.pack(filesystem_path(output), ((name, filesystem_path(path)) for name, path in host.files_in(source)), prefix=prefix)
    elif kind == 'pck':
        if not original:
            raise host.WorkerError('REPACK_REFERENCE', 'Choose the original PCK to preserve its format and engine version')
        index = godot_native.pack_index(filesystem_path(original), host.safe_member)
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
    if kind == 'asar':
        raise host.WorkerError('REPACK_UNSUPPORTED', 'ASAR supports indexed member reads; use the engine assembly route for an expanded product')
    unpack_receipt = receipt_path(source)
    if filesystem_path(unpack_receipt).is_file():
        saved = json.loads(filesystem_path(host.clean_path(unpack_receipt)).read_text(encoding='utf-8'))
        unpack_identity = saved.get('identity', {})
        if unpack_identity.get('operation') == 'unpack':
            result = saved.get('result', {})
            partial = bool(unpack_identity.get('selectedFiles') or result.get('opaqueMembers')) or result.get('completeFilesystemView') is False
            if partial and original is None:
                raise host.WorkerError('REPACK_REFERENCE', 'A selected member view needs its original archive to retain unexpanded members')
            if original is not None and (host.digest_file(original) != unpack_identity.get('archiveHash') or kind != unpack_identity.get('format')):
                raise host.WorkerError('SOURCE_CHANGED', 'The original archive does not match this member view')
    incoming = inventory(source, host)
    identity = {'tool': VERSION, 'operation': 'repack', 'format': kind, 'members': incoming,
                'originalHash': host.digest_file(original) if original else None}
    prior = reusable(output, identity, host, False)
    if prior:
        return prior
    host.fresh(output, (source, *([original] if original else [])))
    filesystem_path(output.parent).mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.pinhao-repack-', dir=filesystem_path(output.parent)) as temporary:
        root = output.parent / Path(temporary).name
        members_root = root / 'members'
        staged = root / ('archive.' + ('rgssad' if kind == 'rgss' else kind))
        if kind == 'xp3' and original:
            # Original payloads stay in their carrier; only changed members are copied.
            baseline = {row['path']: row for row in xp3_archive.member_inventory(filesystem_path(original))}
            expected_by_name = {**baseline, **{row['path']: row for row in incoming}}
            files = {name: filesystem_path(path) for name, path in host.files_in(source)}
            replacements = {name: path for name, path in files.items()
                            if name in baseline and baseline[name] != expected_by_name[name]}
            additions = {name: path for name, path in files.items() if name not in baseline}
            xp3_archive.repack(filesystem_path(original), filesystem_path(staged), replacements, additions=additions)
            expected = sorted(expected_by_name.values(), key=lambda row: row['path'])
            if xp3_archive.member_inventory(filesystem_path(staged)) != expected:
                raise host.WorkerError('ARCHIVE_READBACK', 'Repacked XP3 member readback differs from the complete resource set')
            os.replace(filesystem_path(staged), filesystem_path(output))
        else:
            if original:
                unpack_to(original, members_root, kind, host)
            else:
                filesystem_path(members_root).mkdir()
            for name, path in host.files_in(source):
                target = destination(members_root, host.safe_member(name))
                filesystem_path(target.parent).mkdir(parents=True, exist_ok=True)
                shutil.copyfile(filesystem_path(path), filesystem_path(target))
            expected = inventory(members_root, host)
            pack_to(members_root, staged, kind, original, host)
            checked = root / 'checked'
            unpack_to(staged, checked, kind, host)
            if inventory(checked, host) != expected:
                raise host.WorkerError('ARCHIVE_READBACK', 'Repacked archive member readback differs from the complete resource set')
            os.replace(filesystem_path(staged), filesystem_path(output))
    sha256 = host.digest_file(output)
    result = {'format': kind, 'outputFile': str(output), 'filePath': str(output), 'sha256': sha256,
              'members': expected, 'files': len(expected), 'memberReadback': True, 'toolVersion': VERSION, 'reused': False}
    publish_receipt(output, identity, sha256, result, host)
    return result
