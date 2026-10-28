# Persistent Core

Node.js 24 (`node:sqlite`) domain service used by the Electron host and the local development host.

```js
import { createService } from './service.mjs';

const service = await createService({
  dataDir,
  worker: async (command, args, { signal }) => runPythonWorker(command, args, signal),
  secrets: { encrypt, decrypt },
  onChanged: () => publishProjectChanged(),
});
```

The service implements the shared `DesktopApi` business methods. Native file dialogs, opening folders and launching games belong to the host. `close()` cancels requests and closes the database. Secrets hooks return opaque strings, synchronously or asynchronously. Returned settings expose `hasKey`; empty key inputs retain the saved key.

The optional `defaultFontPath` initializes the first settings snapshot with a host-bundled Chinese font. Saved user settings take precedence. The worker `catalog` command supplies installed native capabilities at startup.

`createProject()` probes, extracts full semantic units, adds statically bound JavaScript display text and verifies an unmodified native roundtrip. Failed preparation can be retried through `startProject()` under the same project ID, using a new preparation directory. The next start dispatches technical analysis, then one scene translation batch whose actual native build and verification must pass before the other batches dispatch. Translation and proofreading lead to an independent game copy. The sample data artifact is recorded separately from final builds and from pending runtime checks. Standard resources use the Python adapter; script display fields use the syntax-bound JavaScript adapter.

SQLite stores immutable source identities, current revisions, historical baseline values, tasks, issues, build records and encrypted connection settings. All model roles share one pool. Concurrency starts at 3. Model calls have bounded attempts and cancellation. Accepted text survives restarts; uncertain in-flight jobs recover paused. Each run fixes its model configurations and language. Repeating an accepted task or unchanged build reuses its result.

Translation and proofreading use versioned task cards, complete source units and read-only adjacent context. Typed control markers are checked before revision commit. Local failures preserve the baseline and continue. Persistent connection failure, total failure of core text tasks and failed native construction pause their stage. Build checks record structural success separately from pending real gameplay checks.

The `provider`, `technicalProvider` and `scriptTools` injections permit offline tests. The production default uses AI SDK Core and its OpenAI-compatible provider, plus `ToolLoopAgent` for technical inspection.

## Shared Glossary

After full extraction and optional OCR, the service prepares a persisted project glossary from typed names, speaker labels and visible terms. Accepted database names seed canonical translations; pending entries use the same bounded model queue. Translation and proofreading receive the relevant confirmed entries with each request. The final consistency pass targets records with residual names or known aliases, using the current translation as its editing baseline. Repair attempts are tracked by unit revision and glossary hash, so resumed projects retain results and changed wording can be checked again.

The glossary is included in the existing `glossary.json` work-package reference. Accepted name-field edits and imported name records refresh the project glossary. Native structure, control markers and optimistic revision checks remain part of every text commit.

## Optional Images

With `processImages`, the technical phase starts UI-first OCR after the user starts production. Each image gets its own shared-pool task and checkpoint. Accepted files survive pause/resume without repeating previous OCR. Nested `www` and packed source-copy paths are resolved from the trusted adapter's resource metadata. OCR units join the same translation/proofreading workflow; only their bounded image bindings reach the optional rewriter after independent assembly. Missing vision capability or failed/complex repainting preserves original image regions and records issues.

`imageTools` can inject `prepareImages`/`applyImageText` for offline scheduling tests. Production uses `packages/images`. Fresh OCR bindings can reuse confirmed image wording from a linked previous project when the image hash, region, source and context still match.

## Verification

```powershell
node --test packages/core/*.test.mjs
```

Fixtures are synthetic and created under ignored `local/core-tests`. One integration case opens an HTTP model emulator on `127.0.0.1`, executes actual technical tool calls and translation through AI SDK, invokes the real Python worker, patches a bound plugin literal, and exchanges actual ZIP files. It makes no paid model requests and uses no game assets. Restricted execution hosts must allow loopback access for this case.
