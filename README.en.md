<p align="center">
  <img src="apps/desktop/public/pinhao-app-icon.png" width="136" height="136" alt="Pinhao's square four-character logo with a red seal">
</p>

<h1 align="center">Pinhao · 拼好汉化</h1>

<p align="center"><strong>Turn a game you love into a story you can read.</strong></p>

<p align="center">
  Windows game localization workbench · Agent collaboration · Open text packages · Standalone games
</p>

<p align="center">
  <a href="README.md">中文</a> · English
</p>

<p align="center">
  <a href="https://github.com/BlandaLin/pinhao/releases/tag/v0.5.8"><strong>Download 0.5.8 for Windows</strong></a> ·
  <a href="#start-your-first-project">Get started</a> ·
  <a href="#engine-coverage">Engine coverage</a> ·
  <a href="docs/CONTRIBUTING.md">Feedback &amp; contributions</a>
</p>

<p align="center">
  <strong>0.5.8 Public Beta</strong> · Windows 10 / 11 x64 ·
  <a href="LICENSE">GPL-3.0-or-later</a> · Official app: free
</p>

**Beta scope:** integrated engine routes do not guarantee complete localization of every game. Custom plugins, encrypted resources, dynamic text, and font layouts still need per-game checks. Keep the original game and saves, and verify a short scene first.

**Official packages are free. Do not pay to buy the official download.** Your chosen model provider bills API usage; compatible local servers are also supported. [Read the 0.5.8 release notes](docs/release-notes/v0.5.8.md).

![Pinhao production overview: project progress, individual stages, and access to the finished build in an original example project](.github/media/overview.png)

<p align="center"><sub>The current Chinese desktop interface, using an original, neutral example project. Model-stage results are local demonstration data.</sub></p>

## It Starts With a Game You Love

Perhaps it is the world, the characters, or a story you want to follow all the way
to its ending. Good localization brings that story within reach: names stay
consistent, dialogue carries its context, and the finished game is ready for your
next adventure.

Pinhao grew out of hands-on game localization. It brings engine adaptation, text
preparation, translation, proofreading, and game assembly into one workflow.
**Choose a game, connect your own models, and produce a standalone localized copy.**

| What matters to you | How Pinhao approaches it |
| --- | --- |
| Dialogue stays connected to the story | Complete text units retain speakers, scene locations, neighboring text, and a shared glossary. |
| Each stage gets the right help | Technical and text roles work in stages with shared or separate connections. Translation and proofreading use the same text model. |
| Your work travels with you | An open ZIP text package connects Pinhao, external AI harnesses, and human translators. Finished builds come as independent game folders and sharing ZIPs. |

**Import a game → Extract and investigate gaps → Translate and proofread → Choose fonts and build → Verify and play**

## 0.5.8: Keep Every Stage Connected

Accepted translations remain saved across pauses. Translation and review Agents can
look up additional project text and retain scoped, evidence-backed decisions about
entities, meanings, and terminology. Differential review records every reviewed
unit and returns actual edits while preserving accurate wording.
First translation starts with the text, not a paid glossary prerequisite. Name choices accumulate with accepted translations; local scanning passes only actual disagreements to the normal review round.

Technical Agents receive complete tool evidence, request related resource scopes,
verify changed text, and reuse validated recipes. Build failures carry their actual
artifacts into technical repair. Output integrity, font coverage, and runtime
observations have separate records.

[Text execution and recovery protocol](docs/product/TEXT_EXECUTION.md) · [Release notes](docs/release-notes/v0.5.8.md)

## Adaptation That Learns From Real Results

Technical execution uses **DeepSeek Harness** by default, with your chosen model;
it does not require a DeepSeek model. Engine detection failures, extraction errors, empty results, and resource coverage gaps
enter a persistent technical task. The Agent inspects working copies, reads public
format documentation, calls registered tools, and writes adapters. Real execution
errors guide the next repair. Host checks cover unchanged round trips, permitted text
differences, protected markers, and changed-text readback before a recipe joins production.

