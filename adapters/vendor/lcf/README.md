# EasyRPG liblcf Native Codec

Upstream: https://github.com/EasyRPG/liblcf

Official Windows artifact, Jenkins build 277:
https://ci.easyrpg.org/job/liblcf-win32/277/artifact/build/bin/lcf2xml.exe

The downloaded 2026-10-17 artifact is fixed locally. SHA-256:
`5822020672595ecc046a79be1ce7f3a4d76e33453575e271ea7c5dce6467ab8a`.
The preparation script uses this fixed build rather than the moving CI latest URL.
The bundled host supplies
`PINHAO_LCF2XML`; local development checks `local/dependencies/lcf/lcf2xml.exe`.

liblcf is MIT licensed. Its native/XML codec is invoked in a private staging
directory, with relative ASCII filenames for Windows argv compatibility.
No-change roundtrip converts native data back through the same source codepage.
Changed builds use the project's target codepage (default CP936), re-export every
native file and compare its complete field tree with the accepted projection.
All strings must be encodable; substitutions are rejected before writing.

Native data support does not establish RPG_RT.exe's Chinese font/codepage
compatibility. The adapter reports this runtime requirement and does not replace
the original player executable or its fixed bitmap font. Source/target codepages
and 2k/2k3 mode are saved with the project so subsequent imports use one recipe.
