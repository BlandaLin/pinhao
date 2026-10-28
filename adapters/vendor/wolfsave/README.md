# WolfSave Native Save Codec

The WOLF save assistance adapter runs Sinflower/WolfSave v0.1.0 as a separate
native process. The codec reads and writes standard encrypted WOLF `.sav` files
through its typed JSON representation. Variable database fields are editable;
structural fields and other save sections retain their original values.

- Project and fixed source: https://github.com/Sinflower/WolfSave/tree/v0.1.0
- Windows binary: https://github.com/Sinflower/WolfSave/releases/download/v0.1.0/WolfSave.exe
- SHA-256: `bf05866896bf7a41211842a20c56581f8707c7c1a08a538d28bcf271525cf020`
- License: MIT, Copyright (c) 2024 Sinflower; see `LICENSE`.
- Native file-version ceiling in this release: `0x8E`.

Run `node scripts/prepare-assist-legacy.mjs` to obtain the fixed codec. Packaged
applications include the executable, this notice and its license. The adapter
first checks a byte-identical no-change native roundtrip, validates a changed
save by independently decoding it, and retains a content-addressed backup before
atomically replacing the selected save. Close the game before editing and load
the modified save in the game afterwards.

The adapter repairs the v0.1.0 writer's dropped `SavePart1` `-1` sentinel at its
fixed typed position, then updates the standard checksum and encryption streams.
The original-byte roundtrip and independent native decode also cover this case.
Format references: the upstream `WolfSaveParser.h` and `SavePart1.h` at the fixed
source tag above.
