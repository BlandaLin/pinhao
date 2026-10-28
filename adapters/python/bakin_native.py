"""RPG Developer Bakin native resource entry point."""
from yukar_native import extract, build, assemble, READY
from yukar_native import probe as _probe


def probe(game):
    info = _probe(game)
    return info if info and info['engine'] == 'RPG Developer Bakin' else None
