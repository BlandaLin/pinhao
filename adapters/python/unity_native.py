"""Unity serialized assets and UnityFS text round-trips through fixed UnityPy.

Only display data with a reversible binding enters the text workbench. Game
assemblies and scripts are data sources; this adapter never loads or runs them.
"""
from __future__ import annotations

import copy
import csv
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import struct
import subprocess
import sys
import tempfile

import rpgmaker as core
import text_formats as formats
from rgss_archive import destination
import asset_overlay
import adapter_overlay
import unity_semantics
from native_attempt import NativeAttempt

ENGINE = 'Unity'
READY = 'native_unity_asset_roundtrip'
UNITYPY_VERSION = '1.23.0'
TYPE_TREE_VERSION = 'pinhao-mono-schema-v1'
_GENERATED_NODES = {}
_SCHEMA_IDENTITIES = {}


class MissingMonoScript(ValueError):
    """A null script reference has no recoverable managed class identity."""

DISPLAY_KEYS = {'text', 'm_text', 'dialogue', 'dialog', 'line', 'message', 'description', 'displayname',
                'display_name', 'title', 'subtitle', 'caption', 'label', 'prompt', 'tooltip', 'speaker', 'name'}
LOCALIZED_KEYS = {'ja', 'jp', 'japanese', 'en', 'english', 'zh', 'zh-cn', 'zh-hans', 'value', 'translation'}
RESOURCE_KEYS = {'id', 'key', 'guid', 'path', 'file', 'filename', 'asset', 'resource', 'prefab', 'icon', 'sprite',
                 'audio', 'sound', 'voice', 'command', 'script', 'expression', 'condition', 'target', 'type'}
LOCALIZATION_NAME = re.compile(r'locali[sz]|dialog|scenario|story|strings|messages|subtitles|translation|language', re.I)
CODE_NAME = re.compile(r'\.(?:cs|js|lua|nani|yarn|ink|shader|cginc|hlsl|sql|xml|html|uss|uxml)$', re.I)
CODE_LINE = re.compile(r'^\s*(?:[@#;]|//|/\*|(?:using|import|class|function|return|if|else|var|let|const)\b)', re.M)
UI_CLASSES = {('UnityEngine.UI', 'Text'), ('TMPro', 'TMP_Text'), ('TMPro', 'TextMeshPro'), ('TMPro', 'TextMeshProUGUI')}
REVIEW_KINDS = {'custom_monobehaviour_display_schema_required', 'unity_typetree_adapter_required'}
REVIEW_BASE_FIELDS = {'m_Name', 'm_EditorClassIdentifier'}
REVIEW_ENGINE_LOGIC_FIELDS = {'m_PersistentCalls', 'm_MethodName', 'm_TargetAssemblyTypeName',
                              'm_ObjectArgumentAssemblyTypeName', 'm_AnimationTriggers',
                              'm_NormalTrigger', 'm_HighlightedTrigger', 'm_PressedTrigger',
                              'm_SelectedTrigger', 'm_DisabledTrigger', 'm_HorizontalAxis',
                              'm_VerticalAxis', 'm_SubmitButton', 'm_CancelButton'}
# Input and state components store axis names, scene keys and object references. None of their
# strings is display text, so the class identity alone settles the review without model work.
INPUT_STATE_CLASSES = {'StandaloneInputModule', 'TouchInputModule', 'PointerInputModule', 'BaseInputModule',
                       'InputSystemUIInputModule', 'EventSystem', 'EventTrigger', 'GraphicRaycaster',
                       'PhysicsRaycaster', 'Physics2DRaycaster', 'CanvasScaler'}
# Engine-internal fields carry identity, tags, layers and serialized bindings, never display text.
PREFILTER_IGNORED_FIELDS = REVIEW_BASE_FIELDS | REVIEW_ENGINE_LOGIC_FIELDS | {
    'm_TagString', 'm_Layer', 'm_Icon', 'm_Sprite', 'm_Script', 'm_ClassName',
    'm_AssemblyName', 'm_Namespace', 'm_CachedPtr', 'm_ObjectHideFlags', 'm_SelectionColor'}
PREFILTERED_NO_TEXT = 'prefiltered_no_text'


def unitypy():
    root = Path(__file__).resolve().parents[2]
    candidate = os.environ.get('PINHAO_UNITYPY') or str(root / 'local/dependencies/unitypy')
    if candidate not in sys.path:
        sys.path.insert(0, candidate)
    try:
        import UnityPy
    except ImportError as error:
        raise ValueError('Prepare the fixed Unity asset tools with prepare-unity-tools.mjs') from error
    if UnityPy.__version__ != UNITYPY_VERSION:
        raise ValueError('Unity asset tools require UnityPy ' + UNITYPY_VERSION)
    from UnityPy.helpers import TypeTreeHelper
    TypeTreeHelper.read_typetree_boost = False
    return UnityPy


def available():
    try:
        unitypy()
        return True
    except (ImportError, ValueError, OSError):
        return False


def carrier_kind(path):
    with path.open('rb') as stream:
        head = stream.read(48)
    if head.startswith(b'UnityFS\0'):
        return 'UnityFS'
    if len(head) < 20:
        return None
    meta, size, version, offset = struct.unpack('>IIII', head[:16])
    if version >= 22 and len(head) >= 48:
        meta, size, offset = struct.unpack('>Iqq', head[20:40])
    if 9 <= version <= 23 and head[16] in (0, 1) and 0 < meta < size and size == path.stat().st_size and 20 <= offset <= size:
        return 'SerializedFile'
    return None


def probe(game):
    game = Path(game)
    roots = [path for path in game.iterdir() if path.is_dir() and path.name.lower().endswith('_data')]
    if not roots or not any((game / name).is_file() for name in ('UnityPlayer.dll', 'GameAssembly.dll')) and not any((path / 'globalgamemanagers').is_file() for path in roots):
        return None
    carriers = []
    for root in roots:
        for current, dirs, names in os.walk(root, followlinks=False):
            for entry in [root, *(Path(current) / name for name in dirs + names)]:
                if entry.is_symlink() or getattr(entry, 'is_junction', lambda: False)():
                    raise ValueError('Choose a Unity directory with regular files and folders')
            for name in sorted(names):
                path = Path(current) / name
                if path.suffix.lower() in ('.dll', '.exe', '.ress', '.resource'):
                    continue
                kind = carrier_kind(path)
                if kind:
                    carriers.append(path.relative_to(game).as_posix())
    return {'engine': ENGINE, 'root': '.', 'support': READY, 'carriers': carriers,
            'dataRoots': [path.relative_to(game).as_posix() for path in roots]}


def serialized_files(top, prefix='@'):
    from UnityPy.files.SerializedFile import SerializedFile
    if isinstance(top, SerializedFile):
        yield prefix, top
    else:
        for name, value in sorted(top.files.items()):
            if hasattr(value, 'files'):
                yield from serialized_files(value, name if prefix == '@' else prefix + '/' + name)


