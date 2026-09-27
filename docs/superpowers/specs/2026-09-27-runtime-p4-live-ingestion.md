# P4 — Live ingestion: hooks, a local OTLP receiver, and the file-tail floor

**Phase A5 of the roadmap in `2026-09-19-agentistics-runtime-master.md` (§46, §52).** Read that
document first, in particular §8, §14.3, §15, §17.3, §18, §21, §43, §47, §48 and decision **D4**
(§50). This one only says what A5 builds, how it is proven and how it is undone. Numbered P4 because
P1 = A1+A2, P2 = A3, P3 = A4.

**Status:** specification. A5.3 (the file-tail floor) is being implemented in parallel on
`feat/a5-live-ingestion`; A5.1, A5.2 and A5.4 are proposals.
**Flags:** `AGENTISTICS_JOURNAL_LIVE` (A5.3), `AGENTISTICS_INGEST` + `AGENTISTICS_INGEST_CHANNELS`
(A5.1/A5.2, master §47). **Absent reads as off** for all three.
**Ships nothing to a user's screen.** Like P1, A5 is measurable from tests, the journal and `agentop`
verbs only.

A claim marked **OPEN** below is not grounded in the research files
(`docs/superpowers/research/*`), in the repo's code, or in a measurement recorded here. Each OPEN
names what would settle it.

---

## 1. What A5 delivers

D4 (master §50) decided the shape: **hooks + a local OTLP receiver, with file-tail as the floor**;
ACP-first and file-tail-only were rejected. A5 is therefore four sub-phases:

| | Deliverable | Channel (`LiveChannel`, master §15) | Provenance mode |
|---|---|---|---|
| **A5.3** | The file-tail floor: a live transcript's new bytes reach the journal within one poll, through the replay's own fold | `file-tail` | `observed` |
| **A5.1** | Hooks: an installed harness hook shells out to `agentop`, which hands the payload to the local server | `hook` | `instrumented` (for hook-only types) |
| **A5.2** | A local OTLP/HTTP JSON receiver that maps a small, documented subset of harness telemetry to canonical events | `otlp` | `instrumented` |
| **A5.4** | ACP as a **spawn-mode transport** only (master §18.4) | `acp` | `instrumented` |

A5.3 is round 1 and ships first because it is the only one that needs no install act, no new port
and no new identity rule (§4.1). A5.1 and A5.2 are round 2. A5.4 is probably Track B (§11).

