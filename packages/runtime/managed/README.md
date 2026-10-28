# Managed Frame Assistance

The product's own bridge runs inside a managed game's existing frame method.
Mono.Cecil 0.11.6 (MIT) performs static assembly inspection and IL insertion in
the generated game copy. Neither inspection nor installation executes the game.

Supported bindings:

- Unity Mono: existing `Update`, `LateUpdate`, `FixedUpdate` or `OnGUI` methods
  on `MonoBehaviour` subclasses in `Assembly-CSharp` assemblies.
- SMILE GAME BUILDER and RPG Developer Bakin Windows/.NET runtimes:
  `Yukar.Engine.GameMain` and `MapScene` frame methods.
- Existing scalar instance/static fields, nested objects, lists and dictionaries
  are presented as named values. Commands preserve CLR types and numeric ranges.
  Properties, arbitrary methods, delegates and custom value-type setters are
  outside the field adapter.

`PINHAO_ASSIST_DIR` and `PINHAO_ASSIST_TOKEN` activate the existing file protocol.
Writes require the current session and an already catalogued field identity;
every write records its original value under `PINHAO_ASSIST_BACKUP_DIR` first.
The fallback backup location is the current Windows user's local application
data directory. Normal standalone play leaves the bridge inactive.

The installer detects IL2CPP through `GameAssembly.dll` and reports that runtime
separately. BepInEx/Il2CppInterop offer an open-source route for native Unity
runtimes, requiring an architecture/version-specific loader and generated
interop assemblies. This Mono/.NET bridge makes no IL2CPP runtime claim.

Preparation: `node scripts/prepare-managed-tools.mjs`. The distributable tools
are `Mono.Cecil.dll`, `Mono.Cecil-LICENSE.txt`, `Pinhao.ManagedPatch.exe`,
`net20/Pinhao.ManagedAssist.dll`, `net40/Pinhao.ManagedAssist.dll`, and
`provenance.json`. Temporary NuGet archives, PDBs and extraction caches stay out
of the product distribution. The bridge and patcher source are GPL-3.0-or-later.