Lightweight JavaScript recipes run in **QuickJS WASM** with explicit file capabilities.
The technical Agent can also write and run scripts through managed local execution,
enabled by an explicit permission grant for each project. Scripts run with the current
Windows user's file and network permissions. The host retains API credentials and
does not pass them to scripts.
Validated recipes are reused against a fresh resource baseline; cancellation retains
progress. Native and supplemental text changes merge by their original locations,
and resource coverage is tracked alongside translation progress.
Switch between day and night modes from the sidebar; Pinhao remembers your choice.

[Adaptation protocol and verification](docs/product/AUTONOMOUS_ADAPTATION.md) · [DSH technical runtime](docs/product/DSH_RUNTIME.md)

## Keep the Context With the Words

Pinhao completes extraction and checks an unchanged writeback before handing the
material to translation and proofreading. Each text unit carries a stable ID,
source text, current translation, and the context supplied by its engine. Shared
names and terminology stay available throughout the project.

Search, review, and revise in the text workbench, or hand the package to an AI tool
or translator you already work with. On return, Pinhao checks source identity,
protected markers, and the revision baseline, then merges accepted work into the
current project.

![Text workbench showing source text, current translation, context, and editing controls in an original example project](.github/media/text-workbench.png)

### A Text Package Built for Collaboration

**Send the context with the task. Bring the results back together.** The ZIP
contains reading instructions, scene references, terminology, current translations,
and editing entry points. Different people or models can handle translation,
proofreading, and polishing while accepted work stays with the project.

<details>
<summary>Explore the package</summary>

```text
text-package.zip
├── START_HERE.md        Reading order and delivery instructions
├── manifest.json        Package identity, format, and file digests
├── source/              Complete source text and stable IDs
├── context/             Scene and context references
├── baseline/            Translation state at export
├── editable/            JSON or plain-text editing entry points
├── reading/             Scene views for continuous reading
├── glossary.json        Shared names and terminology
├── style-guide.md       Writing and localization conventions
└── issues.json          Questions to resolve
```

New exports use **PinHao Text Package 0.2**, with separate targets, read-only references and an explicit translation or proofreading stage. Legacy 0.1 complete packages remain importable. Plain-text mode accepts `TEXT`,
`NOTE`, and submission intent; JSON mode accepts translations, notes, and
submission intent. Stable IDs locate each unit, and three-way merging handles
changes made since export.

[Format and reference implementation](packages/exchange/README.md) · [Text package design](docs/product/TEXT_PACKAGE.md)

</details>

## Start Your First Project

Bring **Windows 10 / 11 x64**, a game folder, and your own model API.
The desktop interface is currently in Chinese; this project overview is available
in Chinese and English.