**Explicitly not in A5:** no surface reads the journal (that is A4/P3's cutover); no change to the
notification channel (`events/`, master §8 — it stays a notification channel and is not widened);
no provider code; no wire change to a central; no conversation text for external harnesses (D5).

## 2. Why this order

- **File-tail first** because it converges with replay **by construction** (§4.1): it *is* the
  replay, called sooner. It cannot double a single counter, needs no install act, opens no port, and
  is the floor D4 and master §18.5 require under every other channel.
- **Hooks second** because the one thing they add that the floor cannot is *latency*: a hook knows
  the moment a turn ends. The safe first use of a hook is therefore to **wake the tail**, not to
  write metrics of its own (§4.2).
- **OTLP third** because its highest-value event (Claude's `api_request`, per-call tokens) is exactly
  the one whose id does **not** provably match the replay's (§4.3); until that is settled it can
  only add signals the replay does not produce.
- **ACP last** because it only sees sessions agentop itself spawned (master §18.4), which is the
  runtime track's territory.

## 3. Where the code goes

```
packages/server/server/integrations/live/
  file-tail.ts        A5.3 — PURE planTail/nextBaseline/asObserved + IO createFileTail   (exists)
  hook-plan.ts        A5.1 — PURE: raw hook payload → { wake: sourceRef } | hook-only events | ignore
  hook-specs.ts       A5.1 — PURE: per-harness hook table (event, verb, timeout, fail mode)
  otlp-map.ts         A5.2 — PURE: OTLP/HTTP JSON logs/metrics → canonical events | ignored-count
  otlp-web.ts         A5.2 — IO: the /v1/logs, /v1/metrics routes (loopback + guards, §6.3)
  ingest-web.ts       A5.1 — IO: POST /api/ingest/hook
packages/server/server/
  cli-ingest.ts       A5.1/A5.2 — `agentop ingest install|uninstall|status|emit` (§6.1)
  claude-hooks.ts     generalised: the spec table keyed by (event, verb), not by event (§5)
  journal/shadow.ts   starts the tail lazily, shares journal + cursors + accepted stamps (exists)
  config.ts           JOURNAL_LIVE_ENABLED (exists, uncommitted); INGEST_ENABLED, INGEST_CHANNELS
```

Nothing under `packages/web`, `packages/tui` or `packages/vscode` changes in A5.

## 4. Contracts

### 4.1 The convergence contract — the one this phase is judged on

> **A live event and a replayed event describing the same fact carry the SAME `eventId`.** The
> journal's `UNIQUE(event_id)` + `INSERT OR IGNORE` (P1 §4.2) then makes live-after-replay and
> replay-after-live converge with **zero new rows**: the first writer wins, the second is counted as
> a `duplicate`, never silently (master §14.3, §44).

What the id is made of, verified in code:

- `eventIdPreimage` (`packages/core/src/canonical/event-id.ts:117-127`) has two paths. The
  **source path** hashes `sourceKind, sourceId, sourceRef, type, ordinal`. The **provider path**
  (resolution O-8, same file lines 26-37) is taken only for `PROVIDER_KEYED_TYPES`
  (`model.invoked`, `model.started`, `model.delta`, `model.completed`; line 88) carrying a non-empty
  `providerRequestId`, and hashes `type, providerRequestId, ordinal` — **excluding the source**, so
  two producers that see the same billed response can yield one id.
- **`provenance.mode` is not in either preimage.** An event re-stamped from `replayed` to `observed`
  keeps its id (`file-tail.ts` `asObserved`). Consequence worth stating: the mode stored on a row is
  *which path wrote it first*, not an intrinsic property of the fact.

How each channel keys its events:

| Channel | `model.*` | `tool.*`, `turn.*`, `agent.*`, lifecycle | Converges with replay? |
|---|---|---|---|
| **file-tail** | provider path on `message.id` (`replay-model.ts:198-205`) — identical | source path, `sourceRef = claude:<conv>:<lineNo>` (`replay-core.ts:146`), ordinal per record (`replay-tools.ts:135-165`) — identical | **Yes, by construction**: same fold, same cursor, same `sourceRef` |
| **hook** | a hook payload carries no `message.id` in the fields research records (`BaseHookInput`, 08a §9) | the replay keys `tool.*` on **line number + ordinal**, not on the tool-use id; a hook has no line number | **No.** Must not emit these types (§4.2) |
| **OTLP** | Claude's `api_request` carries a request id; whether it equals the transcript's `message.id` is **OPEN** (§4.3) | tool/prompt events have no line number | **Only if** the id question closes in its favour |

**The rule, stated once:** *a channel may write an event of a type the replay also emits only if it
derives that event's id from the same preimage the replay uses. Anything else is either (a) a
different event type the replay never emits, written under its own source path, or (b) a candidate
for reconciliation (master §21) — never the same type under a different id, which would double every
counter a projection sums.* A test enforces it (§8): for each channel, the set of types it may emit
is a closed list, and its intersection with the replay's emitted types must be keyed identically.

Types the Claude replay emits today (grep of `makeEvent(ctx, '…'` over `integrations/claude/`):
`session.started/ended`, `run.started/ended`, `agent.started/ended`, `turn.started/ended`,
`model.invoked/completed/failed`, `tool.requested/completed/failed`, `context.compacted`. No
integration emits `tool.approved`, `tool.denied` or `policy.*` today — those are the candidate
hook-only types.

### 4.2 Hooks (A5.1) — a wake-up first, a writer of hook-only facts second

A hook's value over the floor is *when*, not *what*. So the hook path does two things and no third:

1. **Wake.** Every recognised hook payload that names its transcript (`transcript_path` is in
   Claude's `BaseHookInput`, 08a §9; Gemini's common stdin fields, 10b §12; Copilot's `agentStop`,
   `preCompact`, `subagentStart/Stop`, 10b §12) asks the file-tail to tick **that one source now**
   instead of waiting up to `LIVE_INTERVAL_MS`. Every event then comes from the fold, with replay's
   ids — convergence by construction, and the hook adds latency only.
2. **Hook-only facts.** A payload may produce an event whose type is in a closed
   `HOOK_ONLY_TYPES` list that no replay emits, keyed on the source path with
   `sourceKind: 'harness'`, `sourceId: '<harness>-hook'`,
   `sourceRef: '<harness>-hook:<session_id>:<event>:<harness tool-use id>'`. The only candidate
   verified to exist is Claude's `PermissionDenied` (auto mode denies a call, 08a §9) →
   `tool.denied`. Whether its payload carries `tool_use_id` is **OPEN** (08a records
   `SDKPermissionDeniedMessage { tool_name, tool_use_id, … }` for the SDK stream, not for the hook
   stdin — capture one hook payload). If a replay later learns to emit the same type, that type
   moves out of `HOOK_ONLY_TYPES` and both producers must share one key — decided then, not assumed.
3. **Not written:** `tool.requested/completed/failed` from `PreToolUse`/`PostToolUse`, and
   `model.*`. The tool **entity** id *can* be shared — `toolExecutionIdOf(conversationId, toolUseId)`
   (`replay-core.ts:97`) is a function of the tool-use id — so a hook-observed tool call is a valid
   input to master §21's "missing tool" reconciliation. Making the tool **event** id converge would
   need a tool-use-id key path in `deriveEventId`, the O-8 treatment applied to tools; that re-keys
   every existing `tool.*` row and is a leader decision (§13, Q2).

The hook process itself (master §18.1 property 1): **shells out to `agentop`, never `curl`**, exits
0 on every failure, prints nothing, and is bounded by the harness's own timeout (Claude's `Stop`
entry is 5 s, `claude-hooks.ts:74`). If the server is not running, the payload is dropped and
nothing is lost: the tail and the next build read the same bytes. A hook payload is **never
persisted** — it can carry conversation text (Gemini's `AfterModel` carries the raw response,
master §18.2; Copilot's `postToolUse` carries `toolResult`, 10b §12), and D5 forbids storing it.
`hook-plan.ts` extracts ids, names and the transcript path, and drops the rest in memory.

### 4.3 OTLP (A5.2) — a receiver, not a collector

Master §18.1 property 2: accept OTLP/HTTP, map the **documented** event names, **ignore and count**
what is not recognised, never store an unclassified blob.

- **Accepted encoding: OTLP/HTTP JSON only.** `http/protobuf` is **OPEN** (a protobuf decoder is a
  dependency decision; Copilot supports both encodings, 10b §12; which encoding Claude, Gemini and
  Codex default to is not in the research — read each CLI's OTel docs).
- **Claude `claude_code.api_request` → `model.completed`, only if the id converges.** 08a §10 lists
  the log events and their correlation attributes (`prompt.id`, `event.sequence`, `message.uuid`,
  `client_request_id`); master §18.2 says `api_request` carries `request_id`. Verified on disk
  (2026-09-27, one transcript on this machine): an assistant transcript line carries **both** a
  top-level `requestId` (`req_…`) and `message.id` (`msg_…`), and the replay keys on `message.id`.
  So an OTel `request_id` of the `req_…` form would **not** converge. **OPEN**, settled by capturing
  one `api_request` log record and comparing its attributes with the transcript line of the same
  response. Outcomes:
  - OTel carries `msg_…` (e.g. via `message.uuid` — itself OPEN: it may be the line `uuid` instead):
    emit `model.completed` on the provider path; convergence holds.
  - OTel carries only `req_…`: **do not emit `model.completed`.** Either hold the record for §21
    reconciliation (the tail will read the same response within one poll and the transcript line
    pairs `req_` to `msg_`), or re-key the replay on `requestId` — which re-keys every model row
    ever written and is a leader decision (§13, Q3).
- **Claude OTel metrics** (`claude_code.token.usage`, `claude_code.cost.usage`, 08a §10) are
  **aggregates** with no per-call id. They are not canonical events at all; they may feed a
  health/lag comparison only. Writing them as `model.completed` would double the replay's numbers.
- **Gemini / Copilot** follow OTel GenAI conventions (`gen_ai.client.token.usage`, spans
  `chat <model>` / `execute_tool <tool>`, 10b §12). No Gemini provider response id is documented
  (research 12, `requestId` row: "not found documented"), and no non-Claude replay passes a
  `providerRequestId` today (grep of `integrations/*/`: only Copilot's `replay-core.ts` declares the
  option; no Copilot fold sets it). **Therefore no non-Claude OTLP record may be written as a
  `model.*` event in A5.** They may wake the tail (the resource carries `session.id` where
  documented — per harness **OPEN**).

### 4.4 The `HarnessLive` slot

`integrations/types.ts:80-83` declares `HarnessLive { watch(emit): () => void }`, implemented by
nobody. Master §15 sketched a richer `live` (`channels`, `install`, `ingest`). A5 proposes to keep
`watch` for the tail and add, per harness, a declared channel list with a **reason** for every
absence (master §15 rule 2: absent is a FINDING). Antigravity's entry is `live: undefined` with the
§18.6 sentence. The concrete type change is A5.1's to make, when the first non-tail channel exists.

## 5. What A5 changes in existing code

| File | Change | Risk |
|---|---|---|
| `journal/shadow.ts` | A5.3: starts the tail once (`shadowIngest` → `startLive()`, idempotent), sharing its journal, cursor map and accepted stamps; the tail reports acceptances back (`onAccepted`) so a source last accepted while live is replayed once more after it settles | one cursor per conversation is load-bearing: the Claude replay trusts a cursor only if it matches the walk it retained (`claude/index.ts`), so two cursor stores would force alternating full re-reads |
| `integrations/claude/replay-core.ts` | none — `makeEvent` stamps `mode: 'replayed'` (line 192) and the tail re-stamps via `asObserved` | an adapter-version bump is not needed: no id or payload changes |
| `config.ts` | `JOURNAL_LIVE_ENABLED` (in the working tree, uncommitted); round 2 adds `INGEST_ENABLED`, `INGEST_CHANNELS` | affirmative-only parsing, like `JOURNAL_ENABLED` |
| `claude-hooks.ts` | A5.1: the spec table must be keyed by **(event, verb)**. Today `hookSpecFor(event)` returns the *first* spec for an event (line 77) and `isAgentopHookCommand(command, event)` matches **every** verb pair registered on that event (lines 140-146), so a second agentop hook on `Stop` would be rewritten in place by the first one's install and removed by its uninstall — "our two hooks would become one thing", the failure the file's own comment warns about | the narrowing becomes `(event, verb)`; `events emit` keeps its entry and its semantics |
| `capability-guard.ts` | A5.1/A5.2: register `/api/ingest` as a PREFIX and `/v1/logs`, `/v1/metrics` exactly | a missed registration is a vulnerability (file header) |
| `index.ts` | route the ingest paths after the capability guard and (once merged) the Host allowlist | §6.3 |

`events/` is **not** changed: the `Stop → events emit` hook stays the notification channel's exact
source. Ingestion is a separate hook entry with a separate verb (§6.1).

## 6. Install, receive, refuse

### 6.1 The verbs — `agentop ingest …`, not `agentop hooks …`

Proposed:

```
agentop ingest install   <harness> [--channel hook|otlp]
agentop ingest uninstall <harness> [--channel hook|otlp]
agentop ingest status   [<harness>]
agentop ingest emit     --harness <id> --event <name>    # what an installed hook runs; reads stdin
```

Why a new noun rather than widening `agentop hooks`: `hooks` is Claude-only by construction (its
usage text and paths are `~/.claude/…`, `cli-hooks.ts:48-60`), it also installs a *skill*, and its
Stop entry belongs to the notification channel. Ingestion spans six harnesses and an OTLP channel
that is not a hook at all. What is **shared**, not copied: the settings-merge planners
(`planHookInstall` / `planHookRemoval` / `readHookStatus`), generalised per §5, so there is still
exactly one merge implementation for `~/.claude/settings.json`. Deviation from master §18.1, which
names the hook runner `agentop hooks emit`: recorded in §13, Q5.

Rules, each from CLAUDE.md "Anything agentop writes OUTSIDE its own directories is an explicit act of
the user, and is exactly reversible" and the existing `claude-hooks.ts` header:

- **Never a side effect.** `agentop setup` may suggest the command; nothing installs itself.
- **Merge, preserve every unknown key, refuse a document it cannot merge into**, never repair it.
- **Idempotent**: a second install reports `changed: false` and writes nothing.
- **Exact inverse**: uninstall removes our entry and the containers that existed only to hold it.
- **Identified by COMMAND** (`agentop ingest emit … --hook-version N`), no invented key in someone
  else's schema.
- **No harness, no files**: if the harness is not installed, say so and create nothing.
- **`--channel otlp` writes environment/settings for the harness's exporter.** For Claude that means
  `OTEL_*` variables in its settings (`OTEL_LOGS_EXPORTER`, `OTEL_METRICS_EXPORTER` are named in 08a
  §10; the enabling variable and the endpoint/protocol variables are **OPEN** — read the monitoring
  doc). That is an install act into a file that is not ours, under every rule above. It must also
  **pin the content gates off** (`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`,
  `OTEL_LOG_TOOL_DETAILS` unset or false for Claude, 08a §10) — D5.
- **An existing user OTel configuration is refused, not overwritten**: a person already exporting to
  their own collector keeps it; status says why ingest is not installed.

### 6.2 Per-harness channels and the trap in each

Grounded in master §18.2 (verified 2026-09-18) and research 08a / 10a / 10b; everything else OPEN.

| Harness | Hook channel | OTLP channel | The trap |
|---|---|---|---|
| **claude** | ~32 events (08a §9); `transcript_path` in every payload; `Stop` already registered for `events` | log events incl. `api_request` (08a §10) | OTel needs env vars in the harness's settings = an install act; content gates must stay off; `api_request`'s id vs `message.id` is **OPEN** (§4.3); a new `Stop` entry collides with the `events` hook unless the table is keyed by (event, verb) (§5) |
| **gemini** | 11 events incl. `BeforeModel`/`AfterModel` (10b §12); `transcript_path` in common fields | built in, off by default (10b §12) | **`logPrompts` defaults to true** (master §18.2) — enabling telemetry without pinning it off would export prompt text, which D5 forbids; `AfterModel` stdin carries the raw response, so the hook must extract and drop; `AfterModel`/`BeforeModel` can **block** on exit 2 (10b §12), so the runner must never exit 2; no provider response id documented, so no `model.*` from Gemini live channels |
| **codex** | master §18.2 says `notify` (payload UNVERIFIED); research 10a §4 records a **12-event hook system** (`PreToolUse`, `PostToolUse`, `Stop`, …) with **per-hook trust hashes** set through an interactive review | `[otel]` opt-in (master §18.2) | the two sources disagree on what hooks exist — **OPEN**, run `codex --help` / read `codex-rs/hooks`; trust hashes mean an installed hook may not run until the person approves it interactively, which `install` must say rather than report success; **default metrics go to OpenAI's Statsig, not OTLP** (master §18.2) |
| **copilot** | 13 events (10b §12), personal scope `~/.copilot/hooks/*.json` | off by default; `otlp-http` or a JSON-lines `file` exporter (10b §12) | **`preToolUse` is fail-CLOSED**: any non-zero exit other than a timeout DENIES the tool call (10b §12) — so ingest installs **nothing** on `preToolUse`; **an `http://` OTLP endpoint silently disables export** (10b §12), so a plain loopback receiver receives nothing from Copilot — the `file` exporter (`COPILOT_OTEL_FILE_EXPORTER_PATH`) read by the tail is the likelier channel (**OPEN**) |
| **kimi** | exist; **event names UNVERIFIED** (master §18.2) | "added recently" (master §18.2) | nothing may be installed until the names are read from the tool itself — **OPEN**, run `kimi --help` / read its docs; `kimi acp` is native (master §18.2) |
| **antigravity** | none confirmed (master §18.2, §18.6) | none | **stated, not papered over**: file-tail only, `live` declares the reason, and no 5 s directory watch is called instrumentation |
| **opencode** | plugin `Hooks` union only partly read (10c) | tool calls are OTel spans (10c) | not in master §18.2 at all — **OPEN**; its store is one SQLite file, so it has no stat-only stamp either (§7) |

### 6.3 The receiver — bind, auth, refusal

- **Loopback peer only.** The native server binds `0.0.0.0` on the `local` profile (commit
  `e607d942`'s message, branch `fix/s1-host-allowlist`). A route on that listener is reachable from
  the LAN. So `/api/ingest/*` and `/v1/*` must additionally refuse any request whose **peer address**
  is not loopback — a Host header is not a peer address. Alternative: a dedicated listener bound to
  `127.0.0.1` for OTLP only. Which one is **OPEN** (§13, Q6).
- **Host allowlist (S-1).** `host-allow.ts` (commit `e607d942`, **not in this worktree's HEAD**)
  refuses a foreign Host on every `localShell` route with 421, closing DNS rebinding. The ingest
  routes must ride it. It is **not** a loopback guarantee: it admits every interface address and the
  machine's own names by design. Both checks are needed.
- **Capability.** Registered in `capability-guard.ts` under `localShell` (it spawns nothing, but it
  writes into the host's journal from an unauthenticated local caller, and `localShell` is what
  `exposure.ts:84-87` turns off on `public` and on a `lan` without the opt-in). Refused on `public`
  and **refused on a central** (a central has no local harnesses; members' data travels through
  `/api/team/ingest`, unchanged).
- **Auth.** The routes are **not** added to `AUTH_PUBLIC` (`index-routes.ts:11`); on `local` there
  is no account gate, and on `lan` the capability is off unless opted in. A harness's OTel exporter
  cannot carry our cookie; whether a per-install bearer token written alongside the exporter config
  is needed on `lan` is **OPEN**.
- **Size.** `readJsonLimited` (`limits.ts:22`), never `await req.json()`. The limit is per route;
  OTLP batches are larger than hook payloads — number **OPEN** until measured.
- **Flags.** `AGENTISTICS_INGEST` off → the routes answer 404 as if absent;
  `AGENTISTICS_INGEST_CHANNELS` narrows to `hook`, `otlp` or both.

## 7. The file-tail (A5.3) — the round-1 design

- **A poll over stat-only stamps, not `fs.watch`.** Every `LIVE_INTERVAL_MS` = 5000 (the fleet poll's
  cadence, `file-tail.ts:49`) it takes `claudeStamps()` (`shadow.ts:170` — one `readdir` per project,
  one `stat` per file, no transcript opened).
- **The first tick is a BASELINE** and tails nothing. History is the build's and `agentop journal
  import`'s job; the tail only follows what grows.
- **A source is tailed when its stamp changed** since the previous tick. At most
  `LIVE_MAX_SOURCES` = 8 per tick (`file-tail.ts:52`), most-recently-modified first in a total order
  (mtime, then id); the rest are **deferred** and their baseline stamp is not advanced, so they stay
  candidates. 8 is deliberately a quarter of `MAX_STATES` = 32, so the tail's walks and the build's
  cannot evict each other into full re-reads.
- **Shares the shadow's journal, cursor map and accepted stamps** — one cursor per conversation.
- **A cursor advances only over what the journal accepted** (the shadow's rule).
- **Never emits `*.ended`.** The replay emits ends only after the file has been quiet for its settle
  window (`DEFAULT_SETTLED_MS` = 60 s, `claude/index.ts:82`), by which time the stamp has stopped
  moving and the tail has stopped reading it; the build closes it after `SETTLE_MARGIN_MS` = 2 min
  (`shadow.ts:163`).
- **Provenance `observed`** (§4.1). The brief asked for `'live'`, which is not a member of the closed
  `ProvenanceMode` (`event.ts:112`); widening it is a core edit (§13, Q1).
- **Claude only in round 1**: it is the only harness with a stat-only stamp (`IMPORT_STAMPS`,
  `import.ts:81-83`) and a shadow path. Follow-up per harness: codex / copilot / kimi / gemini need a
  per-file stat stamp; antigravity needs the transcript **and** its `conversations/<id>.db` in one
  stamp (its tokens live in the db); opencode has **none possible from stat alone** — one shared
  SQLite file whose mtime moves on every session's message (`import.ts:76-79`).

## 8. Tests

**Pure (unit)**
- `planTail`: baseline, changed-only, the cap and the deferral order, deferred stamps not advanced.
- `hook-plan`: one fixture per harness payload shape → `wake` / hook-only event / ignore; a payload
  carrying prompt or response text yields **no string from that text** in any output (D5, a source
  grep in the style of `events-frontier.test.ts`).
- `otlp-map`: each documented event name maps or is counted as ignored; unknown names are never
  stored; aggregate metrics never become `model.*`.
- The generalised settings planners: two agentop entries on one event are installed, updated and
  removed **independently**; the `events emit` entry survives an ingest install and uninstall
  byte-for-byte.
- **Emission closure**: for every channel, its allowed types are a closed list; a test fails if that
  list intersects the replay's emitted types for a type the channel does not key identically (§4.1).

**Property**
- **Convergence in both orders**: tail-then-build and build-then-tail over the same fixture give the
  same row set; the second path reports only `duplicates` (`integrations/live/file-tail.test.ts`).
- **Chunk independence under growth**: a fixture grown in N uneven appends and tailed tick by tick
  yields the same events as one replay of the final file.
- **No double counting across channels**: a fixture with a Claude hook `Stop` and an OTLP
  `api_request` for one response yields exactly one `model.completed`.

**Security**
- A non-loopback peer and a foreign Host are refused on every ingest route (walk the guard table, as
  S-1's test does).
- Flag off → 404; `public` profile → 403; central → refused.
- An oversized body is abandoned mid-stream.

**Install**
- Install twice → one write; uninstall → the exact original document (byte-compare, including key
  order the merge preserved); an unmergeable document → refused, nothing written; a missing harness
  → nothing created.

## 9. Performance budgets

From master §43; each is an acceptance criterion with a benchmark.

| Budget | Target | How |
|---|---|---|
| hook → journal | **< 50 ms p95, never blocking the harness** | timed from the hook process start to the tail's accepted append for the woken source; the hook process itself must exit well inside its harness timeout (Claude `Stop`: 5 s) |
| hook process wall time | measured and reported; it runs on every turn | compiled binary start + one local POST — **OPEN**, measure before A5.1 ships |
| bytes read per poll | only the bytes appended since the cursor, for at most 8 sources | the replay's anchor-verified cursor; a test asserts no source is read from byte zero on a resume |
| stat cost per poll | one `readdir` per project + one `stat` per file | measured on this machine's store and reported |
| RAM | bounded: no event array outlives a flush (`LIVE_FLUSH_EVENTS` = 500), walks bounded by `MAX_STATES`/`STATE_TTL_MS` — "never hold what you can re-read" | the P1 heap test shape, run with the tail ticking |
| OTLP request | bounded by `readJsonLimited`; mapping is O(records) with no retention | benchmark with a synthetic batch |

A channel that makes the harness slower does not ship.

## 10. Observability

`agentop journal status` gains a **live** block: tail on/off and why (flag, journal off), ticks,
sources tailed / deferred / failed, last tick time, and per channel events accepted / duplicates /
rejected / ignored-unrecognised since boot. `agentop ingest status` reports, per harness and channel:
installed, stale version, refused (with the reason — including "the user already exports OTel
elsewhere" and Codex's pending trust approval), and last payload received. A dropped event is a
counter (master §44). A channel whose install exists but from which nothing has arrived in a long
window says so — the Copilot `http://` trap (§6.2) looks exactly like "on" otherwise.

## 11. Proposed breakdown

| Sub-phase | Files | Model | Tests | Blockers |
|---|---|---|---|---|
| **A5.3** file-tail floor (round 1, in progress) | `integrations/live/file-tail.ts`, `journal/shadow.ts`, `config.ts` | Opus 5.5 | §8 pure + convergence + growth | none; follow-ups: per-harness stamps (§7), leader decision Q1 |
| **A5.1** hooks | `hook-plan.ts`, `hook-specs.ts`, `ingest-web.ts`, `cli-ingest.ts`, `claude-hooks.ts` (generalise), `capability-guard.ts`, `index.ts` | Opus 5.5 for the merge generalisation and the route; Sonnet 5 for per-harness payload fixtures | §8 hook-plan, planners, install, security | S-1 merged; one captured payload per harness (tool-use id, transcript path); Codex/Kimi hook names; Q2, Q5, Q6 |
| **A5.2** OTLP receiver | `otlp-map.ts`, `otlp-web.ts`, `cli-ingest.ts` (`--channel otlp`) | Opus 5.5 | §8 otlp-map, no-double-count, security | the `api_request` id question (§4.3); encoding (JSON vs protobuf); Copilot's https requirement; Q3, Q4, Q6 |
| **A5.4** ACP spawn-mode | a transport beside `spawn-spec.ts` | Opus 5.5 | ACP session fixtures; Gemini's usage omission (master §18.4) must lose to the file reading under §17.3 | whether a first-party Claude bridge exists (UNVERIFIED, master §18.2, research 11 #444); probably **Track B** (spawning is the runtime's job) |

Never Haiku for anything that writes.

## 12. Rollback

- **A5.3:** turn `AGENTISTICS_JOURNAL_LIVE` off; the build's shadow path is unchanged and keeps
  covering the same sources. The journal is additive; rows the tail wrote are rows the replay would
  have written under the same ids.
- **A5.1/A5.2:** turn `AGENTISTICS_INGEST` off → routes inert. `agentop ingest uninstall` is the
  exact inverse of install and is the only way ingest touched a harness's files. An installed hook
  whose server is gone exits 0 silently; a hook left behind after agentop is removed still exits 0
  (the harness logs a missing command at worst — Copilot's `preToolUse` is never used, §6.2).
- **Nothing to delete.** No phase here requires deleting user data (master §48).

## 13. Acceptance

1. Flags off: behaviour byte-identical; the existing suite passes unchanged.
2. A5.3 on: a growing Claude transcript's new events are in the journal within one poll interval
   plus one tick; tail-then-build and build-then-tail give identical row sets, the second path
   counting only duplicates; no `*.ended` is written by the tail.
3. No channel emits a type the replay emits under a different id (the closure test, §8).
4. Every A5.1/A5.2 route is loopback-only, Host-allowlisted, guarded, size-limited, refused on
   `public` and on a central.
5. Install/uninstall are idempotent and exact inverses on every supported harness, and refuse an
   unmergeable document.
6. No conversation text from an external harness reaches the journal (D5), asserted by test.
7. Every §9 budget is measured and in the PR.
8. `agentop ingest status` distinguishes installed / stale / refused / silent.

## 14. Decisions encoded, deferred, and open

**Encoded:** D4 (hooks + OTLP, file-tail as floor); D5 (no conversation text for external
harnesses — hooks and OTLP extract and drop); O-8 (model events keyed on the provider id, which is
what can let a live `model.completed` converge at all); the P1 rule that a cursor advances only over
accepted events; CLAUDE.md's install-reversibility rule.

**Deferred:** reconciliation itself (master §21) — A5 produces its inputs (hook-observed tool entity
ids, held OTLP records) but writes no `recon.*` events; per-harness stamps for the tail; ACP.

### Open questions for the leader

1. **Q1 — provenance vocabulary.** The brief asked for `mode: 'live'`; the closed `ProvenanceMode`
   has no such member, so the tail uses `observed` (its own definition). Widen the vocabulary (a
   core edit, a schema consideration) or keep `observed`/`instrumented`?
2. **Q2 — tool-event keying.** Hooks can match the replay's tool *entity* id but not its *event* id
   (line + ordinal). Add a tool-use-id key path to `deriveEventId` (re-keys every stored `tool.*`
   row), or keep hooks as wake-ups plus reconciliation inputs?
3. **Q3 — model-event keying for OTLP.** If Claude's `api_request` carries only `req_…`, re-key the
   replay on `requestId` (re-keys every stored model row) or hold OTLP model records for
   reconciliation only?
4. **Q4 — encodings.** OTLP/HTTP JSON only, or add a protobuf decoder (a dependency)?
5. **Q5 — verb naming.** `agentop ingest emit` (this spec) vs master §18.1's `agentop hooks emit`.
6. **Q6 — receiver placement.** Loopback-peer check on the existing `0.0.0.0` listener, or a
   dedicated `127.0.0.1` listener for ingestion; and whether `lan` needs a per-install bearer token.
7. **Q7 — Copilot.** Accept that loopback `http://` OTLP never works for Copilot and use its `file`
   exporter via the tail instead?
8. **Q8 — A5.4 ownership.** Move ACP spawn-mode to Track B?

### OPEN items (each with what settles it)

- Claude `api_request` id attribute vs transcript `message.id` / `requestId`; meaning of
  `message.uuid` — capture one log record and compare with the transcript line.
- Claude hook payloads: does `PreToolUse`/`PostToolUse`/`PermissionDenied` stdin carry `tool_use_id`
  — capture one payload per event.
- Claude OTel enabling / endpoint / protocol variables — read the monitoring doc.
- Default OTLP encoding per harness — read each CLI's telemetry doc.
- Codex hook catalogue (`notify` vs 12 events) and its trust-hash approval flow — `codex --help`,
  `codex-rs/hooks`.
- Kimi hook event names — `kimi --help` / its docs.
- `session.id` (or equivalent) on Gemini/Copilot OTLP resources — capture one export.
- Copilot `file` exporter as a tail source — capture one file.
- opencode live channels — read its plugin `Hooks` union.
- Hook process wall time and OTLP body-size limit — measure.
- Whether a first-party Claude ACP bridge exists — UNVERIFIED in master §18.2.
