"""Native save assistance for LCF and WOLF; source bytes remain backed up.

LCF field identifiers follow EasyRPG/liblcf's public format definitions.
WOLF uses Sinflower/WolfSave v0.1.0 (MIT) as its native save codec.
"""
from __future__ import annotations

import copy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import tempfile

import lcf_native

ROOT = Path(__file__).resolve().parents[2]
LCF_ENGINE = 'RPG Maker 2000/2003'
WOLF_SHA256 = 'bf05866896bf7a41211842a20c56581f8707c7c1a08a538d28bcf271525cf020'
MAX_SAVE = 64 * 1024 * 1024


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def wolf_executable(root=ROOT):
    configured = os.environ.get('PINHAO_WOLFSAVE')
    candidates = ([Path(configured)] if configured else []) + [
        Path(root) / 'local/dependencies/wolfsave/WolfSave.exe',
        Path(__file__).parent / 'vendor/wolfsave/WolfSave.exe']
    return next((file.resolve() for file in candidates if file.is_file()), None)


def available(engine, helpers=None):
    if engine in (LCF_ENGINE, 'RPG Maker 2000', 'RPG Maker 2003', '2000', '2003'):
        return True
    return engine == 'WOLF' and wolf_executable(getattr(helpers, 'ROOT', ROOT)) is not None


def ber(value):
    value &= 0xffffffff
    result = [value & 0x7f]
    value >>= 7
    while value:
        result.append((value & 0x7f) | 0x80)
        value >>= 7
    return bytes(reversed(result))


def read_ber(raw, offset=0):
    value = 0
    for _ in range(5):
        if offset >= len(raw):
            raise ValueError('LCF 数据不完整')
        byte = raw[offset]
        offset += 1
        value = (value << 7) | (byte & 0x7f)
        if not byte & 0x80:
            if value > 0xffffffff:
                break
            return value, offset
    raise ValueError('LCF 整数编码无效')


class Chunks:
    def __init__(self, raw):
        self.entries, self.end = [], b''
        offset, seen = 0, set()
        while offset < len(raw):
            start = offset
            tag, offset = read_ber(raw, offset)
            if tag == 0:
                self.end = raw[start:]
                if self.end != b'\0':
                    raise ValueError('LCF 结束标记后仍有数据')
                break
            length, offset = read_ber(raw, offset)
            if tag in seen or offset + length > len(raw):
                raise ValueError('LCF 字段重复或超出文件边界')
            seen.add(tag)
            self.entries.append([tag, raw[offset:offset + length], raw[start:offset + length], None])
            offset += length

    def get(self, tag, default=b''):
        entry = next((entry for entry in self.entries if entry[0] == tag), None)
        return entry[1] if entry else default

    def set(self, tag, value):
        entry = next((entry for entry in self.entries if entry[0] == tag), None)
        if entry:
            if entry[1] != value:
                entry[1], entry[3] = value, True
        else:
            self.entries.append([tag, value, b'', True])

    def integer(self, tag, default=0):
        raw = self.get(tag)
        if not raw:
            return default
        result, offset = read_ber(raw)
        if offset != len(raw):
            raise ValueError('LCF 标量字段长度无效')
        return result if result < 0x80000000 else result - 0x100000000

    def dump(self):
        return b''.join(ber(tag) + ber(len(raw)) + raw if changed else original
                        for tag, raw, original, changed in self.entries) + self.end


def records(raw):
    if not raw:
        return []
    count, offset = read_ber(raw)
    if count > 100000:
        raise ValueError('LCF 记录数量超出范围')
    result, seen = [], set()
    for _ in range(count):
        ident, offset = read_ber(raw, offset)
        if ident < 1 or ident in seen:
            raise ValueError('LCF 记录 ID 无效')
        seen.add(ident)
        start = offset
        while True:
            tag, offset = read_ber(raw, offset)
            if tag == 0:
                break
            size, offset = read_ber(raw, offset)
            if offset + size > len(raw):
                raise ValueError('LCF 记录字段不完整')
            offset += size
        result.append((ident, Chunks(raw[start:offset])))
    if offset != len(raw):
        raise ValueError('LCF 记录末尾有未知数据')
    return result


