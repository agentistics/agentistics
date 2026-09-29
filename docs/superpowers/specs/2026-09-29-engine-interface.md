# The engine interface — the contract between the community build and the private engine

**Date:** 2026-09-29 · **Status:** design, for the leader's and the owner's decision. No product code
was changed to write it. **Lives in the private repository `agentistics/agentistics-engine` only.**

**Read with:** the runtime master spec (`2026-09-19-agentistics-runtime-master.md`, §16 integrations,
§18 live ingestion, §22 providers, §24 native runtime, D23), P1 (`-p1-canonical-journal.md`), P4
(`2026-09-27-runtime-p4-live-ingestion.md`, branch `feat/a5-live-ingestion`), and the licensing
strategy (`held/docs/licensing-strategy`).

---

## 0. What this rests on

| # | Decision | Source |
|---|---|---|
| Q1(b) | `journal/`, `projections/` and `packages/core/src/canonical` stay PUBLIC. `packages/runtime`, `server/integrations` and live ingestion (A5) move to the engine. | leader, 2026-09-29, on `t-e1dea7cd6f` |
| Q2 | The closed harness **stays free on one machine**. | owner, relayed by the coordinator, 2026-09-29 |
| C1 | Device-side E2E crypto stays PUBLIC (`envelope-crypto.ts`, `envelope-keys`, the E8 tunnel, the E12 viewer keys) — otherwise "the hub cannot read your conversation" is not verifiable. | enterprise bridge, accepted by the leader |
| C2 | There are TWO public, versioned contracts: community↔engine (this document + `core/canonical`) and device↔hub (E15). Each gets semver and a contract test in CI **in both repos**. | same |
| P | The public build works WITHOUT the engine and keeps every metric it has today. The official binary bundles the engine. | this brief |

Measured state it starts from (origin/dev `95a6eba4`, and `held/feat/harness-tui-p2` for the host
seams that are not on dev yet):

- `packages/runtime` (74 source files: `loop/ policy/ provider/ sandbox/ stream/ tools/`) depends
  on `@agentistics/core` **only** among workspace packages, plus `ai` and `@ai-sdk/anthropic`. It is
  already cleanly separable.
- `server/integrations/` (7 harnesses) is NOT: its replays deep-import **17 public server modules**
  — `jsonl`, `harness-activity`, `sessions/shell-writes`, `transcript-state`, `transcript-cursor`,
  `edit-lines`, `subagent-join`, `agent-metrics`, the `adapters/*-parse` parsers, `config`, `utils`.
  That reuse is correct (one parser, one answer) and this design keeps it, as a declared surface
  (§6).
- The PUBLIC journal imports the integrations today: `journal/import.ts`, `journal/import-plan.ts`,
  `journal/shadow.ts` (the `INTEGRATIONS` registry and the `HarnessReplay`/`ReplayCursor` types), and
  `data.ts` calls `shadowIngest`. The seven `projections/differential*.ts` and
  `p3-fixture-events.ts` import the replays directly. **This is the one seam that runs the wrong
  way** (public → closed) and it is the first thing to cut.
- The host seams (`runtime-host.ts`, `code-host.ts`, `cli-code.ts`, `runtime-sessions-web.ts`,
  `cli-provider*.ts`, `provider-web.ts`, `provider/*`) import `@agentistics/runtime` and are reached
  from exactly five public places: `bin/cli.ts` (`provider`, `code`), `index.ts` (three lazy
  imports), `cli-start.ts` (the `code` tab, lazy), `cli-i18n.ts` (one TYPE import), and
  `m1-e2e.child.ts` (a test child).

---

## 1. The line — every path, and which side it lands on

