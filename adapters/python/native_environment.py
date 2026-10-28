"""Bounded native dependency diagnostics and refreshable environment identity."""
import hashlib
import json
from pathlib import Path
import re


def diagnostic(category, phase, engine, **fields):
    return {'category': category, 'phase': phase, 'engine': engine, **fields}


def error_details(error):
    result = {}
    value = getattr(error, 'diagnostic', None)
    if isinstance(value, dict) and value.get('category') in ('dependency', 'format', 'native'):
        selected = {key: value[key][:4096] for key in ('category', 'phase', 'engine', 'dependencyId',
                    'expectedVersion', 'detail') if isinstance(value.get(key), str)}
        if value.get('state') in ('ready', 'missing', 'invalid', 'unsupported'):
            selected['state'] = value['state']
        result['diagnostic'] = selected
    attempt = getattr(error, 'attemptId', None)
    if isinstance(attempt, str) and re.fullmatch(r'native-attempt-[a-zA-Z0-9-]{1,80}', attempt):
        result['attemptId'] = attempt
    artifacts = getattr(error, 'artifacts', None)
    if isinstance(artifacts, list):
        selected = []
        for artifact in artifacts[:64]:
            if not isinstance(artifact, dict):
                continue
            relative = artifact.get('relativePath')
            if (not isinstance(relative, str) or not relative or len(relative) > 2048
                    or relative.startswith(('/', '\\')) or ':' in relative
                    or '..' in relative.replace('\\', '/').split('/')):
                continue
            item = {key: artifact[key][:2048] for key in ('artifactId', 'kind', 'relativePath')
                    if isinstance(artifact.get(key), str)}
            if re.fullmatch(r'[a-f0-9]{64}', str(artifact.get('sha256', ''))):
                item['sha256'] = artifact['sha256']
            if isinstance(artifact.get('bytes'), int) and not isinstance(artifact['bytes'], bool) and artifact['bytes'] >= 0:
                item['bytes'] = artifact['bytes']
            selected.append(item)
        if selected:
            result['artifacts'] = selected
    return result


def files_identity(paths):
    result = []
    for path in paths:
        path = Path(path)
        try:
            digest = hashlib.sha256()
            with path.open('rb') as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(chunk)
            result.append({'file': path.name, 'sha256': digest.hexdigest()})
        except FileNotFoundError:
            result.append({'file': path.name, 'missing': True})
        except OSError:
            result.append({'file': path.name, 'unreadable': True})
    return result


def godot_health(*, include_identity=False):
    import godot_native
    exe = godot_native.executable()
    result = {'dependencyId': 'gdre', 'expectedVersion': '2.7.4', 'state': 'missing',
              'detail': 'The bundled GDRETools executable is missing'}
    if exe is None:
        return result
    paths = [exe, exe.with_name('gdre_tools.pck'), exe.with_name('GodotMonoDecompNativeAOT.dll')]
    if include_identity:
        result['identity'] = files_identity(paths)
    missing = [path.name for path in paths if not path.is_file()]
    if missing:
        result.update(state='invalid', detail='GDRETools companion files are missing: ' + ', '.join(missing))
    else:
        try:
            with exe.open('rb') as stream:
                valid = stream.read(2) == b'MZ'
        except OSError:
            valid = False
        result.update(state='ready' if valid else 'invalid',
                      detail='GDRETools file layout is present; game recovery remains separately verified'
                      if valid else 'GDRETools executable is not a Windows PE image')
    return result


def catalog_health():
    import pgmm_native
    components = [godot_health(include_identity=True), pgmm_native.codec_health()]
    fingerprint = hashlib.sha256(json.dumps(components, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return {'protocol': 'pinhao-native-dependency-health-1', 'fingerprint': fingerprint,
            'components': components}


def probe_diagnostic(info):
    value = info.get('diagnostic')
    if isinstance(value, dict):
        return value
    support, engine = info.get('support'), info.get('engine', 'unknown')
    if engine == 'Godot' and support in ('godot_codec_required', 'native_godot_pack_roundtrip'):
        health = godot_health()
        if health['state'] != 'ready':
            info['support'] = 'godot_codec_required'
            return diagnostic('dependency', 'probe', engine, **{key: value for key, value in health.items() if key != 'identity'})
    if support == 'external_native_tool_required':
        dependency = 'lcf2xml' if engine == 'RPG Maker 2000/2003' else 'wolftl-or-uberwolf'
        return diagnostic('dependency', 'probe', engine, dependencyId=dependency, state='missing',
                          detail=info.get('dependency', 'Required native tool is missing'))
    if engine == 'Unity' and not info.get('capabilities', {}).get('extract', True):
        return diagnostic('dependency', 'probe', engine, dependencyId='unitypy', state='invalid',
                          expectedVersion='1.23.0', detail='The fixed UnityPy dependency could not be loaded')
    return None
