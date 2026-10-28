"""Shared resource-copy policy; asset directories keep their original identities."""
import json
from pathlib import Path
import re

POLICY = json.loads((Path(__file__).parent / 'private-paths.json').read_text(encoding='utf-8'))
DIRECTORY_NAMES = frozenset(POLICY['directoryNames'])
ROOT_DIRECTORIES = frozenset(POLICY['rootDirectories'])
FILES = frozenset(POLICY['files'])
EXTENSIONS = frozenset(POLICY['extensions'])
NAME_PATTERNS = [re.compile(value) for value in POLICY['fileNamePatterns']]


def excluded(relative):
    parts = [part.casefold() for part in str(relative).replace('\\', '/').split('/') if part not in ('', '.')]
    if not parts:
        return False
    name = parts[-1]
    path = '/'.join(parts)
    return (any(part in DIRECTORY_NAMES for part in parts)
            or parts[0] in ROOT_DIRECTORIES
            or any(path == directory or path.startswith(directory + '/') for directory in POLICY['directoryPaths'])
            or name in FILES or Path(name).suffix in EXTENSIONS
            or any(pattern.fullmatch(name) for pattern in NAME_PATTERNS)
            or name.startswith(tuple(POLICY['prefixes']))
            or name.endswith(tuple(POLICY['suffixes'])))