| Path (today) | Side | Why |
|---|---|---|
| `packages/core/src/canonical/**` | **public** | the event contract (Q1b) |
| `packages/server/server/journal/**` | **public** | storage + replay driver (Q1b); stops importing integrations (§4.1) |
| `packages/server/server/projections/{catalog,catch-up,facts,kit,reader,store,state-codec,session-meta,run-metrics,tool-metrics,agent-metrics,cost-by-dimension,task-rollup,adapter-versions}.ts` | **public** | the read side of the journal (Q1b) |
| `packages/server/server/projections/differential*.ts`, `parity-matrix.ts`, `p3-fixture-events.ts`, `scripts/parity-matrix.ts` + their fixtures | **engine** | they are PROOFS of the integrations against the legacy adapters; without the integrations they prove nothing |
| `packages/server/server/adapters/**` (the legacy readers) | **public** | they ARE the free metrics. See Q-C: a coordinator note lists them as closed; this design says they cannot be |
| `packages/server/server/runtime-metrics-{query,web,fixtures}.ts` | **public** | reads the public projection store only (imports `projections/facts` and nothing else). Empty in a community build, and says so (§5) |
| `packages/server/server/integrations/types.ts` | **split** | the CONTRACT (`ReplaySource`, `ReplayCursor`, `ReplayBatch`, `HarnessReplay`, `HarnessLive`, `HarnessIntegration`, `hasReplay`) moves to `@agentistics/engine-api`; the `INTEGRATIONS` registry moves to the engine |
| `packages/server/server/integrations/<harness>/**` | **engine** | Q1b |
| A5: `ingest/**` (`hook-plan`, `hook-specs`, `file-tail`, `otlp-web`, `ingest-web`), `agentop ingest …` | **engine** | Q1b ("live ingestion") |
| `packages/runtime/**` | **engine** | Q1b |
| `runtime-host.ts`, `runtime-sessions-web.ts`, `code-host.ts`, `cli-code.ts`, `m1-e2e.child.ts` | **engine** | host seams of the native runtime |
| `provider/*`, `cli-provider.ts`, `cli-provider-models.ts`, `provider-web.ts`, `scripts/record-anthropic-fixtures.ts` | **engine** | providers exist only for the native runtime |
| `packages/tui/src/control/code-types.ts` (`CodeHost`, `CodeEvent`) | **public** | already a pure contract with the rule "nothing here may import `@agentistics/runtime`"; it moves into `@agentistics/engine-api` unchanged |
| `packages/web/src/lib/providerSettings.ts`, `pages/settings/ProvidersSettings.tsx`, the TUI `code` tab's rendering | **public** | CLIENTS over routes; gated on the engine manifest (§5). See Q-E |
| `sessions/task-model.ts` `NativeSessionLink` / `TaskBook.nativeSessions` | **public** | a DATA FORMAT of a public store (§4.6) |
| `capability-guard.ts` entries `/api/provider`, `/api/runtime/*`, `/api/ingest`, `/v1/logs`, `/v1/metrics` | **public** | a guard that disappears with the engine is a guard a community build cannot test (§7) |
| `envelope-crypto.ts`, `envelope-keys.ts`, tunnel, viewer keys | **public** | C1. The engine never implements or wraps them |
| `backup/backup-plan.ts` `secret` rows | **public** | the engine's policy floor is DERIVED from them (`protectedPathsFromSecrets`); the host passes the result in (§3) |

---

## 2. The contract package — `@agentistics/engine-api`

A new PUBLIC workspace package, `packages/engine-api`. **Types plus three pure functions, no IO, no
dependency but `@agentistics/core`.** It is the only thing both repositories compile against besides
`core`. Licence: see Q-A.

