<p align="center">
  <img src="apps/desktop/public/pinhao-app-icon.png" width="136" height="136" alt="Pinhao's square four-character logo with a red seal">
</p>

<h1 align="center">Pinhao · 拼好汉化</h1>

<p align="center"><strong>Turn a game you love into a story you can read.</strong></p>

<p align="center">
  A Windows workbench that brings resource processing, AI translation and proofreading, and standalone game builds into one workflow.
</p>

<p align="center"><a href="README.md">中文</a> · English</p>

<p align="center">
  <a href="https://github.com/BlandaLin/pinhao/releases/tag/v0.5.8"><strong>Download 0.5.8 for Windows</strong></a> ·
  <a href="#start-your-first-project">Get started</a> ·
  <a href="#engine-coverage">Engine coverage</a> ·
  <a href="docs/release-notes/v0.5.8.md#known-issues">Known issues</a>
</p>

<p align="center"><strong>0.5.8 Public Beta</strong> · Windows 10 / 11 x64 · Free software; model services may charge for API usage</p>

**The current download has a Chinese interface. An English-language beta is planned, but is not available yet.** Compatibility varies by game; start with a short scene.

![Historical interface demonstration: production overview for an original, neutral example project](.github/media/overview.png)

<p align="center"><sub>Historical UI demonstration, not a new 0.5.8 screenshot or a real-game success claim. The project is an original neutral example; model-stage results use local demonstration data.</sub></p>

## It Starts With a Game You Love

When making game localizations myself, I had already produced finished copies with existing tools. But some text could not be extracted by those parsers. Translation and production then came to a stop, even though much of the game was within reach.

Pinhao starts with that obstacle. It connects native tools, AI-assisted technical investigation, translation, proofreading, and game assembly. The aim is to keep investigating and attempting adaptation when an unusual format gets in the way, so more localization projects have a chance to continue.

## What You Can Do

| Your task | How Pinhao helps |
| --- | --- |
| Make a localized copy you can check and play | Build an independent game folder, then check its dialogue, choices, fonts, and save/load. The finished localization does not need Pinhao running beside it. |
| Investigate missing or inaccessible text | A technical Agent can inspect files, run tools, and attempt an adapter. Only validated and accepted results enter the translation workflow. |
| Keep and hand off your work | Search and revise translations in the workbench, or exchange open text packages with external AI tools and human translators. Accepted work stays with the project. |

**Import a game → Extract and investigate gaps → Translate and proofread → Build → Check in the game**

0.5.8 brings these stages together, with direct first translation, focused terminology review, saved progress, and projects kept near the game. [Read the release notes](docs/release-notes/v0.5.8.md).

## Engine Coverage

**RPG Maker is the primary route.** These are integrated resource-processing routes, not a promise that every game made with an engine will work completely.

| Engines | Available routes | What still needs checking |
| --- | --- | --- |
| **RPG Maker MV / MZ** | JSON data, bound JavaScript display strings, fonts, standalone assembly | Custom plugins, dynamic text, layout |
| **RPG Maker XP / VX / VX Ace / 2000 / 2003** | Ruby Marshal and RGSS; native LCF with EasyRPG for Chinese builds | Custom scripts, old-runtime behavior, fonts and saves |
| **WOLF RPG Editor** | Archive extraction, native WolfTL writeback and font configuration | Archive variants, encoding and game-specific behavior |
| **TyranoScript / KiriKiri KAG / Ren'Py** | Supported script and archive routes, display text and names | Custom tags, encrypted archives, dynamic scripts |
| **Godot / Unity** | Supported native packs, scenes, scripts and structured text resources | Encrypted or custom resources, dynamic text, Unity font atlases and layout |
| **Pixel Game Maker MV / SMILE GAME BUILDER / RPG Developer Bakin** | Integrated project/container formats, display-event text and resource rebuilding | Format variants and actual runtime behavior |

