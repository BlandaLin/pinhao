"""Native LCF/WOLF save fixtures, lossless changes and backup/CAS checks."""
from pathlib import Path
import os
import shutil
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import worker
import assist_legacy as legacy


def field(tag, value):
    return legacy.ber(tag) + legacy.ber(len(value)) + value


def chunks(*entries):
    return b''.join(field(tag, value) for tag, value in entries) + b'\0'


def table(rows):
    return legacy.ber(len(rows)) + b''.join(legacy.ber(ident) + value for ident, value in rows)


def lcf_fixture():
    system = chunks((31, legacy.ber(3)), (32, b'\0\1\0'), (33, legacy.ber(3)),
                    (34, struct.pack('<iii', 10, -7, 0)), (251, b'preserved system extension'))
    inventory = chunks((1, legacy.ber(1)), (2, struct.pack('<H', 1)), (11, legacy.ber(1)),
                       (12, struct.pack('<H', 1)), (13, b'\3'), (14, b'\2'), (21, legacy.ber(1234)))
    actors = table([(1, chunks((1, b'Hero'), (31, legacy.ber(3)), (32, legacy.ber(25)),
                              (71, legacy.ber(40)), (72, legacy.ber(8)), (253, b'actor extension')))])
    return legacy.ber(11) + b'LcfSaveData' + chunks((101, system), (108, actors), (109, inventory), (901, b'private unknown bytes\0\xff'))


def wolf_fixture(utf8=True, version=0x60):
    """Neutral native section layouts, independently checked by WolfSave."""
    u32 = lambda value: struct.pack('<I', value & 0xffffffff)
    word = lambda value: struct.pack('<H', value)
    text = lambda value, size: (word(len(value) + 1) if size == 2 else u32(len(value) + 1)) + value + b'\0'
    header = bytearray(20)
    header[0], header[3], header[9] = 17, 31, 47
    header[6] = 0x55 if utf8 else 0
    part1 = bytes(12) + text(b'', 4) * 8 + bytes(12)
    part2 = bytes(170)
    part3 = bytes(20) + u32(1) + b'\0'
    character = bytes(21) + text(b'', 2) + bytes(10) + bytes(20) + bytes(12) + bytes(3) + bytes(4)
    part4 = character + bytes(10)
    if version == 0x8e:
        part1 = bytes(20) + u32(-1) + text(b'', 4) * 32 + bytes(8 + 44 + 4)
        part2 = bytes(166 + 8 + 37 + 24 + 2) + text(b'', 2) * 2 + bytes(4 + 12)
        part2 += text(b'', 2) + bytes(12) + text(b'', 2) + bytes(12)
        part2 += text(b'', 2) * 2 + bytes(2) + text(b'', 2) * 3
        part2 += bytes(52 + 2 + 112 + 16) + text(b'', 4) + bytes(4 + 272 + 4)
        character += bytes(2 + 16 + 4 + 12 + 15 + 4 + 4)
        part4 = character + bytes(14)
    elif version != 0x60:
        raise ValueError('Choose a covered neutral fixture layout')
    part5 = bytes(2)
    part6 = b'\0' + u32(1) + u32(3) + u32(1000) + u32(2000) + u32(1000) + u32(1)
    part6 += u32(123) + u32(-5) + text(b'Neutral', 4)
    body = b'\x19' + text(b'Neutral', 2) + word(version) + part1 + part2 + part3 + part4 + part5 + part6 + b'\0\x19'
    header[2] = sum(body) & 255
    result = bytearray(header + body)
    for seed, step in [(result[0], 1), (result[3], 2), (result[9], 5)]:
        current = seed
        for offset in range(20, len(result), step):
            current = (current * 214013 + 2531011) & 0xffffffff
            result[offset] ^= ((current >> 16) & 0x7fff) >> 12
    return bytes(result)