```ts
// packages/engine-api/src/version.ts
/** Semver of THIS contract, not of either product. Major = breaking. */
export const ENGINE_API_VERSION = '1.0.0'
/** PURE. May a host at `host` load an engine built against `engine`? Same major, engine minor ≤ host minor. */
export function apiCompatible(host: string, engine: string): boolean

// packages/engine-api/src/engine.ts
export interface EngineManifest {
  name: 'agentistics-engine'
  version: string              // the engine's own release
  apiVersion: string           // the ENGINE_API_VERSION it was built against
  /** What this engine can do HERE. A capability absent is a declared absence, never a crash. */
  provides: {
    nativeRuntime: boolean
    replay: HarnessId[]        // harnesses with an integration replay
    live: HarnessId[]          // harnesses with a live channel (A5)
    providers: ProviderId[]
  }
}

export interface Engine {
  manifest: EngineManifest
  /** Replay + live per harness. PARTIAL on purpose: the engine's own CI enforces totality (§8). */
  integrations: Partial<Record<HarnessId, HarnessIntegration>>
  /** HTTP routes, each under a RESERVED prefix and naming its capability (§7). */
  routes: EngineRoute[]
  /** `agentop <verb> …` commands the engine answers: `code`, `provider`, `ingest`. */
  commands: EngineCommand[]
  /** The control center's `code` tab. Absent = no tab. */
  codeHost?: (askerFor: (sessionId: string) => PersonAsker) => Promise<CodeHost>
  /** Health checks the engine contributes (provider key unreadable, runtime store unwritable, …). */
  health?: () => Promise<EngineHealthIssue[]>
  dispose(): Promise<void>
}

/** The ONE export of the engine package. */
export type CreateEngine = (host: EngineHostServices) => Promise<Engine>

export interface EngineRoute {
  /** Must start with one of `RESERVED_PREFIXES`; the host refuses anything else at load. */
  prefix: string
  capability: CapabilityName    // a name from exposure.ts CAPS — never a new one
  handle(req: Request, url: URL): Promise<Response | null>   // null = not mine, 404 upstream
}

export const RESERVED_PREFIXES = [
  '/api/runtime/sessions', '/api/provider', '/api/ingest', '/v1/logs', '/v1/metrics',
] as const

export interface EngineCommand {
  verb: 'code' | 'provider' | 'ingest'
  /** Help text in both languages; the host prints it in `agentop --help`. */
  summary: Record<'en' | 'pt', string>
  run(args: string[], io: CommandIO): Promise<number>
  /** `agentop code` opens a full-screen cockpit — the host must know BEFORE it takes the tty. */
  wantsTty?(args: string[], tty: { stdin: boolean; stdout: boolean }): boolean
}

export type EngineStatus =
  | { present: true; manifest: EngineManifest }
  | { present: false; reason: 'community-build' | 'api-mismatch' | 'load-failed' | 'disabled' }
```

`HarnessIntegration`, `HarnessReplay`, `HarnessLive`, `ReplaySource`, `ReplayCursor`, `ReplayBatch`,
`hasReplay` move here verbatim from `integrations/types.ts`. `CodeHost` and its event types move here
verbatim from `tui/src/control/code-types.ts` (the TUI re-exports them so no import there changes).
`PersonAsker` and `ProviderJournalSink` are re-declared here as the minimal structural types the host
needs, so `engine-api` never imports `@agentistics/runtime`.

---

## 3. What the host gives the engine — `EngineHostServices`

D23 already says `@agentistics/runtime` "may know no path, no credential and no environment of this
machine". The engine inherits the rule: **everything machine-specific arrives through this object.**
It is the current `RuntimeHostOptions` defaults, lifted one level up.

```ts
export interface EngineHostServices {
  /** Where things live. The engine never reads `config.ts`. */
  paths: {
    dataDir: string; defaultDataDir: string; contentDir: string; home: string
    harnessRoots: Partial<Record<HarnessId, string>>   // the env-override-resolved roots config.ts owns today
  }
  /** The PUBLIC journal (§4.1). `null` = journal off or unwritable — the engine must cope. */
  journal: { sink(): Promise<ProviderJournalSink | null>; status(): JournalStatus }
  /** The machine's policy floor, derived from backup-plan's `secret` rows (`hostProtectedPaths`). */
  protectedPaths: readonly string[]
  /** exposure.ts, read — never re-derived. */
  caps: Readonly<Record<CapabilityName, boolean>>
  /** `TEAM_CENTRAL` OR preferences.team.mode === 'central'. A central never runs the runtime. */
  isCentral(): boolean
  /** Flags the engine honours (`providerFlagOn`, `AGENTISTICS_INGEST`, …), read by the host. */
  flag(name: EngineFlag): boolean
  audit(event: AuditEvent): void                 // audit.ts; the builder's redaction still applies
  readJsonLimited: typeof readJsonLimited        // limits.ts — the engine never calls req.json()
  safeError: typeof safeError                    // errors.ts
  spawnBudget(): Promise<SpawnBudget>            // sessions/memory-probe (admission control)
  notify(n: NotificationPayload): void           // broadcastNotification
  lang(): 'en' | 'pt'
  /** The board, for filing native sessions (§4.6). The ONLY write into a public store the engine gets. */
  tasks: { fileNative(link: Omit<NativeSessionLink, 'id' | 'linkedAt'>): Promise<FileResult>;
           unfileNative(sessionId: string): Promise<void> }
  /** The declared reuse surface (§6), handed over as values so the engine never deep-imports. */
  readers: ReuseSurface
  now(): Date
}
```

