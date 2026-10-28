# Technical Agent Evaluation

This opt-in runner is separate from default unit tests and never falls back to a
fake provider. It constructs the normal `createService` and `productWorker`, uses
normal settings/import/start or retry APIs, and retains the default lab and paid
display reviewer. It does not launch games, install a build, upload evidence or
select source text for the Agent.

Run contract checks without credentials or network:

```powershell
node --test tests/evals/technical/*.test.mjs
node scripts/eval-technical.mjs help
```

An explicit private JSON configuration must contain `sourceRoot`, `gameDir`,
`outputRoot`, `pythonPath`, `dependencyDir`, `baseUrl`, `model`, `reasoning`,
`caseId`, `pairId`, `concurrency`, `mode` (`adaptation` or `all`), and
`limits: { maxHttp, maxMinutes, maxWindows }`. Paths must be absolute. Do not put
credentials, game content, machine paths or grading answers in a public config.
Source/lockfiles, the Python executable and all dependency files are fingerprinted.

```powershell
node scripts/eval-technical.mjs plan --config=private-config.json
node scripts/eval-technical.mjs run --config=private-config.json
node scripts/eval-technical.mjs run --config=private-config.json --resume=episode-directory
node scripts/eval-technical.mjs grade --episode=episode-directory --expectations=private-answers.json
node scripts/eval-technical.mjs compare --before=before-directory --after=after-directory --expectations=private-answers.json
```

`run` reads one private stdin line `{"apiKey":"..."}` with terminal echo disabled.
The credential stays in memory; settings persist only an opaque in-memory token.
The explicit cumulative cap includes failed sends, nested reviewer calls and
transport resends at the configured endpoint. Resume preserves the episode cap,
source freeze and all earlier attempts; it does not grant another window of API
quota. Product adaptation limits also receive the same HTTP/window cap.
An interrupted send-intent is conservatively unknown, not automatically refunded.

Each episode retains original and source manifests, complete HTTP request/body
evidence, the isolated database, host candidate/validation/recipe/binding records,
freshness replay and output-file hashes. These are private game materials and
must not be published with the source. Source changes invalidate comparison.

`gradeTechnicalRun(evidence, { expectations })` returns separate candidate,
validation, accepted/resolved, integrated, build and runtime outcomes. Without
independent target expectations a positive chain is only `accepted-partial`, not
proof of complete coverage. Targets use `{ locator, sourceSha256 }`; forbidden
locations use `{ locator }`. `allowZeroAdded` requires fresh legal closure proofs
and zero remaining unknown, not a model's statement that nothing needs work.
All accepted locations must appear in the independent targets or in
`allowedLocations: [{ locator, sourceSha256 }]`; unreviewed additions prevent a
complete success even when the easy target subset has perfect recall.
The grader replays the existing domain freshness contracts without calling a model.
Coverage classification uses the existing `hasCoverageDecisionProof` contract:
legacy clusters need actual protocol-valid fresh source receipts, not an invented
extra model-review gate. Precise non-display candidates and non-linguistic display
sites still require the independent negative review required by that contract.
Classification counts are separate from recipes and integrated text, and never
close a run with remaining unknown work. Snapshot reads join `project_resources`
when present, so cold coverage/inventory are not silently omitted.

Delivery evidence also reads the raw `acceptance_receipts` table, immutable
accepted-batch/extraction files and the current publication from the isolated
SQLite database. `delivery` cross-checks their identities, qualified recipe,
extraction hash, actual units and generation. Producer acceptance is not host
integration; missing or conflicting records remain pending/evidence-incomplete.
The poll snapshots include publication/lanes for navigation only. Their labels
and counters never establish delivery or concurrency.

Frozen task inputs and their exact manifest files are collected separately.
`host-request-window-overlap` means a stored text-request interval overlaps an
known-sent technical send-intent-to-settlement window with a published frozen
input; it does not prove exact fetch overlap, simultaneous text HTTP execution,
full resource coverage or gameplay.
Missing intervals/snapshots stay `not-proven`. First acceptance/integration
milestones use raw host-ledger timestamps rather than UI poll times.

`contract` evidence never closes autonomy. Fixture runtime uses explicit display
and completion stdout boundaries bound to an exact product manifest, including
text and control parameters; it is not an authentic engine/gameplay result.
Authentic gameplay remains `not-run`. Exit 0 is not a success criterion. The
grade command exits 2 for partial/unachieved autonomy; reports remain available.
Native handoffs that do not use the lab recipe/binding chain are retained as
`unscoredIntegrationCount` and evidence-incomplete, not declared model failures.
Their independent native acceptance reader is a separate follow-up; the current
scored real-game pilot targets the existing MV supplemental-adapter chain.

All current runs are `unisolated-development`: putting answers outside the work
directory does not hide them from arbitrary current-user scripts. Answers are
not accepted by `run`, and are read only by the post-run grader. Do not describe
this as an OS-isolated blind benchmark. Use real games to assess real autonomy;
passing original fixture-consumer checks cannot replace that evidence.

Compare fresh independent episodes with identical game baseline, model/provider,
parameters, concurrency, lock/dependencies and cumulative budget. Keep failures
and all costs, including unknowns. A cheaper early stop with no legitimate
delivery gain is reported only as lower spend/earlier stopping. A single pair is
a pilot, not a reliable success-rate estimate. Tune on development cases, then
evaluate retained real cases without changing thresholds or picking the best run.
