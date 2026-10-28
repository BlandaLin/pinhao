# Reproducible WolfTL Codec Source

Upstream tag: https://github.com/Sinflower/WolfTL/tree/v0.6.2

Source archive:
https://codeload.github.com/Sinflower/WolfTL/zip/refs/tags/v0.6.2

Source ZIP SHA-256:
`1e527a926ed407760dde42ba9c6e14a8c98a53118d295d2fa57de73326c0ec20`.

Official Windows executable:
https://github.com/Sinflower/WolfTL/releases/download/v0.6.2/WolfTL.exe

Official executable SHA-256:
`a66ffcdb8efa6340b6003cb0afe0cb2bcf3aba5c14499d0b67f8fb868bcfc276`.

The previous project's tested fixed executable differs from the fixed upstream
tag in five source files. `reproduce.py` applies these changes to a fresh source
tree, checking all replacement contexts before writing:

* Merge duplicate size_t/uint32_t overloads for MinGW's 32-bit target.
* Check the read bound without addition overflow, retaining the 32-bit offset.
* Raise stream errors when JSON/native output cannot be written.
* Sanitize carriage returns and newlines in generated export filenames.

The upstream MIT notices remain in every modified file. This patch is an
independently maintained modification of MIT-licensed WolfTL.

Developer build (end users receive the bundled executable):

```powershell
python reproduce.py --source '<fresh WolfTL-0.6.2 folder>' --compiler '<MinGW 14.2 g++.exe>' --output '<new folder>/WolfTL.exe'
```

The tested compiler is MinGW-W64 i686-ucrt-posix-dwarf GCC 14.2.0 (r2).
The script builds lz4 with gcc, then uses C++20, O2, a static GCC/C++ runtime,
Unicode/NOMINMAX defines and shell32. Output hashes vary with compiler build
and timestamp; functional acceptance is native export/build/re-export equality.
Both compilation steps map source and toolchain paths to `/pinhao/source` and
`/pinhao/toolchain`. The mapping covers Windows separator and drive-case variants.

The earlier fixed binary has SHA-256
`f76a63b46efe781281dae88f04f56993a01be6c1ecb1524d6712c7e4fb2a6811`.
Both that binary and the official executable passed the current real WOLF
sample's full native roundtrip. The PinHao modification also handles export names
containing line breaks and reports filesystem write failures explicitly.

The reproduced binary selected for this product has SHA-256
`9075f9d199800b9ea306196513b273a4925c17b471edb0e5e6db7883fb589b6f`.
It was built from the source ZIP identified above and passed the WOLF
native pipeline with 25,423 text units and 163 resources: unmodified
roundtrip, a one-field neutral edited build, full re-export comparison and
unchanged source hashes. No game was launched for this check.

The preceding executable (`2c627f0b011e854bdf1eafee7ae54c8f3d0372502da1f194e81fba0103d2fd45`)
verified the packed 26,461-unit pipeline, complete game assembly and a bundled
LXGW WenKai MainFont patch. Its source changes are retained in the path-mapped build.
