# Native Resource Workers

`python/worker.py COMMAND` reads one UTF-8 JSON object from stdin and emits one
JSON object on stdout. Success is `{ "ok": true, "result": ... }`; failures are
`{ "ok": false, "error": { "code": ..., "message": ... } }` with exit code 2.

| Command | Input paths and values | Result |
| --- | --- | --- |
| `catalog` | none | Installed native engine and play-assist capabilities |
| `probe` | `gameDir` | Engine, native capabilities, unpack/dependency requirement |
| `extract` | `gameDir`, `workspaceDir` | Frozen baseline, complete text units, context, protected tokens, source fingerprint |
| `validate` | `workspaceDir`, optional `translations` | Protected-field and token validation |
| `roundtrip` | `workspaceDir` | No-change native roundtrip proof |
| `build` | `workspaceDir`, `outputDir`, `translations` | Native game data with a verified build manifest |
| `assemble` | `gameDir`, `workspaceDir`, `buildDir`, `outputDir`, optional `fontPath` | Full copied game, font/display runtime, source fingerprint check and absolute protocol-only `launchPath` |
| `zip` | `sourceDir`, `filePath`, optional `release` | ZIP and SHA-256; release mode filters private saves/caches |
| `unzip` | `filePath`, `outputDir` | New directory with path/collision/symlink validation |

`workDir` aliases `workspaceDir`; `outDir` aliases `outputDir`.
`translations` entries contain `legacyId` (or `id`), `translation`, optional
`notes`. Missing IDs retain accepted editable values. Duplicate IDs are errors.
The product owns the portable unit IDs; native bindings stay in the local work.

## Engine Coverage

MV/MZ use JSON native data. VX Ace, VX and XP use Marshal string-span patching,
including XP's command-101 first line and the older vocabulary structures.
RGSS v1/v3 archives are unpacked completely into a private workspace, then
assembled as independent loose-resource copies.

WOLF uses the separate MIT-licensed WolfTL codec. The adapter exports the frozen
native data, selects display commands and schema-labelled database fields,
applies accepted edits, builds native Data, exports it again and compares every
JSON field. Since the codec may decrypt and recompress native bytes, its
roundtrip is structural rather than byte-identical. Unchanged delivery resources
are retained verbatim. The separate bundled MIT UberWolf CLI automatically
unpacks `.wolf` archives into the private workspace. WOLF's original primary
Title remains a read-only save identity; MainFont loads the selected bundled
TTF from the game directory through WOLF's own font-loading mechanism.

LCF 2000/2003 uses the MIT liblcf `lcf2xml` codec. It protects native command
structure, groups dialogue continuations, selects database display fields and
checks a full native/XML re-export. Extraction uses the original codepage
(default 932); edited Chinese builds use codepage 936 with strict conversion.
Reports distinguish native-data proof from runtime/font compatibility. The
original RPG_RT runtime and its bitmap font need an appropriate Chinese runtime;
the desktop product can include a separate EasyRPG player for that purpose.

Environment paths:

* `PINHAO_TOOLKIT`: bundled tutorial parser directory.
* `PINHAO_WOLFTL`: WolfTL executable; local development also checks
  `local/dependencies/wolftl/WolfTL.exe`.
* `PINHAO_UBERWOLF`: UberWolf CLI; local development also checks
  `local/dependencies/uberwolf/UberWolfCli.exe`.
* `PINHAO_LCF2XML`: liblcf codec; local development also checks
  `local/dependencies/lcf/lcf2xml.exe`.

Font and default-name display templates are independently authored. Old custom
actor names retain their values. MV/MZ message layout has synthetic tests for
both character-rendering APIs and page continuation. Actual game launch,
custom-plugin interaction and glyph rendering are runtime acceptance steps.
Source paths are confined to private worker metadata and protocol responses;
the assembled game report uses relative paths. Release ZIPs remove private
saves, MTool sidecars and caches.

## Tests

```powershell
python -X utf8 -B -m unittest discover -s adapters/python -p 'test_*.py' -v
```

Tests create neutral fixtures beneath `local/native-tests`, preserve original
bytes, and exercise native build, complete assembly, font/name bootstrap, ZIP
privacy filtering and path validation. `verify_local_sample.py` can additionally
verify an existing game read-only, retaining only counts/hashes in its report.