def load_carrier(path):
    environment = unitypy().load(Path(path).read_bytes())
    top = environment.file
    if top.__class__.__name__ not in ('SerializedFile', 'BundleFile') or getattr(top, 'signature', 'UnityFS') != 'UnityFS':
        raise ValueError('Choose serialized Unity assets or UnityFS resource bundles')
    if getattr(top, 'decryptor', None):
        raise ValueError('Encrypted Unity resources need a project-specific resource adapter')
    return environment, top


def object_key(member, obj):
    return member + ':' + str(obj.path_id)


def objects(top):
    return {object_key(member, obj): obj for member, file in serialized_files(top)
            for obj in sorted(file.objects.values(), key=lambda value: value.path_id)}


def schema_files(game, carrier):
    data_root = Path(game) / PurePosixPath(carrier).parts[0]
    managed = data_root / 'Managed'
    return sorted(managed.glob('*.dll')) if managed.is_dir() else []


def generated_nodes(obj, script, game, carrier, schema_context=None):
    from UnityPy.helpers.TypeTreeNode import TypeTreeNode
    from UnityPy.helpers.Tpk import get_typetree_node
    scope_key = (os.path.abspath(game), PurePosixPath(carrier).parts[0], obj.assets_file.unity_version, TYPE_TREE_VERSION)
    cached = schema_context.get(scope_key) if schema_context is not None else None
    if cached is None:
        files = schema_files(game, carrier)
        if not files:
            raise ValueError('Unity managed assemblies are required to recover this stripped type tree')
        file_state = []
        for path in files:
            stat = path.stat()
            file_state.append((path.name, stat.st_size, stat.st_mtime_ns))
        state = (str(Path(game).resolve()), *scope_key[1:3], tuple(file_state), TYPE_TREE_VERSION)
        if state not in _SCHEMA_IDENTITIES:
            signatures = []
            for path in files:
                digest = hashlib.sha256()
                with path.open('rb') as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b''):
                        digest.update(block)
                signatures.append((path.name, digest.hexdigest()))
            _SCHEMA_IDENTITIES[state] = (*state[:3], tuple(signatures), TYPE_TREE_VERSION)
        identity = _SCHEMA_IDENTITIES[state]
        if schema_context is not None:
            schema_context[scope_key] = (files, identity)
    else:
        files, identity = cached
    script_id = (script.get('m_AssemblyName', ''), script.get('m_Namespace', ''), script.get('m_ClassName', ''))
    key = (identity, script_id)
    if key not in _GENERATED_NODES:
        root = Path(__file__).resolve().parents[2]
        candidates = [Path(os.environ['PINHAO_UNITY_SCHEMA'])] if os.environ.get('PINHAO_UNITY_SCHEMA') else []
        candidates.extend((root / 'local/dependencies/unity-schema/Pinhao.UnitySchema.exe',
                           Path(__file__).parent.parent / 'dependencies/unity-schema/Pinhao.UnitySchema.exe'))
        executable = next((path for path in candidates if path.is_file()), None)
        if executable is None:
            raise ValueError('Prepare the fixed Mono Unity schema tools')
        result = subprocess.run([str(executable), str(files[0].parent), *script_id, obj.assets_file.unity_version],
                                capture_output=True, encoding='utf-8-sig', timeout=90,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        if result.returncode:
            raise ValueError('Unity Mono schema recovery failed: ' + result.stderr[-400:])
        children = json.loads(result.stdout)
        if not isinstance(children, list) or len(children) > 100000:
            raise ValueError('Unity Mono schema result exceeds its node limit')
        base = get_typetree_node(114, obj.version)
        flat = [{name: getattr(node, name, None) or 0 for name in
                 ('m_Level', 'm_Type', 'm_Name', 'm_ByteSize', 'm_Version', 'm_TypeFlags', 'm_MetaFlag', 'm_Index')}
                for node in base.traverse()]
        _GENERATED_NODES[key] = TypeTreeNode.from_list(flat + children)
    return _GENERATED_NODES[key]


def typed_tree(obj, carrier, loaded, game, schema_context=None):
    tree = None
    try:
        tree = obj.parse_as_dict()
    except Exception:
        if obj.type.name != 'MonoBehaviour':
            raise
    base_fields = {'m_GameObject', 'm_Enabled', 'm_Script', 'm_Name', 'm_ObjectHideFlags',
                   'm_EditorHideFlags', 'm_EditorClassIdentifier', 'm_PrefabParentObject', 'm_PrefabInternal'}
    if obj.type.name != 'MonoBehaviour' or tree is not None and set(tree) - base_fields:
        return tree, None
    # The built-in base schema reads PPtr using the resource's byte order/version.
    # It avoids guessing m_Script offsets or dropping its external file identity.
    from UnityPy.helpers.Tpk import get_typetree_node
    base = tree if tree is not None and 'm_Script' in tree else obj.read_typetree(get_typetree_node(114, obj.version), check_read=False)
    pointer, serialized = base.get('m_Script', {}), getattr(obj, 'serialized_type', None)
    if pointer.get('m_FileID') == pointer.get('m_PathID') == 0 and serialized is not None \
            and getattr(serialized, 'script_type_index', None) == -1 \
            and getattr(serialized, 'script_id', None) is not None and not any(serialized.script_id) \
            and getattr(serialized, 'old_type_hash', None) is not None and not any(serialized.old_type_hash):
        raise MissingMonoScript('Null MonoScript reference and empty serialized script identity; original object bytes are retained, text contents remain unverified')
    script = resolve_script(obj, base, carrier, loaded)
    if not script:
        raise ValueError('Unity MonoScript reference requires an unambiguous carrier/member/fileID/pathID binding')
    nodes = generated_nodes(obj, script, game, carrier, schema_context=schema_context)
    return obj.read_typetree(nodes), nodes


def opaque_members(top, prefix='@'):
    from UnityPy.files.SerializedFile import SerializedFile
    if isinstance(top, SerializedFile):
        return {}
    result = {}
    for name, value in sorted(top.files.items()):
        key = name if prefix == '@' else prefix + '/' + name
        if isinstance(value, SerializedFile):
            continue
        if hasattr(value, 'files'):
            result.update(opaque_members(value, key))
        else:
            result[key] = bytes(value.bytes)
    return result


def verify_carrier(before, after, expected, nodes_map=None):
    old, new = objects(before), objects(after)
    if set(old) != set(new) or opaque_members(before) != opaque_members(after):
        raise ValueError('Unity resource membership changed during serialization')
    for key, original in old.items():
        actual = new[key]
        if original.class_id != actual.class_id:
            raise ValueError('Unity object type changed: ' + key)
        if key in expected:
            if actual.read_typetree((nodes_map or {}).get(key)) != expected[key]:
                raise ValueError('Unity text readback mismatch: ' + key)
        elif original.get_raw_data() != actual.get_raw_data():
            raise ValueError('Unedited Unity object changed: ' + key)
    for (name, left), (right_name, right) in zip(serialized_files(before), serialized_files(after)):
        if name != right_name or left.unity_version != right.unity_version or left.target_platform != right.target_platform:
            raise ValueError('Unity serialized version or platform changed')
        if [(item.path, item.guid, item.type) for item in left.externals] != [(item.path, item.guid, item.type) for item in right.externals]:
            raise ValueError('Unity external resource references changed')


def save_checked(before, expected, nodes_map=None):
    raw = before.save(packer='original')
    _, actual = load_carrier_bytes(raw)
    verify_carrier(before, actual, expected, nodes_map)
    return raw


def load_carrier_bytes(raw):
    environment = unitypy().load(raw)
    return environment, environment.file


def readable(text):
    if not isinstance(text, str) or not text.strip() or any(ord(char) < 32 and char not in '\r\n\t' or 0xD800 <= ord(char) <= 0xDFFF for char in text):
        return False
    plain = re.sub(r'<[^>]+>|\{[^{}]*\}', '', text).strip()
    if not plain or re.fullmatch(r'[\d\W_]+', plain):
        return False
    if re.search(r'(?i)(?:https?://|^[\w.-]+[/\\]|\.(?:png|jpg|prefab|asset|wav|ogg|mp3|ttf|otf)$)', plain):
        return False
    return True


def json_entries(value, localized, path=(), allowed=False):
    if isinstance(value, dict):
        for key, item in value.items():
            normalized = key.lower()
            if normalized in RESOURCE_KEYS:
                continue
            child_allowed = normalized in DISPLAY_KEYS or localized and normalized in LOCALIZED_KEYS
            if normalized == 'name':
                child_allowed = localized or any(k.lower() in DISPLAY_KEYS - {'name'} for k in value)
            if localized and isinstance(item, str) and not any(k.lower() in DISPLAY_KEYS for k in value):
                child_allowed = True
            yield from json_entries(item, localized, path + (key,), child_allowed)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from json_entries(item, localized, path + (index,), allowed or localized)
    elif allowed and readable(value):
        yield {'path': list(path), 'source': value, 'kind': 'localized_string'}


def text_asset_entries(name, text):
    if not isinstance(text, str):
        return None, [], 'script_or_binary_textasset'
    try:
        decoded, encoding, bom = formats.decode_source(text.encode('utf-8', 'surrogateescape'))
    except (UnicodeError, ValueError):
        return None, [], 'script_or_binary_textasset'
    binding, entries, issue = decoded_text_entries(name, decoded)
    if binding:
        binding.update(encoding=encoding, bom=bom)
    return binding, entries, issue


def decoded_text_entries(name, text):
    if not isinstance(text, str) or not text.strip() or any(ord(char) < 32 and char not in '\r\n\t' or 0xD800 <= ord(char) <= 0xDFFF for char in text) or CODE_NAME.search(name):
        return None, [], 'script_or_binary_textasset'
    localized = bool(LOCALIZATION_NAME.search(name))
    suffix = Path(name).suffix.lower()
    if suffix == '.json' or text.lstrip().startswith(('{', '[')):
        try:
            value = core.parse_json(text.encode('utf-8'))
        except (ValueError, UnicodeError):
            return None, [], 'unparsed_json_textasset'
        entries = list(json_entries(value, localized))
        return {'format': 'json'}, entries, None if entries else 'json_display_schema_required'
    first_line = text.splitlines()[0] if text.splitlines() else ''
    table_without_extension = not suffix and localized and any(delimiter in first_line for delimiter in (',', '\t'))
    if suffix in ('.csv', '.tsv') or table_without_extension:
        delimiter = '\t' if suffix == '.tsv' or table_without_extension and '\t' in first_line else ','
        rows = list(csv.reader(io.StringIO(text, newline=''), delimiter=delimiter, strict=True))
        if not rows or len(set(rows[0])) != len(rows[0]):
            return None, [], 'csv_unique_display_headers_required'
        columns = [index for index, key in enumerate(rows[0]) if key.lower() in DISPLAY_KEYS or localized and key.lower() in LOCALIZED_KEYS]
        if any(len(row) != len(rows[0]) for row in rows[1:]):
            return None, [], 'csv_row_width_mismatch'
        entries = [{'path': [r, c], 'source': rows[r][c], 'kind': 'table_cell'} for r in range(1, len(rows)) for c in columns if readable(rows[r][c])]
        return {'format': 'csv', 'delimiter': delimiter, 'newline': '\r\n' if '\r\n' in text else '\n', 'finalNewline': text.endswith(('\r', '\n'))}, entries, None if entries else 'csv_display_headers_required'
    if not (suffix in ('.txt', '.text') or not suffix and localized) or CODE_LINE.search(text) or re.search(r'[{};]|(?:==|=>|:=)', re.sub(r'\{[^{}]*\}|<[^>]*>', '', text)):
        return None, [], 'textasset_format_requires_adapter'
    entries = []
    for match in re.finditer(r'[^\r\n]+(?:\r?\n(?!\r?\n)[^\r\n]+)*', text):
        if readable(match[0]):
            entries.append({'path': [match.start(), match.end()], 'source': match[0], 'kind': 'paragraph'})
    return {'format': 'txt'}, entries, None if entries else 'empty_textasset'


def at(value, path):
    for step in path:
        value = value[step]
    return value


def put(value, path, text):
    target = value
    for step in path[:-1]:
        target = target[step]
    target[path[-1]] = text


def render_text_asset(original, binding, updates):
    raw = original.encode('utf-8', 'surrogateescape')
    bom = bytes.fromhex(binding.get('bom', ''))
    encoding = binding.get('encoding', 'utf-8')
    decoded = raw[len(bom):].decode(encoding)
    result = render_decoded_text(decoded, binding, updates)
    return (bom + result.encode(encoding)).decode('utf-8', 'surrogateescape')


def render_decoded_text(original, binding, updates):
    kind = binding['format']
    if kind == 'json':
        value = core.parse_json(original.encode('utf-8'))
        for entry, text in updates:
            put(value, entry['path'], text)
        return json.dumps(value, ensure_ascii=False, indent=2) + ('\n' if original.endswith('\n') else '')
    if kind == 'csv':
        rows = list(csv.reader(io.StringIO(original, newline=''), delimiter=binding['delimiter'], strict=True))
        for entry, text in updates:
            put(rows, entry['path'], text)
        stream = io.StringIO(newline='')
        csv.writer(stream, delimiter=binding['delimiter'], lineterminator=binding['newline']).writerows(rows)
        result = stream.getvalue()
        return result if binding['finalNewline'] else result[:-len(binding['newline'])]
    result = original
    for entry, text in sorted(updates, key=lambda pair: pair[0]['path'][0], reverse=True):
        start, end = entry['path']
        result = result[:start] + text + result[end:]
    return result


def resolve_script(obj, tree, carrier, loaded):
    pointer = tree.get('m_Script', {})
    if not isinstance(pointer, dict) or not pointer.get('m_PathID'):
        return None
    file_index = pointer.get('m_FileID', 0)
    asset_file = obj.assets_file
    if file_index == 0:
        target = asset_file.objects.get(pointer['m_PathID'])
        return target.parse_as_dict() if target and target.type.name == 'MonoScript' else None
    if not isinstance(file_index, int) or not 0 < file_index <= len(asset_file.externals):
        return None
    reference = asset_file.externals[file_index - 1].path.replace('\\', '/')
    basename = reference.rsplit('/', 1)[-1]
    matches = []
    for other_carrier, (_, top) in loaded.items():
        for member, file in serialized_files(top):
            if (Path(other_carrier).parent == Path(carrier).parent and Path(other_carrier).name == basename) or member.rsplit('/', 1)[-1] == basename:
                target = file.objects.get(pointer['m_PathID'])
                if target and target.type.name == 'MonoScript':
                    matches.append((other_carrier, member, target.parse_as_dict()))
    same_carrier = [script for owner, _, script in matches if owner == carrier]
    if same_carrier:
        return same_carrier[0] if len(same_carrier) == 1 else None
    return matches[0][2] if len(matches) == 1 else None


def metadata_path(path, fields):
    pattern = tuple('*' if type(step) is int else step for step in path)
    return any(tuple(field.get('path', ())) == pattern for field in fields)


def prefilter_string_leaves(tree, path=(), metadata_fields=()):
    """String leaves of a class family after dropping engine-internal field names."""
    if isinstance(tree, dict):
        for key, value in tree.items():
            if not path and isinstance(key, str) and key in PREFILTER_IGNORED_FIELDS:
                continue
            yield from prefilter_string_leaves(value, path + (key,), metadata_fields)
    elif isinstance(tree, list):
        for index, value in enumerate(tree):
            yield from prefilter_string_leaves(value, path + (index,), metadata_fields)
    elif readable(tree) and not metadata_path(path, metadata_fields):
        yield path, tree


def prefilter_no_text(identity, tree, metadata_fields=()):
    """Deterministic no-text verdict for one MonoBehaviour class family.

    Only structural facts are read: serialized field types, engine-internal field names and the
    class identity of input/state components. A class family survives prefiltering (returns None)
    as soon as any string field can hold display text, so this never guesses about semantics.
    """
    if not isinstance(tree, dict):
        return None
    kept = list(prefilter_string_leaves(tree, metadata_fields=metadata_fields))
    name = identity[1] if identity else ''
    if name in INPUT_STATE_CLASSES:
        return 'input-axes' if not kept else None
    if kept:
        return None
    if metadata_fields and any(metadata_path(path, metadata_fields) for path, _ in review_string_fields(tree)):
        return 'engine-event-type-metadata'
    return 'engine-internal' if next(review_string_fields(tree), None) is not None else 'no-string-fields'


def automatic_display_entries(tree, report):
    if report.get('available') is not True:
        return []
    entries = []
    for usage in report.get('fields', []):
        sites = sorted({use['siteId'] for use in usage.get('uses', []) if use.get('displayOnly') is True})
        if not sites:
            continue
        selected = {'path': usage['path'], 'kind': 'display_text', 'displaySites': sites}
        binding = unity_semantics.bind_field({'fieldUses': report}, selected, None)['displayBinding']
        try:
            values = list(review_expand(tree, usage['path']))
        except ValueError:
            # Managed types also contain nonserialized fields; they are not resource text.
            continue
        for path, text in values:
            if path[0] not in REVIEW_BASE_FIELDS:
                entries.append({'path': path, 'source': text, 'kind': 'display_text', 'displayBinding': binding})
    return entries


def native_entries(obj, carrier, loaded, game=None, schema_context=None):
    # A base MonoBehaviour projection cannot prove that its custom fields contain no text.
    if obj.type.name == 'MonoBehaviour' and game:
        tree, _ = typed_tree(obj, carrier, loaded, game, schema_context=schema_context)
    else:
        tree = obj.parse_as_dict()
    kind, entries, binding, issue = obj.type.name, [], {'format': 'fields'}, None
    if kind == 'TextAsset':
        binding, entries, issue = text_asset_entries(tree.get('m_Name', ''), tree.get('m_Script', ''))
    elif kind == 'TextMesh' and readable(tree.get('m_Text')):
        entries = [{'path': ['m_Text'], 'source': tree['m_Text'], 'kind': 'ui_text'}]
    elif kind == 'MonoBehaviour':
        script = resolve_script(obj, tree, carrier, loaded)
        identity = (script.get('m_Namespace'), script.get('m_ClassName')) if script else None
        if identity in UI_CLASSES:
            for field in ('m_Text', 'm_text'):
                if readable(tree.get(field)):
                    entries.append({'path': [field], 'source': tree[field], 'kind': 'ui_text'})
            if identity[0] == 'TMPro':
                issue = 'tmp_font_atlas_requires_separate_font_adapter'
        elif identity == ('UnityEngine.Localization.Tables', 'StringTable'):
            rows = tree.get('m_TableData', [])
            if isinstance(rows, list):
                entries = [{'path': ['m_TableData', index, 'm_Localized'], 'source': row['m_Localized'], 'kind': 'localized_string'}
                           for index, row in enumerate(rows) if isinstance(row, dict) and readable(row.get('m_Localized'))]
        else:
            metadata_fields = []
            if game and script and any(path[-1] == 'm_TypeName' for path, _ in prefilter_string_leaves(tree)):
                metadata_fields = unity_semantics.metadata_fields(game, schema_context or {}, carrier, script)
            prefiltered = prefilter_no_text(identity, tree, metadata_fields)
            if prefiltered:
                binding = {**binding, 'prefiltered': prefiltered}
                if metadata_fields:
                    binding['metadataFields'] = metadata_fields
                issue = PREFILTERED_NO_TEXT
            else:
                issue = 'custom_monobehaviour_display_schema_required'
                if game and script:
                    declaration = {'assembly': script.get('m_AssemblyName', ''), 'namespace': script.get('m_Namespace', ''),
                                   'className': script.get('m_ClassName', '')}
                    report = unity_semantics.inspect_fields(game, schema_context or {}, carrier, declaration)
                    entries = automatic_display_entries(tree, report)
                    if entries:
                        binding = {'format': 'unity-display-site'}
                        covered = {tuple(entry['path']) for entry in entries}
                        if all(tuple(path) in covered for path, _ in review_string_fields(tree, metadata_fields=metadata_fields)):
                            issue = None
    return tree, binding, entries, issue


def review_string_fields(tree, path=(), metadata_fields=()):
    """Enumerate string leaves without inferring whether a custom field is displayed."""
    if isinstance(tree, dict):
        for key, value in tree.items():
            if not path and key in REVIEW_BASE_FIELDS:
                continue
            yield from review_string_fields(value, path + (key,), metadata_fields)
    elif isinstance(tree, list):
        for index, value in enumerate(tree):
            yield from review_string_fields(value, path + (index,), metadata_fields)
    elif readable(tree) and not metadata_path(path, metadata_fields):
        yield path, tree


def review_related(source, metadata, file, loaded, helpers):
    if file not in metadata['nativeFilesSha256']:
        raise helpers.WorkerError('NATIVE_REVIEW_SOURCE_MISSING', 'Native review carrier is not in the source snapshot')
    def load(rel):
        if rel not in loaded:
            path = helpers.clean_path(destination(source, rel))
            if helpers.digest_file(path) != metadata['nativeFilesSha256'][rel]:
                raise helpers.WorkerError('SOURCE_CHANGED', 'Unity source snapshot changed: ' + rel)
            loaded[rel] = load_carrier(path)
    load(file)
    references = {ref.path.replace('\\', '/').rsplit('/', 1)[-1]
                  for _, member in serialized_files(loaded[file][1]) for ref in member.externals}
    for rel in metadata['nativeFilesSha256']:
        if Path(rel).parent == Path(file).parent and Path(rel).name in references:
            load(rel)


def review_groups(source, metadata, helpers, file=None):
    issues = metadata.get('nativeReviewCatalog', metadata.get('issues', []))
    selected = [issue for issue in issues if issue.get('kind') in REVIEW_KINDS
                and issue.get('object') and (file is None or issue.get('file') == file)]
    groups, loaded, indexed = {}, {}, {}
    for rel, digest in metadata.get('assemblyFilesSha256', {}).items():
        if helpers.digest_file(helpers.clean_path(destination(source, rel))) != digest:
            raise helpers.WorkerError('SOURCE_CHANGED', 'Unity schema source snapshot changed: ' + rel)
    for issue in sorted(selected, key=lambda value: (value['file'], value['object'])):
        rel, key = issue['file'], issue['object']
        if rel not in indexed:
            review_related(source, metadata, rel, loaded, helpers)
            indexed[rel] = objects(loaded[rel][1])
        obj = indexed[rel].get(key)
        if obj is None:
            raise helpers.WorkerError('NATIVE_REVIEW_SOURCE_MISSING', 'Unity review object is missing: ' + key)
        tree, nodes, error, script = None, None, None, None
        try:
            if obj.type.name != 'MonoBehaviour':
                raise ValueError('Native field review requires a MonoBehaviour schema')
            tree, nodes = typed_tree(obj, rel, loaded, source)
            script = resolve_script(obj, tree, rel, loaded)
            if not script:
                raise ValueError('Unity MonoScript identity could not be resolved')
        except Exception as failure:
            error = str(failure)[:300]
        identity = {'assembly': script.get('m_AssemblyName', ''), 'namespace': script.get('m_Namespace', ''),
                    'className': script.get('m_ClassName', '')} if script else {'type': obj.type.name, 'object': key}
        group_id = 'native-review-v1:' + core.sha(rel.encode())[:16] + ':' + core.sha(core.serialized(identity))[:24]
        group = groups.setdefault(group_id, {'id': group_id, 'groupId': group_id, 'file': rel,
                                             'script': identity, '_objects': {}, '_fieldMap': {}, '_errors': []})
        group['_objects'][key] = {'tree': tree, 'nodes': nodes, 'rawHash': core.sha(obj.get_raw_data())}
        if error:
            group['_errors'].append(error)
            continue
        metadata_fields = unity_semantics.metadata_fields(source, metadata, rel, identity)
        if metadata_fields:
            group['metadataFields'] = metadata_fields
        for path, text in review_string_fields(tree, metadata_fields=metadata_fields):
            pattern = tuple('*' if type(step) is int else step for step in path)
            field = group['_fieldMap'].setdefault(pattern, {'path': list(pattern), 'count': 0, 'examples': []})
            field['count'] += 1
            if len(field['examples']) < 3:
                field['examples'].append({'object': key, 'path': list(path), 'value': text[:240],
                                           'truncated': len(text) > 240})
    for group in groups.values():
        group['fieldUses'] = unity_semantics.inspect_fields(source, metadata, group['file'], group['script']) if group['_fieldMap'] else {'available': True, 'fields': []}
        evidence = {'protocol': 'pinhao-native-review-v1', 'file': group['file'], 'script': group['script'],
                    'unityPyVersion': UNITYPY_VERSION, 'typeTreeVersion': TYPE_TREE_VERSION, 'fieldSemanticsVersion': unity_semantics.VERSION,
                    'carrierHash': metadata['nativeFilesSha256'][group['file']],
                    'assemblyHashes': metadata.get('assemblyFilesSha256', {}),
                    'objects': {key: item['rawHash'] for key, item in group['_objects'].items()},
                    'fields': [list(path) for path in sorted(group['_fieldMap'], key=lambda path: core.serialized(path))]}
        group['evidenceHash'] = core.sha(core.serialized(evidence))
        group['objectCount'] = len(group['_objects'])
        group['fields'] = [group['_fieldMap'][path] for path in sorted(group['_fieldMap'], key=lambda path: core.serialized(path))]
        group['status'] = 'blocked' if group['_errors'] else 'pending' if group['fields'] else 'no-text'
        if group['_errors']:
            group['detail'] = '; '.join(dict.fromkeys(group['_errors']))[:600]
        decision = metadata.get('nativeReviewDecisions', {}).get(group['groupId'])
        if decision and decision['evidenceHash'] == group['evidenceHash']:
            group['status'] = 'accepted'
            group['decision'] = decision
    return sorted(groups.values(), key=lambda group: (group['file'], group['groupId']))


def review_public(group):
    result = {key: value for key, value in group.items() if not key.startswith('_')}
    result['fieldCount'] = len(result['fields'])
    result['fields'] = result['fields'][:128]
    result['fieldsTruncated'] = result['fieldCount'] > len(result['fields'])
    return result


def review_expand(tree, pattern, path=()):
    if not pattern:
        if not isinstance(tree, str):
            raise ValueError('A selected native field must contain strings')
        if readable(tree):
            yield list(path), tree
        return
    step, *rest = pattern
    if step == '*':
        if not isinstance(tree, list):
            raise ValueError('Native field * matches array elements')
        for index, item in enumerate(tree):
            yield from review_expand(item, rest, path + (index,))
    elif isinstance(tree, dict) and isinstance(step, str) and step in tree:
        yield from review_expand(tree[step], rest, path + (step,))
    elif isinstance(tree, list) and type(step) is int and 0 <= step < len(tree):
        yield from review_expand(tree[step], rest, path + (step,))
    else:
        raise ValueError('Selected native display field is missing: ' + str(path + (step,)))


def review_entries(group, fields):
    selected, seen = [], set()
    for field in fields:
        pattern = field['path']
        leaf = next((step for step in reversed(pattern) if isinstance(step, str) and step != '*'), '')
        normalized = re.sub(r'([a-z])([A-Z])', r'\1_\2', leaf).lower()
        words = set(normalized.split('_'))
        if not field.get('displayBinding') and (pattern[0] in REVIEW_BASE_FIELDS or any(step in REVIEW_ENGINE_LOGIC_FIELDS for step in pattern) or normalized in RESOURCE_KEYS or words & {'id', 'guid', 'target', 'command', 'expression', 'condition', 'script'}):
            raise ValueError('Resource and logic fields retain their native values: ' + str(pattern))
        matches = 0
        for key, item in group['_objects'].items():
            tree, nodes = item['tree'], item['nodes']
            for path, text in review_expand(tree, pattern):
                matches += 1
                identity = (key, tuple(path))
                if identity in seen:
                    continue
                seen.add(identity)
                flat = None
                if nodes is not None:
                    flat = [{name: getattr(node, name, None) or 0 for name in
                             ('m_Level', 'm_Type', 'm_Name', 'm_ByteSize', 'm_Version', 'm_TypeFlags', 'm_MetaFlag', 'm_Index')}
                            for node in nodes.traverse()]
                selected.append({'object': key, 'name': tree.get('m_Name', ''), 'schema': flat,
                                 'entry': {'path': path, 'source': text, 'kind': field['kind'],
                                           **({'codeOrigin': {'method': item['method'], 'methodToken': item['methodToken'],
                                                              'allocationOffset': item['allocationOffset'], 'elementIndex': path[-1],
                                                              'sourceOffsets': item['sourceOffsets'].get(path[-1], [])}}
                                              if 'allocationOffset' in item else {}),
                                           **({'displayBinding': field['displayBinding']} if field.get('displayBinding') else {})}})
        if not matches:
            raise ValueError('Selected native display field has no readable strings: ' + str(pattern))
    return selected


def collect_code_display_entries(collector, metadata, groups, helpers):
    import native_review
    for group in groups:
        if group.get('verifiedDisplayInputs') is not True:
            continue
        fields = [{'path': field['path'], 'kind': 'dialogue', 'displaySites': sorted({
            use['siteId'] for usage in group['fieldUses']['fields'] if usage['path'] == field['path']
            for use in usage['uses'] if use.get('displayOnly') is True})} for field in group['fields']]
        fields = [field for field in fields if field['displaySites']]
        if not fields:
            continue
        decision = native_review.decision_for(group, {
            'groupId': group['groupId'], 'evidenceHash': group['evidenceHash'],
            'disposition': 'display', 'fields': fields,
            'reason': 'Managed IL proves isolated display consumers for these complete literal sentences; source arrays and business consumers retain their original values.'}, helpers)
        metadata.setdefault('nativeReviewDecisions', {})[group['groupId']] = decision
        additions = review_entries(group, [unity_semantics.bind_field(group, field, helpers) for field in decision['fields']])
        by_object = {}
        for item in additions:
            by_object.setdefault(item['object'], []).append(item)
        for obj_key, items in by_object.items():
            virtual = '__unity_review__/' + hashlib.sha256((group['file'] + '\0' + obj_key).encode()).hexdigest()[:24] + '.json'
            target = destination(collector.root, virtual)
            core.write(target, {'entries': [item['entry'] for item in items]})
            file, _ = collector.document(target)
            metadata['recordMap'][file] = {'carrier': group['file'], 'object': obj_key, 'type': 'ManagedMethod',
                                         'binding': {'format': 'unity-display-site'}, 'reviewGroup': group['groupId']}
            for index, item in enumerate(items):
                entry = item['entry']
                collector.add(file, ['entries', index, 'source'], entry['source'], entry['kind'],
                              {'carrier': group['file'], 'object': obj_key, 'asset': item['name'],
                               'field': entry['path'], 'type': 'ManagedMethod', 'reviewGroup': group['groupId'],
                               'scene': item['name'], 'method': item['name'], 'arrayField': group['arrayField'],
                               'elementIndex': entry['path'][-1], **entry['codeOrigin']}, 'formatted')
                display = entry['displayBinding']
                collector.units[collector.rows[-1]['id']]['sync_group'] = 'unity-display-' + core.sha(core.serialized([
                    display['assemblyFile'], sorted(display['sites']), entry['source']]))[:24]


def extract(game, work, info, helpers, args):
    attempt = NativeAttempt(work, ENGINE, helpers, {'name': 'UnityPy', 'version': UNITYPY_VERSION,
                                                  'typeTreeVersion': TYPE_TREE_VERSION})
    try:
        result = _extract(game, work, info, helpers, args, attempt)
        partial = any(row.get('status') == 'failed' for row in attempt.resources.values())
        return {**result, 'nativeAttempt': attempt.finish('partial' if partial else 'complete')}
    except Exception as error:
        attempt.fail(error)
        raise


def _extract(game, work, info, helpers, args, attempt):
    source = helpers.fresh(work.parent / (work.name + '-native-source'), (game, work))
    source.mkdir(parents=True)
    loaded, issues, native_hashes = {}, [], {}
    for rel in info['carriers']:
        attempt.resource(rel, file=rel, phase='load_carrier', status='unexamined')
    for rel in info['carriers']:
        path = helpers.clean_path(destination(game, rel))
        input_hash = helpers.digest_file(path)
        try:
            loaded[rel] = load_carrier(path)
        except Exception as error:
            issues.append({'file': rel, 'kind': 'unity_carrier_adapter_required', 'detail': str(error)[:300]})
            attempt.resource(rel, phase='load_carrier', status='failed', inputSha256=input_hash,
                             error={'code': 'UNITY_CARRIER_UNREADABLE', 'message': str(error)})
            continue
        target = destination(source, rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        native_hashes[rel] = input_hash
        attempt.resource(rel, phase='load_carrier', status='extracted_unverified', inputSha256=input_hash,
                         originalPreserved=True)
    assemblies = {}
    for rel in loaded:
        for path in schema_files(game, rel):
            name = path.relative_to(game).as_posix()
            if name in assemblies:
                continue
            path = helpers.clean_path(path)
            target = destination(source, name)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
            assemblies[name] = helpers.digest_file(path)
    collector = formats.Collector(source, ENGINE, 'json', int(args.get('batchSize', 120)))
    records, fonts, prefiltered_groups = {}, [], {}
    # The source snapshot is immutable during this extract; new operations get a new scope.
    schema_context = {'assemblyFilesSha256': assemblies}
    for rel, (_, top) in sorted(loaded.items()):
        for key, obj in objects(top).items():
            if obj.type.name == 'Font':
                try:
                    tree = obj.parse_as_dict()
                    if tree.get('m_FontData') and tree.get('m_FontSize') == 0:
                        fonts.append({'carrier': rel, 'object': key})
                    else:
                        issues.append({'file': rel, 'object': key, 'kind': 'static_or_external_font_requires_adapter'})
                except Exception:
                    issues.append({'file': rel, 'object': key, 'kind': 'font_typetree_required'})
                continue
            if obj.type.name not in ('TextAsset', 'TextMesh', 'MonoBehaviour'):
                continue
            try:
                tree, binding, entries, issue = native_entries(obj, rel, loaded, source, schema_context=schema_context)
            except MissingMonoScript as error:
                issues.append({'file': rel, 'object': key, 'kind': 'unity_missing_script_reference', 'category': 'info',
                               'detail': str(error), 'originalBytesRetained': True, 'textContentsVerified': False})
                attempt.resource(rel + ':' + key, file=rel, object=key, phase='read_object', status='failed',
                                 error={'code': 'UNITY_SCRIPT_REFERENCE_MISSING', 'message': str(error)})
                continue
            except Exception as error:
                issues.append({'file': rel, 'object': key, 'kind': 'unity_typetree_adapter_required', 'detail': str(error)[:300]})
                attempt.resource(rel + ':' + key, file=rel, object=key, phase='read_object', status='failed',
                                 error={'code': 'UNITY_TYPETREE_REQUIRED', 'message': str(error)})
                continue
            if issue == PREFILTERED_NO_TEXT:
                # One auditable record per class family: it keeps the carrier, the reason and the
                # object count, so a skipped group is never silently dropped from coverage.
                script = resolve_script(obj, tree, rel, loaded) or {}
                signature = (rel, script.get('m_Namespace', ''), script.get('m_ClassName', ''), binding['prefiltered'])
                entry = prefiltered_groups.setdefault(signature, {
                    'file': rel, 'object': key, 'name': tree.get('m_Name', ''), 'kind': PREFILTERED_NO_TEXT,
                    'prefiltered': binding['prefiltered'], 'count': 0,
                    'script': {'assembly': script.get('m_AssemblyName', ''), 'namespace': signature[1], 'className': signature[2]}})
                entry['count'] += 1
                if binding.get('metadataFields'):
                    entry['metadataFields'] = binding['metadataFields']
                continue
            if issue:
                item = {'file': rel, 'object': key, 'name': tree.get('m_Name', ''), 'kind': issue}
                if issue == 'custom_monobehaviour_display_schema_required':
                    script = resolve_script(obj, tree, rel, loaded)
                    if script:
                        item['script'] = {'assembly': script.get('m_AssemblyName', ''),
                                          'namespace': script.get('m_Namespace', ''), 'className': script.get('m_ClassName', '')}
                issues.append(item)
            if not entries:
                continue
            virtual = '__unity_text__/' + hashlib.sha256((rel + '\0' + key).encode()).hexdigest()[:24] + '.json'
            target = destination(source, virtual)
            core.write(target, {'entries': entries})
            file, _ = collector.document(target)
            records[file] = {'carrier': rel, 'object': key, 'type': obj.type.name, 'binding': binding}
            for index, entry in enumerate(entries):
                collector.add(file, ['entries', index, 'source'], entry['source'], entry['kind'],
                              {'carrier': rel, 'object': key, 'asset': tree.get('m_Name', ''), 'field': entry['path'], 'type': obj.type.name}, 'formatted')
                if entry.get('displayBinding'):
                    display = entry['displayBinding']
                    collector.units[collector.rows[-1]['id']]['sync_group'] = 'unity-display-' + core.sha(core.serialized([
                        display['assemblyFile'], sorted(display['sites']), entry['source']]))[:24]
    issues.extend(sorted(prefiltered_groups.values(), key=lambda item: (item['file'], item['script']['className'])))
    if not loaded or not any(objects(top) for _, top in loaded.values()):
        raise helpers.WorkerError('NATIVE_TEXT_UNAVAILABLE', 'Unity resources contain no readable serialized object records')
    source_hashes = {**native_hashes, **assemblies}
    fingerprint = core.sha(core.serialized(source_hashes))
    metadata = {'schema': 'pinhao-native-unity-v1', 'engine': ENGINE, 'root': '.', 'sourceFiles': source_hashes,
                'sourceFingerprint': fingerprint, 'nativeSource': str(source), 'recordMap': records,
                'nativeFilesSha256': native_hashes, 'assemblyFilesSha256': assemblies,
                'fonts': fonts, 'issues': issues, 'unityPyVersion': UNITYPY_VERSION, 'typeTreeVersion': TYPE_TREE_VERSION}
    managed = unity_semantics.code_groups(source, metadata, helpers)
    metadata['issues'] = unity_semantics.code_issues(metadata, managed)
    metadata['nativeReviewCatalog'] = copy.deepcopy(metadata['issues'])
    collect_code_display_entries(collector, metadata, managed, helpers)
    import native_review
    metadata['issues'] = native_review.coverage_issues(metadata, managed)
    issues = metadata['issues']
    if not collector.units and args.get('allowEmpty') is not True:
        raise helpers.WorkerError('NATIVE_TEXT_UNAVAILABLE', 'Unity resources need a display-data schema; inspect TextAsset formats and typetree fields')
    collector.review.extend(issues)
    report = collector.finish(work, allow_empty=args.get('allowEmpty') is True)
    report['review_items'] = len(issues)
    helpers.json_write(work / 'review-required.json', issues)
    helpers.json_write(work / 'extraction-report.json', report)
    helpers.json_write(work / 'technical/product-source.json', metadata)
    helpers.json_write(work / 'image-inventory.json', [])
    helpers.json_write(work / 'dynamic-candidates.json', [])
    manifest, sheets = core.load_work(work)
    rows = [{**row, 'legacyId': row['id'], 'file': manifest['units'][row['id']]['file']} for sheet in sheets.values() for row in sheet['units']]
    return {**report, 'engine': ENGINE, 'workDir': str(work), 'workspaceDir': str(work), 'manifestPath': str(work / 'manifest.json'),
            'sourceFingerprint': fingerprint, 'units': rows, 'reviewItems': issues, 'dynamicCandidates': [], 'images': [],
            'capabilities': helpers.capabilities(ENGINE)}


def build(work, editable, output, helpers):
    report = core.build(work, editable, output)
    core.verify(work, editable, output)
    metadata = core.read(work / 'technical/product-source.json')
    source = Path(metadata['nativeSource'])
    for rel, digest in {**metadata['nativeFilesSha256'], **metadata.get('assemblyFilesSha256', {})}.items():
        if helpers.digest_file(destination(source, rel)) != digest:
            raise helpers.WorkerError('SOURCE_CHANGED', 'Unity source snapshot changed; extract a new workbench: ' + rel)
    changed, display_updates = {}, []
    for virtual, record in metadata['recordMap'].items():
        before = core.read(work / 'baseline' / virtual)['entries']
        after = core.read(output / virtual)['entries']
        updates = [(entry, translated['source']) for entry, translated in zip(before, after) if entry['source'] != translated['source']]
        if updates:
            if record.get('reviewGroup') or record.get('binding', {}).get('format') == 'unity-display-site':
                display_updates.extend(updates)
            else:
                changed.setdefault(record['carrier'], []).append((record, updates))
    loaded = {rel: load_carrier(destination(source, rel)) for rel in changed}
    if changed:
        loaded.update({rel: load_carrier(destination(source, rel)) for rel in metadata['nativeFilesSha256'] if rel not in loaded})
    for rel in metadata['nativeFilesSha256']:
        original = destination(source, rel)
        target = destination(output, rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        if rel not in changed:
            shutil.copyfile(original, target)
            continue
        _, top = loaded[rel]
        indexed, expected, nodes_map = objects(top), {}, {}
        for record, updates in changed[rel]:
            obj = indexed[record['object']]
            if record.get('reviewSchema'):
                from UnityPy.helpers.TypeTreeNode import TypeTreeNode
                schema = metadata.get('nativeReviewSchemas', {}).get(record['reviewSchema'])
                if not schema or core.sha(core.serialized(schema)) != record['reviewSchema']:
                    raise ValueError('Native review type tree identity changed')
                nodes = TypeTreeNode.from_list(schema)
                tree = obj.read_typetree(nodes)
            else:
                tree, nodes = typed_tree(obj, rel, loaded, source)
            updated = copy.deepcopy(tree)
            if record['type'] == 'TextAsset':
                updated['m_Script'] = render_text_asset(tree['m_Script'], record['binding'], updates)
            else:
                for entry, text in updates:
                    put(updated, entry['path'], text)
            obj.save_typetree(updated, nodes)
            expected[record['object']] = updated
            if nodes is not None:
                nodes_map[record['object']] = nodes
        target.write_bytes(save_checked(top, expected, nodes_map))
    display_reports = unity_semantics.build(source, output, display_updates, helpers)
    hashes = {rel: helpers.digest_file(destination(output, rel)) for rel in metadata['nativeFilesSha256']}
    hashes.update({item['file']: item['outputSha256'] for item in display_reports})
    report['files_sha256'].update(hashes)
    report.update(nativeFiles=len(metadata['nativeFilesSha256']), nativeChangedFiles=len(changed),
                  displayFiles=[item['file'] for item in display_reports], displayValidation=display_reports)
    helpers.json_write(output / 'build-report.json', report)
    return {**report, 'engine': ENGINE, 'buildDir': str(output), 'outputDir': str(output), 'runtimeVerified': False}


def roundtrip(work, helpers):
    metadata = core.read(work / 'technical/product-source.json')
    manifest, _ = core.load_work(work)
    with tempfile.TemporaryDirectory(prefix='pinhao-unity-roundtrip-', dir=work.parent) as temporary:
        output = Path(temporary) / 'data'
        build(work, work / 'technical/row-baseline', output, helpers)
        for rel, expected in metadata['nativeFilesSha256'].items():
            if helpers.digest_file(destination(output, rel)) != expected:
                raise helpers.WorkerError('ROUNDTRIP_MISMATCH', 'Unity no-change resource readback differs: ' + rel)
            _, top = load_carrier(destination(output, rel))
            if not objects(top):
                raise helpers.WorkerError('ROUNDTRIP_MISMATCH', 'Unity serialized objects are missing: ' + rel)
    return {'engine': ENGINE, 'files': len(metadata['nativeFilesSha256']), 'units': len(manifest['units']),
            'byteIdentical': True, 'status': 'nochange_byte_identical', 'runtimeVerified': False}


def apply_font(path, records, font, family):
    _, top = load_carrier(path)
    indexed, expected = objects(top), {}
    for record in records:
        obj = indexed[record['object']]
        tree = obj.parse_as_dict()
        if not tree.get('m_FontData') or tree.get('m_FontSize') != 0:
            raise ValueError('Choose a Unity dynamic font with embedded font data')
        updated = copy.deepcopy(tree)
        updated['m_FontData'] = font if isinstance(tree['m_FontData'], bytes) else list(font)
        if 'm_FontNames' in updated:
            updated['m_FontNames'] = [family]
        obj.save_typetree(updated)
        expected[record['object']] = updated
    path.write_bytes(save_checked(top, expected))


def assemble(args, helpers):
    game = helpers.path_arg(args, 'gameDir')
    work = helpers.path_arg(args, 'workspaceDir', 'workDir')
    built = helpers.path_arg(args, 'buildDir')
    output = helpers.fresh(helpers.path_arg(args, 'outputDir', 'outDir'), (game, work, built))
    metadata = core.read(work / 'technical/product-source.json')
    helpers.source_unchanged(game, metadata)
    report = core.read(built / 'build-report.json')
    if report['manifest_sha256'] != helpers.digest_file(work / 'manifest.json'):
        raise helpers.WorkerError('WRONG_BUILD', 'Choose the Unity build from this workbench revision')
    for rel, digest in report['files_sha256'].items():
        if helpers.digest_file(destination(built, rel)) != digest:
            raise helpers.WorkerError('BUILD_CHANGED', 'Unity build changed; rebuild this revision: ' + rel)
    inventory = {'engine': ENGINE, 'copied': 0, 'excluded': [], 'warnings': [], 'runtimeVerified': False,
                 'sourceFingerprint': metadata['sourceFingerprint'], 'nativeFiles': len(metadata['nativeFilesSha256'])}
    output.mkdir(parents=True)
    helpers.copy_tree(game, output, inventory)
    font = helpers.path_arg(args, 'fontPath') if args.get('fontPath') else None
    if font:
        family = helpers.font_family(font)
        font_bytes = font.read_bytes()
    for rel in metadata['nativeFilesSha256']:
        target = destination(output, rel)
        shutil.copyfile(destination(built, rel), target)
        records = [item for item in metadata['fonts'] if item['carrier'] == rel]
        if font and records:
            apply_font(target, records, font_bytes, family)
    for rel in report.get('displayFiles', []):
        if rel not in metadata.get('assemblyFilesSha256', {}):
            raise helpers.WorkerError('WRONG_BUILD', 'Display output does not belong to the source managed assemblies')
        shutil.copyfile(destination(built, rel), destination(output, rel))
    if report.get('displayValidation'):
        inventory['displayValidation'] = report['displayValidation']
    if font:
        if metadata['fonts']:
            inventory['font'] = {'family': family, 'objects': len(metadata['fonts']), 'sha256': helpers.digest_file(font)}
        else:
            inventory['warnings'].append('Unity font selection requires an embedded dynamic Font; TMP SDF atlases use a separate font adapter')
    asset_overlay.apply(output, args, helpers, inventory)
    adapter_overlay.apply(output, args, helpers, inventory, baseline_root=built)
    inventory['warnings'].extend(sorted({item['kind'] for item in metadata['issues']}))
    launchers = [rel for rel, _ in helpers.files_in(output) if rel.lower().endswith('.exe') and '/' not in rel
                 and not any(word in rel.lower() for word in ('crash', 'unity', 'install', 'setup'))]
    launch = launchers[0] if launchers else None
    inventory.update(status='assembled_structurally_checked', launchers=launchers)
    helpers.json_write(output / 'PinHao-build-report.json', inventory)
    if args.get('share', True):
        (output / '使用说明-拼好汉化.txt').write_text('本汉化成果由拼好汉化免费分享。\n切勿付费购买此资源；如已付款，请联系交易平台申请退款。\n启动原游戏程序即可游玩，汉化文字已回写 Unity 原生资源。\n感谢原作者与参与制作的同好，祝游玩愉快。\n', encoding='utf-8')
    return {**inventory, 'outputDir': str(output), 'reportPath': str(output / 'PinHao-build-report.json'),
            'launchPath': str(output / launch) if launch else None}