def dump_records(rows):
    return ber(len(rows)) + b''.join(ber(ident) + fields.dump() for ident, fields in rows)


def lcf_header(raw, signature):
    size, offset = read_ber(raw)
    if raw[offset:offset + size] != signature:
        raise ValueError('请选择标准 LCF 存档文件')
    return raw[:offset + size], Chunks(raw[offset + size:])


def int_array(raw, size):
    if len(raw) % size:
        raise ValueError('LCF 数组长度无效')
    return list(struct.unpack('<' + {1: 'B', 2: 'H', 4: 'i'}[size] * (len(raw) // size), raw))


def array_bytes(values, size):
    return struct.pack('<' + {1: 'B', 2: 'H', 4: 'i'}[size] * len(values), *values)


def integer(value, low, high):
    if type(value) is not int or not low <= value <= high:
        raise ValueError('请输入范围内的整数：%s–%s' % (low, high))
    return value


class LcfSave:
    def __init__(self, raw, directory, encoding):
        self.header, self.top = lcf_header(raw, b'LcfSaveData')
        self.system = Chunks(self.top.get(101))
        self.inventory = Chunks(self.top.get(109))
        self.actors = records(self.top.get(108))
        self.encoding, self.names = encoding, {}
        database = Path(directory) / 'RPG_RT.ldb'
        if database.is_file():
            _, tables = lcf_header(database.read_bytes(), b'LcfDataBase')
            for category, tag in [('actors', 11), ('items', 13), ('switches', 23), ('variables', 24)]:
                self.names[category] = {ident: fields.get(1).decode(encoding, errors='replace')
                                        for ident, fields in records(tables.get(tag))}
        self.switches = int_array(self.system.get(32), 1)
        self.variables = int_array(self.system.get(34), 4)
        self.ids = int_array(self.inventory.get(12), 2)
        self.counts = int_array(self.inventory.get(13), 1)
        self.usage = int_array(self.inventory.get(14), 1)
        if len(self.ids) != len(self.counts) or len(set(self.ids)) != len(self.ids) or self.usage and len(self.usage) != len(self.ids):
            raise ValueError('物品数组长度不一致，请保留原存档')
        for values, size_tag in [(self.switches, 31), (self.variables, 33)]:
            if self.system.integer(size_tag, len(values)) != len(values):
                raise ValueError('开关或变量数量与原生数组不一致')

    def label(self, category, ident):
        return self.names.get(category, {}).get(ident) or '%s %d' % ({'actors': '角色', 'items': '物品', 'switches': '开关', 'variables': '变量'}[category], ident)

    def state(self):
        item_counts = dict(zip(self.ids, self.counts))
        item_ids = sorted(set(self.names.get('items', {})) | set(self.ids))
        actions = ['setGold', 'setItem', 'setSwitch', 'setVariable']
        if self.actors:
            actions += ['setHp', 'setMp']
        return {'engine': LCF_ENGINE, 'mode': 'save', 'ready': True, 'connected': True, 'actions': actions,
                'gold': self.inventory.integer(21),
                'limits': {'gold': {'min': 0, 'max': 9999999, 'integer': True}},
                'editLimits': {name: {'min': 0, 'max': 9999, 'integer': True} for name in ('hp', 'mp')},
                'items': [{'id': ident, 'type': 'item', 'name': self.label('items', ident), 'count': item_counts.get(ident, 0),
                           'min': 0, 'max': 99, 'integer': True} for ident in item_ids],
                'switches': [{'id': ident, 'name': self.label('switches', ident), 'value': bool(value)} for ident, value in enumerate(self.switches, 1)],
                'variables': [{'id': ident, 'name': self.label('variables', ident), 'value': value, 'min': -2147483648,
                               'max': 2147483647, 'integer': True} for ident, value in enumerate(self.variables, 1)],
                'actors': [{'id': ident, 'name': fields.get(1).decode(self.encoding, errors='replace') or self.label('actors', ident),
                            'level': fields.integer(31, 1), 'exp': fields.integer(32), 'hp': fields.integer(71), 'mp': fields.integer(72)}
                           for ident, fields in self.actors]}

    def apply(self, args):
        action, value, ident = args.get('action'), args.get('value'), args.get('id')
        if action == 'setGold':
            self.inventory.set(21, ber(integer(value, 0, 9999999)))
            self.top.set(109, self.inventory.dump())
        elif action in ('setSwitch', 'setVariable'):
            values = self.switches if action == 'setSwitch' else self.variables
            integer(ident, 1, len(values))
            if action == 'setSwitch':
                if type(value) is not bool:
                    raise ValueError('开关值需要为布尔值')
                values[ident - 1] = int(value)
            else:
                values[ident - 1] = integer(value, -2147483648, 2147483647)
            self.system.set(32 if action == 'setSwitch' else 34, array_bytes(values, 1 if action == 'setSwitch' else 4))
            self.top.set(101, self.system.dump())
        elif action == 'setItem':
            integer(ident, 1, 32767)
            integer(value, 0, 99)
            if args.get('type', 'item') != 'item' or ident not in {row['id'] for row in self.state()['items']}:
                raise ValueError('请选择物品列表中的条目')
            if ident in self.ids:
                self.counts[self.ids.index(ident)] = value
            else:
                self.ids.append(ident)
                self.counts.append(value)
                if self.usage:
                    self.usage.append(0)
            self.inventory.set(11, ber(len(self.ids)))
            for tag, values, size in [(12, self.ids, 2), (13, self.counts, 1), (14, self.usage, 1)]:
                if tag != 14 or values:
                    self.inventory.set(tag, array_bytes(values, size))
            self.top.set(109, self.inventory.dump())
        elif action in ('setHp', 'setMp'):
            integer(ident, 1, 32767)
            field = next((fields for actor_id, fields in self.actors if actor_id == ident), None)
            if field is None:
                raise ValueError('请选择存档中的角色')
            field.set(71 if action == 'setHp' else 72, ber(integer(value, 0, 9999)))
            self.top.set(108, dump_records(self.actors))
        else:
            raise ValueError('请选择此存档提供的辅助操作')
        return self.header + self.top.dump()


def wolf_tool(exe, file):
    result = subprocess.run([str(exe), file.name], cwd=file.parent, capture_output=True, timeout=120,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    target = file.with_suffix('.json' if file.suffix == '.sav' else '.sav_new')
    if result.returncode or not target.is_file():
        raise ValueError('WolfSave 未能读取此版本存档，请保留原文件')
    return target


def wolf_crypt(raw):
    """The public WOLF format's three MSVCRT-rand XOR streams are symmetric."""
    data = bytearray(raw)
    for seed, step in [(data[0], 1), (data[3], 2), (data[9], 5)]:
        for offset in range(20, len(data), step):
            seed = (seed * 214013 + 2531011) & 0xffffffff
            data[offset] ^= (seed >> 28) & 7
    return data


class WolfSave:
    def __init__(self, raw, exe, stage):
        self.exe, self.stage = exe, Path(stage)
        file = self.stage / 'input.sav'
        file.write_bytes(raw)
        self.document = json.loads(wolf_tool(exe, file).read_text(encoding='utf-8'))
        self.original = copy.deepcopy(self.document)
        self.targets = []
        section = self.document.get('SavePart6_#1')
        if not isinstance(section, dict):
            raise ValueError('WOLF 存档缺少标准可变数据库')
        type_index = 0
        for category, fields in section.items():
            if not category.startswith('SavePart6_1_#') or not isinstance(fields, dict):
                continue
            configuration = next((metadata['value'] for metadata in fields.values()
                                  if isinstance(metadata, dict) and isinstance(metadata.get('value'), list)), [])
            field_ids = {False: [index for index, kind in enumerate(configuration) if kind < 2000],
                         True: [index for index, kind in enumerate(configuration) if kind >= 2000]}
            row_index = 0
            for row_name, row in fields.items():
                if not row_name.startswith('SavePart6_1_1_#') or not isinstance(row, dict):
                    continue
                for field_name, metadata in row.items():
                    if not isinstance(metadata, dict) or metadata.get('flags') or not isinstance(metadata.get('value'), list):
                        continue
                    for index, value in enumerate(metadata['value']):
                        if type(value) not in (str, int):
                            continue
                        ids = field_ids[type(value) is str]
                        if index >= len(ids):
                            raise ValueError('WOLF 可变数据库字段配置与存档不一致')
                        self.targets.append((metadata['value'], index, (type_index, row_index, ids[index]), value))
                row_index += 1
            type_index += 1

    def state(self):
        rows = []
        for ident, (values, index, names, original) in enumerate(self.targets, 1):
            value = values[index]
            if type(value) is int and value >= 0x80000000:
                value -= 0x100000000
            label = '可变数据库 / 类型 %d / 记录 %d / 字段 %d' % names
            row = {'id': ident, 'name': label, 'value': value}
            if type(value) is int:
                row.update(min=-2147483648, max=2147483647, integer=True)
            rows.append(row)
        return {'engine': 'WOLF', 'mode': 'save', 'ready': True, 'connected': True, 'actions': ['setVariable'], 'variables': rows}

    def encode(self, document, name):
        file = self.stage / (name + '.json')
        file.write_text(json.dumps(document, ensure_ascii=True, separators=(',', ':')), encoding='utf-8')
        raw = wolf_tool(self.exe, file).read_bytes()
        part1 = document.get('SavePart1_#1', {})
        if part1.get('var_#5', {}).get('value') == 0xffffffff:
            # Upstream v0.1.0 reads this sentinel into local v6 but its writer
            # tests the fresh object's m_var6, dropping the four-byte marker.
            plain = wolf_crypt(raw)
            name_size = struct.unpack_from('<H', plain, 21)[0]
            offset = 23 + name_size + 2 + 20
            if plain[offset:offset + 4] != b'\xff' * 4:
                plain[offset:offset] = b'\xff' * 4
                plain[2] = sum(plain[20:]) & 255
                raw = bytes(wolf_crypt(plain))
        return raw

    def apply(self, args, original_raw):
        if self.encode(self.original, 'baseline') != original_raw:
            raise ValueError('此存档的无改动往返存在差异，请保留原文件')
        if args.get('action') != 'setVariable':
            raise ValueError('请选择 WOLF 可变数据库中的数值或文字')
        ident = integer(args.get('id'), 1, len(self.targets))
        values, index, _, original = self.targets[ident - 1]
        value = args.get('value')
        if type(original) is str:
            if not isinstance(value, str) or len(value) > 2000 or '\0' in value:
                raise ValueError('文字长度上限为 2000，使用普通文字字符')
            # WolfSave v0.1.0 uses CP932 for legacy non-UTF8 save strings.
            header = self.document.get('Header_#1', {})
            if header.get('var_#1', {}).get('value') is False:
                value.encode('cp932')
            values[index] = value
        else:
            values[index] = integer(value, -2147483648, 2147483647) & 0xffffffff
        raw = self.encode(self.document, 'changed')
        check = WolfSave(raw, self.exe, self.stage)
        expected = copy.deepcopy(self.document)
        # The native writer updates the checksum in the fixed 20-byte header.
        expected['Header_#1']['var_#0']['value'][2] = check.document['Header_#1']['var_#0']['value'][2]
        if check.document != expected:
            raise ValueError('WOLF 存档修改后重读不一致')
        return raw


def clean_path(value):
    path = Path(value)
    for entry in (path, *path.parents):
        if entry.is_symlink() or getattr(entry, 'is_junction', lambda: False)():
            raise ValueError('请选择普通游戏目录中的存档文件')
    return path


def _file_engine(args, file):
    engine = LCF_ENGINE if file.suffix.lower() == '.lsd' else 'WOLF' if file.suffix.lower() == '.sav' else None
    allowed = ('WOLF',) if engine == 'WOLF' else (LCF_ENGINE, 'RPG Maker 2000', 'RPG Maker 2003', '2000', '2003')
    if engine is None or args.get('engine') and args['engine'] not in allowed:
        raise ValueError('请选择当前引擎对应的存档文件')
    return engine


def _input(args):
    file = clean_path(args['filePath']).resolve(strict=True)
    if not file.is_file() or not 0 < file.stat().st_size <= MAX_SAVE:
        raise ValueError('请选择有效的游戏存档文件')
    raw = file.read_bytes()
    engine = _file_engine(args, file)
    return file, raw, engine


def _codec(args, helpers, raw, engine, stage):
    if engine == LCF_ENGINE:
        directory = Path(args['outputDir'])
        encoding = str(args.get('encoding') or lcf_native.source_encoding(directory, args))
        encoding = {'932': 'cp932', '936': 'gbk', '65001': 'utf-8'}.get(encoding, encoding)
        return LcfSave(raw, directory, encoding)
    exe = wolf_executable(getattr(helpers, 'ROOT', ROOT))
    if exe is None:
        raise ValueError('请准备 WolfSave 原生存档组件')
    return WolfSave(raw, exe, stage)


def _state(codec, file, raw, backup=None, *, changed=False, backup_created=False):
    state = codec.state()
    state.update(changed=changed, backupCreated=backup_created)
    state['saveFile'] = {'path': str(file), 'sha256': digest(raw)}
    if backup:
        state['saveFile']['backupPath'] = str(backup)
    return state


def load(args, helpers=None):
    file, raw, engine = _input(args)
    with tempfile.TemporaryDirectory(prefix='pinhao-save-') as stage:
        return _state(_codec(args, helpers, raw, engine, stage), file, raw)


def _expected(args, raw):
    expected = args.get('expectedSha256')
    if not isinstance(expected, str) or not re.fullmatch(r'[0-9a-f]{64}', expected) or expected != digest(raw):
        raise ValueError('存档已变化，请重新读取后再修改')


def _project_binding(args):
    value = args.get('binding')
    if not isinstance(value, dict) or not isinstance(value.get('projectId'), str) or not value['projectId'] or value.get('buildId') is not None and not isinstance(value['buildId'], str):
        raise ValueError('存档备份缺少当前工程绑定，请重新选择存档')
    return {key: value.get(key) for key in ('projectId', 'buildId')}


def _binding(args, file, engine):
    return {**_project_binding(args),
            'filePath': os.path.normcase(str(file)), 'engine': engine}


def _backup_id(binding, sha):
    return digest(json.dumps([binding, sha], ensure_ascii=True, sort_keys=True).encode('ascii'))


def _read_backup(args, file, engine, ident, record=None):
    if not isinstance(ident, str) or not re.fullmatch(r'[0-9a-f]{64}', ident):
        raise ValueError('请选择当前存档提供的备份记录')
    directory = clean_path(args['backupDir']).resolve()
    if record is None:
        try:
            record = json.loads(clean_path(directory / (ident + '.json')).read_text(encoding='utf-8'))
        except (FileNotFoundError, json.JSONDecodeError, UnicodeDecodeError) as error:
            raise ValueError('备份记录缺失或损坏，请重新选择备份并保留原文件') from error
    if not isinstance(record, dict):
        raise ValueError('备份记录无效，请保留原文件')
    binding, sha = _binding(args, file, engine), record.get('sha256')
    if record.get('schema') != 'pinhao-save-backup-v1' or record.get('binding') != binding or not isinstance(sha, str) or not re.fullmatch(r'[0-9a-f]{64}', sha) or record.get('id') != ident or _backup_id(binding, sha) != ident:
        raise ValueError('备份不属于当前存档与成品，请重新选择')
    backup = clean_path(directory / (sha + '-' + file.name + '.bak'))
    if not backup.is_file() or not 0 <= backup.stat().st_size <= MAX_SAVE:
        raise ValueError('备份文件缺失或大小无效，请保留现有存档')
    raw = backup.read_bytes()
    if digest(raw) != sha or record.get('bytes') != len(raw):
        raise ValueError('备份文件校验不一致，请保留现有存档')
    return record, backup, raw


def _backup(args, file, engine, raw, *, with_created=False):
    directory = clean_path(args['backupDir']).resolve()
    binding, sha = _binding(args, file, engine), digest(raw)
    directory.mkdir(parents=True, exist_ok=True)
    backup = clean_path(directory / (sha + '-' + file.name + '.bak'))
    created = not backup.exists()
    if created:
        with backup.open('xb') as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
    elif digest(backup.read_bytes()) != sha:
        raise ValueError('备份文件校验不一致，请选择新的备份目录')
    ident = _backup_id(binding, sha)
    receipt = clean_path(directory / (ident + '.json'))
    if not receipt.exists():
        record = {'schema': 'pinhao-save-backup-v1', 'id': ident, 'binding': binding,
                  'sha256': sha, 'bytes': len(raw), 'createdAt': datetime.now(timezone.utc).isoformat()}
        handle, temporary = tempfile.mkstemp(prefix='.pinhao-receipt-', dir=directory)
        try:
            with os.fdopen(handle, 'w', encoding='utf-8') as output:
                json.dump(record, output, ensure_ascii=True)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, receipt)
        finally:
            Path(temporary).unlink(missing_ok=True)
    _read_backup(args, file, engine, ident)
    return (backup, created) if with_created else backup


def _record_file(args, record):
    binding = record.get('binding') if isinstance(record, dict) else None
    if not isinstance(binding, dict) or not isinstance(binding.get('filePath'), str) or not Path(binding['filePath']).is_absolute():
        raise ValueError('备份记录缺少原存档路径，请保留原文件')
    file = clean_path(binding['filePath']).resolve()
    return file, _file_engine(args, file)


def _current_bytes(file):
    try:
        info = clean_path(file).stat()
    except FileNotFoundError:
        return None
    if not file.is_file() or not 0 <= info.st_size <= MAX_SAVE:
        raise ValueError('当前存档大小或类型无效，请先保留原文件')
    raw = file.read_bytes()
    if len(raw) > MAX_SAVE:
        raise ValueError('当前存档大小无效，请先保留原文件')
    return raw


def backups(args, helpers=None):
    project_binding = _project_binding(args)
    selected = clean_path(args['filePath']).resolve() if args.get('filePath') else None
    directory = clean_path(args['backupDir']).resolve()
    rows = []
    for receipt in directory.glob('*.json'):
        if not re.fullmatch(r'[0-9a-f]{64}\.json', receipt.name):
            continue
        row = {'id': receipt.stem, 'status': 'unavailable'}
        try:
            record = json.loads(clean_path(receipt).read_text(encoding='utf-8'))
            binding = record.get('binding') if isinstance(record, dict) else None
            if isinstance(binding, dict) and {key: binding.get(key) for key in project_binding} != project_binding:
                continue
            file, engine = _record_file(args, record)
            if selected is not None and file != selected:
                continue
            record, _, raw = _read_backup(args, file, engine, receipt.stem, record)
            row.update({key: record[key] for key in ('createdAt', 'sha256', 'bytes')})
            row['filePath'] = str(file)
            with tempfile.TemporaryDirectory(prefix='pinhao-backup-check-') as stage:
                _codec(args, helpers, raw, engine, stage)
            current = _current_bytes(file)
            row.update(status='available', targetAbsent=current is None)
            if current is not None:
                row['currentSha256'] = digest(current)
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError, struct.error) as error:
            row['error'] = str(error)
        rows.append(row)
    result = {'backups': sorted(rows, key=lambda row: (row.get('createdAt', ''), row['id']), reverse=True)}
    if selected is not None:
        raw = _current_bytes(selected)
        if raw is not None:
            result['saveFile'] = {'path': str(selected), 'sha256': digest(raw)}
    return result


def _replace(args, file, engine, raw, changed, stage):
    backup, backup_created = _backup(args, file, engine, raw, with_created=True) if raw is not None else (None, False)
    temporary = Path(stage) / 'validated-save.tmp'
    with temporary.open('wb') as output:
        output.write(changed)
        output.flush()
        os.fsync(output.fileno())
    clean_path(file)
    clean_path(args['backupDir'])
    if _current_bytes(file) != raw:
        raise ValueError('游戏更新了存档，请关闭游戏并重新读取')
    if raw is None:
        # Publish exclusively: a save appearing after the comparison must survive.
        try:
            if os.name == 'nt':
                os.rename(temporary, file)
            else:
                os.link(temporary, file)
                temporary.unlink()
        except FileExistsError as error:
            raise ValueError('存档已变化，请重新读取后再恢复') from error
    else:
        os.replace(temporary, file)
    return backup, backup_created


def restore(args, helpers=None):
    ident = args.get('backupId')
    if not isinstance(ident, str) or not re.fullmatch(r'[0-9a-f]{64}', ident):
        raise ValueError('请选择当前存档提供的备份记录')
    directory = clean_path(args['backupDir']).resolve()
    try:
        record = json.loads(clean_path(directory / (ident + '.json')).read_text(encoding='utf-8'))
    except (FileNotFoundError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ValueError('备份记录缺失或损坏，请保留原文件') from error
    file, engine = _record_file(args, record)
    if args.get('filePath') and clean_path(args['filePath']).resolve() != file:
        raise ValueError('备份不属于当前存档与成品，请重新选择')
    _, _, changed = _read_backup(args, file, engine, args.get('backupId'))
    raw = _current_bytes(file)
    if args.get('expectedAbsent') is True:
        if raw is not None or args.get('expectedSha256') is not None:
            raise ValueError('存档已变化，请重新读取后再恢复')
    elif raw is None:
        raise ValueError('存档已变化，请确认目标不存在后再恢复')
    else:
        _expected(args, raw)
    with tempfile.TemporaryDirectory(prefix='pinhao-save-', dir=file.parent) as stage:
        verified = _codec(args, helpers, changed, engine, stage)
        if changed == raw:
            return _state(verified, file, raw)
        backup, backup_created = _replace(args, file, engine, raw, changed, stage)
        actual = file.read_bytes()
        if actual != changed:
            raise ValueError('恢复后的存档已发生变化，当前进度备份仍保留')
        return _state(_codec(args, helpers, actual, engine, stage), file, actual, backup,
                      changed=True, backup_created=backup_created)


def write(args, helpers=None):
    file, raw, engine = _input(args)
    _expected(args, raw)
    with tempfile.TemporaryDirectory(prefix='pinhao-save-', dir=file.parent) as stage:
        codec = _codec(args, helpers, raw, engine, stage)
        changed = codec.apply(args, raw) if engine == 'WOLF' else codec.apply(args)
        verified = _codec(args, helpers, changed, engine, stage)
        state = verified.state()
        action, ident, value = args['action'], args.get('id'), args.get('value')
        if action == 'setGold':
            actual = state.get('gold')
        else:
            section, field = {'setSwitch': ('switches', 'value'), 'setVariable': ('variables', 'value'),
                              'setItem': ('items', 'count'), 'setHp': ('actors', 'hp'), 'setMp': ('actors', 'mp')}[action]
            actual = next((row[field] for row in state.get(section, []) if row['id'] == ident), None)
        if type(actual) is not type(value) or actual != value:
            raise ValueError('修改后的目标值重读不一致，请保留原存档')
        if changed == raw:
            return _state(verified, file, raw)
        backup, backup_created = _replace(args, file, engine, raw, changed, stage)
        return _state(verified, file, changed, backup, changed=True, backup_created=backup_created)