**Nothing in this object is a secret.** Provider keys are the engine's own store (`provider/*` moves
with it); the host passes only the floor that protects them.

---

## 4. Each seam, cut

### 4.1 The journal stops importing the integrations (the backwards seam)

- `journal/import.ts`, `import-plan.ts`, `shadow.ts` take an `IntegrationRegistry =
  Partial<Record<HarnessId, HarnessIntegration>>` as a parameter (`ShadowDeps` already injects
  `replay`; this widens it). The default is `engineIntegrations()` — the engine's registry when one is
  loaded, `{}` otherwise.
- `shadowIngest` with an empty registry returns `{ status: 'off' }` with a new reason
  `no-integrations`, and writes the status file saying so.
- `health.ts`: `JournalDisabledReason` gains `'no-integrations'`, reported as INFO with the sentence
  "this build has no integration to feed the journal — every surface keeps working off its existing
  data". It must never read as a fault: it is the normal state of a community build.
- `agentop journal status` prints the same sentence.

**Consequence to state plainly:** in a community build the journal and the projections are PRESENT
and EMPTY. The free metrics keep coming from the legacy adapters, exactly as today. See Q-B — this is
the question that decides A4 for the community build.

### 4.2 `data.ts`

One line changes: `void shadowIngest(dedupedSessions)` → `void shadowIngest(dedupedSessions, {
integrations: engineIntegrations() })`. Nothing else in the build path knows the engine exists.

### 4.3 `health.ts`

Besides §4.1, `runHealthChecks` appends `await engine?.health?.()`, guarded so an engine that throws
contributes one `engine-health-failed` issue and never takes the check down.

### 4.4 `bin/cli.ts`, `cli-start.ts`, `index.ts`

- **CLI.** `provider`, `code` and `ingest` are dispatched through `engine.commands`. With no engine the
  verb is still RECOGNISED and answers, exit 2: *"`agentop code` runs the native harness, which is in
  the official build of agentop and not in this one. Download it from … or keep using the harnesses
  you already have — every metric works without it."* (EN+PT, `cli-i18n.ts`). An unknown verb and a
  verb this build lacks are different sentences.
- **Help.** `agentop --help` lists the engine verbs with a `(official build)` marker when absent —
  hiding them makes the docs lie to a community user.
- **`agentop --version`** adds one line: `engine 1.4.0 (api 1.0)` or `engine: none — community build`.
- **Cockpit.** The `code` tab exists only when `engine.codeHost` does. `cli-start.ts`'s lazy
  `import('./code-host')` becomes `engine?.codeHost`. The Help screen says the tab is absent and why.
- **Server.** The three lazy imports in `index.ts` (`runtime-metrics-web` stays; `provider-web` and
  `runtime-sessions-web` go) become one loop over `engine.routes`, placed exactly where they are now:
  AFTER the capability guard and the Host allowlist, BEFORE the SPA fallback. No engine → the reserved
  prefixes answer 404 with `{ error: 'engine-absent' }`.
- **`GET /api/engine`** (new, authenticated, not in `AUTH_PUBLIC`) returns `EngineStatus`. The web and
  the VS Code extension read it once per load.
- **`cli-i18n.ts`**'s type import of `RateLimitAbsentReason` / `RateLimitResourceKind` from
  `@agentistics/runtime` moves to `engine-api` (it is a type the public host renders), or the strings
  move with `cli-provider.ts` into the engine. Recommendation: the latter — the sentences belong to the
  verb.

### 4.5 `runtime-host.ts` / `runtime-sessions-web.ts` / `code-host.ts` / `cli-code.ts`

