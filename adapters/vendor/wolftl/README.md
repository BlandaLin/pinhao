# WolfTL Native Codec

Upstream: https://github.com/Sinflower/WolfTL

License: MIT, copyright 2024 Sinflower. The codec also carries its bundled
third-party notices in the upstream source headers.

The product adapter invokes WolfTL as a separate process and validates native
output by exporting it again. It never uses the codec's in-place patch option.

The bundled codec is WolfTL 0.6.2 with the reproducible PinHao source changes,
SHA-256 `9075f9d199800b9ea306196513b273a4925c17b471edb0e5e6db7883fb589b6f`.
Its local development location is `local/dependencies/wolftl/WolfTL.exe`.
Packaged builds set `PINHAO_WOLFTL` to their bundled executable. The fixed upstream
source archive, patch and tested build command are documented in
`patches/README.md`; `patches/reproduce.py` recreates the source changes and builds
the codec. Source and toolchain paths use portable build prefixes in the
executable. The MIT license and bundled third-party notices are included here.

WOLF archives are unpacked with the separately bundled MIT UberWolf CLI before
this codec processes native Data. Native roundtrip compares all
exported fields because WolfTL may decrypt/recompress native bytes. Unchanged
release resources are retained byte for byte.

The source changes passed a real packed WOLF sample with 26,461 text
units: archive extraction, native roundtrip, edited native build and re-export,
complete assembly, and MainFont mutation with a bundled TTF. The source archive
hashes remained unchanged. These are resource-level checks, not a game-runtime
acceptance claim. The path-mapped executable additionally passed native
export/roundtrip/edited-build/re-export checks on a complete 25,423-unit,
163-resource sample, with source files unchanged.

WOLF's official documentation specifies that TTF/TTC files beside Game.exe (or
inside an unpacked Data directory) are loaded by the engine. The font adapter
uses this mechanism and sets MainFont to the font's actual family name:
https://silversecond.com/WolfRPGEditor/Help/02gamesetting.html
https://silversecond.com/WolfRPGEditor/Help/?frame=06material.html

The same documentation states that changing Game.dat's primary Title changes
save compatibility. That field is kept as a read-only save identity; TitlePlus
and startup/title display messages remain editable. Special-symbol subfonts
retain their original settings.
