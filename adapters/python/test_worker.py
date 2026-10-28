"""Neutral native adapter tests. These tests never start a game or call a model."""
import json
import errno
import io
from pathlib import Path
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile
import zlib

import worker
from ruby_marshal import RObject, Reader, long_bytes
from test_rpgmaker import archive_v3, json_game, marshal


def ruby_value(value):
    if isinstance(value, bytes):
        return b'"' + long_bytes(len(value)) + value
    if isinstance(value, list):
        return b'[' + long_bytes(len(value)) + b''.join(ruby_value(item) for item in value)
    return marshal(value)


def ruby_game(root, engine):
    root.mkdir(parents=True)
    data = root / 'Data'
    data.mkdir()
    ext = {'VX Ace': '.rvdata2', 'VX': '.rvdata', 'XP': '.rxdata'}[engine]
    def obj(class_name, **fields):
        return RObject(class_name, {'@' + key: value for key, value in fields.items()})
    def command(code, params, indent=0):
        return obj('RPG::EventCommand', code=code, parameters=params, indent=indent)
    entries = ([command(101, ['First line']), command(401, ['Second line'])]
               if engine == 'XP' else [command(101, ['', 0, 0, 2]), command(401, ['First line']),
                                       command(401, ['Second line'])])
    entries += [command(102, [['Yes', 'No'], 0]), command(402, [0, 'Yes']),
                command(402, [1, 'No']), command(404, []), command(0, [])]
    event = obj('RPG::Event', x=1, y=2, pages=[obj('RPG::Event::Page', list=entries)])
    system = obj('RPG::System', game_title='Neutral', currency_unit='Coin', elements=['', 'Fire'])
    if engine == 'XP':
        system.attrs['@words'] = obj('RPG::System::Words', hp='HP', gold='Gold')
    elif engine == 'VX':
        system.attrs['@terms'] = obj('RPG::System::Terms', hp='HP', level='Level')
    else:
        system.attrs['@terms'] = obj('RPG::System::Terms', basic=['Level'])
    records = {'System': system,
               'Actors': [None, obj('RPG::Actor', name='Lin', nickname='', description='A visitor.', note='')],
               'Map001': obj('RPG::Map', display_name='Inn', events={1: event}, data=RObject('Table', data=b'\0fixture\xff'))}
    for name, value in records.items():
        (data / (name + ext)).write_bytes(b'\x04\x08' + marshal(value))
    (data / ('Scripts' + ext)).write_bytes(b'\x04\x08' + ruby_value([[1, 'Main', zlib.compress(b"p 'neutral boot'\n")]]))
    (root / 'Game.exe').write_bytes(b'neutral launcher fixture, not executable')
    return root


def font_fixture(path):
    name = 'Fixture Sans'.encode('utf-16-be')
    names = struct.pack('>HHH', 0, 1, 18) + struct.pack('>HHHHHH', 3, 1, 1033, 1, len(name), 0) + name
    head = bytearray(54)
    struct.pack_into('>I', head, 12, 0x5F0F3CF5)
    cmap = struct.pack('>HHHHI', 0, 1, 3, 10, 12) + struct.pack('>HHIII', 12, 0, 28, 0, 1) + struct.pack('>III', 0, 65533, 1)
    tables = {b'name': names, b'head': head, b'maxp': struct.pack('>IH', 0x5000, 65535), b'cmap': cmap, b'glyf': b'\0'}
    offset = 12 + len(tables) * 16
    directory, payload = bytearray(), bytearray()
    for tag, data in tables.items():
        directory.extend(struct.pack('>4sIII', tag, 0, offset, len(data)))
        payload.extend(data)
        offset += len(data)
    path.write_bytes(struct.pack('>IHHHH', 0x10000, len(tables), 0, 0, 0) + directory + payload)


def snapshot(root):
    return {rel: path.read_bytes() for rel, path in worker.files_in(root)}


