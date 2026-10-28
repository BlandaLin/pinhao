# PinHao Text Package 0.2

`index.mjs` is the reference reader/writer for a portable UTF-8 ZIP work package. ZIP transport belongs to the host worker; this library reads and writes the expanded directory. JSON schemas describe the manifest and editable records.

The package contains `START_HERE.md`, immutable `source/`, `context/` and `baseline/`, one editable profile, a generated reading view, glossary/style reference and issues. Source records preserve semantic units, stable IDs, display kind, protected markers and engine-extracted context. Baselines include each unit's exact target value and revision. Local machine paths and credentials are removed from generated portable metadata.

Version 0.2 declares `taskStage` (`translation` or `proofreading`) and separates editable `unitIds` from immutable `referenceUnitIds`. `writePackage` accepts `targetUnitIds` (omitted means all units), closes the selection over synchronized display groups, and writes only those targets to source, baseline and editable records. Other units remain in `context/reference-units.json`; full-project scene and character evidence remains accessible. Unknown or duplicate requested IDs are rejected. Only manifest targets can be submitted, even when reference text is visible nearby. The stage describes the external handoff, not independent proof of language quality.

The authoritative profile is `editable/units.json` or `editable/units.txt`. JSON records allow only `id`, `translation`, `notes`, `intent`. The text profile uses one JSON-escaped string per physical field:

```text
# PINHAO-TEXT 0.2
ID="unit-id"
TEXT="First line\nSecond line"
NOTE=""
INTENT="submit"
```

Intent is `submit`, `keep`, `pending`, or `clear`. `submit` returns work for the declared stage; a translation-stage result does not claim proofreading. `pending` retains the exported text and expresses an unresolved question, not a request to discard the current translation. A notes-only change is not proofreading confirmation. Native engine field restrictions still apply; protected engine line markers represent mandatory native breaks. The pure-text transport can represent arbitrary multiline values without ambiguous separators.

Import validates project/source identity, immutable file hashes, complete task coverage, duplicate and unknown IDs, field types, protected marker order, and historical baselines. The service performs a transaction-wide three-way merge: equal results are idempotent; unchanged returns preserve local changes; a clean local baseline accepts returned changes; divergent edits become conflicts with no partial scene commit. Source/baseline files are generated reference data.

Unknown required capabilities are rejected. Unknown optional extension metadata and declared immutable supplementary files survive import/re-export. Core and extension file paths remain relative and cannot collide.

New packages declare `context/story.json` through the optional `pinhao.story` extension and the ordinary immutable `manifest.files` checksums. `context/scenes.json` retains full-project per-unit engine positions; `context/reference-units.json` contains non-target source/current text and is immutable. The reader still accepts 0.1 complete packages and leaves their original manifest intact; returned `taskStage` is explicitly `unknown` because a prose instruction is not a machine-readable stage declaration. Older packages without story materials remain importable and are described as engine-position context only. The 0.2 writer does not silently downgrade to 0.1, and a 0.1-only reader must reject the new version.

`story.mjs` builds stable engine-position blocks, explicit structural links, scene reading scopes and evidence-based character indices. A position block is a scene candidate; cross-map plot relationships remain unknown until evidence establishes them. Static common-event calls refer to shared text IDs. Dynamic targets stay unknown, and identical names or portraits alone do not merge characters. Source/current-text changes revise only the affected scope's material version.

`reading/scenes.md` contains complete source/current-text views with branch and speaker information. `reading/characters.md` indexes identity evidence, appearances and scene/unit references rather than repeating complete scene text for each character. `START_HERE.md` is the single authoritative handoff: stage, exact editable target range, existing translations, scene-based ownership, synchronized groups, shared terminology, evidence questions, consolidation and final coverage checks. Read the relevant complete scenes, not every project unit indiscriminately. An external lead Agent can delegate to subagents and return the complete package; this workflow needs no product API configuration.

The MIT material API exports `buildStoryContext`, `storyScope`, `storyScopesForUnits`, `storyMaterialEntrypoints`, `readStoryContext` and `verifyStoryReading`. A reading page keeps the same full scope/version, preserves whole units and synchronized groups, and returns a host-generated coverage receipt. Reading coverage demonstrates accessible material, not semantic translation quality.

This implementation supports the native JSON/text exchange profiles. XLIFF and TMX converters are separate follow-up interfaces, not claims made by this reader.
