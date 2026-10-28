# DSH Technical Runtime

The desktop product replaces the per-job autonomous adaptation loop with
DeepSeek Harness while retaining Pinhao's task pool, business tools, source
identities, laboratory validation, accepted-batch consumer and shared budget.
It does not replace the translation or proofreading model protocols.

The upstream revision is `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`.
The npm package labelled `0.2.1-rc.3` differs from that revision and is not used
as an interchangeable runtime. Run `npm run prepare:dsh` to prepare the fixed
official source and frozen dependencies. The unused document-preview frontend
is excluded from dependency preparation; the upstream source and lock are not
patched. The upstream MIT license stays with the source.

`npm run prepare:dsh -- --build` also compiles the upstream host libraries with
its own fixed compiler. Runtime packaging uses `scripts/package-dsh-runtime.mjs`
and the actual loaded-module manifest, preserving declared runtime dependencies,
licenses and a SHA-256 file inventory. It does not ship the upstream Web UI.

The Windows carrier contains a separately verified Node 24.16.0 executable.
Electron's embedded V8 is not an interchangeable standard Node ABI. The fixed
SDK's generic process-client construction seam selects the contained executable;
the official SDK still owns JSON-RPC, sessions and the EOF/termination ladder.
No upstream kernel or runtime ABI fingerprint is patched. This seam is tied to
the pinned commit, not advertised as an upstream public `nodePath` option.

## Ownership

`createDshAdaptationProvider` is injected through the existing `adaptationProvider`
service argument. Each job has a separate process, home and durable session.
The old model loop is not run around that process. A local tool plugin invokes
the original business tools with host-bound operation identities. Candidate
validation, partial acceptance and project integration keep their original
meaning; an idle session or a model's completion text is never verification.

All runtime model traffic, including compaction and retries, goes through a
job-local HTTP relay. Provider credentials stay in the host. The relay uses the
existing request accounting and request artifacts. Prepared context, actual
upstream dispatch, provider usage and accepted business data are distinct facts.

## Recovery

The checkpoint binds project, request, job, execution, source fingerprint,
assignment revision, profile digest and DSH session. Missing or mismatched
sessions are not replaced silently. Completed business calls return saved
receipts when IPC delivery is retried. Unknown mutations are reconciled before
continuing; the same arguments in a genuinely new model call remain a new call.
Business callbacks and the existing project database prevent duplicate units.

The normal development, desktop and packaging entries use DSH. Build carriers
with `npm run package` or `node scripts/package-desktop.mjs --directory-only`;
no environment flag is required. A missing runtime produces an explicit error,
not a silent fallback to the old model loop. Runtime replacement and model
changes must preserve accepted business results and prior execution evidence.
Source changes and local checks are not proof of autonomous paid-task acceptance;
the accompanying verification report states the actual tested boundary.