Move into the engine unchanged in shape. `createRuntimeHost` stops importing `config.ts`,
`backup-plan.ts` and `cli-provider.ts` from the public tree: `paths`, `protectedPaths` and the
credential resolver come from `EngineHostServices` / the engine's own `provider/`. The invariant
"nothing else builds a session runtime; CLI and web come through one `createRuntimeHost`" is kept,
now INSIDE the engine.

### 4.6 `TaskBook.nativeSessions`

Stays public, as a data format of the public board. Reason: the board is a JSON file both builds
read; a record the community build does not understand must survive a read-modify-write, or opening
the board in a community build after using the official one DELETES the links (the registry-race
class of bug `registry.ts` documents). The engine files through `host.tasks.fileNative`, never by
writing `tasks.json`. A community build renders such a link as *"native session — opening it needs the
official build"*, with no metrics (they had none before either: native sessions do not enter rollups,
P1 scope).

### 4.7 `runtime-metrics-*`

Public, untouched. In a community build `GET /api/runtime/metrics` answers from an empty projection
store; its response gains `feeder: 'none'` so a surface says "no data because nothing feeds the
journal in this build" rather than drawing zeros.

### 4.8 Live ingestion (A5)

Engine. Each harness's `HarnessLive` rides on `integrations[h].live`; the hook/OTLP routes ride on
`engine.routes` under `/api/ingest` and `/v1/*`; `agentop ingest …` rides on `engine.commands`. The
settings-merge planner the A5 spec reuses (`claude-hooks.ts`) is PUBLIC and is handed over in
`ReuseSurface` (§6) — `agentop hooks` keeps using it without the engine.

### 4.9 Web and VS Code

- `ProvidersSettings` is shown only when `EngineStatus.present && manifest.provides.nativeRuntime`;
  otherwise the Settings entry is absent and Settings → About says which build this is.
- The VS Code extension is a client; it reads `/api/engine` and changes nothing else.

---

## 5. Absence is always said in words

The product's N/A-versus-a-confident-0 rule applies to the engine as a whole. Every surface that
could show an engine feature has exactly one of: the feature, or a sentence naming the build. Never
an empty panel, a greyed button with no reason, or a `0`. `EngineStatus.reason` distinguishes
`community-build` (normal), `api-mismatch` (official binary with a stale engine — a release defect),
`load-failed` (the engine threw at load; logged with a `safeError` ref) and `disabled`
(`AGENTISTICS_ENGINE=0`, for a person who wants the free path on an official binary). **A failed or
mismatched engine never takes the product down**: the host logs it and runs as a community build.

---

## 6. The reuse surface — what the engine may use from the public tree

The integrations need 17 public modules. Duplicating those parsers in the engine would give the
product two answers to one question, which this repo forbids everywhere else. So:

- **The engine may import `@agentistics/core`, `@agentistics/engine-api`, and NOTHING ELSE from the
  public tree directly.** Everything else arrives in `host.readers: ReuseSurface`, a typed object
  whose members are the existing public functions (`parseSessionJsonl`, `foldClaudeParse`,
  `readTranscriptFrom`, `countGitCommands`, `canonicalTool`, `commandSummary`, `joinSubagents`,
  `parseKimiWire`, `decodeGenMetadata`, …).
- `ReuseSurface`'s TYPE is declared in `engine-api`; the public host builds the VALUE. So a public
  refactor that changes a signature fails `tsc` in the PUBLIC repo, at the place it happens, instead of
  breaking the engine silently a release later.
- `config.ts` is not in the surface: roots arrive in `host.paths`.
- Growing the surface is a minor bump of `ENGINE_API_VERSION`; changing a member is a major.

Cost: the integrations' ~60 import lines are rewritten to take `readers` (a mechanical change done
once, in the engine repo, during the move).

---

## 7. Security invariants

1. The reserved prefixes stay in the PUBLIC `capability-guard.ts` table whether or not an engine is
   loaded; `capability-guard.test.ts` asserts every `RESERVED_PREFIXES` entry resolves to a
   capability. A guard that ships only with the engine cannot be tested by public CI.
2. The host REFUSES at load any `EngineRoute` whose prefix is not reserved or whose capability is not
   the one the public table holds for that prefix. The engine cannot add an `AUTH_PUBLIC` route —
   there is no field for it.
