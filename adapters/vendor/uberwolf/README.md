# UberWolf Archive Codec

Upstream: https://github.com/Sinflower/UberWolf

Fixed release URL:
https://github.com/Sinflower/UberWolf/releases/download/v0.6.4/UberWolfCli.exe

SHA-256: `0c9645733ae9544df11ee0c859a7f2cb51aa547d5d13f7935cb480bdab96fb3a`.
The release asset reports `UberWolfCli v0.5.4 Build #106` in its help output.
The adapter records the actual asset hash rather than inferring binary version
from the GitHub release title.

License: MIT, copyright 2023 Sinflower. Retain the bundled CLI11, JSON and
compression notices listed beside WolfTL in the distributed third-party notices.

The product copies `.wolf` archives into a private workspace and invokes only
those copied archives. It never supplies a game executable to the codec or uses
the codec's game-run route. Decoded resources are checked as regular files,
then native data passes through WolfTL build/re-export validation.

On Windows the adapter sets an ASCII argv[0] and passes the actual executable
separately through CreateProcessW. This fixes the upstream self-spawn failure
under Unicode installation directories. The codec's working directory is private
staging, including any detected-key cache, and such cache is excluded from output.

`PINHAO_UBERWOLF` points to the packaged executable. Local development checks
`local/dependencies/uberwolf/UberWolfCli.exe`.
