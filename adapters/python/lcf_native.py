"""LCF 2000/2003 adapter backed by EasyRPG's MIT-licensed lcf2xml codec."""
from __future__ import annotations

import configparser
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET

import rpgmaker as native
import text_formats
from rgss_archive import destination

XML_EXT = {'.ldb': '.edb', '.lmt': '.emt', '.lmu': '.emu'}
NATIVE_EXT = {value: key for key, value in XML_EXT.items()}
DATABASE_OBJECTS = {'Actor', 'Skill', 'Item', 'Enemy', 'Attribute', 'State', 'Class', 'BattleCommand'}


def executable(root):
    configured = os.environ.get('PINHAO_LCF2XML')
    paths = [Path(configured)] if configured else []
    paths.extend((Path(root) / 'local' / 'dependencies' / 'lcf' / 'lcf2xml.exe',
                  Path(__file__).parent / 'vendor' / 'lcf' / 'lcf2xml.exe'))
    return next((path.resolve() for path in paths if path.is_file()), None)


def convert(exe, source, output_dir, encoding='932', engine='2k3'):
    output_dir.mkdir(parents=True, exist_ok=True)
    # The upstream Windows program has a narrow argv and writes to its cwd.
    # Relative ASCII basenames work with a Unicode cwd via CreateProcessW.
    extension = source.suffix.lower()
    input_file = output_dir / ('resource' + extension)
    shutil.copyfile(source, input_file)
    result = subprocess.run([str(exe), '--' + engine, '--encoding', str(encoding), input_file.name],
                            cwd=output_dir, capture_output=True, timeout=120,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    detail = (result.stdout + result.stderr).decode('utf-8', errors='replace')
    if result.returncode or 'Error:' in detail or 'Corrupted Chunk' in detail:
        raise ValueError('liblcf conversion failed: ' + detail[-1800:])
    output_ext = XML_EXT.get(extension, NATIVE_EXT.get(extension))
    if output_ext is None or not (output_dir / ('resource' + output_ext)).is_file():
        raise ValueError('liblcf did not produce its native/XML output')
    return output_dir / ('resource' + output_ext)


def node(element):
    children = [node(child) for child in element]
    return {'tag': element.tag, 'attributes': dict(element.attrib),
            'text': (element.text or '') if not children else '', 'children': children}


def element(doc):
    result = ET.Element(doc['tag'], doc['attributes'])
    result.text = doc['text']
    for child in doc['children']:
        result.append(element(child))
    return result


def child(doc, name):
    return next((entry for entry in doc['children'] if entry['tag'] == name), None)


def child_value(doc, name, fallback=''):
    value = child(doc, name)
    return value['text'] if value else fallback


def text_target(doc, path, tag):
    for index, entry in enumerate(doc['children']):
        if entry['tag'] == tag:
            return path + ['children', index, 'text']
    return None


def add_group(collector, file, texts, paths, kind, context):
    if not any(text.strip() for text in texts):
        return
    # Empty leading message lines still belong to a complete, independently located unit.
    # Collector.add ignores whitespace-only seeds, so never reuse its preceding row.
    collector.add(file, paths[0], next(text for text in texts if text.strip()), kind, context)
    row = collector.rows[-1]
    ident = row['id']
    value, controls, tokens = native.protect(texts)
    collector.units[ident].update(targets=paths, source=value, initial_value=value,
                                  controls=controls, tokens=tokens)
    row.update(source=value, translation=value, source_preview='\n'.join(texts), tokens=tokens)
    for path in paths[1:]:
        key = (file, tuple(path))
        if key in collector.targets:
            raise ValueError('Repeated LCF dialogue target')
        collector.targets.add(key)


def collect(collector, file, doc):
    def walk(current, path, context, parent=''):
        tag = current['tag']
        context = dict(context)
        if tag in ('Event', 'EventPage', 'CommonEvent', 'TroopPage'):
            context[tag] = current['attributes'].get('id', '')
        if tag == 'event_commands':
            commands = current['children']
            index = 0
            branches = {}
            while index < len(commands):
                command = commands[index]
                code = int(child_value(command, 'code', '0'))
                indent = int(child_value(command, 'indent', '0'))
                base = path + ['children', index]
                ctx = {**context, 'command': index, 'code': code, 'indent': indent,
                       'branch_path': [value for level, value in sorted(branches.items()) if level < indent]}
                if code == 10110:
                    texts, targets, following = [], [], index
                    while following < len(commands):
                        entry = commands[following]
                        expected = 10110 if following == index else 20110
                        if int(child_value(entry, 'code', '0')) != expected:
                            break
                        texts.append(child_value(entry, 'string'))
                        targets.append(text_target(entry, path + ['children', following], 'string'))
                        following += 1
                    add_group(collector, file, texts, targets, 'dialogue', {**ctx, 'line_count': len(texts)})
                    index = following
                    continue
                if code in (20140, 10610, 10620):
                    target = text_target(command, base, 'string')
                    value = child_value(command, 'string')
                    if target:
                        collector.add(file, target, value, 'choice' if code == 20140 else 'actor_attribute', ctx)
                    if code == 20140:
                        branches[indent] = {'type': 'choice', 'label': value}
                elif code == 12010:
                    branches[indent] = {'type': 'conditional', 'side': 'then', 'command': index}
                elif code == 22010:
                    branches[indent] = {'type': 'conditional', 'side': 'else'}
                elif code in (20141, 22011):
                    branches.pop(indent, None)
                elif child_value(command, 'string').strip():
                    collector.review.append({'file': file, 'context': ctx, 'kind': 'lcf_non_display_string', 'editable': False})
                index += 1
            return
        for index, entry in enumerate(current['children']):
            target = path + ['children', index]
            if tag in DATABASE_OBJECTS and entry['tag'] in ('name', 'title', 'description', 'using_message1', 'using_message2', 'message_actor', 'message_enemy', 'message_already', 'message_affected', 'message_recovery', 'skill_name'):
                collector.add(file, target + ['text'], entry['text'], 'database_' + entry['tag'],
                              {**context, 'record_type': tag, 'record': current['attributes'].get('id'), 'field': entry['tag']})
            elif tag == 'Terms' and not entry['children']:
                collector.add(file, target + ['text'], entry['text'], 'system_term', {'field': entry['tag']})
            walk(entry, target, context, tag)
    walk(doc, [], {})


def source_encoding(game, args):
    if args.get('sourceEncoding'):
        return str(args['sourceEncoding'])
    ini = game / 'RPG_RT.ini'
    if ini.is_file():
        config = configparser.ConfigParser(interpolation=None, strict=False)
        try:
            config.read_string(ini.read_text(encoding='utf-8-sig', errors='replace'))
            if config.has_option('EasyRPG', 'Encoding'):
                return config.get('EasyRPG', 'Encoding')
        except configparser.Error:
            pass
    return '932'


def extract(game, work, exe, helpers, args):
    files = [path for path in sorted(game.iterdir()) if path.is_file() and path.suffix.lower() in XML_EXT]
    encoding = source_encoding(game, args)
    engine = args.get('lcfEngine', '2k3')
    if engine not in ('2k', '2k3'):
        raise ValueError('lcfEngine must be 2k or 2k3')
    with tempfile.TemporaryDirectory(prefix='pinhao-lcf-extract-', dir=work.parent) as temp:
        root = Path(temp)
        projection = root / 'projection'
        projection.mkdir()
        collector = text_formats.Collector(projection, 'RPG Maker 2000/2003', 'json', int(args.get('batchSize', 120)))
        for index, path in enumerate(files):
            xml = convert(exe, path, root / ('resource-%d' % index), encoding, engine)
            document = node(ET.parse(xml).getroot())
            target = projection / (path.name + '.json')
            helpers.json_write(target, document)
            file, doc = collector.document(target)
            collect(collector, file, doc)
        report = collector.finish(work)
    originals = {path.name: helpers.digest_file(path) for path in files}
    for path in files:
        target = work / 'native-baseline' / path.name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
    fingerprint = native.sha(native.serialized(originals))
    metadata = {'schema': 'pinhao-native-source-v1', 'engine': 'RPG Maker 2000/2003',
                'root': '.', 'packed': False, 'archives': [], 'sourceFiles': originals,
                'sourceFingerprint': fingerprint, 'sourceEncoding': encoding, 'lcfEngine': engine,
                'additionalSourceRoots': [str((work / 'baseline').resolve())],
                'targetEncoding': str(args.get('targetEncoding', '936')), 'codec': 'liblcf',
                'codecSha256': helpers.digest_file(exe)}
    helpers.json_write(work / 'technical' / 'product-source.json', metadata)
    images = [{'file': rel, 'status': 'unreviewed_image'} for rel, path in helpers.files_in(game)
              if path.suffix.lower() in ('.png', '.bmp', '.xyz') and not helpers.excluded(rel)]
    helpers.json_write(work / 'image-inventory.json', images)
    helpers.json_write(work / 'dynamic-candidates.json', [])
    manifest, sheets = native.load_work(work)
    rows = [{**row, 'legacyId': row['id'], 'file': manifest['units'][row['id']]['file']}
            for sheet in sheets.values() for row in sheet['units']]
    return {**report, 'workDir': str(work), 'workspaceDir': str(work), 'units': rows,
            'manifestPath': str(work / 'manifest.json'), 'sourceFingerprint': fingerprint,
            'images': images, 'dynamicCandidates': [], 'reviewItems': collector.review,
            'sourceEncoding': encoding, 'targetEncoding': metadata['targetEncoding'],
            'capabilities': {'extract': True, 'nativeBuild': True, 'assemble': True, 'font': False,
                             'oldDefaultNames': False, 'dynamicCandidates': False, 'runtimeVerified': False}}


def check_baseline(work, helpers):
    metadata = native.read(work / 'technical' / 'product-source.json')
    for rel, digest in metadata['sourceFiles'].items():
        if helpers.digest_file(work / 'native-baseline' / rel) != digest:
            raise ValueError('LCF native baseline changed: ' + rel)
    return metadata


def projection_build(work, editable, folder, exe, helpers, encoding):
    metadata = check_baseline(work, helpers)
    projected = folder / 'projected'
    native.build(work, editable, projected)
    manifest, _, validation = native.validate(work, editable)
    outputs = {}
    for index, file in enumerate(manifest['files']):
        doc = native.read(projected / file)
        for value in string_values(doc):
            value.encode('cp' + encoding if encoding.isdigit() else encoding, errors='strict')
        name = file[:-5]
        xml = folder / ('input-%d' % index) / ('resource' + XML_EXT[Path(name).suffix.lower()])
        xml.parent.mkdir(parents=True)
        ET.ElementTree(element(doc)).write(xml, encoding='utf-8', xml_declaration=True)
        # Upstream format detection recognizes the double-quoted XML declaration.
        raw = xml.read_bytes().replace(b"<?xml version='1.0' encoding='utf-8'?>", b'<?xml version="1.0" encoding="UTF-8"?>')
        xml.write_bytes(raw)
        result = convert(exe, xml, folder / ('native-%d' % index), encoding, metadata['lcfEngine'])
        verify = convert(exe, result, folder / ('verify-%d' % index), encoding, metadata['lcfEngine'])
        if node(ET.parse(verify).getroot()) != doc:
            raise ValueError('LCF native re-export changed protected fields or text encoding: ' + name)
        outputs[name] = result
    return outputs, validation


def string_values(doc):
    if not doc['children']:
        yield doc['text']
    for entry in doc['children']:
        yield from string_values(entry)


def roundtrip(work, exe, helpers):
    metadata = check_baseline(work, helpers)
    with tempfile.TemporaryDirectory(prefix='pinhao-lcf-roundtrip-', dir=work.parent) as temp:
        output = Path(temp) / 'delivery'
        report = build(work, work / 'technical' / 'row-baseline', output, exe, helpers)
        # Validate the delivered no-change files, not liblcf's canonicalized intermediate.
        # build() still requires a native re-export with identical text and protected fields.
        identical = all((output / rel).read_bytes() == (work / 'native-baseline' / rel).read_bytes()
                        for rel in metadata['sourceFiles'])
    return {'engine': 'RPG Maker 2000/2003', 'files': len(metadata['sourceFiles']), 'units': report['units'],
            'byteIdentical': identical, 'nativeSemanticRoundtrip': True,
            'codecByteIdentical': report['codecByteIdentical'], 'passed': identical,
            'status': 'nochange_byte_identical' if identical else 'nochange_delivery_changed', 'runtimeVerified': False}


def build(work, editable, output, exe, helpers):
    metadata = check_baseline(work, helpers)
    validation = native.validate(work, editable)[2]
    encoding = metadata['targetEncoding'] if validation['changed'] else metadata['sourceEncoding']
    with tempfile.TemporaryDirectory(prefix='pinhao-lcf-build-', dir=work.parent) as temp:
        outputs, _ = projection_build(work, editable, Path(temp), exe, helpers, encoding)
        codec_identical = all(path.read_bytes() == (work / 'native-baseline' / rel).read_bytes()
                              for rel, path in outputs.items()) if not validation['changed'] else None
        output.mkdir(parents=True)
        for rel, path in outputs.items():
            source = path if validation['changed'] else work / 'native-baseline' / rel
            shutil.copyfile(source, output / rel)
    files = {rel: helpers.digest_file(path) for rel, path in helpers.files_in(output)}
    report = {**validation, 'engine': 'RPG Maker 2000/2003', 'files': len(files),
              'files_sha256': files, 'manifest_sha256': helpers.digest_file(work / 'manifest.json'),
              'status': 'native_built_and_reexport_verified', 'runtimeVerified': False,
              'nativeSemanticRoundtrip': True, 'codecByteIdentical': codec_identical, 'encoding': encoding,
              'sourceEncoding': metadata['sourceEncoding'], 'targetCodepage': encoding,
              'warnings': ['RPG_RT Chinese codepage and fixed bitmap font require a matching runtime; runtime acceptance pending']}
    helpers.json_write(output / 'build-report.json', report)
    return {**report, 'buildDir': str(output), 'outputDir': str(output)}
