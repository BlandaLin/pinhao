# Godot RE Tools

The Godot native adapter invokes the unmodified MIT-licensed GDRETools 2.7.4.
It recovers scene resources, project settings and compiled GDScript, then creates
a native pack for the game's existing runtime. The adapter reads public PCK
directory fields and checks the final file inventory and every payload hash.

- Project: https://github.com/GDRETools/gdsdecomp/tree/v2.7.4
- Fixed Windows release: https://github.com/GDRETools/gdsdecomp/releases/download/v2.7.4/GDRE_tools-v2.7.4-windows.zip
- Archive SHA-256: `af24c563eee501effb194d83595de64696c32547b2246034dbfb891a24bfa0ad`
- Source and build instructions: https://github.com/GDRETools/gdsdecomp/tree/v2.7.4#building-from-source
- License: MIT, retained in `LICENSE`.
- Godot PCK reader specification: https://github.com/godotengine/godot/blob/4.4.1-stable/core/io/file_access_pack.cpp
- Godot engine license and dependency notices: https://github.com/godotengine/godot/blob/4.4.1-stable/COPYRIGHT.txt

Run `node scripts/prepare-godot-tools.mjs` to prepare the verified Windows helper.
The helper runs headlessly as a separate process. Runtime artifacts stay in the
local dependency directory and are copied as dependencies when packaging the
desktop product. Each exported game retains its own executable and dependencies;
GDRETools is a construction tool and is not required by the exported game.

Godot 2.1.6, 3.6.1 and 4.4.1 PCK/embedded EXE fixtures are tested with the actual
official engine. Tests cover compiled scenes and scripts, translation catalogs,
the game title, bundled Chinese fonts and native texture replacement.
Source-only projects additionally require a matching Windows runtime through
`PINHAO_GODOT_RUNTIME`. Encrypted packs need a game-specific key recipe. Native
extensions and managed code retain their original binaries. Additional PCK files
and assembly-only text are listed for a project-specific adaptation recipe.
