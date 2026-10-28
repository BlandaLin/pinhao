"""Optional, read-only TextAsset inventory. Does not rebuild Unity asset files."""
from pathlib import Path

import rpgmaker as core


def inventory(asset, output, loader=None):
    asset = Path(asset).resolve()
    if not asset.is_file(): raise ValueError('Choose one serialized Unity asset/bundle file')
    output = core.fresh(output, (asset.parent,))
    if loader is None:
        try:
            import UnityPy
        except ImportError as error:
            raise ImportError('Optional UnityPy is not installed; follow guides/unity.md. No packages were installed.') from error
        loader = UnityPy.load
    before = core.sha(asset.read_bytes())
    environment = loader(str(asset))
    records, exports, identities = [], [], set()
    for obj in environment.objects:
        if obj.type.name != 'TextAsset': continue
        native_file = str(obj.assets_file.name)
        ident = (native_file, int(obj.path_id))
        if ident in identities: raise ValueError('Duplicate native asset/path ID')
        identities.add(ident)
        data = obj.parse_as_object()
        raw = data.m_Script
        if isinstance(raw, str): raw = raw.encode('utf-8', 'surrogateescape')
        if not isinstance(raw, bytes): raise ValueError('Unexpected TextAsset payload type')
        try:
            text = raw.decode('utf-8-sig')
            candidate = bool(text.strip()) and not any(ord(c) < 32 and c not in '\t\r\n' for c in text)
        except UnicodeError:
            text, candidate = None, False
        record = {'asset_file': native_file, 'path_id': obj.path_id, 'name': data.m_Name,
                  'sha256': core.sha(raw), 'bytes': len(raw), 'status': 'review_text_not_automatically_translatable' if candidate else 'binary_or_unsupported_encoding'}
        records.append(record)
        if candidate:
            exports.append({'asset_file': native_file, 'path_id': obj.path_id, 'name': data.m_Name, 'text': text})
    if core.sha(asset.read_bytes()) != before: raise ValueError('Source asset changed during inventory')
    result = {'schema': 'kickstart-unity-inventory-v1', 'source_sha256': before, 'textassets': records,
              'status': 'read_only_inventory_native_reimport_not_implemented', 'native_reimport_required': True}
    output.mkdir(parents=True)
    core.write(output / 'inventory.json', result)
    core.write(output / 'textassets.json', {'assets': exports})
    return {'textassets': len(records), 'text_candidates': len(exports), 'status': result['status']}
