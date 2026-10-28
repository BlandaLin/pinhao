"""Small shared helpers for native tests."""
import os
import time

_WINDOWS = os.name == 'nt'


def cleanup_temporary(temporary):
    """Allow up to 0.75 seconds for Windows to release fixture file locks."""
    for attempt in range(6):
        try:
            temporary.cleanup()
            return
        except OSError as error:
            if not _WINDOWS or getattr(error, 'winerror', None) not in (32, 145) or attempt == 5:
                raise
            time.sleep(0.05 * (attempt + 1))