class LegacyAssistTests(unittest.TestCase):
    def setUp(self):
        parent = worker.ROOT / 'local/native-tests'
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.root = Path(self.temp.name)
        self.temp_patch = patch('tempfile.tempdir', str(self.root))
        self.temp_patch.start()
        self.game = self.root / '中文游戏'
        self.game.mkdir()
        self.file = self.game / 'Save01.lsd'
        self.file.write_bytes(lcf_fixture())
        labels = table([(1, chunks((1, b'Potion'))), (2, chunks((1, b'Key')))])
        db = legacy.ber(11) + b'LcfDataBase' + chunks((13, labels))
        (self.game / 'RPG_RT.ldb').write_bytes(db)
        self.args = {'outputDir': str(self.game), 'filePath': str(self.file), 'backupDir': str(self.root / 'backups'),
                     'binding': {'projectId': 'project', 'buildId': 'build'}}

    def tearDown(self):
        self.temp_patch.stop()
        self.temp.cleanup()

    def modify(self, action, value, **extra):
        state = legacy.load(self.args, worker)
        return legacy.write({**self.args, 'expectedSha256': state['saveFile']['sha256'], 'action': action, 'value': value, **extra}, worker)

    def test_lcf_read_names_signed_arrays_and_exact_nochange_roundtrip(self):
        raw = self.file.read_bytes()
        codec = legacy.LcfSave(raw, self.game, 'cp932')
        self.assertEqual(codec.header + codec.top.dump(), raw)
        state = legacy.load(self.args, worker)
        self.assertEqual(state['mode'], 'save')
        self.assertEqual(state['gold'], 1234)
        self.assertEqual(state['variables'][1]['value'], -7)
        self.assertEqual(state['items'][0]['name'], 'Potion')
        self.assertEqual(state['items'][0]['count'], 3)
        self.assertEqual(state['items'][0]['max'], 99)
        self.assertEqual(state['actors'][0]['hp'], 40)
        self.assertEqual(state['limits']['gold']['max'], 9999999)
        self.assertEqual(state['editLimits']['hp'], {'min': 0, 'max': 9999, 'integer': True})
        self.assertEqual(state['editLimits']['mp'], state['editLimits']['hp'])
        self.assertEqual(self.file.read_bytes(), raw)

    def test_lcf_each_edit_preserves_other_chunks_and_creates_exact_backup(self):
        old = self.file.read_bytes()
        result = self.modify('setGold', 5000)
        self.assertEqual(result['gold'], 5000)
        self.assertEqual(Path(result['saveFile']['backupPath']).read_bytes(), old)
        _, before = legacy.lcf_header(old, b'LcfSaveData')
        _, after = legacy.lcf_header(self.file.read_bytes(), b'LcfSaveData')
        for tag in [101, 108, 901]:
            self.assertEqual(after.get(tag), before.get(tag))
        self.assertEqual(self.modify('setSwitch', True, id=1)['switches'][0]['value'], True)
        self.assertEqual(self.modify('setVariable', -123, id=2)['variables'][1]['value'], -123)
        self.assertEqual(self.modify('setItem', 6, id=2, type='item')['items'][1]['count'], 6)
        self.assertEqual(self.modify('setHp', 99, id=1)['actors'][0]['hp'], 99)
        self.assertEqual(self.modify('setMp', 31, id=1)['actors'][0]['mp'], 31)
        _, final = legacy.lcf_header(self.file.read_bytes(), b'LcfSaveData')
        self.assertEqual(final.get(901), before.get(901))
        self.assertEqual(legacy.Chunks(final.get(101)).get(251), b'preserved system extension')
        self.assertEqual(legacy.records(final.get(108))[0][1].get(253), b'actor extension')

    def test_lcf_noop_reuses_original_and_rejects_stale_or_wrong_types(self):
        old = self.file.read_bytes()
        result = self.modify('setGold', 1234)
        self.assertNotIn('backupPath', result['saveFile'])
        self.assertFalse(result['changed'])
        self.assertFalse(result['backupCreated'])
        self.assertFalse((self.root / 'backups').exists())
        with self.assertRaisesRegex(ValueError, '存档已变化'):
            legacy.write({**self.args, 'expectedSha256': 'wrong', 'action': 'setGold', 'value': 4}, worker)
        for action, value, ident in [('setSwitch', 1, 1), ('setVariable', 2.5, 1), ('setItem', 100, 1), ('setVariable', 2, 99)]:
            with self.assertRaises(ValueError):
                self.modify(action, value, id=ident)
        self.assertEqual(self.file.read_bytes(), old)

    def test_read_stages_outside_save_directory_and_write_requires_fingerprint(self):
        original_temporary = legacy.tempfile.TemporaryDirectory
        dirs = []
        def temporary(*args, **kwargs):
            dirs.append(kwargs.get('dir'))
            return original_temporary(*args, **kwargs)
        with patch.object(legacy.tempfile, 'TemporaryDirectory', temporary):
            legacy.load(self.args, worker)
        self.assertEqual(dirs, [None])
        with self.assertRaisesRegex(ValueError, '存档已变化'):
            legacy.write({**self.args, 'action': 'setGold', 'value': 10}, worker)

    def test_backup_restore_exact_bytes_preserves_current_progress_and_binding(self):
        original = self.file.read_bytes()
        self.modify('setGold', 5000)
        middle = self.file.read_bytes()
        first = legacy.backups(self.args, worker)['backups'][0]
        self.modify('setGold', 7000)
        current = self.file.read_bytes()
        loaded = legacy.load(self.args, worker)
        restored = legacy.restore({**self.args, 'backupId': first['id'],
                                   'expectedSha256': loaded['saveFile']['sha256']}, worker)
        self.assertEqual(self.file.read_bytes(), original)
        self.assertEqual(restored['gold'], 1234)
        self.assertEqual(Path(restored['saveFile']['backupPath']).read_bytes(), current)
        listed = legacy.backups(self.args, worker)['backups']
        self.assertEqual(len(listed), 3)
        self.assertEqual({row['sha256'] for row in listed}, {legacy.digest(original), legacy.digest(middle), legacy.digest(current)})
        for binding in ({'projectId': 'other', 'buildId': 'build'}, {'projectId': 'project', 'buildId': 'new'}):
            self.assertEqual(legacy.backups({**self.args, 'binding': binding}, worker)['backups'], [])
        elsewhere = self.root / 'elsewhere' / self.file.name
        elsewhere.parent.mkdir()
        elsewhere.write_bytes(current)
        moved = {**self.args, 'filePath': str(elsewhere)}
        self.assertEqual(legacy.backups(moved, worker)['backups'], [])
        with self.assertRaises(ValueError):
            legacy.restore({**moved, 'backupId': first['id'], 'expectedSha256': legacy.digest(current)}, worker)
        self.assertEqual(elsewhere.read_bytes(), current)

    def test_restore_rejects_unbound_ids_stale_state_and_corrupt_backup(self):
        changed = self.modify('setGold', 5000)
        backup = legacy.backups(self.args, worker)['backups'][0]
        before = self.file.read_bytes()
        for extra in ({'expectedSha256': '0' * 64}, {'backupId': '../arbitrary'},
                      {'binding': {'projectId': 'other', 'buildId': 'build'}}):
            with self.assertRaises(ValueError):
                legacy.restore({**self.args, 'backupId': backup['id'],
                                'expectedSha256': changed['saveFile']['sha256'], **extra}, worker)
            self.assertEqual(self.file.read_bytes(), before)
        Path(changed['saveFile']['backupPath']).write_bytes(b'corrupt backup')
        with self.assertRaisesRegex(ValueError, '备份'):
            legacy.restore({**self.args, 'backupId': backup['id'],
                            'expectedSha256': changed['saveFile']['sha256']}, worker)
        self.assertEqual(self.file.read_bytes(), before)

    def test_restore_rechecks_current_file_after_saving_progress_backup(self):
        changed = self.modify('setGold', 5000)
        backup = legacy.backups(self.args, worker)['backups'][0]
        external = self.file.read_bytes() + b'external'
        actual_backup = legacy._backup
        def racing(*args, **kwargs):
            result = actual_backup(*args, **kwargs)
            self.file.write_bytes(external)
            return result
        with patch.object(legacy, '_backup', racing), self.assertRaisesRegex(ValueError, '游戏更新了存档'):
            legacy.restore({**self.args, 'backupId': backup['id'],
                            'expectedSha256': changed['saveFile']['sha256']}, worker)
        self.assertEqual(self.file.read_bytes(), external)

    def test_project_backup_list_survives_bad_receipts_and_missing_current_save(self):
        self.modify('setGold', 5000)
        self.modify('setGold', 7000)
        directory = Path(self.args['backupDir'])
        (directory / ('f' * 64 + '.json')).write_text('{broken', encoding='utf-8')
        self.file.unlink()
        args = {key: value for key, value in self.args.items() if key != 'filePath'}
        listed = legacy.backups(args, worker)
        good = [row for row in listed['backups'] if row['status'] == 'available']
        self.assertEqual(len(good), 2)
        self.assertTrue(all(row['targetAbsent'] for row in good))
        self.assertEqual(len([row for row in listed['backups'] if row['status'] == 'unavailable']), 1)
        self.assertNotIn('saveFile', listed)
        restored = legacy.restore({**args, 'backupId': good[0]['id'], 'expectedAbsent': True}, worker)
        self.assertTrue(restored['changed'])
        self.assertFalse(restored['backupCreated'])
        self.assertEqual(legacy.load(self.args, worker)['gold'], restored['gold'])

    def test_restore_corrupt_current_save_preserves_exact_bytes_without_decoding_it(self):
        self.modify('setGold', 5000)
        backup = legacy.backups(self.args, worker)['backups'][0]
        broken = b'broken current save\0\xff'
        self.file.write_bytes(broken)
        restored = legacy.restore({**self.args, 'backupId': backup['id'],
                                   'expectedSha256': legacy.digest(broken)}, worker)
        self.assertEqual(restored['gold'], 1234)
        self.assertEqual(Path(restored['saveFile']['backupPath']).read_bytes(), broken)
        self.assertTrue(restored['backupCreated'])
        listed = legacy.backups(self.args, worker)['backups']
        self.assertEqual(len([row for row in listed if row['status'] == 'unavailable']), 1)

    def test_absent_restore_rejects_a_new_target_and_does_not_overwrite_it(self):
        self.modify('setGold', 5000)
        backup = legacy.backups(self.args, worker)['backups'][0]
        self.file.unlink()
        self.file.write_bytes(b'new external progress')
        with self.assertRaisesRegex(ValueError, '存档已变化'):
            legacy.restore({**self.args, 'backupId': backup['id'], 'expectedAbsent': True}, worker)
        self.assertEqual(self.file.read_bytes(), b'new external progress')

    def test_absent_restore_rejects_target_created_at_final_publish(self):
        self.modify('setGold', 5000)
        backup = legacy.backups(self.args, worker)['backups'][0]
        self.file.unlink()
        publish_name = 'rename' if os.name == 'nt' else 'link'
        publish = getattr(legacy.os, publish_name)
        def racing(source, destination):
            self.file.write_bytes(b'new external progress')
            return publish(source, destination)
        with patch.object(legacy.os, publish_name, racing), self.assertRaisesRegex(ValueError, '存档已变化'):
            legacy.restore({**self.args, 'backupId': backup['id'], 'expectedAbsent': True}, worker)
        self.assertEqual(self.file.read_bytes(), b'new external progress')

    def test_empty_damaged_save_can_be_preserved_and_recovered(self):
        self.modify('setGold', 5000)
        backup = legacy.backups(self.args, worker)['backups'][0]
        self.file.write_bytes(b'')
        restored = legacy.restore({**self.args, 'backupId': backup['id'],
                                   'expectedSha256': legacy.digest(b'')}, worker)
        self.assertEqual(restored['gold'], 1234)
        self.assertEqual(Path(restored['saveFile']['backupPath']).read_bytes(), b'')
        self.assertTrue(restored['backupCreated'])

    def test_other_save_bad_receipt_does_not_hide_healthy_current_backups(self):
        self.modify('setGold', 5000)
        other = self.game / 'Save02.lsd'
        other.write_bytes(b'not a native save')
        legacy._backup({**self.args, 'filePath': str(other)}, other, legacy.LCF_ENGINE, other.read_bytes())
        listed = legacy.backups(self.args, worker)['backups']
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]['status'], 'available')

    def test_unbound_legacy_backups_stay_manual_and_invalid_native_backups_cannot_restore(self):
        raw = self.file.read_bytes()
        directory = Path(self.args['backupDir'])
        directory.mkdir()
        manual = directory / (legacy.digest(raw) + '-' + self.file.name + '.bak')
        manual.write_bytes(raw)
        self.assertEqual(legacy.backups(self.args, worker)['backups'], [])
        legacy._backup(self.args, self.file, legacy.LCF_ENGINE, b'not a native save')
        invalid = legacy.backups(self.args, worker)['backups'][0]
        with self.assertRaises(ValueError):
            legacy.restore({**self.args, 'backupId': invalid['id'], 'expectedSha256': legacy.digest(raw)}, worker)
        self.assertEqual(self.file.read_bytes(), raw)
        self.assertEqual(manual.read_bytes(), raw)

    def test_redecoded_target_must_match_requested_value(self):
        with patch.object(legacy.LcfSave, 'apply', lambda codec, args: self.file.read_bytes()), self.assertRaisesRegex(ValueError, '目标值重读不一致'):
            self.modify('setGold', 999)
        self.assertEqual(self.file.read_bytes(), lcf_fixture())
        self.assertFalse((self.root / 'backups').exists())

    def test_linked_save_and_ancestor_are_rejected(self):
        link = self.root / 'linked.lsd'
        try:
            link.symlink_to(self.file)
        except OSError:
            if os.name != 'nt':
                self.skipTest('Symbolic link creation is unavailable')
        else:
            with self.assertRaisesRegex(ValueError, '普通游戏目录'):
                legacy.load({**self.args, 'filePath': str(link)}, worker)
        directory = self.root / 'linked-directory'
        try:
            directory.symlink_to(self.game, target_is_directory=True)
        except OSError:
            environment = {**os.environ, 'PINHAO_TEST_LINK': str(directory), 'PINHAO_TEST_TARGET': str(self.game)}
            result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
                'New-Item -ItemType Junction -Path $env:PINHAO_TEST_LINK -Target $env:PINHAO_TEST_TARGET | Out-Null'],
                capture_output=True, env=environment, timeout=20)
            if result.returncode:
                self.skipTest('Link/junction creation is unavailable')
        with self.assertRaisesRegex(ValueError, '普通游戏目录'):
            legacy.load({**self.args, 'filePath': str(directory / self.file.name)}, worker)

    def test_link_preflight_checks_ancestors_before_resolution(self):
        linked = self.root / 'linked'
        with patch.object(Path, 'is_symlink', lambda path: path == linked), self.assertRaisesRegex(ValueError, '普通游戏目录'):
            legacy.load({**self.args, 'filePath': str(linked / self.file.name)}, worker)

    def test_cas_checks_again_before_atomic_replace(self):
        original = legacy.LcfSave.apply
        external = lcf_fixture() + b'external change'
        def racing(codec, args):
            changed = original(codec, args)
            self.file.write_bytes(external)
            return changed
        with patch.object(legacy.LcfSave, 'apply', racing), self.assertRaisesRegex(ValueError, '游戏更新了存档'):
            self.modify('setGold', 500)
        self.assertEqual(self.file.read_bytes(), external)
        self.assertEqual(next((self.root / 'backups').glob('*.bak')).read_bytes(), lcf_fixture())

    def test_lcf_native_easyrpg_codec_reads_changed_save(self):
        exe = worker.lcf_native.executable(worker.ROOT)
        if not exe:
            self.skipTest('Native liblcf codec is not installed')
        original = self.file.read_bytes()
        self.modify('setGold', 4321)
        self.modify('setVariable', -9, id=2)
        stage = self.root / 'independent'
        stage.mkdir()
        shutil.copyfile(self.file, stage / 'Save01.lsd')
        result = subprocess.run([str(exe), '--2k3', '--encoding', '932', 'Save01.lsd'], cwd=stage, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        xml = (stage / 'Save01.esd').read_text(encoding='utf-8')
        self.assertIn('<gold>4321</gold>', xml)
        self.assertIn('-9', xml)
        backup = next(row for row in legacy.backups(self.args, worker)['backups'] if row['sha256'] == legacy.digest(original))
        legacy.restore({**self.args, 'backupId': backup['id'], 'expectedSha256': legacy.digest(self.file.read_bytes())}, worker)
        self.assertEqual(self.file.read_bytes(), original)
        shutil.copyfile(self.file, stage / 'Save01.lsd')
        result = subprocess.run([str(exe), '--2k3', '--encoding', '932', 'Save01.lsd'], cwd=stage, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('<gold>1234</gold>', (stage / 'Save01.esd').read_text(encoding='utf-8'))

    def test_wolf_native_codec_roundtrip_numeric_and_string_values(self):
        if not legacy.wolf_executable(worker.ROOT):
            self.skipTest('WolfSave native codec is not installed')
        self.file = self.game / 'SaveData01.sav'
        self.file.write_bytes(wolf_fixture())
        self.args['filePath'] = str(self.file)
        self.args['engine'] = 'WOLF'
        state = legacy.load(self.args, worker)
        self.assertEqual([row['value'] for row in state['variables']], [123, -5, 'Neutral'])
        self.assertTrue(state['variables'][1]['name'].endswith('字段 2'))
        self.assertTrue(state['variables'][2]['name'].endswith('字段 1'))
        original = self.file.read_bytes()
        changed = self.modify('setVariable', -42, id=1)
        self.assertEqual(changed['variables'][0]['value'], -42)
        self.assertEqual(Path(changed['saveFile']['backupPath']).read_bytes(), original)
        changed = self.modify('setVariable', '中文\n标记', id=3)
        self.assertEqual(changed['variables'][2]['value'], '中文\n标记')
        self.assertEqual(changed['variables'][1]['value'], -5)
        with self.assertRaises(ValueError):
            self.modify('setVariable', 1, id=3)
        current = self.file.read_bytes()
        backup = next(row for row in legacy.backups(self.args, worker)['backups'] if row['sha256'] == legacy.digest(original))
        restored = legacy.restore({**self.args, 'backupId': backup['id'],
                                   'expectedSha256': changed['saveFile']['sha256']}, worker)
        self.assertEqual(self.file.read_bytes(), original)
        self.assertEqual(Path(restored['saveFile']['backupPath']).read_bytes(), current)
        self.assertEqual([row['value'] for row in restored['variables']], [123, -5, 'Neutral'])

    def test_wolf_upper_native_version_and_cp932_are_preserved(self):
        if not legacy.wolf_executable(worker.ROOT):
            self.skipTest('WolfSave native codec is not installed')
        self.file = self.game / 'SaveData02.sav'
        self.args.update(filePath=str(self.file), engine='WOLF')
        for version, utf8 in [(0x60, False), (0x8e, True)]:
            with self.subTest(version=version, utf8=utf8):
                self.file.write_bytes(wolf_fixture(utf8=utf8, version=version))
                self.assertEqual(self.modify('setVariable', -123, id=2)['variables'][1]['value'], -123)
                text = '中文' if utf8 else '名前'
                self.assertEqual(self.modify('setVariable', text, id=3)['variables'][2]['value'], text)
                if not utf8:
                    before = self.file.read_bytes()
                    with self.assertRaises(UnicodeEncodeError):
                        self.modify('setVariable', '汉', id=3)
                    self.assertEqual(before, self.file.read_bytes())

    def test_malformed_and_wrong_engine_are_readonly(self):
        self.file.write_bytes(b'bad save')
        with self.assertRaises(ValueError):
            legacy.load(self.args, worker)
        self.assertEqual(self.file.read_bytes(), b'bad save')
        self.assertTrue(legacy.available('RPG Maker 2000/2003'))
        self.assertFalse(legacy.available('Unrecognized'))


if __name__ == '__main__':
    unittest.main()