3. Engine routes run after the capability guard, the auth gate and the Host allowlist; loopback-only
   routes (`/api/ingest`, `/v1/*`, per P4 §6.3) are enforced by the host's guard, not trusted to the
   engine.
4. The engine never logs a credential and writes audit through `host.audit` (the builder's redaction
   applies).
5. The engine never touches device-side E2E crypto (C1).

---

## 8. Build and loading — the three builds

**Static resolution decides the mechanism.** `bun build --compile` resolves imports at bundle time,
before dead-code elimination (the `react-devtools-core` stub in `packages/tui/stubs` exists for
exactly this). So the engine cannot be an optional `import('@agentistics/engine')` — a community
build would fail to compile. It follows the `embedded-dist.generated.ts` pattern instead:

- `packages/server/server/engine-slot.generated.ts` — gitignored, generated by
  `packages/server/scripts/engine-slot.ts`:
  - **no engine found** → `export const createEngine: CreateEngine | null = null`
  - **engine found** (`AGENTISTICS_ENGINE_DIR`, or `packages/engine/` checked out beside the others)
    → `export { createEngine } from '@agentistics/engine'`
- `bun run stub` writes the null slot, so a fresh public checkout typechecks exactly as today.
- `engine/load.ts` (public) calls `createEngine(host)` once at boot, checks `apiCompatible`, freezes
  the result, and exposes `engine()` + `engineIntegrations()` + `engineStatus()`.

| Build | Who | Engine |
|---|---|---|
| **community** | anyone cloning the public repo; `central.sh` from a checkout; public CI | null slot |
| **official** | `release.yml` → the binaries, the desktop sidecar, (see Q-D) the GHCR image | engine checked out at a pinned ref |
| **dev with engine** | people with engine access | `AGENTISTICS_ENGINE_DIR=../agentistics-engine`; `bun run dev` regenerates the slot |

**Pinning.** The public repo carries `engine.pin` (`{ "ref": "<engine tag>", "api": "^1.0.0" }`). A
SHA/tag reveals nothing. The release fails if the pinned engine's `apiVersion` is outside the range —
loud at build time, never a quiet community binary under an official name.

---

## 9. CI

### Public `ci.yml` (no secret, runs on forks)

- builds, typechecks and tests with the null slot — which is the community build, so it is tested on
  every push;
- a **fake engine** fixture (test-only, `engine/fake-engine.ts`) exercises the host side of the
  contract: load, `apiCompatible` refusal, route guard refusal, command dispatch, absent-engine
  sentences, `nativeSessions` round-trip;
- the **parity-matrix step moves out** (it proves integrations) to the engine's CI;
- a lint: nothing outside `engine/` and `engine-slot.generated.ts` may name `@agentistics/engine` or
  `@agentistics/runtime` (the grep-over-source shape `tokens.lint.test.ts` uses).

### Engine CI (private)

- checks out the public repo at the pinned public ref it targets (public, no secret) plus itself as
  `packages/engine` + `packages/runtime`;
- `tsc`, its own tests, the parity matrix, and the **conformance kit**: `engine-api` exports
  `runEngineConformance(createEngine)` (test-only entry) and the engine runs it — the same contract
  test in both repos (C2);
- asserts `integrations` is total over `HARNESS_ORDER` (the totality `Record<HarnessId,…>` gave the
  public registry moves here, since the public type is `Partial`).

### `release.yml` (public repo, the official build)

- one new step before `bun install`: check out `agentistics/agentistics-engine` at `engine.pin`'s ref
  into `packages/engine` using a **read-only deploy key** (`ENGINE_DEPLOY_KEY` secret, scoped to that
  one repository). A deploy key survives the public repo's move to the org and grants nothing else.
  Fallback: a GitHub App installation token with `contents: read` on the engine only;
- the step runs only on `push` to `main` / tag — never on `pull_request`, and the workflow never uses
  `pull_request_target`;
- after compile, the smoke test asserts `agentop --version` prints an `engine` line with the pinned
  version — an official binary without its engine fails the release;
- the `build-desktop` job consumes the same binary, so the desktop app bundles the engine for free.