1. **Open the workbench.** Get the Windows portable package from the [0.5.8 download page](https://github.com/BlandaLin/pinhao/releases/tag/v0.5.8), extract the entire folder to a writable location, and launch `PinhaoWorkbench.exe`.
2. **Connect your models.** In Settings (`设置`), enter your OpenAI-compatible endpoint, model name, and API key. Technical and text work can use separate models; translation and proofreading share the text connection.
3. **Bring in a game and start production.** Drag in a game folder, executable, or Windows shortcut. Check the extracted text and outstanding items, then start production. Use text packages to exchange work with external translators and tools.
4. **Check the result and continue the adventure.** In Builds & Export (`成品与导出`), launch the standalone localized copy and check dialogue, choices, fonts, and save/load. Export a sharing ZIP only when needed.

**Keep work near the game.** Settings and the project index live in `data` beside the portable app. Growing text, technical work, and recovery records live in a recognizable `game-name-拼好工程` folder beside the original game; standalone builds also default to a neighboring folder. Resources are prepared when tools need them, not by copying the entire game for each Agent. Ordinary requests no longer save redundant network streams, reasoning dumps, and parsed translations. See [Project storage](docs/product/PROJECT_STORAGE.md).

**Try a small amount of text before running a full project.** Translation, proofreading, and technical requests can incur API charges. Speed, quality, and cost depend on the game, model, and provider.
Local models connect through OpenAI-compatible servers; see the Qwen example in
[Local Models](docs/product/LOCAL_MODELS.md).

<details>
<summary>The four-step first-launch guide</summary>

![First-launch guide covering model setup, game import, text collaboration, and standalone builds](.github/media/welcome.png)

Open the guide again from Tutorial (`使用教程`) in the sidebar. During production,
the interface shows the current stage and progress, and accepted results are saved
as work proceeds. Translation, proofreading, and targeted cleanup also have
individual entry points.

</details>

## Give the Story Its Typeface

Pinhao includes **Source Han Serif**, **Source Han Sans**, and **LXGW WenKai**, with
each choice previewed in its own typeface. Keep the game's font or choose your own
TTF / OTF file. Selected bundled fonts and their licenses travel with the build.

![Font settings previewing Source Han Serif, Source Han Sans, and LXGW WenKai in their own typefaces](.github/media/font-choices.png)

Engine-specific play assistance provides access to characters, inventory, money,
movement and exploration, recollection-condition analysis, and variables.
MV / MZ builds can also be exported as JoiPlay `.rga` packages for mobile play.

[Play assistance and engine capabilities](docs/product/PLAY_ASSIST.md) · [Mobile play and device checks](docs/product/GAME_TYPES_AND_MOBILE.md)

## Engine Coverage

<p>
  <img src="apps/desktop/public/engines/rpgmaker.webp" height="32" alt="RPG Maker"> &nbsp;
  <img src="apps/desktop/public/engines/godot.svg" height="32" alt="Godot"> &nbsp;
  <img src="apps/desktop/public/engines/unity.svg" height="32" alt="Unity"> &nbsp;
  <img src="apps/desktop/public/engines/renpy.png" height="32" alt="Ren'Py">
</p>

**RPG Maker is the primary route.** Adaptation for indie RPGs, strategy games, and
visual novels follows their actual engines and resource formats:

| Engine | Current resource routes |
| --- | --- |
| **RPG Maker MV / MZ** | JSON data, bound JavaScript display strings, fonts, and standalone assembly. |
| **RPG Maker XP / VX / VX Ace** | Ruby Marshal data, RGSS archives, script containers, and localization modules. |
| **RPG Maker 2000 / 2003** | Native LCF data; Chinese builds include an EasyRPG runtime and fonts. |
| **WOLF RPG Editor** | Archive extraction, native WolfTL writeback, font configuration, and standalone assembly. |
| **TyranoScript / KiriKiri KAG** | KS scenes, display names and buttons, standard ASAR, raw / zlib XP3, and corresponding embedded archives. |
| **Ren'Py** | RPY, static recovery from RPYC, RPA2 / 3, dialogue, choices, character names, UI, and fonts. |
| **Godot 2 / 3 / 4** | PCK and embedded packs, integrated compiled-scene and GDScript routes, translation catalogs, and fonts. |
| **Pixel Game Maker MV** | Text, font bindings, and resource rebuilding for standard and integrated encrypted-project formats. |
| **SMILE GAME BUILDER / RPG Developer Bakin** | Native catalogs and resource containers, display-event text, fonts, and assembly with the original runtime. |
| **Unity** | SerializedFile / UnityFS, structured TextAssets, confirmed UI / TMP fields, StringTables, and embedded dynamic fonts. |

Drag in your game to see its detected engine, extracted text, and project check results.
Each project records its detected capabilities, build checks, and open items. The
implementation matrix documents format coverage and runtime evidence; custom
plugins, encrypted resources, and font layouts receive game-specific adaptation.
Engine detection, text extraction, native writeback, and actual playability are separate checks; none alone proves the others.

[Implementation and verification matrix](docs/product/IMPLEMENTATION.md) · [Native engine routes](docs/product/NATIVE_ENGINES.md)

## Carry Your Work Into the Next Update

Projects retain current translations and revision history. When a game updates,
Connect New Version (`接入新版`) creates a separate project and reuses translations
whose source and context match. The next round of work can focus on new and
changed content.

Everyday work can follow the same staged rhythm: translate, proofread, then run
targeted cleanup. Optional image-text processing sends recognized text through the
same queue; current writeback covers flat-background PNG regions.

## Help More Stories Find Their Readers

Pinhao puts localization tools, technical knowledge, and portable text work into
more players' hands. Use it for your first project, then bring your discoveries,
terminology, and improvements back to the community.

- **Players:** share issues, screenshots, and the result you want to achieve in [Issues](https://github.com/BlandaLin/pinhao/issues).
- **Translators and creators:** exchange text packages and improve terminology, proofreading workflows, and the experience inside the game.
- **Developers:** contribute engine adapters, interface improvements, tests, documentation, and tools for the text-package ecosystem.
- **Supporters:** star the project and share its official address so more people can find it.

The [contribution guide](docs/CONTRIBUTING.md) provides issue templates, minimal
examples, and submission guidance. Redact API keys, personal paths, and private
saves from reports, and use sample material you have permission to share.

## Development and Further Reading

Pinhao uses **Electron + TypeScript / React + SQLite**, with Python-based native
codecs. The DSH technical Agent executes tools and validation/repair loops;
translation and proofreading use a separate text protocol. The task queue saves
results and supports recovery.

<details>
<summary>Run and package from source</summary>

On Windows, prepare **Node.js 24.5+**, npm, and Git:

```powershell
npm ci
npm run prepare:tools
npm run prepare:dsh -- --build
npm run build
npm run desktop
```

`prepare:tools` downloads and verifies pinned Python, fonts, and native tools.
`prepare:dsh -- --build` prepares and compiles the pinned DSH runtime; first setup
requires internet access. See [DSH technical runtime](docs/product/DSH_RUNTIME.md)
for the fixed revision, dependency manager, and packaged runtime details.
Building the legacy managed bridge from source requires the **.NET Framework 3.5**
Windows feature; portable releases include the compiled bridge.

Run local checks as needed:

```powershell
npm test
npm run test:engines
npm run test:ui
```

`test:engines` also needs an available Python interpreter. These component checks
use neutral fixtures or local mock endpoints; they do not replace real-model,
in-game, or clean-machine acceptance testing.

```powershell
npm run package
```

The release folder is generated at
`local/releases/<version>/PinhaoWorkbench-win32-x64/`.
The base CI runs `npm run build`, `npm run check:public`, `npm run test:ci`, and
`npm run test:ui`. Tests use neutral fixtures and local mock model endpoints.

The [desktop development guide](apps/desktop/README.md) covers dependencies and
packaging in detail.

</details>

| Guide | What you will find |
| --- | --- |
| [Product and architecture](docs/product/README.md) | Product definition, responsibilities, and implementation routes |
| [Desktop usage and development](apps/desktop/README.md) | Setup, models, fonts, play assistance, and running from source |
| [Open text packages](packages/exchange/README.md) | Format, schemas, and the MIT reference library |
| [Lessons from localization projects](docs/工程经验.md) | Returned packages, coverage checks, layout, saves, and release practices |
| [Implementation and verification](docs/product/IMPLEMENTATION.md) | Engine capabilities, recorded checks, and ongoing adaptation |

## License and Sharing

**The official software is free, and the technology is open. Do not pay to buy the official download.** Share the official
release address and help others find it. Contributions, sponsorships, and other
forms of support are welcome.

The desktop application and product modules use [GPL-3.0-or-later](LICENSE).
The [text-package library](packages/exchange/LICENSE) uses MIT to make integration
straightforward for other software. Commercial use follows the applicable
licenses; distributing modified GPL versions includes providing the corresponding
source. Bundled fonts use the SIL Open Font License, and third-party components
retain their respective licenses.

Game resources, translations, and their distribution follow their respective
permissions.
