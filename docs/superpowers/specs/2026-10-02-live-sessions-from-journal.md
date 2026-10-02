# LIVE — the session surfaces read from the journal, fed live, for every harness

**Date:** 2026-10-02 · **Item:** LIVE.0 (`s-6d3cdfc0f9`) · **Status:** design, for the leader's and
the owner's decision. No product code was changed to write it. **Lives in the private repository
`agentistics/agentistics-engine` only** (branch `spec/live-sessions`).

**Scope, as decided by the owner on 2026-10-02:** A5 (live ingestion) plus a NARROW A4 — only the
**session surfaces** switch to the journal: the chat transcript, reopen/link, and attention/approval
with its options answerable from the chat. Two facts become additive core/canonical types: the
**transcript state** and the **conversation-link provenance**. The metrics screens are out of scope
and keep the legacy readers.

**Read with:** the engine interface (`2026-09-29-engine-interface.md`, this repo), the runtime
master spec (§8, §10, §14.3, §18, D5, D6, D20, D22, D25), P1 (canonical journal), P3 (projections and
parity — its flags `AGENTISTICS_PROJECTIONS` / `AGENTISTICS_PROJECTIONS_SURFACES` are reused here),
P4 (`2026-09-27-runtime-p4-live-ingestion.md`, public branch `feat/a5-live-ingestion`, commit
`46b71171`), and the transcript-state module written by the agy hotfix session `e5da88d093`
(`packages/server/server/sessions/transcript-availability.ts`, public branch
`fix/agy-session-details`, commit `680af5c1`, PRs #878 → dev / #880 → main).

A claim marked **OPEN** is not settled by the code, the specs or a measurement recorded here; each
names what settles it.

---

## 0. The fact this design starts from: the journal holds no conversation text

D5 (owner, 2026-09-25): for EXTERNAL harnesses the journal stores **metadata + tool summaries**, never
the conversation's text — "the harness already stores it, and a copy doubles the sensitive surface".
The canonical vocabulary is built that way: there is no message event in `EVENT_TYPES`; a turn is
`turn.started`/`turn.ended`, a tool call carries `canonicalName` + a `commandSummary()` `summary`, and
every event carries a `sourceRef` (`claude:<conv>:<lineNo>`) that points BACK into the harness's own
file.

So "the chat reads from the journal" cannot mean the bubbles' text comes out of `journal.db`. It
means, precisely:

1. **The text of a bubble keeps coming from the harness's own transcript**, through the six public
   readers in `harness-transcript.ts` that already exist and already pass their tests. Nothing in this
   design re-implements a reader or copies text into a store.
2. **The journal supplies what the transcript cannot**: the record that outlives the file (D6 — events
   are kept forever; Claude deletes transcripts after `cleanupPeriodDays`), a uniform skeleton across
   harnesses (turn boundaries, tool summaries in the shared vocabulary, models, timings), and the
   attention history the screen sees and no transcript records.
3. **The session surfaces MERGE the two by a pure rule** (§4) whose first clause is: when the
   transcript is there and readable, the payload is the legacy payload, byte for byte, plus only the
   overlays this document names.

Native (runtime) sessions are different — their full content lives in the engine's content store
(D5 amendment) — and are out of scope: their chat is the native runtime's own surface.

Measured state on this machine at the time of writing (2026-10-01): the journal is OFF here (no
`journal.db`), `agentop server` held **343 MB RSS** eleven minutes after start, the box has 12 GB
with **3.2 GB available**, and this same server was OOM-killed at **7.4 GB** on 2026-09-26. Those
are the numbers §7's memory gate is measured against.

---

## 1. The line — what is public, what is engine

Unchanged from the engine interface (Q1(b)): `journal/`, `projections/`, `core/canonical` are public;
integrations and live ingestion are engine.

| Piece | Side | Why |
|---|---|---|
| `TranscriptState` / `TranscriptAvailability` / `transcriptAvailability()` / `TRANSCRIPT_RETENTION` | **public** (`core/canonical`) | computed from LEGACY facts (did the resolver find a file, is the session live, last activity); every build needs it |
| `ConversationLinkProvenance` + `conversationLinkOf()` + the registry field it reads | **public** (`core/canonical` + `sessions/types.ts`) | a fact about the public registry |
| `attention.raised` / `attention.cleared` event types and their data shapes | **public** (`core/canonical`) | vocabulary is public (Q1(b)) |
| The `SESSION_SURFACE` projection (fold + stored rows + reader) | **public** (`projections/`) | the read side of the journal is public; in a community build it folds an empty journal |
| The merge rule `planSessionSource()` and its use in `chat-web.ts`, `chat-tail.ts`, `session-view.ts` | **public** | the surfaces are public; with no engine the rule always answers `legacy` |
| Live feeding for every harness (file-tail generalised beyond Claude) | **engine** | A5 |
| The attention producer (fleet transitions → `attention.*` events) | **engine** | it writes the journal; a community build's journal stays empty |
| `EngineHostServices.fleet` (the subscription the producer uses) | **public contract** (`engine-api` 1.3.0) | the host gives, the engine takes |

---

## 2. The two canonical facts (LIVE.1)

### 2.1 Transcript state — a MOVE, names kept

The hotfix session wrote `sessions/transcript-availability.ts` "shaped so it can be lifted into
`@agentistics/core/canonical` as an additive change … so the lift is a move and not a rename". This
design takes it at its word:

- `packages/core/src/canonical/transcript.ts` receives, **unchanged in name and shape**:
  `TranscriptState = 'present' | 'not-yet-written' | 'expired' | 'deleted' | 'unreadable'`,
  `TranscriptReason = 'resolved' | 'live-no-file-yet' | 'past-retention' | 'no-file-found' |
  'read-failed'`, `TranscriptAvailability { state; reason; expiredAt?; retentionDays? }`,
  `TRANSCRIPT_RETENTION: Record<HarnessId, {days, who} | null>` and the pure
  `transcriptAvailability(o)`.
- `transcriptSentence()` is rendering, not contract: it moves to `@agentistics/core`
  (`transcriptSentence.ts`, beside the other EN/PT helpers) so the web, the cockpit and the VS Code
  extension can render the same sentence. The old server path **re-exports both** in the same commit,
  so nothing else changes.
- `ChatPayload` gains `transcript?: TranscriptAvailability` (the hotfix already computes it; this makes
  it a typed field rather than only a sentence). Additive: an older client ignores it.

The rules the hotfix established stay the rules: `expired` only where a retention rule is
established (today Claude alone) AND the arithmetic agrees; everything else missing is `deleted`,
which claims no cause; `not-yet-written` keeps the composer.

### 2.2 Conversation-link provenance — new, and reconciled with what exists

The registry already records HOW a link was made, in two vocabularies that answer different
questions and both keep their names:

- `ManagedSession.conversationLink?: 'assigned' | 'observed'` (absent reads `assigned`);
- `task-model.ts` `LinkProvenance = 'assigned' | 'observed' | 'none'` — the ROLLUP's question: is
  this session's cost exact or inferred.

The new type answers the SESSION SURFACE's question — *where did this link come from, and if there is
none, will there ever be one?* — which is what the chat needs to choose between "not linked yet" and
"this harness can never be linked this way":

```ts
// packages/core/src/canonical/conversation-link.ts
export type ConversationLinkProvenance = 'spawn' | 'recovered' | 'unrecoverable'

export type ConversationLinkReason =
  // spawn — the id existed before the process did
  | 'assigned-id'          // SpawnSpec.assignId: claude/copilot `--session-id <uuid>`
  | 'resumed-id'           // reopened from a known conversation (every harness with `resume`)
  // recovered — the id was learned after spawn, from the harness's OWN statement or a claim
  | 'harness-session-file' // claude ~/.claude/sessions/<pid>.json naming our tmux session
  | 'process-log'          // agy: the open cli-*.log fd → `Created conversation <uuid>`
  | 'first-sighting'       // task-attribution.ts claim (harness + directory + time); gemini's synthetic id
  // unrecoverable — no route exists for THIS session, and none will appear
  | 'no-id-route'          // the harness has no assign flag, no id-taking resume and no session record
  | 'platform-unsupported' // the only route needs /proc (agy off Linux)
  | 'external-process'     // not started by agentop: nothing to bind a pane to

export interface ConversationLink {
  provenance: ConversationLinkProvenance
  reason: ConversationLinkReason
  /** `true` only for spawn/* and the harness's-own-statement recoveries; first-sighting is `false`. */
  exact: boolean
}

/** PURE. `null` = not linked YET (a live agy session before its log line) — never `unrecoverable`. */
export function conversationLinkOf(o: {
  harness: HarnessId
  conversationId?: string
  linkVia?: ConversationLinkReason      // the new registry field, below
  conversationLink?: 'assigned' | 'observed'
  external: boolean
  platform: NodeJS.Platform
}): ConversationLink | null
```

- **Registry field:** `ManagedSession.conversationLinkVia?: ConversationLinkReason`, written at the
  moment a link is recorded (`recordConversation`, the spawn path, the process-log path). **Absent
  reads by the existing rule**: absent + `conversationLink` absent/`assigned` → `spawn/assigned-id`;
  `observed` → `recovered/first-sighting`. So every row written before the field exists keeps meaning
  exactly what it meant.
- **Mapping to the rollup's vocabulary is one pure function** (`rollupProvenanceOf(link)`):
  `spawn/*`, `harness-session-file`, `process-log` → `assigned`; `first-sighting` → `observed`;
  `null` / `unrecoverable` → `none`. agy's process-log link is already recorded as `assigned`
  (CLAUDE.md: "the harness's own statement, not the time-and-directory claim"); this keeps it so.
- **`unrecoverable` is never inferred from absence.** A live session with no link yet is `null`, and
  the chat says "not linked yet"; only a harness/platform fact produces `unrecoverable`. Today's
  `conversationBlind` sentence is the `no-id-route` rendering and stays the row's own words.
- `ChatPayload` and the fleet row gain `link?: ConversationLink | null` (additive). The relay to a
  central does **not** carry it until decided (§9, Q2): `reduceMachineFleetRow` is an allowlist.

### 2.3 Attention — two additive event types

Nothing in `EVENT_TYPES` says "a person is being asked something, and the session is blocked on it".
`tool.approved`/`tool.denied` record a DECISION, `policy.requested` a policy consultation. Proposed
(D20-style: additive, typed, a compile-time test like `d20-additive.test.ts`):

```ts
'attention.raised', 'attention.cleared'   // appended to EVENT_TYPES

export interface AttentionRaisedData {
  kind: 'approval' | 'question' | 'select' | 'confirm' | 'unknown'
  /** Only when the screen names a tool the journal already knows (claude's permission prompt). */
  toolExecutionId?: Id
  optionCount?: number
  hasFreeText?: boolean          // an `isFreeTextOption` row is present
  via: 'screen'                  // the only producer in LIVE; a hook may only WAKE (§5.3)
}
export interface AttentionClearedData {
  how: 'answered-here' | 'answered-elsewhere' | 'session-ended' | 'unknown'
  /** The 1-based option index, only when agentop sent it. An index, never a label. */
  choice?: number
  blockedMs?: number
}
```

**No text crosses into the journal.** Option LABELS are not stored: an `AskUserQuestion`'s options are
model-written text and D5 forbids it for external harnesses. The options are read off the live screen
at the moment of answering, which is what the host must do anyway (the existing rule: re-read
immediately before sending, refuse when they changed). The journal records that a person was asked,
what kind of thing, how many options, and how it ended.

---

## 3. The `SESSION_SURFACE` projection (LIVE.2, public)

**Why a projection and not a journal query:** the journal answers exactly two queries — the rowid
cursor (`readFrom`, ≤ `MAX_PAGE` = 1000) and `stats()`. `events_v2` carries NO secondary index, on
purpose (A1.7 measured the two v1 indexes at 51 MB of a 267 MB file). A chat poll asking "the events
of conversation X" would scan the file. The P3 pattern answers it: a stored projection, folded by
`catchUpProjections`, keyed per session, read from `projections.db`.

```
projections/session-surface.ts     PURE fold: events → per-session state + skeleton rows
projections/catalog.ts             SESSION_SURFACE = stored(sessionSurfaceProjection, bySession, …)
```

**State per session** (key = canonical `sessionId`): `harness`, `conversationId`, `projectPath`,
`title`, `firstAt`, `lastAt` (= last activity, the input `transcriptAvailability` needs and the
legacy side does not always have once the file is gone), `turnCount`, the open attention (if any),
and the highest `sourceRef` line folded.

**Rows** (`out_session_surface`, one per skeleton turn — never one blob per session, so a read is
bounded by the window it asks for):

```ts
interface SkeletonTurn {
  at: string
  by: 'user' | 'assistant'
  sourceLine?: number               // into the harness file; how a present transcript is aligned
  tools: { canonicalName: string; summary?: string; outcome: 'ok' | 'failed' | 'denied' | 'open' }[]
  model?: string
  attention?: { kind: AttentionRaisedData['kind']; how?: AttentionClearedData['how']; blockedMs?: number }
}
```

`summary` is `commandSummary()` output, which D5 permits ("tool summaries"). No prompt, no response,
no tool RESULT.

**Reader:** `ProjectionReader.rowsFor('session_surface', key, { last: n })`. It needs an index on
`out_session_surface(key, rid)` — **OPEN**: confirm whether `reader.ts` already serves by key or this
adds the first keyed read; measure the index's size on a store folded from this machine's import.

**Projection version** starts at 1 and carries `adapterVersions` like the others, so a parser fix in
an integration rebuilds it (P3 §1).

---

## 4. The merge rule — `planSessionSource()` (LIVE.2, public, pure)

One pure function decides, **per surface and per conversation**, where the payload comes from. It is
the only place the decision lives; `chat-web.ts`, `chat-tail.ts` and `session-view.ts` call it and do
not re-derive it.

```ts
type SessionSource =
  | { from: 'legacy' }                                   // today's path, byte for byte
  | { from: 'legacy+overlay'; overlay: 'attention' }     // legacy text, attention markers placed by time
  | { from: 'skeleton'; transcript: TranscriptAvailability } // text gone, journal record shown

function planSessionSource(o: {
  enginePresent: boolean
  surfaceFlag: boolean            // AGENTISTICS_PROJECTIONS on AND 'sessions' in _SURFACES
  projectionReady: boolean        // the store opened and is not rebuilding
  projectedTurns: number          // rows the projection holds for THIS conversation
  projectedAttention: number
  transcript: TranscriptAvailability
  legacyReadOk: boolean
}): SessionSource
```

The table, every row tested:

| engine & flag & ready | transcript | projection has it | → |
|---|---|---|---|
| any false | any | any | **legacy** |
| true | `present`, read ok | attention rows | legacy + attention overlay |
| true | `present`, read ok | none | **legacy** (payload identical) |
| true | `not-yet-written` | any | **legacy** (empty, composer offered — the hotfix's rule) |
| true | `expired` | turns | **skeleton**, with the expired sentence above it |
| true | `deleted` | turns | **skeleton**, folded behind a disclosure (Q3) |
| true | `unreadable` | turns | **skeleton**, with the unreadable sentence |
| true | not `present` | none | **legacy** (its sentence, unchanged) |

Consequences that are the point of the design:

- **A present transcript always wins.** The journal can lag the file (the tail ticks every 5 s; the
  catch-up pass is bounded); a merge that let the skeleton override text would show a conversation
  older than the one on disk. It may only ADD attention markers, which no transcript carries.
- **The link rule is untouched.** Only an exact `conversationId` reaches either path; the projection is
  keyed by the canonical `sessionIdOf(conversationId)` of that exact id. The harness-and-directory
  guess never reaches a skeleton any more than it reaches a reader.
- **Reopen.** `session-view.ts` asks the same rule about a reopenable row: a row whose transcript is
  `expired` is listed with **why it cannot be reopened** ("expired around 3 Sep — Claude Code deletes
  transcripts after 30 days") instead of offering a Reopen whose only outcome is the harness failing
  to find the conversation. Reopen itself is unchanged: it hands the harness an id, and the harness
  needs its own file.
- **Answering from the chat.** Whether a card is ANSWERABLE is decided by the live fleet row
  (`waiting-approval` + options re-read from the screen), exactly as `ApprovalCard` does today. A
  journal `attention.raised` without a live confirmation renders as HISTORY, never as a button: a
  stale journal must never offer an answer to a dialog that has already closed.

---

## 5. Live feeding (LIVE.3 / LIVE.4, engine)

### 5.1 File-tail for every harness, not only Claude

P4's A5.3 (`integrations/live/file-tail.ts`, public branch `feat/a5-live-ingestion`, not yet in this
repository — the engine `index.ts` says so: "`ingest` … arrives by its own step-6 replay") is
replayed into the engine layout and generalised. The convergence contract is P4 §4.1's, unchanged:
the tail IS the replay called sooner, the same fold, cursor and `sourceRef`, so tail-then-build and
build-then-tail write the same row set and the second only counts duplicates.

What "all harnesses" costs is a stat-only stamp per harness (P4 §7):

| Harness | Stamp | Live in LIVE.3 |
|---|---|---|
| claude | per transcript (exists: `claudeStamps`) | yes |
| codex, copilot, kimi, gemini | per file stat over each store's layout | yes |
| antigravity | transcript **and** `conversations/<id>.db` in ONE stamp (tokens live in the db) | yes |
| opencode | **none possible**: one shared SQLite file whose mtime moves on every session | **no** — `live` absent with that sentence; its chat reader is `null` too, so nothing on a session surface changes |

`manifest.provides.live` lists exactly the harnesses whose `HarnessLive` exists, derived from the
registry like `replay` already is — never restated.

### 5.2 The attention producer

The engine subscribes to the host's fleet poll — the one `createSessionsPoller` already runs every 5 s
and the event channel already rides — through a new optional member of `EngineHostServices`
(`engine-api` 1.2.0 → **1.3.0**, minor: optional, so an older engine compiles):

```ts
fleet?: {
  /** Confirmed transitions only — the event channel's two-consecutive-polls rule. Returns unsubscribe. */
  subscribe(cb: (t: FleetTransition) => void): () => void
}
interface FleetTransition {
  managedId: string
  harness: HarnessId
  conversationId?: string          // the EXACT link or absent
  from: SessionState; to: SessionState
  at: string
  dialog?: { kind: AttentionRaisedData['kind']; optionCount?: number; hasFreeText?: boolean }
  answeredHere?: { choice: number } // set when the host's own approve route sent the keystroke
}
```

Into `waiting-approval` → `attention.raised`; out of it → `attention.cleared`. Identity: source path
(P4 §4.1), `sourceKind 'harness'`, `sourceId '<harness>-screen'`,
`sourceRef 'screen:<managedId>:<raisedAt ms>'`, ordinal 0 raised / 1 cleared — these types have no
replay counterpart, so there is nothing to converge with (P4's "hook-only types" rule, applied to the
screen). **A transition with no exact `conversationId` writes nothing**: it cannot be keyed to a
session, and the live `ApprovalCard` covers that session today anyway.

The two-poll confirmation is the event channel's (`event-plan.ts`) and is reused, not restated: a
repaint that flickers one poll must not write a raised/cleared pair.

### 5.3 Claude hooks — no new hook, no new install

The brief's constraint is that Claude hooks stay an explicit `agentop hooks install`. This design adds
**no hook at all**. `agentop hooks install` already registers `Stop → agentop events emit`, which fires
on every turn end, and that payload carries `transcript_path`. The engine uses the hook-sourced
transitions it already receives through `fleet.subscribe` (`source: 'hook'` in the event channel) as a
**wake** for that one source — tick it now instead of waiting up to 5 s. Every event still comes from
the fold, with replay's ids (P4 §4.2, rule 1). A machine that never ran `agentop hooks install` loses
only latency, never data.

P4's `agentop ingest install` (A5.1) and the OTLP receiver (A5.2) are **not** part of LIVE. They stay
P4's, behind their own flags and decisions.

---

## 6. The five constraints, each with its enforcement

### C1 — Metrics screens keep the legacy readers until parity says otherwise

- **Rule:** `SESSION_SURFACE` and `planSessionSource` are read ONLY by `chat-web.ts`, `chat-tail.ts`
  and `session-view.ts`. `/api/data`, `useData`/`useDerivedStats`, the TUI `selectors.ts`, the MCP
  analytics tools and `runtime-metrics-*` do not import them. The metrics cutover remains P3's,
  gated by the parity matrix; nothing here moves it.
- **Enforced by:** `session-surface.lint.test.ts` (grep over the module sources, the
  `tokens.lint.test.ts` shape): the allowed importer set is exact, and a new importer fails the build.
- **Tested by:** with the flag ON and a non-empty journal, `/api/data` is byte-identical to the flag
  OFF response over the same fixture store.

### C2 — The community build keeps today's behaviour EXACTLY

- **Rule:** `planSessionSource` returns `legacy` whenever `engineStatus().present` is false; in that
  case `projections.db` is not even opened by the session surfaces (a community build creates no new
  file). LIVE.1's `transcript` / `link` fields are computed from LEGACY facts and ship to every build —
  they are the hotfix's behaviour, typed; "exactly" applies to everything LIVE.2–LIVE.4 add.
- **Tested by:** `session-surface-community.test.ts` — over the chat, tail, fleet and reopen routes,
  three runs compared field for field: null engine slot; fake engine (`engine/fixtures/fake-engine.ts`)
  with the flag off; fake engine with the flag on and an EMPTY journal. All three must equal the
  pre-LIVE snapshot plus only the LIVE.1 fields. Runs in the public CI, which IS the community build.

### C3 — Per-surface fallback, never a blank pane

- **Rule:** §4's table. No row of it produces `turns: []` with no `unavailable`, no sentence and a
  state other than `not-yet-written`.
- **Tested by:** `planSessionSource.test.ts` over the full table (every combination, not a sample),
  plus a property test over the chat route: for every generated (transcript state × projection
  contents × engine/flag) the payload is either non-empty, or carries a sentence, or is
  `not-yet-written` on a LIVE session. A projection store that fails to open or is `rebuilding` →
  `projectionReady: false` → legacy, tested by forcing both.

### C4 — Claude hooks stay an explicit `agentop hooks install`, never auto-installed

- **Rule:** LIVE writes nothing outside agentop's own directories. No new hook spec, no change to
  `HOOK_SPECS`, no install from `agentop setup`, the engine, or a server boot.
- **Enforced by:** `claude-hooks.ts`'s existing table test (exact contents) is unchanged by LIVE and
  must stay green; a source grep asserts `planHookInstall` is called only from `cli-hooks.ts`; the
  engine has no `ReuseSurface` member that writes `~/.claude/settings.json`.

### C5 — The shadow writer stays bounded, and memory is measured on this box before default-on

- **Bounds (each a test):**
  - **single flight** — one shadow ingest and one projection catch-up in flight per process; a tick
    that arrives while one runs is COALESCED into a dirty bit, never queued (a queue is unbounded
    memory by another name);
  - **incremental** — cursors only; a test asserts no source is read from byte zero on a resume (P4 §9);
  - **caps** — `LIVE_MAX_SOURCES` = 8 per tick, `FLUSH_EVENTS` = 500, walks under `MAX_STATES` = 32 /
    `STATE_TTL_MS`, catch-up `maxPages` per pass; the attention producer holds one open record per
    LIVE session and nothing per ended one.
- **Measurement protocol (LIVE.4), on THIS machine (WSL2, 12 GB):**
  1. Baseline: `agentop server`, flags off, the real fleet, RSS sampled every 60 s for 24 h.
  2. Same with `AGENTISTICS_JOURNAL=1`, `AGENTISTICS_JOURNAL_LIVE=1`, `AGENTISTICS_PROJECTIONS=1`,
     `AGENTISTICS_PROJECTIONS_SURFACES=sessions`, after an `agentop journal import` of this machine's
     history.
  3. Report: steady-state RSS delta, the slope after a 1 h warm-up, peak, journal/projection file
     sizes, tail tick p95, catch-up pass p95, chat route p95 before/after.
- **Default-on gate:** delta ≤ **+150 MB** over baseline, slope indistinguishable from zero, no peak
  above **1 GB**, chat p95 not worse. Numbers are this document's proposal (Q6); the results are
  written into an appendix of this spec before the flag's default changes, and the owner signs.

---

## 7. Flags

| Flag | Meaning | Absent |
|---|---|---|
| `AGENTISTICS_JOURNAL` / `AGENTISTICS_JOURNAL_LIVE` | P1 / P4 — the shadow and the tail | off |
| `AGENTISTICS_PROJECTIONS` | P3 — projections are maintained | off |
| `AGENTISTICS_PROJECTIONS_SURFACES` | P3 — which surfaces read projections; LIVE adds the token **`sessions`** | legacy everywhere |

All four are inert without an engine (C2). `sessions` is independent of P3's metric tokens: turning it
on moves no metric surface (C1).

---

## 8. Implementation items

Sequenced; each leaves both builds green. "Model" follows the owner's 2026-10-01 rule (Opus for
design/lead/complex, Sonnet for scoped + mechanical code, Haiku for probes; never Haiku for anything
that writes).

| Item | Side | What | Model | Done when |
|---|---|---|---|---|
| **LIVE.1** — canonical facts | **public** | Move `transcript-availability.ts` into `core/canonical/transcript.ts` + `transcriptSentence` into core (names kept, old path re-exports); `conversation-link.ts` + `conversationLinkOf` + `rollupProvenanceOf`; `ManagedSession.conversationLinkVia` written at the three link sites; `attention.raised/cleared` in `EVENT_TYPES` with a D20-style additive test; `ChatPayload.transcript` / `.link` and the fleet row's `link` (not relayed). | **Sonnet 5.5** (scoped, contract written here verbatim); the vocabulary diff reviewed by the runtime leader | tsc + suite green; additive test; legacy-row mapping test (absent field ⇒ old meaning) |
| **LIVE.2** — projection + merge | **public** | `projections/session-surface.ts` + catalog entry + keyed reader; `planSessionSource` + its use in `chat-web.ts`, `chat-tail.ts`, `session-view.ts` (expired-row reopen sentence); the `sessions` surface token; C1 lint, C2 community test, C3 table + property tests. Web: render a skeleton turn (tool chips + time, no bubble text) and the history attention marker, mobile in the same change. | **Opus 5.5** (new fold, the merge rule is where a wrong answer hides) | C1–C3 tests green; a fixture conversation whose transcript is deleted renders its skeleton with the right sentence, at 390 px too |
| **LIVE.3** — live for every harness + attention | **engine** (+ `engine-api` 1.3.0 public) | Replay `feat/a5-live-ingestion`'s file-tail into the engine layout (§11 step 6 path map); per-harness stat stamps (§5.1); `HarnessLive` per harness, opencode's absence stated; `EngineHostServices.fleet` (public contract + host wiring) and the attention producer; single-flight/coalescing for shadow + catch-up. | **Opus 5.5** (convergence and concurrency) | P4 convergence tests per harness (both orders, chunk independence); attention pair written once per confirmed transition, nothing for an unlinked one; bounds tests |
| **LIVE.4** — wake, measure, decide | **engine** (wake) + **public** (measurement script) | Hook-sourced `turn-end` wakes its source (§5.3, no new hook); the §6 C5 measurement on this machine, results appended here; the default-on proposal. | **Sonnet 5.5** for the wake wiring and the measurement runs; the default-on call is the **owner's** | measurement appendix written; owner decision recorded |

LIVE.1 can start now and does not wait for the hotfix PRs: if #878/#880 have not merged, LIVE.1 is
based on `fix/agy-session-details` and moves the file from there. LIVE.2 depends on LIVE.1. LIVE.3
depends on LIVE.1 (vocabulary) and is independent of LIVE.2. LIVE.4 depends on LIVE.2 + LIVE.3.

---

## 9. Open questions

**For the owner (product / privacy):**

- **Q2 — Do `transcript` and `link` cross to a central** in the managed-sessions relay? They carry no
  text, but `expiredAt` reveals when a conversation was last active. Recommendation: **not in LIVE**;
  the relay allowlist (`reduceMachineFleetRow`) stays as it is and adding a field is its own decision.
- **Q3 — Show a skeleton for a `deleted` transcript?** `expired` is a schedule the person did not
  choose; `deleted` may be a person removing a conversation on purpose. Recommendation: `expired` and
  `unreadable` show the skeleton; `deleted` shows the sentence plus a closed-by-default "show what
  agentop recorded" disclosure.
- **Q6 — The default-on numbers** (+150 MB, flat slope, < 1 GB peak, chat p95 not worse) on this box.

**For the runtime leader (technical):**

- **Q1 — `attention.raised/cleared` as a new pair** (recommended) **vs widening `policy.requested`**,
  which today means "a policy was consulted" — a harness permission prompt, an `AskUserQuestion` and a
  trust dialog are not policy consultations, and overloading one type is how a projection starts
  summing unlike things.
- **Q4 — Confirm "no new hook"** (§5.3): the existing `Stop → events emit` is the wake, and P4's
  `agentop ingest` / OTLP stay out of LIVE. **OPEN to verify in LIVE.4:** that a hook-sourced event
  reaches the daemon process within a second (socket) rather than only on the next inbox read.
- **Q5 — Keyed projection reads.** The first `rowsFor(key, last n)` on `projections.db` adds an index
  to a store the P3 work sized without one; LIVE.2 measures it and the leader accepts or asks for a
  different shape.
- **Q7 — `engine-api` 1.3.0** for the optional `fleet` member, released with LIVE.3 under the
  `engine.pin` lockstep.

---

## 10. Rollback

- Turn `sessions` out of `AGENTISTICS_PROJECTIONS_SURFACES` (or any of the four flags off): every
  session surface is legacy again on the next request; nothing is migrated.
- `projections.db` is regenerable (P3 §7) — deleting it costs one rebuild.
- The journal is additive; attention events are rows nothing else sums.
- LIVE.1's fields are additive and legacy-derived; removing them is a revert, and the registry field
  is ignored by a build that does not know it (absent reads by the old rule).
- Nothing outside agentop's own directories was written, so there is nothing to uninstall.

## 11. Acceptance

1. Community build: chat, tail, fleet and reopen responses equal the pre-LIVE snapshot plus only the
   LIVE.1 fields (C2).
2. Flags on, transcript present: chat payload equals legacy except attention markers (C3, §4).
3. Flags on, transcript expired, journal has the conversation: the skeleton renders with the expired
   sentence and the expiry date; the reopen row says why it cannot reopen.
4. No session-surface path ever yields an unexplained empty pane (C3 property test).
5. `/api/data` and every metric surface byte-identical with `sessions` on (C1).
6. No file outside agentop's directories changed by any LIVE item (C4).
7. The C5 bounds tests pass and the measurement appendix exists before default-on.
8. No conversation text from an external harness reaches the journal (D5) — the P4 source-grep test,
   extended to the attention producer.