---

## 10. Q2 in the contract — free on one machine

The engine carries **no licence or entitlement check** in `ENGINE_API_VERSION` 1. Every official
binary runs the native harness on one machine, for everyone. Joining machines or people is gated by
the hub (cloud), which is outside this contract. `EngineHostServices` reserves no entitlement field;
adding one later is a minor bump, and the absence is deliberate so nobody builds a half-check now.

---

## 11. Migration order

Each step leaves both builds green.

1. **Public:** create `packages/engine-api`; move the integration contract types and `CodeHost` into
   it (re-exported from the old paths so nothing else changes yet).
2. **Public:** registry injection in `journal/*` + `data.ts` (§4.1–4.2); `no-integrations` status;
   the slot generator + null stub; `engine/load.ts`; `/api/engine`; absent-verb sentences; route loop
   in `index.ts`; guard test for reserved prefixes; fake engine + its tests. At this point the public
   tree still contains the engine code, wired THROUGH the slot.
3. **Engine repo:** bring in `packages/runtime`, `integrations/`, the host seams, the differentials and
   the parity matrix; rewrite imports to `host.readers`/`host.paths`; implement `createEngine`; run the
   conformance kit.
4. **Public:** delete the moved paths; drop `@agentistics/runtime`, `ai`, `@ai-sdk/anthropic` from
   `packages/server/package.json`; move the parity step to the engine CI; add `engine.pin`.
5. **Public:** `release.yml` engine checkout + deploy key + the version smoke assertion.
6. **Held branches** (`held/feat/runtime-*`, `harness-tui-p2`, `runtime-undo`, …) are replayed onto
   the engine layout with a path map (`packages/server/server/<seam>.ts` →
   `packages/engine/src/<seam>.ts`, `integrations/**` → `packages/engine/src/integrations/**`) via
   `format-patch` + a path rewrite + `am`, one branch at a time, AFTER step 3.

A fact to keep in view: `packages/runtime` is already in the public history (`main` and `dev`,
28 commits), under the licence each version was published with. Moving it stops future versions
from being public; it does not retract past ones.

---

## 12. Open questions

**For the owner (product, money or licence):**

- **Q-A — Licence of `@agentistics/engine-api`.** It is the integration surface a third party would
  code an alternative engine or an adapter against. Recommendation: **Apache-2.0**, matching the
  licensing strategy's Q6 answer ("integration pieces yes, the platform no"). Alternative: FSL like
  the rest of the public repo.
- **Q-B — Does the REPLAY (A2/A3 import) close together with live (A5)?** As decided, yes — and then
  the community build's journal is always empty, so A4 ("the product reads from the journal") can
  never be the community build's read path, and the legacy adapters must stay in the public repo
  indefinitely. Recommendation: accept it — the legacy adapters are the free metrics and are already
  proven. Alternative: keep replay public and close only live + runtime, which lets the free build
  cut over to the journal but gives away the whole integration layer.
- **Q-D — The GHCR image and `central.sh`.** Should the published Docker image be the official build
  (engine inside, same as the binaries) or the community one? A central never runs the runtime, but
  `docker/machine.yml` runs a solo/member MACHINE from the same image. Recommendation: GHCR = official;
  `central.sh` building from a checkout = community.
- **Q-F — Confirm: no licence/entitlement check in the engine at all for now** (§10), i.e. the gating
  for teams lives only in the hub.

**For the leader (technical, delegated):**

- **Q-C — Correct the coordinator's rule.** Its 2026-09-29 note lists `server/adapters`,
  `server/journal` and `server/projections` as closed. Q1(b) keeps journal/projections public, and
  this design keeps the legacy adapters public because they are the free metrics. Only the
  differentials and the parity matrix move.
- **Q-E — Engine UI stays public as clients** (Providers settings, the `code` tab rendering, gated on
  `/api/engine`), rather than shipped by the engine. Recommendation: yes — the engine cannot inject
  React into a bundle it does not build, and a client reveals nothing a route does not.
- **Q-G — `engine.pin` lockstep.** One engine ref per public release (recommended), versus the engine
  releasing on its own cadence and the public build taking the newest compatible.
