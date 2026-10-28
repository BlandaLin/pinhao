"""Pixel Game Maker MV distribution layout and native project font settings."""
from pathlib import Path
import base64
import importlib
import importlib.util
import os
import shutil
import sys

import rpgmaker as core
import native_environment

ENGINE = 'Pixel Game Maker MV'
READY = 'native_source_roundtrip'
IV = bytes.fromhex('A047E93D230A4C62A744B1A4EE857FBA')


class CodecError(ValueError):
    def __init__(self, state, message):
        super().__init__(message)
        self.code = 'NATIVE_DEPENDENCY_MISSING' if state == 'missing' else 'NATIVE_DEPENDENCY_INVALID'
        self.diagnostic = native_environment.diagnostic('dependency', 'probe', ENGINE,
            dependencyId='pgmm-codec', state=state, expectedVersion='0.6.0 / CPython 3.12 Windows x64', detail=message)


def codec_root():
    return Path(os.environ.get('PINHAO_PGMM_CODEC') or Path(__file__).resolve().parents[2] / 'local/dependencies/pgmm')


def codec():
    name = '_pinhao_pgmdec'
    if name not in sys.modules:
        root = codec_root()
        package = root / 'pgmdec'
        if not (package / '__init__.py').is_file():
            raise CodecError('missing', 'PGMM Twofish codec is required')
        spec = importlib.util.spec_from_file_location(name, package / '__init__.py', submodule_search_locations=[str(package)])
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
            if not all(callable(getattr(module, function, None)) for function in
                       ('decrypt_key', 'decrypt_resource_bytes', 'decrypt_resource_file')):
                raise CodecError('invalid', 'PGMM Twofish codec is missing its required API')
        except CodecError:
            del sys.modules[name]
            raise
        except (ImportError, OSError):
            del sys.modules[name]
            raise CodecError('invalid', 'PGMM Twofish codec requires its matching Python runtime') from None
        except Exception:
            del sys.modules[name]
            raise CodecError('invalid', 'PGMM Twofish codec could not be loaded') from None
    return sys.modules[name]


def codec_health():
    package = codec_root() / 'pgmdec'
    result = {'dependencyId': 'pgmm-codec', 'expectedVersion': '0.6.0 / CPython 3.12 Windows x64',
              'identity': native_environment.files_identity([package / name for name in
                  ('__init__.py', 'decrypt.py', 'utils.py', '_minicrypto.cp312-win_amd64.pyd')])}
    try:
        codec()
        result.update(state='ready', detail='PGMM codec imported with the current Python runtime')
    except CodecError as error:
        result.update(state=error.diagnostic['state'], detail=str(error))
    return result


def resource_key(root):
    info = Path(root) / 'info.json'
    if not info.is_file():
        raise ValueError('Encrypted PGMM resources require info.json with their resource key')
    document = core.read(info)
    if not isinstance(document, dict) or not isinstance(document.get('key'), str):
        raise ValueError('PGMM resource key is missing from info.json')
    try:
        encrypted = base64.b64decode(document['key'].strip(), validate=True)
    except ValueError:
        raise ValueError('PGMM resource key is not valid base64') from None
    if not encrypted or len(encrypted) % 16 or len(encrypted) > 32:
        raise ValueError('PGMM resource key has an unsupported encrypted length')
    return codec().decrypt_key(encrypted)


def decrypt_resource(raw, key):
    if not raw.startswith(b'enc'):
        return raw
    if len(raw) < 4 or raw[3] > 16 or (len(raw) - 4) % 16 or raw[3] > len(raw) - 4:
        raise ValueError('Invalid encrypted PGMM resource header or block length')
    return codec().decrypt_resource_bytes(raw[4:], raw[3], key)


def encrypt_resource(raw, key):
    codec()
    native = importlib.import_module('_pinhao_pgmdec._minicrypto')
    derive = importlib.import_module('_pinhao_pgmdec.utils').derive_subkey
    cipher = native.Weakfish() if len(key) <= 8 else native.Twofish(derive(key, len(raw)))
    padding = (-len(raw)) % 16
    ciphertext = native.CBC(IV).encrypt(cipher, raw + b'\0' * padding)
    return b'enc' + bytes([padding]) + ciphertext


