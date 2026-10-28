# KiriKiri XP3 and Font Support

The XP3 codec is an independent format implementation based on the public
[KiriKiri archive reader](https://github.com/krkrz/krkrz/blob/master/base/XP3Archive.cpp).
It reads standard raw/zlib XP3, segmented resources, patch containers and executable overlays.
Game-specific encryption filters are reported during extraction.

The fixed official [KiriKiri2 2.32r2 SDK](https://krkrz.github.io/download/kr2_232r2.zip)
supplies the unmodified x86 `addFont.dll` plugin. `prepare-kirikiri-tools.mjs` verifies
the SDK checksum and retains its original license with the plugin. The selected
font is process-private; the game receives a KAG3 `AfterInit2.tjs` bootstrap.
The original game runtime is retained. The SDK engine is used only for optional tests.

The plugin retains the W.Dee KiriKiri license, offered in the SDK alongside GPL-2.0.
Its redistribution terms cover SDK runtime plugins with games; the license is also
included in the workbench distribution and generated game font directory.

Optional runtime verification: `python scripts/test-kirikiri-native.py --sdk <sdk-directory> --output <new-test-directory>`.
Add `--embedded` for an executable-overlay test. Tests use a neutral scene and the
official KAG3 template, write the engine's displayed history and font, and exit.