Engine detection, text extraction, native writeback, and playability are separate checks. A format table is not a collection of completed game playthroughs. See the [implementation and verification matrix](docs/product/IMPLEMENTATION.md) and [native engine routes](docs/product/NATIVE_ENGINES.md) for the recorded scope.

The screenshots on this page demonstrate the interface. A publicly shareable, same-scene comparison of original text, workbench edits, and the finished game remains to be added; these images do not stand in for it.

## Start Your First Project

Bring **Windows 10 / 11 x64**, a game folder, and your own model API. Keep the original game and saves.

1. **Open the workbench.** Download `pinhao-0.5.8-Windows-x64.zip` from the [release page](https://github.com/BlandaLin/pinhao/releases/tag/v0.5.8), extract the whole package to a writable location, and run `PinhaoWorkbench.exe`. The source ZIP is for development, not for launching the app.
2. **Connect your models.** In Settings (`设置`), enter your OpenAI-compatible endpoint, model name, and API key. Technical work and text work can use different connections; translation and proofreading share the text connection.
3. **Import and try a short scene.** Drag in a game folder, executable, or Windows shortcut. Check the extracted text and outstanding items, then start production. Project script execution requires its own permission grant.
4. **Check the result.** In Builds & Export (`成品与导出`), launch the standalone copy and check dialogue, choices, fonts, branches, and save/load. Export a sharing ZIP when you need one.

**Where your work goes:** settings and the lightweight project index live in `data` beside the portable app. Projects default to a recognizable `game-name-拼好工程` folder beside the original game; the localized copy also defaults to a neighboring folder. See [Project storage](docs/product/PROJECT_STORAGE.md).

**Official downloads are free. Do not pay to buy the official package.** Technical, translation, and proofreading requests may incur API charges from your chosen provider. Compatible local model servers are another option; see [Local models](docs/product/LOCAL_MODELS.md) for setup and limitations.

## Beta Status and Feedback

This is a public beta, not an all-engine or all-game completion guarantee. Test a short scene before a full project; build checks alone do not prove the game is playable.

The first GitHub CI run for the published 0.5.8 source had **4 failing tests**. Two were identified as Windows long/short-path comparisons; the other two remain under investigation. See [Known issues](docs/release-notes/v0.5.8.md#known-issues) for the run, version boundary, and current record. A later change on `main` does not silently update the existing download.

**One actual scene can make a useful report.** In [Issues](https://github.com/BlandaLin/pinhao/issues), include your software and engine versions, steps, expected and actual results, and where the work stopped. For missing text, identify the dialogue or menu; for terminology, a small example is enough. Redact keys and personal paths. Do not publicly upload complete games, private projects, API settings, or saves. [Feedback and contribution guide](docs/CONTRIBUTING.md).

## Investigate Gaps in Text Extraction

When extraction fails or misses a resource, the technical Agent can inspect files, call tools, and attempt an adaptation. The host checks its results before accepted text joins the workbench. An inventory of candidates or an Agent saying "done" is not a verified delivery.

Technical execution uses **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** by default. You choose the model; a DeepSeek model is not required. Thanks to the upstream project for its MIT-licensed runtime; the fixed revision and integration are documented in [DSH technical runtime](docs/product/DSH_RUNTIME.md).

<details>
<summary>Technical checks and script permissions</summary>

Native parsers handle known formats. For exceptions, the Agent can investigate resources and propose adapters; checks include unchanged round trips, protected markers, permitted changes, and changed-text readback. Validated adaptation results can be reused after checking the resource baseline, rather than repeating the same investigation.

Lightweight JavaScript recipes use QuickJS WASM with explicit file capabilities. With a project permission grant, the Agent can also write and run scripts through managed local execution. **Those scripts run with the current Windows user's file and network permissions; this is not a strong operating-system sandbox.** The host retains API credentials and does not pass them to scripts. Pause before revoking script permission.

[Adaptation protocol and verification](docs/product/AUTONOMOUS_ADAPTATION.md)

</details>

## Keep the Context With the Words

Complete text units retain their available scene, speaker, neighboring-text and terminology context. The model handles the language; local software maps results to their engine locations and checks protected markers. Initial translations accumulate name choices, and actual disagreements go into the normal review process rather than a separate full-glossary prerequisite.

In proofreading, scene-review results are saved before final consistency checks and submission. **"Reviewed" and "proofreading complete" are different states.** Accepted translations, revisions, and recovery records remain with the project, with recovery based on saved checkpoints.

<details>
<summary>Text workbench and open text packages</summary>

![Historical text-workbench demonstration using an original neutral example](.github/media/text-workbench.png)

Historical UI demonstration with local model-stage data, not a new 0.5.8 capture or a real-game completion result.

An open ZIP package carries source text, current translations, scene references, terminology, a revision baseline, and an editing entry point. Work with an external AI tool or a human translator, then return the package to the same project. Source identity, protected markers, and revision conflicts are checked on import.

Exports use **PinHao Text Package 0.2**; complete legacy 0.1 packages remain importable. JSON and plain-text editing share stable identities and three-way merging. The package is not tied to one model provider.

[Format and MIT reference library](packages/exchange/README.md) · [Package design](docs/product/TEXT_PACKAGE.md) · [Text execution and recovery](docs/product/TEXT_EXECUTION.md)

</details>

## Fonts and Other Tools

Choose **Source Han Serif**, **Source Han Sans**, **LXGW WenKai**, the game's font, or your own TTF/OTF. Bundled fonts and their licenses travel with the build. Font coverage and in-game layout still need checking.

Play assistance provides engine-specific state, inventory, character, movement, or recollection-condition tools; it is not a universal gallery-unlock switch. MV/MZ builds can export JoiPlay `.rga` packages, with phone behavior requiring device checks. Optional image-text processing can write back supported flat-background PNG regions; complex images may remain unchanged.

<details>
<summary>Historical interface examples</summary>

![Historical font-selection interface preview](.github/media/font-choices.png)

![Historical first-launch guide demonstration](.github/media/welcome.png)

These are historical interface examples, not newly captured 0.5.8 screens. Any model-stage results shown use local demonstration data. The desktop also offers day/night themes and separate translation, proofreading, and targeted-cleanup entry points.

</details>

[Play assistance](docs/product/PLAY_ASSIST.md) · [Mobile play](docs/product/GAME_TYPES_AND_MOBILE.md)

## Development and Further Reading

The desktop uses **Electron + TypeScript / React + SQLite**, with Python-based native codecs. DSH handles technical model/tool execution; translation and proofreading retain their separate text protocol.

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

First setup downloads pinned tools and runtime dependencies. Building the legacy managed bridge requires the Windows **.NET Framework 3.5** feature; portable packages include the compiled bridge. See the [desktop guide](apps/desktop/README.md) and [DSH runtime guide](docs/product/DSH_RUNTIME.md) for prerequisites.

```powershell
npm test
npm run test:engines
npm run test:ui
npm run package
```

`test:engines` also needs Python. These local component checks use neutral fixtures or mock model endpoints, not real-model or in-game acceptance. Packaging writes `local/releases/<version>/PinhaoWorkbench-win32-x64/`. The CI configuration and its recorded result are separate facts; see [Beta status](#beta-status-and-feedback).

</details>

[Product and architecture](docs/product/README.md) · [Implementation and verification](docs/product/IMPLEMENTATION.md) · [Project experience](docs/工程经验.md) · [Contributing](docs/CONTRIBUTING.md)

## License and Sharing

**Official downloads are free. Do not pay to buy the official package.** Share the official download address; contributions and sponsorships are welcome.

The desktop application and product modules use [GPL-3.0-or-later](LICENSE); the standalone [text-package library](packages/exchange/LICENSE) uses MIT. Commercial use follows the applicable licenses, and distributing modified GPL versions includes providing the corresponding source. Bundled fonts use the SIL Open Font License; third-party components retain their notices. Game resources, translations, and their distribution follow their respective permissions.