def probe(game):
    game = Path(game)
    # These are the runtime's data/project.json and Resources search-path layouts.
    for root in (game / 'data', game / 'Resources' / 'data', game):
        path = root / 'project.json'
        if not path.is_file():
            continue
        with path.open('rb') as stream:
            prefix = stream.read(16)
        if prefix.startswith(b'enc'):
            try:
                document = core.parse_json(decrypt_resource(path.read_bytes(), resource_key(root)))
                if not isinstance(document, dict) or not isinstance(document.get('textList'), list) or not isinstance(document.get('gameInformation'), dict):
                    raise ValueError('Decoded PGMM project has an unsupported schema')
            except CodecError as error:
                return {'engine': ENGINE, 'root': root.relative_to(game).as_posix(),
                        'support': 'pgmm_encrypted_project_codec_required', 'dependency': str(error),
                        'diagnostic': error.diagnostic}
            except (ValueError, UnicodeError) as error:
                return {'engine': ENGINE, 'root': root.relative_to(game).as_posix(),
                        'support': 'pgmm_encrypted_project_unsupported', 'dependency': str(error),
                        'diagnostic': native_environment.diagnostic('format', 'probe', ENGINE,
                            state='unsupported', detail=str(error))}
            return {'engine': ENGINE, 'root': root.relative_to(game).as_posix(), 'support': READY,
                    'packed': True, 'archives': [], 'archiveFormat': 'pgmm-enc'}
        try:
            document = core.read(path)
        except (ValueError, UnicodeError):
            continue
        if isinstance(document, dict) and isinstance(document.get('textList'), list) and isinstance(document.get('gameInformation'), dict):
            return {'engine': ENGINE, 'root': root.relative_to(game).as_posix(), 'support': READY}
    return None


def prepare(game, source, info, helpers):
    """Stage a project tree and decode encrypted resources at their original paths."""
    from rgss_archive import destination
    game, source = Path(game), Path(source)
    root = game / info['root']
    key = resource_key(root)
    source.mkdir(parents=True)
    encrypted, files = [], {}
    for relative, path in helpers.files_in(root):
        if helpers.excluded(relative):
            continue
        name = (Path(info['root']) / relative).as_posix()
        target = destination(source, name)
        target.parent.mkdir(parents=True, exist_ok=True)
        with path.open('rb') as stream:
            prefix = stream.read(3)
        if prefix == b'enc':
            target.write_bytes(decrypt_resource(path.read_bytes(), key))
            encrypted.append(relative)
        else:
            shutil.copyfile(path, target)
        files[name] = helpers.digest_file(path)
    return {'format': 'pgmm-enc', 'root': info['root'], 'encryptedFiles': encrypted, 'sourceFiles': files}


def finalize(root, layout, helpers, inventory):
    """Restore the shipped encrypted format after text, font and image overlays."""
    from rgss_archive import destination
    root = Path(root)
    key = resource_key(root)
    for file in layout['encryptedFiles']:
        path = destination(root, file)
        if not path.is_file():
            raise ValueError('Encrypted PGMM resource is missing after assembly: ' + file)
        raw = path.read_bytes()
        encoded = encrypt_resource(raw, key)
        if decrypt_resource(encoded, key) != raw:
            raise ValueError('PGMM encrypted resource roundtrip differs: ' + file)
        path.write_bytes(encoded)
    notices = next((directory for directory in (helpers.ROOT / 'adapters/vendor/pgmm',
                    helpers.ROOT / 'THIRD_PARTY_LICENSES/adapters/pgmm') if directory.is_dir()), None)
    for name, target_name in (('LICENSE', 'pgmm-codec-LICENSE.txt'), ('NOTICE.txt', 'pgmm-twofish-NOTICE.txt')):
        if notices and (notices / name).is_file():
            target = root / 'pinhao-localization' / target_name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(notices / name, target)
    inventory['encryptedResources'] = len(layout['encryptedFiles'])


def install_font(root, font, inventory, helpers):
    """Retain font resource IDs/sizes while giving each locale a CJK-capable TTF."""
    if not font:
        return
    root, font = Path(root), Path(font)
    project = root / 'project.json'
    document = core.read(project)
    fonts = document.get('fontList', [])
    if not isinstance(fonts, list):
        raise ValueError('PGMM fontList must be an asset tree')
    settings = []

    def walk(items):
        for resource in items:
            if not isinstance(resource, dict):
                raise ValueError('PGMM font resources must be objects')
            if resource.get('folder'):
                children = resource.get('children', [])
                if not isinstance(children, list):
                    raise ValueError('PGMM font folder children must be a list')
                walk(children)
                continue
            locales = resource.get('localeSettings', {})
            if not isinstance(locales, dict) or any(not isinstance(value, dict) for value in locales.values()):
                raise ValueError('PGMM font localeSettings must contain font-setting objects')
            settings.append(resource)
            settings.extend(locales.values())

    walk(fonts)
    if not settings:
        inventory['warnings'].append('PGMM project has no font resources to update')
        return
    family, digest = helpers.font_family(font), helpers.digest_file(font)
    name = 'PinHao-' + digest[:16]
    # The official FontManager probes .ttf/.ttc paths; FreeType reads TTF and OTF headers.
    target = root / 'fonts' / (name + '.ttf')
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.resolve() != font.resolve():
        shutil.copyfile(font, target)
    converted = sum(bool(setting.get('imageFontFlag')) for setting in settings)
    for setting in settings:
        setting['imageFontFlag'] = False
        setting['fontName'] = name
        setting['ttfName'] = name
    helpers.json_write(project, document)
    inventory['font'] = {'family': family, 'file': target.relative_to(root).as_posix(),
                         'sha256': digest, 'settings': len(settings), 'bitmapSettingsConverted': converted}