class NativeWorkerTests(unittest.TestCase):
    def setUp(self):
        parent = worker.ROOT / 'local' / 'native-tests'
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def pipeline(self, engine, nested=False, media=False):
        game = self.root / (engine.replace(' ', '-') + '-game')
        if engine in ('MV', 'MZ'):
            json_game(game, engine, nested)
            (game / 'Game.exe').write_bytes(b'neutral exe')
        else:
            ruby_game(game, engine)
        if media:
            (game / 'audio').mkdir()
            (game / 'audio' / 'theme.ogg').write_bytes(b'original game audio')
        save = game / 'save'
        save.mkdir()
        (save / 'file1.rpgsave').write_bytes(b'private fixture')
        (game / 'Save01.rvdata2').write_bytes(b'private fixture')
        (game / 'ManualTransFile_zh.json').write_bytes(b'private translation fixture')
        before = snapshot(game)
        work = self.root / (engine.replace(' ', '-') + '-work')
        result = worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
        self.assertEqual(result['engine'], engine)
        self.assertTrue(worker.roundtrip({'workspaceDir': str(work)})['byteIdentical'])
        message = next(row for row in result['units'] if row['kind'] == 'dialogue')
        self.assertIn('{{LINE0001}}', message['source'])
        name = next(row for row in result['units'] if row['kind'] == 'database_name')
        choice = next(row for row in result['units'] if row['kind'] == 'choice')
        changes = [{'legacyId': name['id'], 'translation': '\u6797'},
                   {'legacyId': choice['id'], 'translation': '\u786e\u8ba4'}]
        built = self.root / (engine.replace(' ', '-') + '-built')
        worker.build({'workspaceDir': str(work), 'outputDir': str(built), 'translations': changes})
        output = self.root / (engine.replace(' ', '-') + '-output')
        font = self.root / (engine.replace(' ', '-') + '.ttf')
        font_fixture(font)
        assembly = worker.assemble({'gameDir': str(game), 'workspaceDir': str(work), 'buildDir': str(built),
                                    'outputDir': str(output), 'fontPath': str(font)})
        self.assertFalse((output / 'save').exists())
        self.assertFalse((output / 'Save01.rvdata2').exists())
        self.assertFalse((output / 'ManualTransFile_zh.json').exists())
        self.assertEqual(assembly['oldDefaultNames'], 1)
        self.assertEqual(assembly['font']['family'], 'Fixture Sans')
        self.assertTrue((output / 'Game.exe').is_file())
        self.assertEqual(assembly['launchPath'], str(output / 'Game.exe'))
        public_report = (output / 'PinHao-build-report.json').read_text(encoding='utf-8')
        self.assertNotIn(str(output), public_report)
        self.assertEqual(snapshot(game), before)
        self.assertEqual(worker.native.validate(work)[2]['changed'], 0)
        if engine in ('MV', 'MZ'):
            native_root = output / ('www' if nested else '')
            doc = worker.native.read(native_root / 'data' / 'Actors.json')
            self.assertEqual(doc[1]['name'], '\u6797')
            self.assertIn('PinHaoLocalization', (native_root / 'js' / 'plugins.js').read_text(encoding='utf-8'))
        else:
            ext = {'VX Ace': '.rvdata2', 'VX': '.rvdata', 'XP': '.rxdata'}[engine]
            doc = Reader((output / 'Data' / ('Actors' + ext)).read_bytes()).root
            self.assertEqual(doc[1].attrs['@name'].text(), '\u6797')
            script = Reader((output / 'Data' / ('Scripts' + ext)).read_bytes()).root[0][2]
            self.assertTrue(zlib.decompress(script.raw).startswith(worker.rgss_bootstrap('PinHaoLocalization.rb')))
        return game, work, built, output

    def test_mv_native_pipeline(self):
        self.pipeline('MV')

    def test_validate_checks_proposed_text_without_materializing_temporary_sheets(self):
        game, work = self.root / 'game', self.root / 'work'
        json_game(game)
        extracted = worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
        message = next(row for row in extracted['units'] if '{{LINE' in row['source'])
        original = snapshot(work / 'editable')
        with mock.patch.object(worker.tempfile, 'TemporaryDirectory', side_effect=AssertionError('validate must not materialize sheets')), \
                mock.patch.object(worker, 'json_write', wraps=worker.json_write) as writes:
            result = worker.validate({'workspaceDir': str(work), 'translations': [
                {'id': message['id'], 'translation': 'Translated ' + message['source']}]})
            self.assertEqual(result['changed'], 1)
            with self.assertRaises(ValueError):
                worker.validate({'workspaceDir': str(work), 'translations': [
                    {'id': message['id'], 'translation': 'lost tokens'}]})
            writes.assert_not_called()
        self.assertEqual(snapshot(work / 'editable'), original)

    def test_assembled_native_resources_copy_only_the_verified_built_version(self):
        for engine, nested, relative in [('MV', False, 'data/Actors.json'),
                                         ('MZ', True, 'data/Actors.json'),
                                         ('VX Ace', False, 'Data/Actors.rvdata2')]:
            with self.subTest(engine=engine), mock.patch.object(worker.shutil, 'copyfile', wraps=worker.shutil.copyfile) as copied:
                _, _, built, output = self.pipeline(engine, nested)
            target = output / ('www' if nested else '') / relative
            sources = [Path(call.args[0]) for call in copied.call_args_list if Path(call.args[1]) == target]
            self.assertEqual(sources, [built / relative])

    def test_default_native_product_is_independent_when_users_modify_media_and_launcher(self):
        game, _, _, output = self.pipeline('MV', media=True)
        for relative in ('Game.exe', 'audio/theme.ogg'):
            source = game / relative
            original = source.read_bytes()
            (output / relative).write_bytes(b'user modified independent output')
            self.assertEqual(source.read_bytes(), original)
        report = json.loads((output / 'PinHao-build-report.json').read_text(encoding='utf-8'))
        self.assertEqual(report['linked'], 0)

    def test_copy_space_preflight_fails_before_any_file_is_written(self):
        source, output = self.root / 'source', self.root / 'output'
        source.mkdir()
        (source / 'first.bin').write_bytes(b'12345678')
        (source / 'second.bin').write_bytes(b'abcdefgh')
        with mock.patch.object(worker.shutil, 'disk_usage', return_value=mock.Mock(free=15)) as usage:
            with self.assertRaises(worker.WorkerError) as error:
                worker.copy_tree(source, output, {'excluded': []})
        self.assertEqual(error.exception.code, 'DISK_SPACE')
        self.assertIn('16', str(error.exception))
        usage.assert_called_once_with(self.root)
        self.assertFalse(output.exists())

    def test_copy_space_plan_uses_existing_private_and_archive_exclusions(self):
        source, output = self.root / 'source', self.root / 'output'
        source.mkdir()
        (source / 'keep.bin').write_bytes(b'12345678')
        (source / 'save').mkdir()
        (source / 'save' / 'Save01.rpgsave').write_bytes(b'p' * 65536)
        (source / 'Game.rgssad').write_bytes(b'a' * 65536)
        inventory = {'excluded': []}
        with mock.patch.object(worker.shutil, 'disk_usage', return_value=mock.Mock(free=8)):
            worker.copy_tree(source, output, inventory, omit_archives=True)
        self.assertEqual((output / 'keep.bin').read_bytes(), b'12345678')
        self.assertFalse((output / 'save').exists())
        self.assertFalse((output / 'Game.rgssad').exists())
        self.assertEqual(inventory['copied'], 1)

    def test_copy_space_reserves_the_final_built_resources_without_copying_old_versions(self):
        source, output = self.root / 'source', self.root / 'output'
        source.mkdir()
        (source / 'replaced.json').write_bytes(b'o' * 60)
        (source / 'keep.bin').write_bytes(b'12345678')
        options = {'replacement_files': {'replaced.json'}, 'reserve_bytes': 100}
        with mock.patch.object(worker.shutil, 'disk_usage', return_value=mock.Mock(free=107)):
            with self.assertRaises(worker.WorkerError) as error:
                worker.copy_tree(source, output, {'excluded': []}, **options)
        self.assertEqual(error.exception.code, 'DISK_SPACE')
        self.assertFalse(output.exists())
        inventory = {'excluded': []}
        with mock.patch.object(worker.shutil, 'disk_usage', return_value=mock.Mock(free=108)):
            worker.copy_tree(source, output, inventory, **options)
        self.assertEqual((output / 'keep.bin').read_bytes(), b'12345678')
        self.assertFalse((output / 'replaced.json').exists())
        self.assertEqual(inventory['skipped'], 1)
        self.assertEqual(inventory['excluded'], [])

    def test_hardlink_fallback_keeps_built_resource_space_reserved(self):
        source, output = self.root / 'source', self.root / 'output'
        source.mkdir()
        (source / 'theme.ogg').write_bytes(b'12345678')
        with mock.patch.object(worker.os, 'link', side_effect=OSError('no hardlink support')), \
                mock.patch.object(worker.shutil, 'disk_usage', return_value=mock.Mock(free=39)):
            with self.assertRaises(worker.WorkerError) as error:
                worker.copy_tree(source, output, {'excluded': []}, hardlink=True, reserve_bytes=32)
        self.assertEqual(error.exception.code, 'DISK_SPACE')
        self.assertFalse((output / 'theme.ogg').exists())

    def test_independent_incremental_copy_breaks_preexisting_hardlinks(self):
        source, output = self.root / 'source', self.root / 'output'
        source.mkdir(); output.mkdir()
        original = source / 'theme.ogg'
        original.write_bytes(b'original audio')
        try:
            worker.os.link(original, output / original.name)
        except OSError as error:
            self.skipTest('Filesystem does not support the hardlink fixture: ' + str(error))
        inventory = {'excluded': []}
        worker.copy_tree(source, output, inventory)
        self.assertEqual(inventory['copied'], 1)
        self.assertEqual(inventory['skipped'], 0)
        (output / original.name).write_bytes(b'changed output audio')
        self.assertEqual(original.read_bytes(), b'original audio')

    def test_replacing_a_stale_hardlinked_destination_does_not_modify_its_other_owner(self):
        source, output = self.root / 'source', self.root / 'output'
        source.mkdir(); output.mkdir()
        (source / 'file.bin').write_bytes(b'new bytes')
        other_owner = self.root / 'protected-original.bin'
        other_owner.write_bytes(b'keep original bytes')
        try:
            worker.os.link(other_owner, output / 'file.bin')
        except OSError as error:
            self.skipTest('Filesystem does not support the hardlink fixture: ' + str(error))
        worker.copy_tree(source, output, {'excluded': []})
        self.assertEqual((output / 'file.bin').read_bytes(), b'new bytes')
        self.assertEqual(other_owner.read_bytes(), b'keep original bytes')

    def test_explicit_hardlink_failure_checks_copy_fallback_space(self):
        source, output = self.root / 'source', self.root / 'output'
        source.mkdir()
        (source / 'theme.ogg').write_bytes(b'original audio')
        with mock.patch.object(worker.os, 'link', side_effect=OSError('no hardlink support')):
            with mock.patch.object(worker.shutil, 'disk_usage', return_value=mock.Mock(free=0)):
                with self.assertRaises(worker.WorkerError) as error:
                    worker.copy_tree(source, output, {'excluded': []}, hardlink=True)
        self.assertEqual(error.exception.code, 'DISK_SPACE')
        self.assertFalse((output / 'theme.ogg').exists())

    def test_mz_nested_native_pipeline(self):
        self.pipeline('MZ', True)

    def test_ace_native_pipeline(self):
        self.pipeline('VX Ace')

    def test_vx_native_pipeline_and_terms(self):
        _, work, _, _ = self.pipeline('VX')
        rows = [row for sheet in worker.native.load_work(work)[1].values() for row in sheet['units']]
        self.assertIn('HP', [row['source'] for row in rows])

    def test_xp_first_line_and_words(self):
        _, work, _, _ = self.pipeline('XP')
        rows = [row for sheet in worker.native.load_work(work)[1].values() for row in sheet['units']]
        message = next(row for row in rows if row['kind'] == 'dialogue')
        self.assertEqual(message['source'], 'First line{{LINE0001}}Second line')
        self.assertIn('Gold', [row['source'] for row in rows])

    def test_duplicate_and_bad_tokens_rejected(self):
        game = self.root / 'game'
        json_game(game)
        work = self.root / 'work'
        extracted = worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
        row = extracted['units'][0]
        changes = [{'legacyId': row['id'], 'translation': row['translation']}] * 2
        with self.assertRaises(worker.WorkerError) as error:
            worker.validate({'workspaceDir': str(work), 'translations': changes})
        self.assertEqual(error.exception.code, 'DUPLICATE_ID')
        message = next(row for row in extracted['units'] if '{{LINE' in row['source'])
        with self.assertRaises(ValueError):
            worker.build({'workspaceDir': str(work), 'outputDir': str(self.root / 'bad'),
                          'translations': [{'id': message['id'], 'translation': 'lost tokens'}]})
        self.assertFalse((self.root / 'bad').exists())

    def test_source_drift_rejected_before_copy(self):
        game, work, built, _ = self.pipeline('MV')
        path = game / 'data' / 'Actors.json'
        path.write_bytes(path.read_bytes() + b'\n')
        with self.assertRaises(worker.WorkerError) as error:
            worker.assemble({'gameDir': str(game), 'workspaceDir': str(work), 'buildDir': str(built),
                             'outputDir': str(self.root / 'drift')})
        self.assertEqual(error.exception.code, 'SOURCE_CHANGED')
        self.assertFalse((self.root / 'drift').exists())

    def test_zip_roundtrip_and_release_filter(self):
        source = self.root / 'source'
        source.mkdir()
        (source / 'text.json').write_text('{"a":1}', encoding='utf-8')
        (source / 'save').mkdir()
        (source / 'save' / 'private.sav').write_bytes(b'private')
        archive = self.root / 'package.zip'
        worker.zip_command({'sourceDir': str(source), 'filePath': str(archive), 'release': True})
        output = self.root / 'expanded'
        worker.unzip_command({'filePath': str(archive), 'outputDir': str(output)})
        self.assertEqual((output / 'text.json').read_bytes(), (source / 'text.json').read_bytes())
        self.assertFalse((output / 'save').exists())

    def test_bad_zip_paths_and_collisions_rejected_before_writing(self):
        cases = [['../outside'], ['A.json', 'a.json'], ['CON.txt'], ['a', 'a/b'], ['safe/./bad']]
        for index, names in enumerate(cases):
            archive = self.root / ('bad%d.zip' % index)
            with zipfile.ZipFile(archive, 'w') as stream:
                for name in names:
                    stream.writestr(name, b'fixture')
            target = self.root / ('bad%d' % index)
            with self.subTest(names=names), self.assertRaises(ValueError):
                worker.unzip_command({'filePath': str(archive), 'outputDir': str(target)})
            self.assertFalse(target.exists())

    def test_zip_symlink_rejected(self):
        path = self.root / 'link.zip'
        with zipfile.ZipFile(path, 'w') as stream:
            member = zipfile.ZipInfo('link')
            member.external_attr = (stat.S_IFLNK | 0o777) << 16
            stream.writestr(member, '../escape')
        with self.assertRaises(ValueError):
            worker.unzip_command({'filePath': str(path), 'outputDir': str(self.root / 'bad')})

    def test_protocol_outputs_one_json_object(self):
        result = subprocess.run([sys.executable, '-X', 'utf8', str(Path(worker.__file__)), 'probe'],
                                input=json.dumps({'gameDir': str(self.root / 'missing')}),
                                capture_output=True, encoding='utf-8', check=False)
        self.assertEqual(result.returncode, 2)
        response = json.loads(result.stdout)
        self.assertFalse(response['ok'])
        self.assertIsInstance(response['error']['code'], str)

    def protocol_error(self, operation):
        output = io.StringIO()
        with mock.patch.object(worker.sys, 'argv', ['worker.py', 'probe']), \
                mock.patch.object(worker.sys, 'stdin', io.StringIO('{}')), \
                mock.patch.object(worker.sys, 'stdout', output), \
                mock.patch.dict(worker.COMMANDS, {'probe': lambda args: operation()}):
            status = worker.main()
        return status, json.loads(output.getvalue())

    def test_protocol_preserves_structured_disk_and_permission_errno(self):
        for name in ('ENOSPC', 'EROFS', 'EACCES', 'EPERM'):
            def fail(code=getattr(errno, name)):
                raise OSError(code, 'isolated filesystem error fixture')
            with self.subTest(code=name):
                status, response = self.protocol_error(fail)
                self.assertEqual(status, 2)
                self.assertFalse(response['ok'])
                self.assertEqual(response['error']['code'], name)
        explicit = worker.WorkerError('DISK_SPACE', 'space preflight fixture')
        explicit.errno = errno.ENOSPC
        def fail_explicit():
            raise explicit
        self.assertEqual(self.protocol_error(fail_explicit)[1]['error']['code'], 'DISK_SPACE')

    def test_protocol_serializes_actual_read_only_write_failure(self):
        readonly = self.root / 'read-only-original.txt'
        readonly.write_bytes(b'preserve this original')
        readonly.chmod(stat.S_IREAD)
        try:
            status, response = self.protocol_error(lambda: readonly.write_bytes(b'must not overwrite'))
            if status == 0:
                self.skipTest('The current filesystem/user does not enforce read-only file writes')
            self.assertEqual(response['error']['code'], 'EACCES')
            self.assertEqual(readonly.read_bytes(), b'preserve this original')
        finally:
            readonly.chmod(stat.S_IREAD | stat.S_IWRITE)

    def test_lcf_wolf_capability_does_not_claim_native(self):
        lcf = self.root / 'lcf'
        lcf.mkdir()
        (lcf / 'RPG_RT.ldb').write_bytes(b'fixture')
        with mock.patch.object(worker.lcf_native, 'executable', return_value=None):
            self.assertFalse(worker.probe({'gameDir': str(lcf)})['capabilities']['nativeBuild'])
        wolf = self.root / 'wolf'
        (wolf / 'Data' / 'BasicData').mkdir(parents=True)
        (wolf / 'Data' / 'BasicData' / 'Game.dat').write_bytes(b'fixture')
        with mock.patch.object(worker.wolf_native, 'executable', return_value=None):
            self.assertFalse(worker.probe({'gameDir': str(wolf)})['capabilities']['nativeBuild'])

    def test_packed_rgss_assembles_all_resources_and_removes_archive(self):
        source = ruby_game(self.root / 'unpacked-fixture', 'VX Ace')
        game = self.root / 'packed'
        game.mkdir()
        resources = [(rel, path.read_bytes()) for rel, path in worker.files_in(source) if rel.startswith('Data/')]
        resources.append(('Graphics/Pictures/fixture.png', b'neutral image bytes'))
        archive_v3(game / 'Game.rgss3a', resources)
        (game / 'Game.exe').write_bytes(b'neutral launcher')
        work, built, out = self.root / 'work', self.root / 'built', self.root / 'out'
        result = worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
        self.assertEqual(result['engine'], 'VX Ace')
        worker.roundtrip({'workspaceDir': str(work)})
        worker.build({'workspaceDir': str(work), 'outputDir': str(built), 'translations': []})
        with mock.patch.object(worker.shutil, 'copyfile', wraps=worker.shutil.copyfile) as copied:
            worker.assemble({'gameDir': str(game), 'workspaceDir': str(work), 'buildDir': str(built), 'outputDir': str(out)})
        self.assertEqual([Path(call.args[0]) for call in copied.call_args_list
                          if Path(call.args[1]) == out / 'Data' / 'System.rvdata2'],
                         [built / 'Data' / 'System.rvdata2'])
        self.assertFalse((out / 'Game.rgss3a').exists())
        self.assertEqual((out / 'Graphics' / 'Pictures' / 'fixture.png').read_bytes(), b'neutral image bytes')
        self.assertEqual((out / 'Data' / 'System.rvdata2').read_bytes(), (source / 'Data' / 'System.rvdata2').read_bytes())

    def test_javascript_runtime_message_and_default_name_behavior(self):
        script = Path(__file__).parent / 'test_runtime.cjs'
        result = subprocess.run(['node', str(script)], capture_output=True, encoding='utf-8', check=False)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
