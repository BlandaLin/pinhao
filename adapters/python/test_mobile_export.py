"""Neutral MV/MZ package fixtures; mobile device execution is a separate check."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import mobile_export
import worker
from test_rpgmaker import json_game


class MobileExportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='pinhao-mobile-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.game = self.root / 'original'

    def fixture(self, engine='MV', nested=False):
        runtime = json_game(self.game, engine, nested)
        (runtime / 'index.html').write_text('<html>neutral entry</html>', encoding='utf-8')
        for name, raw in {
            'Game.exe': b'neutral desktop runner', 'UnityPlayer.dll': b'neutral library',
            'resources.pak': b'neutral nw data', 'save/file1.rpgsave': b'private save',
            'logs/output.log': b'private log', 'fonts/PinHaoChinese.ttf': b'neutral font',
            'PinHao-build-report.json': b'{"privatePath":"local-only-fixture"}',
        }.items():
            path = self.game / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
        return runtime

    def snapshot(self):
        return {rel: worker.digest_file(path) for rel, path in worker.files_in(self.game)}

    def export(self, **args):
        return mobile_export.export({'sourceDir': str(self.game), 'filePath': str(self.root / 'mobile.rga'), **args}, worker)

    def put(self, runtime, relative, value):
        target = runtime / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(value if isinstance(value, bytes) else json.dumps(value).encode('utf-8'))

    def report(self, result):
        with zipfile.ZipFile(result['filePath']) as archive:
            self.assertIsNone(archive.testzip())
            return json.loads(archive.read('PinHao-mobile-report.json'))

    def test_flat_mv_and_nested_mz_preserve_entry_resources_and_font(self):
        for engine, nested in [('MV', False), ('MZ', True)]:
            with self.subTest(engine=engine):
                self.game = self.root / engine
                runtime = self.fixture(engine, nested)
                before = self.snapshot()
                output = self.root / (engine + '.rga')
                result = self.export(filePath=str(output), engine=engine, name='中性游戏', projectId='neutral-project')
                with zipfile.ZipFile(output) as archive:
                    names = archive.namelist()
                    self.assertEqual(len(names), len(set(names)))
                    entry = 'www/index.html' if nested else 'index.html'
                    self.assertIn('execFile=' + entry, archive.read('game.cfg').decode())
                    self.assertIn('type=html', archive.read('game.cfg').decode())
                    self.assertEqual(archive.read(entry), (runtime / 'index.html').read_bytes())
                    for rel in ('fonts/PinHaoChinese.ttf', 'www/data/Map001.json' if nested else 'data/Map001.json'):
                        self.assertEqual(archive.read(rel), (self.game / rel).read_bytes())
                    for rel in ('Game.exe', 'UnityPlayer.dll', 'resources.pak', 'save/file1.rpgsave', 'logs/output.log', 'PinHao-build-report.json'):
                        self.assertNotIn(rel, names)
                    report = json.loads(archive.read('PinHao-mobile-report.json'))
                    self.assertEqual(report['engine'], engine)
                    self.assertFalse(report['phoneRuntimeVerified'])
                    self.assertNotIn(str(self.game), json.dumps(report))
                    self.assertIsNone(archive.testzip())
                    self.assertEqual(result['files'], len(names))
                self.assertEqual(self.snapshot(), before)

    def test_desktop_api_warnings_only_scan_enabled_plugins(self):
        runtime = self.fixture()
        plugins = runtime / 'js/plugins'
        plugins.mkdir()
        for name in ('Active', 'Disabled', 'PinHaoRuntime'):
            (plugins / (name + '.js')).write_text('require("fs").readFileSync("neutral");', encoding='utf-8')
        (runtime / 'js/plugins.js').write_text('var $plugins = ' + json.dumps([
            {'name': 'Active', 'status': True}, {'name': 'Disabled', 'status': False},
            {'name': 'PinHaoRuntime', 'status': True},
        ]) + ';', encoding='utf-8')
        result = self.export()
        self.assertEqual(len(result['warnings']), 2)
        self.assertIn('Active.js', result['warnings'][0])
        self.assertIn('PinHaoRuntime.js', result['warnings'][1])
        with zipfile.ZipFile(result['filePath']) as archive:
            self.assertEqual(archive.read('js/plugins/Active.js'), (plugins / 'Active.js').read_bytes())

    def test_known_resource_fields_report_case_missing_and_source_attribution_without_repair(self):
        runtime = self.fixture()
        self.put(runtime, 'data/Actors.json', [None, {'id': 1, 'characterName': 'Hero', 'faceName': 'AbsentFace'}])
        self.put(runtime, 'img/characters/hero.png', b'neutral-image')
        before = self.snapshot()
        result = self.export()
        report = self.report(result)
        cases = [item for item in report['reviewItems'] if item['kind'] == 'resource-case-mismatch']
        missing = [item for item in report['reviewItems'] if item['kind'] == 'resource-missing-in-export-source']
        self.assertEqual(cases[0]['pointer'], '/1/characterName')
        self.assertEqual(cases[0]['candidates'], ['img/characters/hero.png'])
        self.assertEqual(missing[0]['pointer'], '/1/faceName')
        self.assertEqual(missing[0]['originalSourceAttribution'], 'unknown')
        self.assertFalse(cases[0]['automaticRepair'])
        self.assertEqual(report['resourcePreflight']['automaticRepairs'], [])
        self.assertEqual(self.snapshot(), before)
        with zipfile.ZipFile(result['filePath']) as archive:
            self.assertIn('img/characters/hero.png', archive.namelist())
            self.assertNotIn('img/characters/Hero.png', archive.namelist())

    def test_policy_excluded_dependency_is_distinct_from_already_missing_resource(self):
        runtime = self.fixture('MZ', nested=True)
        self.put(runtime, 'data/CommonEvents.json', [None, {'list': [
            {'code': 231, 'parameters': [1, 'mtool_neutral', 0]},
            {'code': 250, 'parameters': [{'name': 'AbsentSound'}]},
        ]}])
        self.put(runtime, 'img/pictures/mtool_neutral.png', b'neutral resource excluded by policy')
        report = self.report(self.export())
        excluded = next(item for item in report['reviewItems'] if item['kind'] == 'resource-excluded')
        missing = next(item for item in report['reviewItems'] if item['kind'] == 'resource-missing-in-export-source')
        self.assertEqual(excluded['candidates'], ['www/img/pictures/mtool_neutral.png'])
        self.assertEqual(excluded['exportSourceStatus'], 'present')
        self.assertEqual(missing['expected'], ['www/audio/se/AbsentSound.ogg', 'www/audio/se/AbsentSound.m4a'])
        self.assertEqual(missing['exportSourceStatus'], 'missing')
        self.assertEqual(excluded['originalSourceAttribution'], 'unknown')

    def test_case_ambiguity_probe_never_selects_a_candidate(self):
        runtime = self.fixture()
        self.put(runtime, 'data/Actors.json', [None, {'id': 1, 'characterName': 'Hero'}])
        self.put(runtime, 'img/characters/hero.png', b'neutral-image')
        entries = list(worker.files_in(self.game))
        # Exercise the index in memory; Windows source enumeration already rejects case collisions.
        entries.append(('img/characters/HERO.png', self.game / 'img/characters/hero.png'))
        result = mobile_export.mobile_preflight.inspect(self.game, runtime, 'MV', entries, entries,
                                                        {'plugins': [], 'unresolved': []})
        case = next(item for item in result['reviewItems'] if item['kind'] == 'resource-case-mismatch')
        self.assertTrue(case['ambiguousCaseMatch'])
        self.assertEqual(len(case['candidates']), 2)
        self.assertFalse(case['automaticRepair'])
        self.assertEqual(result['automaticRepairs'], [])

    def test_stock_activation_flags_exclude_dormant_fields_but_not_explicit_plugin_loads(self):
        for engine in ('MV', 'MZ'):
            self.game = self.root / engine
            runtime = self.fixture(engine)
            self.put(runtime, 'data/Actors.json', [None, {'id': 1, 'battlerName': 'NeutralActor'}])
            self.put(runtime, 'js/plugins/Loader.js', b'ImageManager.loadSvActor("ExplicitPluginLoad");')
            (runtime / 'js/plugins.js').write_text('var $plugins = [{"name":"Loader","status":true}];', encoding='utf-8')
            for active in (False, True):
                with self.subTest(engine=engine, active=active):
                    self.put(runtime, 'data/System.json', {'optSideView': active})
                    self.put(runtime, 'data/Map001.json', {'specifyBattleback': active,
                        'battleback1Name': 'NeutralBack1', 'battleback2Name': 'NeutralBack2',
                        'events': [None, {'pages': [{'list': [
                            {'code': 322, 'parameters': [1, '', 0, '', 0, 'NeutralActor']},
                        ]}]}]})
                    before = self.snapshot()
                    result = self.export(filePath=str(self.root / f'{engine}-{active}.rga'))
                    missing = [item for item in self.report(result)['reviewItems'] if item['kind'] == 'resource-missing-in-export-source']
                    data = [item for item in missing if item['file'].startswith('data/')]
                    plugin = [item for item in missing if item['file'].startswith('js/plugins/')]
                    self.assertEqual(len(data), 4 if active else 0)
                    self.assertEqual(len(plugin), 1)
                    self.assertEqual(self.snapshot(), before)

    def test_encrypted_ogg_header_is_inspected_in_memory_and_mobile_selection_stays_pending(self):
        runtime = self.fixture()
        key = bytes.fromhex('0123456789abcdef0123456789abcdef')
        payload = b'OggS' + bytes(60)
        encrypted = bytes.fromhex('5250474d560000000003010000000000') + bytes(
            value ^ key[index] for index, value in enumerate(payload[:16])) + payload[16:]
        self.put(runtime, 'data/System.json', {'hasEncryptedAudio': True, 'encryptionKey': key.hex(),
                                              'titleBgm': {'name': 'NeutralTheme'}})
        self.put(runtime, 'audio/bgm/NeutralTheme.rpgmvo', encrypted)
        before = self.snapshot()
        result = self.export()
        report = self.report(result)
        inventory = report['resourcePreflight']['audioInventory']
        self.assertEqual(inventory[0]['container'], 'ogg')
        self.assertEqual(inventory[0]['status'], 'matched')
        self.assertTrue(inventory[0]['encrypted'])
        self.assertFalse(inventory[0]['runtimeDecodeVerified'])
        self.assertIn('mobile-audio-selection-unverified', [item['kind'] for item in report['reviewItems']])
        self.assertFalse(report['phoneRuntimeVerified'])
        self.assertNotIn(key.hex(), json.dumps(report))
        self.assertEqual(self.snapshot(), before)
        with zipfile.ZipFile(result['filePath']) as archive:
            self.assertEqual(archive.read('audio/bgm/NeutralTheme.rpgmvo'), encrypted)
            self.assertNotIn('audio/bgm/NeutralTheme.rpgmvm', archive.namelist())

    def test_audio_header_mismatch_and_uninspectable_key_are_not_treated_as_compatible(self):
        runtime = self.fixture('MZ')
        self.put(runtime, 'audio/se/Wrong.m4a', b'OggS' + bytes(60))
        self.put(runtime, 'audio/se/Unknown.ogg_', bytes.fromhex('5250474d560000000003010000000000') + bytes(64))
        self.put(runtime, 'audio/se/Container.m4a', b'\x00\x00\x00\x18ftypM4A ' + bytes(64))
        report = self.report(self.export())
        by_file = {row['file']: row for row in report['resourcePreflight']['audioInventory']}
        self.assertEqual(by_file['audio/se/Wrong.m4a']['status'], 'mismatch')
        self.assertEqual(by_file['audio/se/Unknown.ogg_']['status'], 'unverified')
        self.assertEqual(by_file['audio/se/Unknown.ogg_']['reason'], 'encryption-key-unavailable')
        self.assertEqual(by_file['audio/se/Container.m4a']['container'], 'iso-bmff')
        self.assertFalse(by_file['audio/se/Container.m4a']['runtimeDecodeVerified'])

    def test_mobile_audio_variant_check_is_per_track_not_satisfied_by_another_track(self):
        runtime = self.fixture()
        for name in ('Paired', 'Unpaired'):
            self.put(runtime, 'audio/bgm/' + name + '.ogg', b'OggS' + bytes(60))
        self.put(runtime, 'audio/bgm/Paired.m4a', b'\x00\x00\x00\x18ftypM4A ' + bytes(64))
        report = self.report(self.export())
        pending = [item for item in report['reviewItems'] if item['kind'] == 'mobile-audio-selection-unverified']
        self.assertEqual([item['file'] for item in pending], ['audio/bgm/Unpaired.ogg'])
        self.assertEqual(pending[0]['expectedMobileVariant'], 'audio/bgm/Unpaired.m4a')

    def test_enabled_plugin_direct_and_dynamic_dependencies_are_distinguished(self):
        runtime = self.fixture()
        self.put(runtime, 'js/plugins/Loader.js', b'ImageManager.loadPicture("AbsentPicture");\n'
                 b'ImageManager.loadCharacter("Hero" + "_Dying");\n'
                 b'AudioManager.createBuffer("se", "AbsentSound");\n'
                 b'AudioManager.playBgm(currentTrack);')
        self.put(runtime, 'js/plugins/Disabled.js', b'ImageManager.loadPicture("NotEnabled");')
        (runtime / 'js/plugins.js').write_text('var $plugins = ' + json.dumps([
            {'name': 'Loader', 'status': True}, {'name': 'Disabled', 'status': False}]) + ';', encoding='utf-8')
        report = self.report(self.export())
        unresolved = [item for item in report['reviewItems'] if item['kind'] == 'dynamic-resource-unresolved']
        self.assertEqual([item['pointer'] for item in unresolved], ['line:2', 'line:4'])
        self.assertTrue(all(item['file'] == 'js/plugins/Loader.js' for item in unresolved))
        missing = [item for item in report['reviewItems'] if item['kind'] == 'resource-missing-in-export-source']
        self.assertEqual(len(missing), 2)
        self.assertNotIn('NotEnabled', json.dumps(report))

    def test_plugin_comment_examples_are_not_dependencies_and_templates_stay_unresolved(self):
        runtime = self.fixture()
        self.put(runtime, 'js/plugins/Loader.js', b'// ImageManager.loadPicture("CommentOnly");\n'
                 b'var example = \'ImageManager.loadPicture("StringOnly")\';\n'
                 b'var dynamic = `${ImageManager.loadPicture("TemplatePicture")}`;\n'
                 b'ImageManager.loadPicture("RealPicture");')
        (runtime / 'js/plugins.js').write_text('var $plugins = [{"name":"Loader","status":true}];', encoding='utf-8')
        report = self.report(self.export())
        missing = [item for item in report['reviewItems'] if item['kind'] == 'resource-missing-in-export-source']
        unresolved = [item for item in report['reviewItems'] if item['kind'] == 'dynamic-resource-unresolved']
        self.assertEqual(len(missing), 1)
        self.assertEqual(missing[0]['pointer'], 'line:4')
        self.assertEqual(unresolved[0]['pointer'], 'line:3')
        self.assertEqual(unresolved[0]['call'], 'template-resource-expression')
        self.assertNotIn('CommentOnly', json.dumps(report))
        self.assertNotIn('StringOnly', json.dumps(report))

    def test_legacy_owned_plugin_registrations_are_included_in_phone_review(self):
        runtime = self.fixture()
        fixtures = json.loads((Path(__file__).resolve().parents[2] / 'packages/runtime/fixtures/rpgmaker-plugin-manifests.json').read_text(encoding='utf-8'))
        legacy = next(item['source'] for item in fixtures if item['name'] == 'both-legacy-blocks')
        (runtime / 'js/plugins.js').write_text(legacy, encoding='utf-8')
        for name in ('Alpha', 'PinHaoLocalization', 'PinhaoAssist'):
            self.put(runtime, 'js/plugins/' + name + '.js', b'require("fs");' if name == 'PinhaoAssist' else b'void 0;')
        result = self.export()
        report = self.report(result)
        self.assertEqual(len(result['warnings']), 1)
        self.assertIn('PinhaoAssist.js', result['warnings'][0])
        self.assertNotIn('plugin-manifest-unresolved', [item['kind'] for item in report['reviewItems']])

    def test_invalid_json_and_dynamic_manifest_are_explicitly_unresolved(self):
        runtime = self.fixture()
        self.put(runtime, 'data/Actors.json', b'{not valid json')
        (runtime / 'js/plugins.js').write_text('var $plugins = []; $plugins.push(runtimeDescriptor);', encoding='utf-8')
        report = self.report(self.export())
        kinds = {item['kind'] for item in report['reviewItems']}
        self.assertIn('data-json-unresolved', kinds)
        self.assertIn('plugin-manifest-unresolved', kinds)
        self.assertFalse(report['phoneRuntimeVerified'])

    def test_config_values_are_single_line_and_generated_members_replace_old_reports(self):
        self.fixture()
        (self.game / 'game.cfg').write_text('private old configuration', encoding='utf-8')
        (self.game / 'PinHao-mobile-report.json').write_text('old private report', encoding='utf-8')
        result = self.export(name='中性\ntype=bad\r\n\x00标题', projectId='a/b private identifier')
        with zipfile.ZipFile(result['filePath']) as archive:
            config = archive.read('game.cfg').decode()
            self.assertEqual(sum(line.startswith('type=') for line in config.splitlines()), 1)
            self.assertIn('type=html', config)
            self.assertNotIn('\x00', config)
            ident = next(line[3:] for line in config.splitlines() if line.startswith('id='))
            self.assertTrue(ident.isalnum())
            self.assertNotIn('private old', config)

    def test_existing_output_and_source_overlap_keep_existing_files(self):
        self.fixture()
        output = self.root / 'mobile.rga'
        output.write_bytes(b'existing result')
        with self.assertRaises(worker.WorkerError):
            self.export()
        self.assertEqual(output.read_bytes(), b'existing result')
        with self.assertRaises(worker.WorkerError):
            self.export(filePath=str(self.game / 'mobile.rga'))
        self.assertFalse((self.game / 'mobile.rga').exists())

    def test_wrong_engine_and_missing_entry_produce_no_archive(self):
        runtime = self.fixture()
        with self.assertRaisesRegex(worker.WorkerError, 'MV'):
            self.export(engine='MZ')
        (runtime / 'index.html').unlink()
        with self.assertRaisesRegex(worker.WorkerError, 'index.html'):
            self.export()
        self.assertFalse((self.root / 'mobile.rga').exists())

    def test_failed_archive_is_removed_and_original_stays_identical(self):
        self.fixture()
        before = self.snapshot()
        with patch.object(zipfile.ZipFile, 'write', side_effect=OSError('neutral write failure')):
            with self.assertRaisesRegex(OSError, 'neutral write failure'):
                self.export()
        self.assertFalse((self.root / 'mobile.rga').exists())
        self.assertEqual(self.snapshot(), before)


if __name__ == '__main__':
    unittest.main()
