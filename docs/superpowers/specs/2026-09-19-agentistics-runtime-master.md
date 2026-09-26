# Agentistics Runtime, Adapter Architecture & Native Harness — Master Specification

**Status:** discovery + architecture specification. **No code is changed by this document.**
**Date:** 2026-09-19 · **Base:** `origin/dev` @ `9b06537a`, read in the worktree
`.claude/worktrees/runtime-spec` (branch `spec/runtime-architecture`).
**Companions:** the phase specs listed in §52, which are the only executable documents; this file
is the reference they are read against.

> Every claim about the current code cites `file:line` as read on that commit. Every claim about an
> external product cites a URL with the date it was accessed. Anything that could not be verified is
> marked **UNVERIFIED** and is never used as a load-bearing premise.

---

## 1. Executive summary

Agentistics today is an **observability product for other people's agents**. It reads six harnesses'
own files after the fact, normalises them into one `SessionMeta` record, and renders that record
across four surfaces. It does this unusually well: the parsers carry measured, dated findings about
each vendor's format, and the house rules (`N/A` never `0`, provenance over convenience, one
implementation per rule) are enforced by tests that grep the source.

The goal now is three capabilities at once:

**A. External harnesses** keep working, and a seventh can be added without touching the core.
**B. A native Agentistics harness** executes agents itself — providers, tools, subagents, browser,
ALM, policy — as a first-class implementation, not a second product.
**C. One runtime** underneath both, shared by Web, CLI, TUI, API and MCP.

The discovery behind this document found seven facts that decide the shape of the answer:

1. **There is no provider integration anywhere in the monorepo.** No Anthropic/OpenAI SDK, no API
   URL, in any `package.json` or source file. Every "chat" capability — Nay and the session manager
   alike — spawns a vendor CLI. The native harness is greenfield, not a refactor.
2. **There is no event model for metrics.** `events.jsonl` is an attention-notification channel
   whose own test forbids it carrying an instruction, and OTel here is **export-only** (an
   exhaustive grep found no OTLP receiver). A canonical event journal is a new subsystem.
3. **`SessionMeta` is the universal currency** — adapter output, consolidate-store file format,
   Mongo `TeamSessionDoc` base, MCP/CLI/TUI/web wire shape and the OTel exporter's source. It is
   already the de-facto canonical model, and any new model must subsume it rather than sit beside it.
4. **There is no parser version anywhere.** `parse-cache.ts` keys on `(mtime, size)` only, so a
   parser fix reaches a screen only when the source file changes or the 30-day GC drops the row.
   Event-sourcing needs the opposite: a version that forces re-projection.
5. **Live ingestion is possible today for four harnesses and impossible for one.** Claude Code
   exposes ~32 hooks plus a per-call OTel event carrying the four token counters; Gemini CLI exposes
   `BeforeModel`/`AfterModel`; Copilot and Kimi speak ACP natively; Codex has opt-in OTel and
   `exec --json`; Antigravity has **no confirmed live channel at all**.
6. **The three chat mechanisms in the product do not converge.** A stateless per-turn CLI spawn that
   re-inlines the last eight messages as text, a tmux fleet whose "chat" is a transcript poll and
   whose approvals are screen-scraped, and a legacy Claude-only route. The runtime's first product
   job is to make the chat and the session one object.
7. **Two legal limits are real and dated.** Claude subscription OAuth may not be used by a
   third-party application (Anthropic's own legal page, quoted in §22.3), and the "OpenClaude" family
   derives from Anthropic's accidentally published source (31 Mar 2026) and is under active DMCA —
   it may be read as behaviour reference, never used as a code source.

The recommended shape is a **canonical event journal** written by adapters (replay and live) and by
the native runtime alike, with the existing `SessionMeta` retained as a *projection* rather than a
source, and a parity harness that proves the projection equals today's answer before anything
switches over. The native harness is the **last** phase, not the first; everything before it is
valuable on its own (durable metrics, live ingestion, provider-truth costs, a queryable API).

---

## 2. Scope

In scope for this specification:

- the canonical domain model, event model and their versioning;
- the adapter contract (replay + live) and the capability declaration that goes with it;
- the collector and the per-harness live-ingestion channels;
- the durable event journal, its projections and its parity with today's numbers;
- reconciliation between live events and source artifacts;
- provenance and metric ownership;
- the provider layer, the optional provider gateway and credential handling;
- the native runtime and native harness contracts (agent loop, tools, policy, subagents);
- the browser runtime contract;
- ALM's participation in the execution cycle (prepared sessions, dispatch, evidence);
- Web/CLI/TUI/API/MCP as surfaces of one runtime, and the shared session;
- migration, feature flags, rollback, test strategy and acceptance criteria.

## 3. Non-scope

- **No implementation.** No file outside `docs/` changes as a result of this document.
- **No schema migration** is performed here; §46 specifies how one would be staged.
- **No harness is removed or deprecated.** Six adapters keep working unchanged through every phase.
- **All decisions are recorded in `2026-09-25-owner-decisions.md`.** On 2026-09-25 the owner reviewed
  the recommendations for every open question and decided according to the recommendation (D1–D16).
- **No pricing, window or capability figure is invented.** Where a number cannot be cited it is
  absent, exactly as `MODEL_PRICING` and `contextWindows.ts` already require.
- **Gemini's token/cost flip is out of scope** (CLAUDE.md records it as a deliberate, unreconciled
  decision; §17.4 records the drift found between that prose and the code).

---

## 4. Principles

These are not new. They are the house rules already enforced in this repo, restated because the
canonical model has to inherit them rather than replace them.

1. **N/A is never 0.** A capability that cannot be produced is declared absent
   (`HARNESS_CAPABILITIES`), and a capability gates the *denominator*, not only a rendering
   (`session-profile.ts`'s per-metric `n`).
2. **One implementation per rule.** `share-rules.ts` for sharing, `billing.ts` for plan arithmetic,
   `tokens.ts` for token sums, `task-reopen.ts` for reopening. A second implementation is a second
   answer.
3. **Provenance travels with the number.** Pricing already carries `official | community | builtin`;
   sessions carry `_source`; agent invocations carry `unmeasured`; workflow agents carry
   `labelSource`. The canonical event extends this rather than inventing it.
4. **A refusal is a sentence, never a silence.** Four different silences get four different
   sentences (`not-owner` / `refused` / `offline` / `silent`); an empty list may not stand in for any
   of them.
5. **Measure before believing.** Every format rule in this repo carries a measurement and a date
   (`1.4.1` constant across 2966 rows; `event_msg` covering 21 of 42 user messages). The canonical
   model's own rules must be established the same way, against fixtures.
6. **Never load everything into RAM.** The resumable cursor walk
   (`transcript-cursor.ts`, 21–44× measured) is the pattern; a new store is cursor-native from day
   one, not retrofitted after an outage.
7. **Absent reads as the safe answer** — but *which* answer is per switch and is decided
   deliberately (`chat-gate.ts` absent = OFF; `shareMode` absent = denylist; the shell/editor gates
   were flipped ON by an owner decision on 2026-09-14). The canonical model states the reading for
   every new switch it introduces.
8. **Normalise the semantics, never the identity.** Harness, Provider, Model, Session, Run, Agent,
   Subagent, Tool, Task, Repository and Project stay independent dimensions wherever the source
   distinguishes them.

---

## 5. Current state — harnesses

Six adapters, registered in one hand-written array (`adapters/types.ts:26-33`) — the single place in
the harness system that is not a `Record<HarnessId, …>` and therefore the one a seventh harness can
be forgotten in.

| Harness | Source of truth on disk | Format | Session id | Tokens | Model | Context gauge | Subagents | Live link |
|---|---|---|---|---|---|---|---|---|
| `claude` | `~/.claude/{stats-cache.json, usage-data/session-meta, projects/**}` | JSONL + JSON aggregate | harness UUID | 4 counters, deduped by `message.id` | per-turn | last `message.usage` input side | `AgentInvocation[]` from `subagents/agent-<id>.jsonl` | `--session-id` (assign) + own session file |
| `codex` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | envelope JSONL | own UUID | cumulative, last wins; `input` excludes cache | `turn_context.model` | `last_token_usage.input_tokens` | none | resume only |
| `gemini` | `~/.gemini/tmp/<project>/chats/*.jsonl\|json` | two shapes (rich JSON + append journal) | **synthetic** `${dir}/${file}` | rich-JSON path only | rich-JSON path only | none | none | **never exact** |
| `copilot` | `~/.copilot/session-state/<uuid>/{events.jsonl, workspace.yaml}` | JSONL + flat YAML | own UUID | **only at `session.shutdown`** | at shutdown | none | none | `--session-id` (assign+resume) |
| `kimi` | `~/.kimi-code/sessions/<ws>/session_<id>/{state.json, agents/*/wire.jsonl}` | JSONL per agent | own UUID | per-turn increments (`usage.record` only) | per record, provider prefix stripped | main agent's latest record | folded into the session, no per-agent row | resume only |
| `antigravity` | `~/.gemini/antigravity-cli/{brain/**, conversations/<id>.db, history.jsonl}` | JSONL + SQLite protobuf | own UUID | protobuf `1.4.2/1.4.3/1.4.5` | dominant `1.19` | `1.9.10.1`, window `1.9.10.4` | child conversation + rollup | `/proc` log fd only |

Facts that constrain the canonical model:

- **Three different shapes of "what a subagent cost"** already exist: Claude's `AgentInvocation[]`
  joined by `subagent-join.ts`; Antigravity's child conversation folded upward by
  `rollUpAntigravitySessions` (deepest-first, `active_minutes` deliberately not summed); Kimi's
  agent tree merged into one set of session totals with no per-agent breakdown. A canonical `Agent`
  entity must accommodate all three without pretending the third has data it does not.
- **`SessionMeta.daily` (per-UTC-day slices) and `daily[].hours` are Claude-only** — no other
  adapter populates them, and there is no capability flag for it. Every non-Claude session therefore
  falls back to the start-day rule under a date filter. This is a real, currently-unlabelled parity
  gap (see §40).
- **`conversationLinkable` is a three-way OR** (`spawn-spec.ts:255-259`): `assignId`, Claude's own
  live session file, or Antigravity's held-open process log. Gemini can never be exactly linked for
  a fresh session, and that is a *link* fact, not a format fact.
- **Copilot's tokens/lines exist only at shutdown**, so a crashed session reports zero — a
  structurally different failure mode from every other harness, and one the canonical model should
  be able to express as "unmeasured", not as zero.

## 6. Current state — the pipeline and the stores

`buildApiResponse` (`data.ts:543`, 1238-line module) is a 13-step build behind a 30-second
stale-while-revalidate cache (`CACHE_TTL_MS`, `data.ts:488`): read statsCache + session-meta +
health in parallel → scan `~/.claude/projects` → resolve project facts (git remotes) for every
harness → normalise + dedup by `session_id` → `writeConsolidated` (**Claude only, and it must run
before the non-Claude merge or Codex double-counts** — an inline comment, not a type) → gap-fill from
the consolidate store → backfill git remotes → `supplementStatsCache` → append the other five
adapters → apply session labels → merge team data on a central → final dedup by
`(harness, session_id)`.

Two caches stack with different staleness semantics: the module-level result cache above, and a
SQLite parse cache at `~/.agentistics/cache.db` keyed on `(kind, mtime+size, variant)` with **no
parser version** — which is the literal mechanism behind the repo's own rule that "the store must be
rebuilt for a correction to reach a screen".

Stores that a canonical model has to coexist with, each with a different concurrency model:

| Store | Shape | Concurrency |
|---|---|---|
| `~/.agentistics/sessions/<harness>/<id>.json` | one `SessionMeta` per file | last-write-wins per file, 20-way limiter |
| `~/.agentistics/managed-sessions.json` | `ManagedSession[]` | documented race — a short-lived process's record observed erased |
| `~/.agentistics/events.jsonl` (0600, 2 MB rotation) | `SessionEvent` per line | `O_APPEND`; `seq` is a cursor ordinal, **not an identity** |
| `~/.agentistics/tasks` book | one JSON document | the ONE store with a real cross-process file lock |
| `cache.db`, `git-stats.db` | SQLite | SQLite locking; degrade to no-op on failure |
| Mongo (central) | 16 collections | `DATE_MIGRATION_VERSION = 4` is the only schema version in the codebase |

## 7. Current state — surfaces

`GET /api/data` returns one fully materialised `ApiResponse` and is consumed **wholesale** by the web
dashboard, the TUI cockpit, the VS Code extension (on its own 300 s timer) and the MCP server, five
of whose tools re-fetch that blob and filter it client-side in JS. There is **no query API**. The
fleet surface is separate and cheap (`/api/fleet`, ~5 s, kilobytes), guarded by a path *prefix* in
`capability-guard.ts` so a new fleet route is guarded by being added.

## 8. Current state — live signals that already exist

- **The event channel** (`events/`): `SessionEvent {v, seq, at, source: 'poll'|'hook', kind:
  'working'|'waiting'|'waiting-approval'|'exited'|'turn-end', …}`, a two-poll confirmation rule
  (`event-plan.ts`), a 90 s dedupe window that never dedupes `waiting-approval`
  (`event-dedupe.ts`), an `offset:seq` cursor with explicit `rotated` reporting, and a frontier test
  that fails the build if a field named `action` appears. It is a **notification** channel by
  design, and this specification does not widen it — §12 explains why the metrics journal is separate.
- **Two Claude Code hooks**, held in one table (`claude-hooks.ts:41-146`, `HOOK_VERSION = 2`):
  `SessionStart → hooks context` and `Stop → events emit`.
- **The 5 s fleet poll** (`sessions-host.ts`), which is also the event producer's poll — one scan,
  not two — plus `/proc`-based live-process detection with a typed `LiveUnavailableReason`.
- **The resumable transcript cursor** (`transcript-cursor.ts`, pure; `transcript-state.ts`, IO):
  anchor-verified byte offsets, never consuming a partial line, TTL+LRU bounded, measured 21–44×.
- **Workflow runs** (`WorkflowRun`/`WorkflowAgent`): the one existing Run→Agent hierarchy with
  provenance-tagged attribution (`labelSource: 'record'|'matched'|'none'`), paired by longest
  verbatim prompt fingerprint and deliberately conservative on ties.
- **OTel export only.** 17 `claude_stats.*` metrics plus `agentistics.harness.*`; no receiver exists.

## 9. Current state — ALM

`task-model.ts` holds `Task` (7-state Kanban), `Subtask` (same status type, plus `isGroup` /
`parentGroupId`), `Attempt` (`{harness, model?, effort?, method?}` + `running|delivered|abandoned`),
`TaskClaim` (a 30-minute lease decided inside the store's lock), `TaskEvent`, `TaskFile`,
`TaskComment`. `task-rollup.ts` produces `null`, never `0`, and already carries a `costMeasured`
field **that nothing sets to true**.

**Corrected 2026-09-20, and the correction matters for §26.** An earlier draft of this section said
prepared sessions were absent. They are not: `Subtask.stagedSession` shipped on 2026-09-18
(`38e62538`, "stage a dormant session draft on a subtask or group"). A subtask — or a group, never a
group MEMBER, by the same `subtask_in_group` rule that refuses to file a real session there — holds
a `StagedSessionDraft`: a prompt (the only required field) plus optional harness, model, effort,
cwd and `TaskFile` attachments. Firing it spawns a real session through the very `/api/fleet/new`
path the wizard uses and **files the result under that subtask automatically**. Validation lives in
`@agentistics/core`'s `stagedSession.ts` and drops a half-read draft rather than repairing it.

So what `execucao.md` asks for is now **partly built**. Still genuinely absent: Epic/Phase above
Task, acceptance criteria as a first-class field, an explicit dispatch lifecycle separate from the
Kanban status, and the model-selection/approval metadata (`modelSelectionReason`, `approvedBy`).
`agentistics_task_subtask` also does not expose `stagedSession`, so a draft can be written over HTTP
or from the board but not through MCP — an asymmetry worth closing.

## 10. Current state — chat

Three mechanisms, none linked to another:

1. **Nay** (`chat-drivers/*`, `chat-tty.ts`): a fresh CLI process per turn; history re-inlined as
   `"User: … / Assistant: …"` text for every non-Claude driver (no resume exists in their headless
   modes); Nay's system prompt is a `CLAUDE.md` written to disk because the CLI reads one.
2. **The fleet** (`sessions/*`): long-lived tmux processes; chat is a transcript *read*
   (`harness-transcript.ts` → one unified `ChatTurn`), the live view is a `capture-pane` frame, and
   approvals are answered by parsing the options off the screen.
3. **`/api/claude-chat`**: an older Claude-only duplicate of (1).

The read path of (2) is the one piece already shaped like the target: a `Record<HarnessId,
Reader|null>` registry, an exact-link-only rule, worded refusals, and a uniform output type.

## 11. Problems this architecture must solve

1. **Durability.** Deleting a harness's local files today loses everything the consolidate store did
   not already hold — and the store holds a *computed projection*, so no correction can ever be
   re-derived from it.
2. **No re-projection lever.** A parser fix cannot be forced through the two caches.
3. **Post-hoc only.** Metrics exist minutes after the fact at best; nothing is captured during
   execution, so a session killed mid-turn (Copilot) or a rotated log (Antigravity) is lost.
4. **One blob, four consumers.** Every analytical question re-derives from a megabyte snapshot.
5. **Claude asymmetry.** `stats-cache.json` forces two aggregation regimes into every metric
   surface, duplicated in at least eight places.
6. **Provider is not a dimension.** Cost can be grouped by harness and model but not by the billing
   entity, although `resolveProvider` already exists for pricing headings.
7. **No Run.** A conversation reopened four times is four `ManagedSession` rows and one
   `SessionMeta`; there is no entity for "one execution", which is what a shared session needs.
8. **Order-dependent correctness** inside a 1200-line function, asserted by a comment.
9. **The chat gap.** For every non-Claude harness there is no code path where the chat UI and the
   live session are the same object.

---

# PART II — TARGET ARCHITECTURE

## 12. The layer model

```
Provider        an account that bills tokens          Anthropic · OpenAI · Google · OpenRouter · LiteLLM · Ollama
Harness         an orchestrator of an agent           Claude Code · Codex · Gemini · Copilot · Kimi · agy · Agentistics Native
Runtime         the operational environment           filesystem · shell · git · browser · MCP · processes · network
Adapter         harness ⇄ canonical events            one module per harness, replay and/or live
Gateway         optional provider proxy               request/response telemetry only
Surface         Web · CLI · TUI · VS Code · API · MCP
Analytics       projections over the journal
ALM             tasks, criteria, evidence, dispatch
```

Two boundaries are load-bearing and are asserted by tests (§38):

- **A gateway owns provider-request telemetry and nothing else.** It may never be the source of
  subagents, tools, MCP, browser, shell, filesystem, ALM or agent lifecycle — those belong to the
  harness or the runtime, and a gateway that reported them would be inventing them.
- **A harness owns lifecycle telemetry and never the provider's billing truth** unless it states it
  (Claude's `cost-state`, OpenRouter's in-band `usage.cost`).

## 13. Canonical domain model

```ts
// packages/core/src/canonical/entities.ts  (proposed)

type Id = string                    // opaque, prefixed: ses_, run_, agt_, inv_, tex_, bro_, …

interface Session {                 // the RUNTIME's unit of work. May span harnesses.
  id: Id
  createdAt: string
  title?: string
  taskId?: string                   // ALM link, optional
  subtaskId?: string
  repoKey?: string                  // normalizeGitRemote(), '' = the "no linked repository" bucket
  projectPath?: string
  origin: 'adapter' | 'native' | 'imported'
}

interface Run {                     // ONE execution segment of ONE harness inside a Session.
  id: Id
  sessionId: Id
  harness: HarnessId                // 'claude' | … | 'agentistics'
  harnessVersion?: string
  conversationId?: string           // the harness's OWN thread id, when one exists and is EXACT
  conversationLink?: 'assigned' | 'observed' | 'none'
  startedAt: string
  endedAt?: string
  status: 'running' | 'completed' | 'failed' | 'abandoned' | 'lost'
  cwd?: string
  managedSessionId?: string         // the tmux-backed row, when agentop hosts it
}

interface Agent {                   // the run's main agent, and every subagent, as ONE type.
  id: Id
  runId: Id
  parentAgentId?: Id                // absent = the run's main agent
  kind: 'main' | 'subagent' | 'fork'
  agentType?: string                // 'Explore', 'general-purpose', an agy subagent, …
  description?: string
  model?: string
  startedAt: string
  endedAt?: string
  status: 'running' | 'completed' | 'failed' | 'unmeasured'
}

interface ModelInvocation {         // ONE billed response. The unit of cost.
  id: Id
  agentId?: Id                      // OPTIONAL since D20 (O-6): a bare runtime call has no agent
  attemptId?: Id                    // D20 — the inv_… grouping key SHARED by every attempt
  attempt?: number                  // D20 — 1-based; (attemptId, attempt) names one attempt
  modelRequested?: string           // D20 — what the caller asked for
  modelServed?: string              // D20 — what answered; the only id that prices the call
  stopReason?: {                    // D20 — B1.1's StopReason, plus the provider's own value
    normalised: StopReason
    verbatim?: string
  }
  iterations?: {                    // D20 — server-side sub-calls (§22.1.1 condition #2)
    relation: 'unmeasured'          //   O-3: relation to the four counters is not yet measured
    items: Array<{ kind: string; model?: string }>
  }
  providerRequestId?: string        // Anthropic message.id / request-id header, OpenAI id, …
  provider: ProviderId
  model: string
  deployment?: string               // vertex / bedrock / azure / openrouter route, when stated
  startedAt: string
  completedAt?: string
  latencyMs?: number
  usage: TokenBreakdown             // the four counters, ALWAYS all four
  reasoningTokens?: number          // never added on top of output — see §16.3
  costUSD?: number                  // ONLY when measured; otherwise the projection prices it
  costSource?: 'provider' | 'harness' | 'table'
  status: 'completed' | 'failed' | 'cancelled'
  errorClass?: string
}

interface ToolExecution {
  id: Id
  agentId: Id
  name: string                      // the harness's own name
  canonicalName: string             // canonicalTool() — the shared vocabulary
  kind: 'shell' | 'file' | 'search' | 'mcp' | 'browser' | 'agent' | 'other'
  mcpServer?: string                // only when the harness names one
  requestedAt: string
  startedAt?: string
  endedAt?: string
  status: 'completed' | 'failed' | 'denied' | 'cancelled' | 'unknown'
  approval?: 'auto' | 'user' | 'policy' | 'denied'
  summary?: string                  // commandSummary() — never a raw first-line truncation
  filesTouched?: string[]
  linesAdded?: number
  linesRemoved?: number
}

interface BrowserSession { id: Id; runId: Id; implementation: 'playwright' | 'extension' | 'remote'; startedAt: string; endedAt?: string }
interface BrowserTab     { id: Id; browserSessionId: Id; openedAt: string; closedAt?: string; lastUrlHost?: string }
interface BrowserAction  { id: Id; tabId: Id; kind: 'navigate'|'click'|'input'|'scroll'|'screenshot'|'download'; at: string; detail?: string }

interface Artifact {                // evidence: a file, a screenshot, a diff, a test report
  id: Id
  runId: Id
  kind: 'file' | 'screenshot' | 'diff' | 'log' | 'report'
  ref: string                       // a storage id, NEVER inline bytes
  bytes?: number
  sha256?: string
  createdAt: string
}
```

Entities that already exist keep their identity and are *referenced*, not redefined: `Task`,
`Subtask`, `Attempt` (ALM), `ManagedSession` (the registry row), `SessionMeta` (the projection),
`Provider`/`Model` (pricing), `Repository` (the normalised remote), `Project` (a directory).

### 13.1 Hierarchy and cardinality

```
Task 1─* Session 1─* Run 1─* Agent ─┬─* Agent (subagent, recursive)
                                    ├─* ModelInvocation
                                    ├─* ToolExecution ─* Artifact
                                    └─* BrowserSession 1─* BrowserTab 1─* BrowserAction
```

- A **Session may hold Runs of different harnesses** — the capability §9 of the source prompt asks
  for, and the reason `Run` exists as its own entity.
- A **conversation reopened N times is N Runs and ONE `conversationId`** — which is exactly the
  distinction `collapseSupersededSessions` already has to make by hand today.
- A **Run may have no conversation** (Gemini fresh sessions, an unlinkable agy row). Then
  `conversationLink: 'none'` and every projection reads it as unmeasured, never as zero.

### 13.2 The legacy projection is part of the model

`SessionMeta` remains, and is produced by a projection keyed on **`(harness, conversationId)`** —
which is exactly today's `session_id`. Consequences, all deliberate:

- today's consolidate store, team wire, MCP, OTel exporter and all four surfaces keep working with
  no change at all while phases 1–3 run;
- a Session that holds two harnesses' Runs projects into **two** `SessionMeta` rows, as it does
  today, and the grouping is expressed by `Session`/`Task` above them;
- a Run with no conversation projects into **no** `SessionMeta` row (it has no key) and is visible
  only through the canonical surfaces. That is honest and is stated in the UI, not silently dropped.

To remove an ambiguity before it is implemented twice: **a replay adapter mints one Run per
conversation it reads** (`conversationLink: 'observed'`, `mode: 'replayed'`), so every session that
exists today continues to project exactly as it does today. The only Runs without a conversation
are the ones agentop *hosted* and could never link — a tmux row for gemini, an unlinkable agy
process — and those contribute no metrics today either. No existing row is lost by this model; the
new entity only adds rows that previously had nowhere to be.

### 13.3 Identity and correlation

```
taskId → sessionId → runId → agentId → modelInvocationId → providerRequestId
                                    └→ toolExecutionId → artifactId
```

- Ids are **minted by the writer** with a type prefix (the ALM's `mint(prefix)` convention).
- `providerRequestId` is the **correlation key across layers**: a gateway, a native invocation and a
  harness's own telemetry all name the same response with it. Where the harness does not expose it
  (every file-based adapter today), the invocation carries `providerRequestId: undefined` and is
  correlated by `(agentId, startedAt, model)` — an inference, and marked as one.
- **`message.id` is already this key for Claude** (`usage-dedupe.ts`: one id = one billing event,
  last wins, a record with no id is always counted). The canonical rule is the same rule.

### 13.4 A process that outlives its tool call

Found by issue triage (2026-09-20, issue #342): the model above has no home for a **dev server**. A
`ToolExecution` ends; a `bun run dev` started inside one does not. Every surveyed harness has the
same hole, and it is why "the preview is still running from an hour ago" is invisible to all of them.

```ts
interface SideProcess {
  id: Id
  runId: Id                       // who started it
  startedByToolExecutionId: Id    // the call that spawned it — which has long since ended
  kind: 'server' | 'watcher' | 'task' | 'unknown'
  command: string                 // summarised, never raw with secrets
  cwd: string
  pid?: number
  ports?: number[]                // what it bound, when observable
  startedAt: string
  endedAt?: string
  endedBy?: 'exit' | 'killed-by-runtime' | 'killed-externally' | 'lost'
  url?: string                    // the preview address, when one can be established
}
```

Rules:

- It is **owned by a Run and outlives a ToolExecution** — that asymmetry is the whole point.
- **`lost` is a real end state**: the runtime restarted, the process may or may not still be alive,
  and claiming either would be inventing it — the same discipline `ManagedSession`'s `lost` already
  carries for a session after a reboot.
- Its lifecycle is events (`process.started` / `process.ended`), so "what is still running because
  of this task" is a projection rather than a `ps` at render time.
- It is what makes a **POC/preview** attributable: the URL that a screenshot artifact came from has
  a process, a run and a task behind it.
- **Killing it is a person's act or the run's end**, never a timer — the `SHELL_CAP` reasoning.

## 14. Event model

```ts
// packages/core/src/canonical/event.ts  (proposed)

interface AgentisticsEvent<T extends EventType = EventType> {
  /** Deterministic. sha256(source.kind, source.id, sourceRef, type, ordinal) — see §17.2 */
  eventId: string
  schema: number                    // CANONICAL_EVENT_SCHEMA, bumped on any breaking change
  type: T
  /** When it HAPPENED, per the source's own clock. */
  occurredAt: string
  /** When WE learned it. Never used for ordering within a run. */
  recordedAt: string

  sessionId?: Id
  runId?: Id
  agentId?: Id
  taskId?: string

  source: {
    kind: 'harness' | 'provider' | 'gateway' | 'runtime' | 'alm' | 'adapter'
    id: string                      // 'claude' | 'anthropic' | 'agentistics' | …
    version?: string                // the harness/adapter/gateway version that produced it
  }

  provenance: {
    mode: 'native' | 'instrumented' | 'observed' | 'inferred' | 'replayed'
    confidence: 'exact' | 'estimated' | 'inferred'
    adapterVersion: string          // REQUIRED — this is the re-projection lever (§45)
    sourceRef?: string              // file:offset, db rowid, hook id — what can be re-read
  }

  data: EventData[T]
}
```

Four rules, each of which exists because its absence was a real defect in this repo:

1. **`adapterVersion` is required.** `parse-cache.ts` has no parser version, so a fix cannot be
   forced through; an event that cannot say which code produced it cannot be re-projected either.
2. **`occurredAt` and `recordedAt` are both required and never conflated.** Ingestion order is not
   execution order — a hook fires before the transcript line is flushed, and a backfill arrives days
   later.
3. **`provenance.confidence` is separate from `provenance.mode`.** An `observed` event can be exact
   (a token counter read out of a file) and an `instrumented` one can be estimated (a cost priced
   from a table). Collapsing them is how "the harness said so" comes to mean "it is exact".
   **One confidence vocabulary everywhere — `exact | estimated | inferred` (D17, DECIDED 2026-09-25
   by the owner); `derived` is gone.** A value derived from exact inputs by a deterministic rule is
   `exact`; it becomes `estimated` when the rule introduces an estimate (a price table, a token
   approximation). The confidence of a number is the weakest of its inputs (P3 §2). *Rejected:* keeping
   `derived` as a fourth level — it mixes how a value was computed with how certain it is.
4. **`data` is typed per `type`.** A union with a loose payload is how a field named `action`
   appears; `events-frontier.test.ts` already guards the notification channel this way and the same
   shape of test guards this one.

### 14.1 Event types

Required of every adapter that claims the capability at all:

```
session.started      session.ended
run.started          run.ended
agent.started        agent.ended
model.invoked        model.completed        model.failed
tool.requested       tool.completed         tool.failed
```

Optional, emitted only where the source genuinely produces them:

```
model.started        model.delta                       (streaming)
tool.approved        tool.denied        tool.progress
mcp.requested        mcp.completed
browser.session.started  browser.tab.created  browser.tab.focused  browser.navigation
browser.click  browser.input  browser.scroll  browser.screenshot  browser.download  browser.tab.closed
context.compacted    context.window.observed
policy.requested     policy.approved    policy.denied
alm.task.created     alm.task.updated   alm.task.completed   alm.evidence.attached
```

Harness-specific facts do **not** get their own event types. They travel as typed `data` on the
event that carries them, so the vocabulary stays closed and a new harness cannot widen it silently.

### 14.2 What a `model.completed` carries

This is the event the whole cost model rests on, so it is specified exactly:

```ts
interface ModelCompletedData {
  providerRequestId?: string
  provider: ProviderId
  model: string
  deployment?: string
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number }
  cacheWriteByTtl?: Record<string, number>   // Anthropic reports ephemeral_5m / ephemeral_1h
  reasoning?: {                              // NEVER a bare number — see the correction below
    tokens: number
    billing: 'included-in-output' | 'additive' | 'unknown'
  }
  contextTokens?: number                     // a GAUGE, never summed
  contextWindow?: number                     // only when the SOURCE states it
  costUSD?: number                           // only when the SOURCE states it
  costSource?: 'provider' | 'harness'
  latencyMs?: number
  status: 'completed' | 'failed'
  // ── D20 (2026-09-25): all OPTIONAL and additive ─────────────────────────────
  attemptId?: Id                             // also on model.invoked / model.failed
  attempt?: number                           // also on model.invoked / model.failed
  modelRequested?: string                    // also on model.invoked / model.failed
  modelServed?: string
  stopReason?: { normalised: StopReason; verbatim?: string }
  iterations?: { relation: 'unmeasured'; items: Array<{ kind: string; model?: string }> }
}
```

- **D20 — the fields B1 measures, added OPTIONAL and ADDITIVE** (owner-decisions D20). A source
  that cannot produce one leaves it ABSENT, never zero; an event written before D20 still
  type-checks (`canonical/d20-additive.test.ts`). `attemptId`/`attempt` link a retry's attempts:
  the runtime owns the retry (§22.1.1), so each attempt is its own `model.invoked` and its own
  terminal event, while the billed response is still ONE `model.completed`, keyed on the
  provider's response id (§14.3, O-8). `model` stays what the event is about — the SERVED model on
  `model.completed`, the requested one on `model.invoked` / `model.failed`. `stopReason.normalised`
  is B1.1's `StopReason` (`packages/core/src/provider/stop-reason.ts`), reused rather than restated.
  `iterations` carries kind and model only: their counters stay in the raw capture until a fixture
  pins the key names (B1 O-3), and a projection must call the price PARTIAL while any are present.
- **All four counters, always.** `tokens.ts`'s rule — `input + output` alone was measured at 0,34 %
  of real volume on this machine.
- **CORRECTED 2026-09-20 — reasoning tokens are not one thing.** The first draft of this section
  said they are "billed inside output, never added on top". That is true for OpenAI and OpenRouter,
  **false for Google** — `thoughtsTokenCount` is a separate, additionally-billed top-level counter —
  and **moot for Anthropic**, which exposes no such field at all. A bare number would therefore be
  added on top by one implementer and not by another, and both would look right. Hence the
  `billing` discriminator above: a reader may only sum what the flag says is additive, and
  `unknown` is never summed.
- **`input` is normalised to EXCLUDE the cache counters**, per provider on the way in. Anthropic
  already reports it that way; OpenAI, Google and OpenRouter include the cached portion in their
  prompt count, so the client subtracts it. Without that, `input + cacheRead` double-counts on three
  providers out of four — the exact normalisation `codex-parse.ts` already performs for Codex
  (`totalInput - cached`), applied at the provider boundary instead of the adapter's.
- **A subset is never inferred into a total.** A source that reports three counters reports three;
  the fourth is absent, and the projection says the figure is partial.
- **`costUSD` is present only when somebody else computed it.** Otherwise the projection prices it
  through `calcCost` and marks `costSource: 'table'`. This is what finally lets `costMeasured` in
  `task-rollup.ts` become true rather than remaining a field nothing sets.

### 14.3 Idempotency and ordering

- **Identity is the `eventId`**, derived from the source, not minted at ingest. Replaying a whole
  transcript after a live ingestion of the same session therefore converges instead of doubling —
  which is the property `ingest-batch.ts` had to build by hand for the team push.
- **`seq` is per producer and is a cursor ordinal, never an identity** — the rule `event-store.ts`
  already states, kept verbatim.
- **Ordering within a run is by `occurredAt`, then by the source's own ordinal** (`step_index`,
  line number, rowid). Clock skew between a hook process and a file writer is real; the canonical
  rule is that a *source ordinal* beats a timestamp whenever both exist.
- **A duplicate is dropped at the journal boundary**, by `UNIQUE(eventId)`, and counted. Silent
  dedupe and reported dedupe are different things; the count is an observability metric (§44).

## 15. Adapter architecture

```ts
interface HarnessIntegration {
  id: HarnessId
  version: string                   // the ADAPTER's version — travels on every event
  capabilities: HarnessCapabilityDeclaration     // §16

  /** Historical artifacts → canonical events. Every harness must have one. */
  replay?: {
    discover(): AsyncIterable<SourceArtifact>
    read(artifact: SourceArtifact, cursor?: SourceCursor):
      AsyncIterable<{ events: AgentisticsEvent[]; cursor: SourceCursor }>
  }

  /** Signals during execution. Absent is a FINDING, not a gap. */
  live?: {
    channels: LiveChannel[]         // 'hook' | 'otlp' | 'acp' | 'stream-json' | 'file-tail'
    install?(): Promise<InstallPlan>    // what it would write, for the user to approve
    ingest(raw: unknown, channel: LiveChannel): AgentisticsEvent[]
  }
}
```

Five rules:

1. **An adapter is a module, never a package** — the existing rule, unchanged.
2. **`replay` is mandatory, `live` is optional.** Agy has no live channel that anybody has
   reproduced (§18.6); it is `live: undefined` with a recorded reason, exactly as `RENAME_SPECS`
   carries five nulls with five sentences.
3. **Both paths emit the SAME events** and must produce byte-identical canonical output for the same
   underlying activity — asserted by the golden fixtures in §42.
4. **The adapter never writes a metric.** It writes events; the projection computes metrics. This is
   what removes the "statement order in a 1200-line function" hazard.
5. **Registration is a `Record<HarnessId, HarnessIntegration>`**, so the compiler fails on a missing
   harness — closing the one hand-written array that exists today (`adapters/types.ts:26-33`).

### 15.1 Reading is incremental by construction

`replay.read` takes and returns a cursor. Every file-based adapter reuses `transcript-cursor.ts`'s
anchor-verified offsets rather than reinventing them; the SQLite ones (agy) carry a rowid. **An
adapter that reads a whole file per poll fails review** — that is the bug that took this machine
down twice, and the fix is already written.

## 16. Capabilities — declared, not inferred

`HARNESS_CAPABILITIES` today is `Record<HarnessId, Record<metric, boolean>>`. A boolean cannot say
*why*, and this document needs five distinctions the prompt names. The declaration becomes:

```ts
type CapabilityState =
  | { state: 'supported'; exactness: 'exact' | 'estimated' | 'inferred' }
  | { state: 'partial'; exactness: 'exact' | 'estimated' | 'inferred'; limit: string }
  | { state: 'not_supported'; reason: string }     // a SENTENCE, rendered in the UI
  | { state: 'not_applicable'; reason: string }
  | { state: 'unknown'; reason: string }           // nobody has measured it yet
```

- **`exactness` is the SAME three-value vocabulary as `provenance.confidence` (§14) — D17, decided
  2026-09-25.** There is no `derived`: see the rule in §14.3.
- **`boolean` migrates mechanically**: `true → {supported, exact}`, `false → {not_supported, reason}`
  with the reason taken from the existing comments, which already exist for every false in the table.
- **`partial` is the entry the current table cannot express** and that the code needs today:
  Gemini's tokens (rich-JSON shape only), Copilot's tokens/lines (shutdown only), Kimi's agents
  (folded, no per-agent breakdown), Antigravity's `gitLines` (edit deltas, not `git diff`).
- **`unknown` is honest and is the default for a harness nobody has driven.** It renders as N/A and
  is visibly different from `not_supported`.
- Capabilities gate **the denominator** everywhere `session-profile.ts` already does, and now also
  gate the parity matrix (§40): a metric a harness cannot produce is not a parity failure.

## 17. Provenance and metric ownership

### 17.1 Who is authoritative for what

| Metric family | Authority | Fallback | Never |
|---|---|---|---|
| tokens, provider cost, latency, request ids | provider / gateway | harness telemetry | the runtime |
| model id, deployment | harness (it chose it) | provider response | a table |
| agents, subagents, tools, MCP, approvals, lifecycle | harness | — | the gateway |
| files, lines, git, shell, browser, process | runtime | harness telemetry | the provider |
| task, criteria, evidence, delivery | ALM | — | any of the above |
| aggregate cost, cost/task, efficiency, success rate | projection (derived) | — | any single source |

### 17.2 The provenance question set

Every metric on every surface must be able to answer, without a new query:

```
what was measured · who produced it · where it came from · how it was captured ·
when it was captured · which adapter version · exact or estimated
```

This is satisfied structurally: the fields exist on every event, the projection carries them
forward per metric, and a surface that cannot show them is showing a number it cannot defend.

### 17.3 Precedence when two sources disagree

```
native  >  instrumented(hook/OTel/ACP)  >  observed(file/db)  >  inferred
```

…**and the loser is kept.** A divergence is a recorded fact (§21), never a silent overwrite. The
one exception is exactness: an `exact` observed figure beats an `estimated` instrumented one, and
the rule is stated once, in the reconciliation module, not per metric.

### 17.4 A doc/code drift found during discovery, recorded here so it is decided rather than inherited

`CLAUDE.md` and `docs/data-sources.md` describe Gemini token/cost capture as deliberately **not**
turned on. The current `types.ts` sets `gemini: { tokens: true, cost: true }`, and
`gemini-parse.ts`'s rich-JSON path does read `msg.tokens` — while its JSONL/bootstrap path hardcodes
zero. So the capability is really `partial`, the prose is stale, and money is already being computed
from one of the two shapes. This is exactly the case `partial` exists for. **DECIDED 2026-09-25 by the
owner (D8, §50):** declare the capability `partial` and keep the money, with the reconciliation
against a bill written down; the first step, before anything is flipped, is to read the code and
record which of the two statements is true. Not fixed by this document.

## 18. Live ingestion

### 18.1 The collector

A local endpoint family under `/api/ingest/*`, registered in `capability-guard.ts` as host-touching,
`local` profile by default, never reachable on a `public` exposure profile:

| Route | Who calls it | Payload |
|---|---|---|
| `POST /api/ingest/hook` | `agentop hooks emit` (the harness's own hook runs the CLI) | the harness's hook JSON, verbatim |
| `POST /v1/logs`, `POST /v1/metrics` | a harness's OTel exporter, pointed at us | OTLP/HTTP JSON |
| `POST /api/ingest/events` | the native runtime, the gateway, a plugin | canonical events |

Three properties:

1. **A hook shells out to `agentop`, never to `curl`.** The CLI already exists, already resolves the
   socket/port, and already fails silently by design — a hook that fails a session start is worse
   than one that no-ops.
2. **The OTLP receiver is a receiver, not a collector deployment.** It accepts OTLP/HTTP (the
   protocol Claude Code, Gemini CLI, Codex and Kimi can all be pointed at), maps the documented
   event names to canonical events, and **ignores what it does not recognise** rather than storing
   it as an unclassified blob.
3. **Installing an ingestion channel is an explicit act of the user**, merge-based, exactly
   reversible, and refused rather than repaired when the target document cannot be merged into —
   the rule `cli-hooks.ts` already implements for `~/.claude/settings.json`.

### 18.2 Per-harness live channels — what is actually available

Verified 2026-09-18 against each vendor's own docs and the CLIs installed on this machine.

| Harness | Hooks | OTel export | Structured stream | ACP | Recommendation |
|---|---|---|---|---|---|
| claude | ~32 events incl. `PreToolUse`/`PostToolUse`/`SubagentStart`/`SubagentStop`/`PreCompact`/`Notification`/`Stop` | yes — incl. `claude_code.api_request` with the four token fields + `request_id` | `--output-format stream-json`, `--include-partial-messages`, `--include-hook-events` | via a separate bridge package (**UNVERIFIED** whether first-party) | hooks **and** OTel: hooks for lifecycle/tools, OTel for per-call tokens/cost |
| gemini | 11 events incl. **`BeforeModel`/`AfterModel`** (raw request/response + `usageMetadata`) | yes (`telemetry.*` in settings; `logPrompts` defaults **true** — opt-out) | `--output-format stream-json` | `--acp` native | hooks (the model pair is unique and exact) |
| codex | `notify` (payload **UNVERIFIED**) | `[otel]` opt-in; default metrics go to OpenAI's Statsig, not OTLP | `exec --json` (`thread.started`, `item.*`, `turn.completed` with usage) | none native | OTel when configured; otherwise file-tail |
| copilot | 13 events incl. `permissionRequest`, `subagentStart/Stop` | SDK-level OTel w/ W3C trace context | `--output-format json` (JSONL, post-hoc) | `--acp` native | hooks |
| kimi | exist; **event names UNVERIFIED** | added recently (PRs #871 / #3897) | `--output-format stream-json` | `kimi acp` native | ACP for spawned sessions; file-tail otherwise |
| antigravity | **none confirmed** (`agy --help` shows no hook/telemetry/ACP flag; one blog claim contradicts it and is UNVERIFIED) | **none** (upstream issue open) | `--print` only, unstructured | none native | **file-tail only, and say so** |

### 18.3 The channel a live adapter uses is a property of the SESSION, not of the harness

A session agentop spawned can be driven over ACP or stream-json; a session the user opened in their
own terminal can only be observed. So `LiveChannel` is resolved per run:

```
spawned by us  → acp | stream-json | hook | otlp | file-tail
attached       → hook | otlp | file-tail
observed only  → hook | otlp | file-tail
```

…and the run records which channel produced its events, because that is what its provenance means.

### 18.4 ACP is not the answer to observation, and is the right answer to spawning

ACP (JSON-RPC over stdio, four of the six harnesses speak it natively) formalises exactly what
`spawn-spec.ts` + `approval-spec.ts` + `dialog-choice.ts` do by screen-scraping. But an ACP client
*is* the thing that started the agent — it cannot see a session the user opened in their own
terminal, which is most of the fleet today. It is therefore specified as a **spawn-mode transport**
(§32), not as the live-ingestion strategy.

Recorded caution: Gemini CLI's own ACP surface is reported to omit cached/thought tokens from
`PromptResponse.usage` (two open upstream issues, accessed 2026-09-18) — so an ACP-sourced cost for
Gemini would be *lower* than the truth. Under the precedence rule (§17.3) that is exactly the case
where an `exact` file reading must beat an `instrumented` protocol reading.

### 18.5 File-tail stays, for everyone, forever

Live ingestion never replaces the file readers: it precedes them. Every harness keeps its replay
adapter as the floor (the only thing that works with zero configuration and on a machine whose
hooks were never installed), and reconciliation (§21) is what makes having both safe.

### 18.6 Antigravity is stated, not papered over

`agy` has no reproducible live channel. Its adapter declares `live: undefined` with the reason, the
UI says so where the session's provenance is shown, and the product does not pretend a 5-second
directory watch is instrumentation.

## 19. The event journal

### 19.1 Requirements

append-only · idempotent by `eventId` · ordered per run · cursor-readable · replayable · bounded in
memory · survives the deletion of the source artifacts · versioned · auditable.

### 19.2 Storage — the decision and the alternatives weighed

**DECIDED 2026-09-25 by the owner (D2): SQLite (WAL), one journal per machine**, at `~/.agentistics/journal.db`.

```sql
CREATE TABLE events (
  rowid       INTEGER PRIMARY KEY,          -- the global read cursor
  event_id    TEXT NOT NULL UNIQUE,         -- idempotency, structurally
  schema      INTEGER NOT NULL,
  type        TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  session_id  TEXT, run_id TEXT, agent_id TEXT, task_id TEXT,
  source_kind TEXT NOT NULL, source_id TEXT NOT NULL, source_version TEXT,
  mode        TEXT NOT NULL, confidence TEXT NOT NULL, adapter_version TEXT NOT NULL,
  source_ref  TEXT,
  data        TEXT NOT NULL                 -- JSON
);
CREATE INDEX events_run  ON events(run_id, occurred_at);
CREATE INDEX events_type ON events(type, occurred_at);
```

Why: `bun:sqlite` is already a dependency and already used read-only for agy and for two caches; the
product ships as **one binary** and must not acquire a server dependency on a solo machine;
`UNIQUE(event_id)` makes idempotency structural rather than a code path; `rowid` is the cursor every
projection resumes from; and a single file is what `backup/` can carry to another machine with the
layer rules it already has.

**MEASURED 2026-09-20 on this machine** (`findings/15-sqlite-journal-measurement.md`; Bun 1.3.14,
WSL2, `$HOME` on the VM's own ext4 — **not** a `/mnt/c` DrvFs mount). 1/2/4/8 concurrent writer
**processes**, 2000 rows each in batches of 100: **zero rows lost, zero duplicated, zero surfaced
`SQLITE_BUSY`** at every level; 29k→60k rows/s aggregate; p99 batch latency 8 ms→130 ms. Contention
shows up as latency, never as error, because `busy_timeout` absorbs it. A concurrent cursor scan
never blocked (max 6 ms) and never saw torn state over 3,1 M scans against 120 k concurrent writes.
A `SIGKILL` mid-transaction always recovered clean (`integrity_check: ok`, no partial rows). A held
long transaction made the second writer **wait**, not fail.

Two amendments the implementation must carry, both found by the measurement rather than by reading:

1. **`busy_timeout` is set BEFORE `journal_mode = WAL`, on every connection.** The other order
   produced an uncaught `SQLITE_BUSY_RECOVERY` that killed a worker outright when two processes
   raced to open a fresh database — reproduced reliably, and the same race exists on ext4, merely
   narrower.
2. **The first write after recovering a killed WAL gets its own short bounded retry.** Even with
   `busy_timeout` set, the statement immediately following recovery sometimes threw one transient
   `SQLITE_BUSY` (identified by error code, never by matching a message string).

**And a placement rule, because the measurement found where this breaks:** the journal must live on
a real local filesystem. On a DrvFs mount WAL is correct on this build but **6–20× slower**, with
worst-case batch latency at 3,2 s under 8 writers — 64 % of the timeout ceiling — and SQLite
documents WAL as **unsafe on network filesystems** regardless of OS. So: refuse to open the journal
on a network path and say why, rather than running slowly until it corrupts.

*Alternative A — JSONL segments + index.* Inspectable, trivially appendable, and the shape
`events.jsonl` already uses. Rejected as the default because dedupe, ordering and query become our
code, and the multi-process write race is a defect this repo has already paid for twice
(`registry.ts`, `session-adopt.ts`).
*Alternative B — Mongo everywhere.* Uniform with the central, but forces a database onto every solo
machine, against the single-binary model. The central keeps Mongo for what it already holds; the
machine journal is local (§23).

### 19.3 Retention and compaction

- Raw events are kept for a configurable window (**default: forever**, because the whole point is
  surviving the harness's own 30-day cleanup; the size budget is in §43).
- **Snapshots**: a periodic per-run materialisation so a projection can resume without replaying
  from zero. Snapshots are derived and may always be deleted.
- Compaction never deletes an event that a snapshot does not already cover, and never deletes an
  event whose `sourceRef` no longer exists — that one is now the only copy.

### 19.4 Projections

A projection is a pure fold over an ordered event stream with a declared version:

```ts
interface Projection<S> {
  name: string
  version: number                   // bumping it re-projects from the journal
  empty(): S
  fold(state: S, event: AgentisticsEvent): S
  finish(state: S): unknown
}
```

The first projections are the ones that must reach parity: `sessionMeta` (per
`(harness, conversationId)`), `runMetrics`, `agentMetrics`, `toolMetrics`, `costByDimension`,
`taskRollup`. `empty`/`fold`/`finish` is deliberately the same shape as `ClaudeParseState`,
`ActiveTimeState` and `AgentMetricsState` already have, so the existing tests carry over.

**The re-projection lever this product does not have today**: `projectionVersion` and
`adapterVersion` are both recorded; changing either marks the affected projections stale and they
rebuild from the journal. No file needs to be touched, no cache deleted.

## 20. Replay

Two modes, one output:

```
Live adapter   → events during execution
Replay adapter → events from artifacts
```

Replay is also the **import** path: a machine that installs Agentistics today has months of history
in its harness directories, and phase 3 replays it into the journal exactly as a live session would
have written it (`mode: 'replayed'`, the adapter version of the day it ran).

`docs`-level distinction the prompt asks for, stated once:

- **event replay** — re-fold the journal into projections (safe, routine);
- **state replay** — reconstruct a run's state at a point in time (safe, read-only);
- **visual replay** — render the conversation/terminal as it appeared (safe, from artifacts);
- **execution replay** — re-run the actions. **Out of scope** and deliberately unimplemented: the
  tool executions in this journal are shell commands, file writes and git operations.

## 21. Reconciliation

When a run has both live events and source artifacts, `reconcile(runId)` compares them per entity:

| Divergence | Detection | Resolution |
|---|---|---|
| missing event | an artifact record with no `eventId` match | ingest it as `mode: 'replayed'`, flag `backfilled` |
| duplicate | two events, one `providerRequestId` | keep the higher-precedence source, count the drop |
| divergent tokens | same invocation, different counters | keep both, surface the delta, prefer per §17.3 |
| divergent timestamps | > skew threshold | keep the source ordinal's order; record the skew |
| missing subagent | a transcript with no `agent.started` | ingest from the artifact; mark the run's agent list `partial` |
| missing tool | artifact-only tool call | ingest; a live channel that missed it is an adapter finding |

**Nothing is corrected silently.** A reconciliation writes its own events
(`recon.divergence.found`, `recon.backfilled`) so the history of the correction is itself auditable
— the discipline `rotate-identity.ts` already applies to a rotation's losses.

## 22. Provider architecture

> **Phase spec:** B1 (ProviderClient + Anthropic, no streaming) is specified in `2026-09-25-runtime-b1-provider.md`.

```
Provider            a billing entity            anthropic | openai | google | openrouter | litellm | ollama | custom
ProviderAccount     a credential's owner
ProviderConnection  account + endpoint + auth mode, per machine
Credential          a reference, NEVER a value in the journal
Model               a billable model id
ModelDeployment     where it runs               direct | vertex | bedrock | azure | openrouter-route | local
ModelRoute          how an invocation chose it  explicit | router | fallback
Usage               the four counters (+ reasoning, + cache TTL buckets)
Pricing             MODEL_PRICING + official + community, unchanged
```

- **`resolveProvider` already exists** for pricing headings; this promotes the same function to a
  first-class dimension, so "how much did I spend with Anthropic, across every harness" becomes a
  filter rather than a rebuild.
- **A provider is not a harness.** Codex and Copilot both run OpenAI models; agy runs Google's and
  Anthropic's; Kimi routes to whoever. The dimensions stay orthogonal.
- **Local models have no dollar cost.** Ollama reports `prompt_eval_count`/`eval_count` and no
  money; those runs carry `costUSD: undefined` with `costSource: undefined`, never a zero. Kimi's
  existing local-prefix rule (`isLocalModelId`, keep the prefix) is the precedent.

### 22.1 Direct provider mode (the primary path)

```
Native harness → ProviderClient → provider API
```

`ProviderClient` is one interface with per-provider implementations, and the **usage mapping is the
whole of its contract**:

| Provider | input | output | cache read | cache write | extra |
|---|---|---|---|---|---|
| Anthropic | `usage.input_tokens` (**already excludes cache**) | `usage.output_tokens` | `usage.cache_read_input_tokens` | `usage.cache_creation_input_tokens` (+ per-TTL buckets) | header **`request-id`** (verified 2026-09-20); **no reasoning field exists** |
| OpenAI | `usage.input_tokens` | `usage.output_tokens` | `input_tokens_details.cached_tokens` | — | `output_tokens_details.reasoning_tokens` **inside** output |
| Google | `promptTokenCount` | `candidatesTokenCount` | `cachedContentTokenCount` | — | `thoughtsTokenCount`, `toolUsePromptTokenCount` |
| OpenRouter | `usage.prompt_tokens` | `usage.completion_tokens` | cached in `usage` | — | **`usage.cost` in-band → `costSource: 'provider'`** |
| LiteLLM | proxied | proxied | proxied | proxied | `response_cost` in callbacks |
| Ollama | `prompt_eval_count` | `eval_count` | — | — | no cost, durations only |

**The recurring trap, recorded once, and it cuts BOTH ways** (verified per provider 2026-09-20,
`findings/12-provider-apis.md`): a sub-count inside a total must never be added on top — OpenAI's
and OpenRouter's reasoning tokens, agy's `1.4.9` inside `1.4.3` — **and an additive counter must
never be left out**: Google's `thoughtsTokenCount` is separately billed. One rule cannot cover both,
which is why §14.2 carries a `billing` discriminator rather than a number. The same defect in the
other direction cost this repo a 4,8× token error once already.

**Streaming differs in ways a shared reader must know**, all verified from the vendors' own pages:
Anthropic's `message_delta.usage` is **cumulative** — take the last one, never sum the chunks;
OpenAI and OpenRouter put final usage on a dedicated trailing chunk; and **OpenRouter reports a
mid-stream failure as HTTP 200 with an in-band `error` and `finish_reason: "error"`**, so a reader
that checks the status code alone records a failed call as a successful one. Tool arguments also
arrive differently: Anthropic streams partial JSON text that resolves to an object, OpenAI keeps
`arguments` a JSON string even outside streaming, and Google hands over an already-parsed object.

**Identity, resolved:** Anthropic's header is **`request-id`**, OpenAI's is `x-request-id`, and
**Google and Ollama document none at all** — a declared capability gap, so an invocation from those
carries no `providerRequestId` and is correlated by `(agentId, startedAt, model)`, marked inferred.

### 22.1.1 If the Vercel AI SDK is the transport — the four conditions

Verified 2026-09-20 by reading the SDK's own source at the published version (`ai@7.0.107`,
`@ai-sdk/provider@4.0.17`, provider contract `LanguageModelV4`) and by compiling it under Bun —
`findings/13-ai-sdk-fidelity.md`. Bundling is clean (112 modules, no dynamic `require`,
`bun build --compile` succeeds and runs), the licence is Apache-2.0, and the typed usage covers
Anthropic's cache read/write, OpenAI's reasoning and cached tokens, and Google's thoughts and
cached-content counts. **Three losses are real, and one of them under-reports money**, so depending
on the SDK is conditional on all four of these:

1. **Capture the RAW response per step, always.** Anthropic's per-TTL cache-creation breakdown
   (`ephemeral_5m` / `ephemeral_1h`) has no typed field — it survives only as untyped passthrough in
   the provider metadata, and the typed `cacheWrite` is the flat sum. A metrics product that wants
   the breakdown must read the raw.
2. **Read `providerMetadata.anthropic.iterations`, or under-report.** Anthropic's
   advisor/compaction iterations are deliberately excluded from the top-level totals. That is
   defensible for the SDK and wrong for us: those are **billed tokens absent from
   `usage.inputTokens`/`outputTokens`**. This is exactly the shape of defect this product has been
   burned by twice (the agent-metrics async cutover, the agy protobuf mapping): a number that looks
   right and is quietly short.
3. **Take usage PER STEP, never from the aggregate.** `addLanguageModelUsage()` — the multi-step
   tool-loop summation — **drops the `raw` field**; `result.usage.raw` is `undefined` on any
   multi-step call and only `result.steps[i].usage.raw` keeps it. Since one step is one billed
   response, per-step is also the right granularity for `ModelInvocation`.
4. **Own the retry.** The SDK retries twice by default, a successful retry is **invisible to the
   caller** (no hook), and there is no idempotency-key support anywhere in the tree. A hidden retry
   breaks "one billed response = one event" at its root. Set `maxRetries: 0` and implement retry in
   our own layer, where each attempt is its own event with its own request id.

Two behaviours to encode rather than discover: on abort, **completed steps keep real usage and the
in-flight step contributes none**; with zero completed steps the usage promise **rejects** rather
than resolving to zero — which must become `model.failed` carrying no usage, never a zeroed
invocation.

**Dependency risk, stated:** six major versions in about three years, each with real breaking
changes, and the cadence is shortening rather than lengthening. The provider contract versions far
more slowly than the package, which is what makes the bet survivable — but our own
`ProviderClient` interface must keep the SDK behind it, so a major bump is a contained migration
rather than a rewrite of the harness.

### 22.2 The optional gateway

```
Native harness → Agentistics Provider Gateway → provider
```

Captures provider, model, request/response ids, the four counters, latency, cost, errors, retries
and correlation ids — **and nothing else** (§12). It is opt-in, it is not required for any metric
the direct path already produces, and it never becomes the only source of a number: its events carry
`source.kind: 'gateway'` and reconcile against the invocation the runtime already recorded.

### 22.3 Credentials — the legal boundary

> "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and
> Enterprise subscription plans and is designed to support ordinary use of Claude Code and other
> native Anthropic applications… Developers building products or services that interact with
> Claude's capabilities, including those using the Agent SDK, should use API key authentication…
> Anthropic does not permit third-party developers to offer Claude.ai login into their own
> applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their
> users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or
> session tokens."
> — code.claude.com/docs/en/legal-and-compliance, fetched 2026-09-18

Therefore, as hard rules for the native harness:

1. **Never read, relay or reuse a harness's OAuth/subscription credential.** Not Claude's, and the
   same caution for any vendor whose terms say the same.
2. **API keys and legitimate provider integrations only**, entered by the user, stored with the
   `envelope-keys.ts` discipline (0600, never logged, never audited, never returned by an API).
3. **Observing Claude Code's own local output is unaffected** — that is what this product already
   does and is not authentication.
4. `billing-detect.ts`'s existing guard (a test greps the module for forbidden field names) extends
   to the provider layer: a module that may name a token must be unable to name it.

### 22.4 Three engines — and the only honest way to use a subscription

*Added 2026-09-25, from the owner's question "can I use another vendor's subscription through OUR
harness?".* The answer depends on the vendor, and there are two very different meanings of "use":

**(1) Delegating to the vendor's official CLI — always allowed, any vendor.** The native harness is
the master and hands a task to Claude Code, Codex, Gemini CLI or Copilot CLI (§24.7). The model call
is made by the official harness, logged in with the person's own subscription; we never touch the
credential, so rule 1 above is intact. The cost: inside a delegated task, that harness — not ours —
decides context and tools. We still measure it, through the adapters.

**(2) Logging the subscription into OUR loop — per vendor, verified 2026-09-25:**

| Vendor | Subscription inside our harness? | Basis |
|---|---|---|
| Anthropic (Pro/Max) | **Prohibited** | the terms quoted in §22.3; reported billing enforcement since April 2026 |
| Google (AI Pro/Ultra) | **Prohibited, with account suspension** | "Directly accessing the services powering Gemini CLI … using third-party software … may be grounds for suspension or termination of your account" — geminicli.com/docs/resources/tos-privacy |
| OpenAI (ChatGPT Plus/Pro) | **Appears open** — Cline and OpenClaw ship "Sign in with ChatGPT" | **no OpenAI text read yet**; must be confirmed from OpenAI's own terms before anything is built |
| GitHub Copilot | **By partnership only** — OpenCode has a "formal partnership" (github.blog changelog, 2026-01-16) | we would need our own |

**So the native harness has three engines, and the master picks per task:** an **API key** (any
provider; full control; paid per token), a **direct subscription** where the vendor permits it (full
control; flat cost), and **delegation to an official CLI** (any subscription; partial control; flat
cost). Where a vendor prohibits (2), delegation is the only door — and the consequence of ignoring
that is the person's account being suspended, not a theoretical risk.

## 23. Team mode and the central

The journal is **per machine**. What a member pushes stays what it pushes today — computed metrics,
under the same per-connection sharing rules (`share-rules.ts`), with the same redaction at both ends
— and phase 4 may add an *event delta* push behind its own flag. Two invariants:

- **The sharing rules bind the canonical events exactly as they bind sessions today.** A run in a
  withheld repository produces no event that crosses the wire, and the count of withheld items is
  reported rather than silently subtracted.
- **`rotate-identity.ts` gains any new collection keyed by a machine id.** That module's own comment
  records this as "the same bug three times already".

## 24. The native runtime

Nine contracts, each a module boundary with one purpose:

| Runtime | Owns | Emits |
|---|---|---|
| `SessionRuntime` | session/run lifecycle, resume, shared access | `session.*`, `run.*` |
| `AgentRuntime` | the agent loop, subagent delegation | `agent.*` |
| `ContextRuntime` | what is sent to the model, eviction, recall — designed in `2026-09-25-runtime-context-manager-design.md` | `context.*` |
| `ProviderRuntime` | provider clients, routing, retries, usage | `model.*` |
| `ToolRuntime` | tool registry, execution, results, MCP | `tool.*`, `mcp.*` |
| `BrowserRuntime` | browser sessions/tabs/actions | `browser.*` |
| `PolicyRuntime` | approvals, allowlists, sandboxing | `policy.*` |
| `EventRuntime` | the bus, the journal writer, subscriptions | — |
| `PersistenceRuntime` | sessions, messages, artifacts, snapshots | — |
| `SchedulerRuntime` | concurrency, queueing, backpressure | `run.queued`, `run.resumed` |

### 24.1 The agent loop

```
Session → Context → ModelInvocation → Response → (tool calls | delegation | answer)
   → Policy → Execution → Result → Context update → next invocation
```

Subagents are **the same loop** with a `parentAgentId`, their own context and their own budget. They
are not a special case, and their events are the same events — which is what makes "what did the
subagents cost" a projection rather than a per-harness reader.

### 24.2 Streaming

One stream shape for model deltas, tool progress, agent state, browser activity and ALM changes,
consumed identically by Web, CLI, TUI, VS Code and API. The existing terminal channel
(`terminal-hub.ts`: one loop per watched session, viewer-gated, shared across readers) is the
precedent for the fan-out rule: **cost is per watched entity, never per watcher.**

### 24.3 Shared session

A session belongs to the runtime, not to a surface. Opening it in the Web while the CLI holds it is
an additional *view*, not a second session; writes are serialised by the runtime (the FIFO
ack-per-keystroke model `input-channel.ts` already uses), and every surface sees the same event
stream. This is the capability that makes "CLI → Session #123 → Web → Session #123" true.

### 24.4 Resource-aware scheduling (from `execucao.md`)

`SchedulerRuntime` decides admission before a run starts: concurrency ceiling, memory headroom, CPU
pressure, per-session context budget, bounded event buffers, and backpressure on every stream. The
existing ceilings are the precedent and the starting values: `MAX_TERMINAL_STREAMS = 100`,
`MAX_INPUT_SOCKETS = 100`, `SHELL_CAP = 8`, `MAX_CONCURRENT_PUSHES = 2` with an adaptive batch.
**A ceiling, not a timer** — the `SHELL_CAP` rationale, applied to runs.

### 24.5 Memory rules, as acceptance criteria rather than aspirations

- Opening a session loads **metadata + a window**, never the whole history; older turns arrive on
  demand and the UI virtualises.
- Events are processed as streams (`for await`), never `getAllEvents()`.
- Attachments are **references** (`storageId`, mime, size, sha256) — never bytes inside a session
  object.
- **Full persistence ≠ full context**: a session may hold millions of events and send a bounded
  context to the model.
- Every cache is bounded (TTL and/or LRU), following `evictTranscriptStates`.

### 24.6 Memory — what the runtime remembers between sessions

Researched 2026-09-19; the full survey is
`PROMPTS NOVO CORE/findings/09-agent-memory-architecture.md`. Summary of what this specification
adopts.

**Three tiers, and the first one is not ours.**

| Tier | What it holds | Key | Lifetime |
|---|---|---|---|
| short | the conversation's own working context | — | **the harness's** for external harnesses; **ours** for native runs — `2026-09-25-runtime-context-manager-design.md` |
| medium | repository knowledge: decisions taken, conventions, what was tried and failed | `normalizeGitRemote()` | until retracted or superseded |
| long | how THIS person works: preferences, recurring corrections | account id | until deleted by them |

**The shape: structured facts, derived from the journal, with semantic retrieval as a later, opt-in
addition.** A fact is a row with a scope, a category, a statement, a confidence, the **event it came
from**, a created and a last-confirmed date, and a supersession pointer. It is written by (a) an
explicit "remember this", which is itself an event (`memory.noted`), or (b) a projection over events
that already exist for other reasons — ALM task outcomes, repeated tool failures with the same
signature, the session-profile baselines this product already computes. **No second write path that
can drift from the journal.** Semantic retrieval over transcript text is a separate, later layer,
allowed only where `archiveMode: 'full'` consent already exists, and it may never override a
structured fact — the same precedence rule pricing already uses (official beats community beats
built-in).

**Rules, adopted:**

1. **Inspectable and editable in full, at any time.** Memory may not be the one store in this
   product that is write-only from the user's side.
2. **Every fact carries provenance and a date.** A fact with neither is indistinguishable from a
   hallucination six months later — the discipline `MODEL_PRICING`, `task-rollup.ts` and
   `HARNESS_CAPABILITIES` already impose on every other number here.
3. **A fact learned in one repository never leaks into another, and the scope is enforced on the
   READ path.** "A rule enforced when you look and not when you act is not a rule" (`machine-fleet.ts`),
   applied to recall.
4. **Nothing is remembered from a session whose archive mode did not consent to retaining that
   content.** Deriving a fact from the words of an `archiveMode: 'off'` session is retaining those
   words by another name. Structural facts (outcomes, baselines) may still be derived under
   `consolidate`, because that data is already retained there today.
5. **Automatic writes are off unless switched on**; an explicit "remember this" is the one path that
   may default to available. A durable fact silently shaping every future session is at least as
   consequential as opening a shell, and this product gates that.
6. **Forgetting deletes.** A hide-toggle that leaves the row is the filtered-versus-pruned defect
   `selectLiveProposals` exists to avoid, applied to memory.
7. **A superseded fact is closed, not overwritten** — its validity ends at a timestamp, so "what did
   we believe on day X" stays answerable. Adopted from Zep/Graphiti's bi-temporal model, and free if
   memory is a projection.
8. **One occurrence never becomes a rule.** Promotion needs an explicit request or a repeated (≥2)
   observation; over-fitting on a single success is how an agent starts being confidently wrong.

**Placement in the roadmap: B6**, after sessions persist (B4). Memory before durable sessions has
nothing to derive from.

**All decisions are recorded in `2026-09-25-owner-decisions.md`** (D1–D16): memory consent switches
(D13), repository memory to centrals (D14), and semantic retrieval in v1 (D15).

### 24.7 Other harnesses as tools of the native loop — the master

*Added 2026-09-25, owner's direction.* The native harness is the **master**: besides its own tools and
subagents, it can hand a task to another harness — Claude Code, Codex, Gemini CLI, Copilot CLI, Kimi,
Antigravity — as a tool (`delegate:<harness>`). Three consequences:

- **One mechanism for everything the master commands.** A delegation is an execution like any other:
  it gets an index line, and its "raw content" is the delegate's own transcript, which the existing
  adapters already read (context manager spec §3). Its cost and tokens are measured through those
  adapters with the delegate's own `provenance`.
- **Economics.** A delegation runs on the person's subscription for that vendor, while the native
  loop's own calls are API-billed (§22.4). Routing heavy work to an already-paid harness is a lever
  the master may use, and the routing decision is recorded on the event, with its reason.
- **Self-sufficiency.** Delegation is a capability of the master, never a dependency of the core: the
  native runtime must work end to end with no other harness installed.

Transport: ACP where the harness speaks it, otherwise the spawn specs and screen reading the session
manager already uses (§18.4). It belongs to B3 (the tool) and B6 (delegation).

## 25. Browser runtime

`BrowserSession / BrowserTab / BrowserAction` (§13) is the contract; the implementation is pluggable
(`playwright` | `extension` | `remote`). Playwright is the default implementation (D12, decided
2026-09-25; the contract stays implementation-agnostic) —
Apache-2.0, already a devDependency here (used only by a GIF-recording script today), and it exposes
the events the model needs including an explicit `download`. The native harness and any external
harness that can report browser activity emit the *same* events; nothing about the model assumes
Playwright.

## 26. ALM in the execution cycle

`execucao.md` asks for a workflow the board cannot express today. The additions, specified here and
implemented in their own phase spec:

```
Task ─ acceptance criteria
     ─ Subtask ─ prepared Session (harness, model, prompt, context refs, attachments, constraints)
                   └─ DISPATCH → Run → events → evidence → validation → completion
```

- **`AcceptanceCriterion`** — id, text, state (`open|met|failed`), evidence refs. A task may not
  reach `done` with an open criterion (the same 422 shape as `blocked_needs_reason` /
  `done_needs_session`, which already bind the browser, the CLI and the MCP alike).
- **`PreparedSession` — mostly SHIPPED (2026-09-18), and this entry is now about the gap.**
  `Subtask.stagedSession` already stores prompt, harness, model, effort, cwd and attachments ahead
  of time, and firing it spawns and files automatically (§9). What it does **not** yet carry, and
  what this section still asks for: the **spec reference** the session implements, the **files it
  may and may not touch**, the **acceptance criteria copied from the task**, the **allowed tools**,
  and the **expected result**. Until those are fields, they live in the prompt — which works, and
  makes them invisible to any check. Dispatch **must not silently alter** anything prepared; a
  change after preparation mints a new version of the draft.
- **Model selection is recorded, and Opus requires an explicit approval**: `model`,
  `modelSelectionReason`, `approvalRequired`, `approvedBy`, `approvalAt`. This is a *record*, not an
  enforcement of who may spend — the gate is the person's.
- **Dispatch lifecycle** is its own field, not a widening of `TaskStatus`:
  `draft → ready → dispatched → running → validating → done | failed | cancelled`. The 7-state
  Kanban stays exactly as it is — it is a board vocabulary, and the two were never the same thing.
- **Evidence** is `Artifact` refs plus the existing `task-evidence.ts` commit/PR extraction, which
  already refuses to invent a link from a bare `#N`.
- **Nothing here changes the frontier rule**: an ALM event carries facts; it never carries an
  instruction to an agent.

### 26.1 The squad — a prepared fan-out with a name

A `PreparedSession` describes one session. Most real work is several at once, and today that shape
exists only as a mechanism (`agentop session batch`) with nothing to name, save or reuse. The
competitive scan (2026-09-19) found this is exactly what the orchestration products sell, under
names like *squads* and *recipes* — and it is the one idea from that scan worth taking, because the
substance already exists here and only the noun is missing.

```ts
interface Squad {                    // a reusable template
  id: Id
  name: string                       // "review + fix", "three opinions", "port a module"
  roles: Array<{
    label: string                    // 'reviewer' | 'implementer' | …
    harness: HarnessId               // including 'agentistics'
    model?: string; effort?: string
    promptTemplate: string           // with named slots the dispatch fills
    allowedTools?: string[]
    isolation?: 'worktree' | 'none'
  }>
  join?: 'none' | 'summarize' | 'pick-one'   // what happens to the results, stated up front
}
```

Rules, so this stays a product feature and not a second orchestrator:

- **A squad dispatches into the same `PreparedSession` + `Run` machinery.** It is a template that
  mints N prepared sessions under one task, not a parallel execution path.
- **One `Session` may hold the whole squad's Runs** — which is precisely what the `Run` entity was
  introduced for (§13.1): cost, tokens and time roll up per role and per squad without inventing a
  new grouping.
- **The join step is declared before dispatch**, never improvised afterwards; `none` is a legitimate
  and common answer.
- **Isolation is per role**: a role that writes files gets a worktree, which is this repo's own rule
  for concurrent work.
- A squad is **saved, versioned and diffable** — running "the same squad" next month must mean the
  same thing, or the comparison between two runs of it is meaningless.

## 27. Surfaces over one runtime

- **Web** becomes a client of the runtime API and the event stream; the Sessions workspace's chat and
  the Nay chat converge on one session object (§10's three mechanisms become one).
- **CLI/TUI** keep their current shape; `agentop` gains the runtime verbs and loses nothing.
- **VS Code** stays a pure client and needs no new rule — it already holds none.
- **API** is the contract in §28.
- **MCP** gains read tools over the *query* API instead of mining `/api/data`; the session verbs stay
  out of MCP for the reason already recorded (Bash's permission prompt is the consent gate for
  starting N billable assistants).

## 28. The runtime API

```
POST   /api/runtime/sessions                 create
GET    /api/runtime/sessions                 list (paged, filtered)
GET    /api/runtime/sessions/:id             detail (metadata; messages are a separate window read)
POST   /api/runtime/sessions/:id/messages    send
GET    /api/runtime/sessions/:id/messages    window read (cursor + limit)
GET    /api/runtime/sessions/:id/stream      SSE/WS canonical event stream
POST   /api/runtime/runs/:id/cancel          cancel
POST   /api/runtime/tools/:execId/approve    approve / reject
GET    /api/runtime/events                   journal read (cursor, filters)
GET    /api/runtime/metrics                  projection query (the replacement for mining /api/data)
POST   /api/runtime/tasks/:id/dispatch       ALM dispatch of a prepared session
```

Rules: every route is authenticated by default and registered in `capability-guard.ts`; every list is
paged with a cursor; no route returns a whole history; errors go through `safeError`; bodies on
unauthenticated routes go through `readJsonLimited`.

## 29. Plugins and extension points

Stable, versioned extension points: **harness integration**, **provider client**, **tool**,
**browser implementation**, **policy**, **storage backend**, **telemetry sink**. Everything else is
internal. A plugin declares the schema version it was built against; the runtime refuses one it
cannot satisfy rather than running it degraded. **Sandboxing is optional in v1** (D-T5): `setrlimit`
+ a capability probe + Docker as the opt-in sandbox; bubblewrap/Landlock via FFI later; native
Windows last. See `2026-09-25-owner-decisions.md`.

## 30. Security and retention

- Journal events may carry prompts, tool output and file content. **What is stored is a decision per
  category** (D5, decided 2026-09-25 — §50), and the default is: metadata and counters always; text bodies only for the
  native harness's own runs and only with the archive-style consent the product already has.
- `redactSecrets` runs at both ends of anything that leaves the machine, unchanged.
- Credentials never enter the journal, the audit log or any API response.
- Browser artifacts (screenshots, downloads) are references in a local store with the same
  exclusion rules `backup-plan.ts` already encodes per layer.
- The exposure profiles and the capability guard bind every new route; a `public` central keeps no
  host power and no ingestion endpoint.

---

# PART III — INTEGRATION, VERIFICATION, DELIVERY

## 31. Adding a new harness — the objective checklist

A harness is integrated when every line below is answered. An unanswered line is a declared
`unknown`, never an assumed `true`.

```
[ ] Identity            id, display name, colour, provider(s) it can drive
[ ] Capabilities        the §16 declaration, every entry with an exactness or a reason
[ ] Source discovery    where its artifacts live, env override, how a session is keyed
[ ] Replay adapter      artifacts → canonical events, cursor-based
[ ] Live channels       hook | otlp | acp | stream-json | file-tail — or a recorded "none"
[ ] Session mapping     what is a Run, what is a Conversation, can they be linked exactly
[ ] Agent mapping       main/subagent shape, or a declared absence
[ ] Tool mapping        names → canonicalTool, MCP server naming, approval signals
[ ] Model mapping       model id, prefix rules, deployment, provider resolution
[ ] Usage mapping       the four counters + which sub-counts are INSIDE which totals
[ ] Cost mapping        provider-stated / harness-stated / table-priced / unknown
[ ] Context gauge       gauge field + declared window, or absent
[ ] Time                TurnEvent + activeMinutesOf; measured duration preferred
[ ] Provenance          mode + confidence per event family
[ ] Fixtures            a real session per §42's coverage list
[ ] Golden tests        replay == live == expected canonical events
[ ] Parity              its rows in the §40 matrix are green or explained
[ ] Spawn spec          flags read from --help, never guessed (the existing rule)
[ ] Live detection      process names, script paths, fd patterns, id flags
[ ] Docs                this file, harness-contract.md, data-sources.md
```

The compiler enforces the `Record<HarnessId, …>` half; this checklist covers what the compiler
cannot see.

## 32. External harness execution modes

| Mode | What it means | Available today | Channels |
|---|---|---|---|
| **Spawn** | Agentistics starts the process | all six (`spawn-spec.ts`) | ACP / stream-json when the harness has one; otherwise tmux + file-tail |
| **Attach** | Agentistics takes over an existing tmux session it owns | all six | screen + file-tail |
| **Observe** | the user started it themselves | all six (`/proc`, attention rules) | hook / OTLP / file-tail only |
| **Instrument** | the harness pushes events to us | claude, gemini, copilot, codex, kimi (§18.2) | hook / OTLP |
| **Adopt** | a process nobody here started becomes a managed row | all six, with limits (below) | whatever the observed process already exposes |

**Adopt was missing from the first draft** and was found by issue triage (2026-09-20, issue #213):
the VS Code case is a session the editor started, which the product can see but does not own.
Adoption is the one mode that must never invent: the link is the harness's own record naming our
handle, or the process's own open file — never a guess from directory and time. A row that cannot be
linked stays **visible and unowned** rather than being filed under an invented identity; the rules
`session-adopt.ts` already encodes apply verbatim, and the failure it exists to prevent — a user
sitting in a session no verb can name — is exactly what a careless adoption produces.

**ACP is a spawn-mode transport.** Where a harness speaks it natively (gemini, copilot, kimi;
claude through a bridge — **UNVERIFIED** whether first-party), a spawned run may be driven over
JSON-RPC instead of tmux keystrokes, which removes screen-scraped approvals and dialog parsing for
those runs. It cannot serve Observe, which is most of the fleet, so it is additive and never the
strategy. Its per-harness usage caveats (§18.4) apply to any cost it reports.

## 33. Invariants

Asserted by tests over the journal and the projections:

1. `Σ agent.cost(children) ≤ agent.cost(parent subtree)` where the parent subtree includes the
   children — and the two are **equal** when every child is measured.
2. A run's `Σ ModelInvocation.usage` equals the run's projected token totals, per counter. Never a
   two-counter sum (`tokens.lint.test.ts`'s rule, applied to the journal).
3. `tool.completed` / `tool.failed` implies a prior `tool.requested` with the same id. The only
   sanctioned exception is an artifact-sourced backfill, which carries `mode: 'replayed'`.
4. `agent.ended` implies `agent.started`; `run.ended` implies `run.started`.
5. A `ModelInvocation` with a `providerRequestId` appears **once** per run, whatever the number of
   sources that reported it (`usage-dedupe.ts`'s `message.id` rule, generalised).
6. Duration never double-counts nesting: a subagent's wall time is inside its parent's span
   (`rollUpAntigravitySessions`'s rule, which deliberately does not sum `active_minutes`).
7. A gauge (`contextTokens`) is never summed; a counter is never treated as a gauge.
8. Every event carries a non-empty `adapterVersion` and a `confidence`.
9. A run with `conversationLink: 'none'` contributes **no** `SessionMeta` row and **no** confident
   zero to any per-conversation metric.
10. Ingesting the same source twice changes no projected number.

## 34. Test strategy

- **Pure-function unit tests** for every parser, projection, reconciliation rule and capability
  reading — the existing discipline (do not mock the filesystem; the functions are pure).
- **Golden fixtures** (§42): real sessions per harness, checked in with their expected canonical
  event stream and expected projection output.
- **Cross-path equality**: replay(fixture) ≡ live(recorded channel payloads) for the same session,
  event for event, modulo `recordedAt` and `provenance.mode`.
- **Parity tests** (§40): projection output vs today's `SessionMeta`, on a real machine's store,
  field by field, with a tolerance of zero for counters and an explicit explained delta otherwise.
- **Lint-style source tests**, the pattern this repo already uses (`tokens.lint.test.ts`,
  `events-frontier.test.ts`, `shell-isolation.test.ts`, `backup-plan.test.ts`): a gateway module may
  not import a tool/agent module; an adapter may not import a projection; an event type union may
  not gain an imperative field; every `Record<HarnessId, …>` stays total.
- **Property tests** for idempotency and ordering: shuffling ingestion order, replaying twice, and
  splitting a file into arbitrary chunks must all yield identical projections (the differential
  `transcript-cursor.ts` already runs over 484 real transcripts is the model).

## 35. Raw / normalized / derived, and historical coexistence

```
Raw artifact  →  Adapter  →  Canonical event (journal)  →  Projection  →  Derived metric  →  UI
   (kept)         (versioned)      (append-only)            (versioned)     (computed)
```

- **Raw provenance is preserved** by `sourceRef` — a journal row can always name what it was read
  from, even after that file is gone (at which point the event is the only copy, and §19.3 forbids
  compacting it away).
- **Legacy and new projections coexist** during migration: the legacy `SessionMeta` path keeps
  running, the projection writes to a shadow store, and a flag decides which one the API serves.
  Historical numbers are never silently reinterpreted — a changed reading appears as a new
  projection version, with the old one still answerable.

## 36. Data retention

| Class | Default | Rationale |
|---|---|---|
| canonical events (metadata + counters) | keep | the point of the journal |
| prompt/response text | **not stored** for external harnesses; stored for native runs under the existing archive consent | the harness already stores it; we do not duplicate it silently |
| tool output bodies | not stored; summaries only | shell output is the highest-risk content in the system |
| browser screenshots/downloads | artifact refs, local store, opt-in | size and sensitivity |
| snapshots | rebuildable, freely deletable | derived |

## 37. Dashboard compatibility

Every filter that exists today keeps working and keeps its semantics: harness, model, repository,
project, session, date, tag, member, machine, presence. Two dimensions are **added** —
**provider** and **run** — and one existing dimension becomes real rather than Claude-only:
**agent/subagent** (once every harness that has agents emits them).

The user must still be able to answer, unchanged:

> How much did I spend on Claude (the provider)? · on Claude Code (the harness)? · on Claude through
> Agentistics (the native harness)? · what did Codex cost? · what did this task cost? · what did the
> subagents cost? · which tools took the most time?

The last question is the one that is not answerable today and becomes answerable: `ToolExecution`
carries a start and an end.

## 38. Architectural boundary tests

Three boundaries are asserted over module source, because a comment does not hold:

1. **Gateway ⊅ harness telemetry** — the gateway module may not import or emit agent/tool/MCP/ALM
   events.
2. **Adapter ⊅ projection** — an adapter may not compute a metric.
3. **Journal ⊅ instruction** — the canonical event union may not carry a field named `action`,
   `command`, `instruction` or an imperative sentence, exactly as `events-frontier.test.ts` already
   guards the notification channel.

## 39. Compare

Comparisons survive and widen: harness vs harness, provider vs provider, model vs model, native vs
external, task vs task, repository vs repository, and **run vs run of the same task** (the one the
new model makes possible: two harnesses attempting the same delivery). Every comparison respects
capabilities — a metric one side cannot produce renders N/A on that side and is excluded from the
delta rather than counted as zero.

## 40. The parity matrix

Parity is the gate for every phase that changes where a number comes from. The matrix has one row
per (metric × harness) and is generated, not written by hand:

```
metric · harness · legacy value · projected value · delta · capability · exactness · status
```

`status ∈ { equal, explained, regression }`. **A phase may not ship with a `regression` row**, and an
`explained` row must name the reason in one sentence (e.g. "legacy filed the session on its start
day; the projection slices per UTC day, which is why the 'today' figure differs for sessions that
span midnight").

Rows that must be green before the legacy path is retired, per harness where the capability exists:
cost (api and plan basis), the four token counters and their total, sessions, rounds/messages,
active minutes, agents and subagent tokens/cost, tool counts by canonical name, MCP calls, git
commits/pushes, lines added/removed, files modified, languages, context gauge, compaction counts,
skill uses, repositories, projects, tags, task rollups, streak, hour-of-day buckets, daily slices.

**Known non-parity, by design, stated up front:** the per-UTC-day slice and hour buckets exist only
for Claude today (§5); a projection that computes them for every harness is *better*, and every
affected figure is an `explained` row rather than a silent improvement.

## 41. Cost model

Four distinct figures, never conflated:

| Figure | Source | When |
|---|---|---|
| **provider cost** | the provider's own response (`usage.cost`) or a gateway | exact, `costSource: 'provider'` |
| **harness cost** | the harness states it (Claude's `cost-state`) | exact, `costSource: 'harness'` |
| **estimated cost** | `calcCost()` × `MODEL_PRICING` | `costSource: 'table'` |
| **unknown** | no rate exists, or the plan is a subscription with no marginal price | `undefined`, rendered N/A |

- **Subscription harnesses**: where the marginal cost of a call is genuinely unavailable, the answer
  is `unknown` — never an invented per-request price. The plan basis (`billing.ts`) already
  re-expresses estimates against what the user pays and stays exactly as it is.
- **The measured figure finally has somewhere to live.** `RollupSession.costMeasured` exists today
  and is never set true; with `costSource` on the invocation, the rollup can say "12 of 14 sessions
  measured, 2 estimated" instead of implying one basis for all.
- Local models: no cost, ever, and the absence is visible.

### 41.1 Burn rate and rate-limit headroom — two metrics the journal makes possible

Everything this product measures today is **retrospective**: what a session, a day or a task has
already cost. Two forward-looking figures are asked for constantly and cannot be computed from the
current stores, because they need events with time on them:

- **Burn rate** — spend (or tokens) per unit of time over a live window, per harness, per provider,
  per task, with a projection to the end of the day or of the billing period. It is a rate over
  `model.completed` events, so it is a one-line projection once the journal exists and is
  impossible without it.
- **Rate-limit headroom** — how much of a provider's or plan's window is spent. Two honest sources
  and no third: the **harness states it** (Claude Code's statusline carries a `rate_limits` block
  with used percentage and reset time — **UNVERIFIED field names**, §54) or the **provider states it**
  in response headers on a native call. Where neither says, the figure is `unknown` and the surface
  says so; it is never inferred from our own counting, because our counting cannot see the calls
  made outside this machine.

Both obey the existing rules: a rate is `null` rather than `0` when the window holds no measured
event, the basis (API or plan) is stated beside it, and a projection is labelled a projection.

## 42. Golden fixtures

Per harness, checked in under `packages/server/server/adapters/__fixtures__/<harness>/`, each a real
(redacted) session plus its expected canonical events and projection:

```
[ ] a plain session: prompts, answers, a few tools
[ ] a session with subagents (where the harness has them) incl. a NESTED one
[ ] a session with a failed tool and a denied/approved permission
[ ] a session with an interrupted / never-answered call
[ ] a session with MCP tool calls
[ ] a session that compacted (claude)
[ ] a session that crashed without a clean end (the copilot shutdown case)
[ ] a resumed session (the same conversation across two runs)
[ ] a multi-model session (a cheap subagent under an expensive parent)
[ ] a session in a worktree (project_path ≠ current_cwd)
[ ] the live-channel payloads for the same session, when a live channel exists
```

Redaction is mechanical and checked: no absolute home paths, no credentials, no customer content.

## 43. Performance — budgets, not aspirations

Every budget below is an acceptance criterion with a benchmark test, and the numbers are taken from
measurements this repo already has rather than invented:

| Budget | Target | Basis |
|---|---|---|
| ingesting a live turn (hook → journal) | < 50 ms p95, never blocking the harness | the `Stop` hook's 5 s timeout is the ceiling; it runs every turn |
| journal append | amortised O(1), one row, no read-modify-write | SQLite WAL |
| projection of one run's event tail | incremental; never re-folds from zero while a snapshot exists | `transcript-cursor.ts`'s 21–44× |
| bytes read per poll per live transcript | bounded window, never the whole file | the 4.533 MB → 248 MB measurement |
| opening a session in the Web | metadata + one window; independent of total history | `MAX_TURNS = 400` today, made a real cursor |
| RAM per idle session held by the server | bounded; caches TTL+LRU | `evictTranscriptStates` |
| concurrent runs | admission-controlled, queued rather than refused | §24.4 |
| `/api/runtime/metrics` p95 | < 300 ms on a store of 100k sessions | new; must be measured, not assumed |

**The stated open regression**, carried forward from the existing code so it is not lost:
`getSessionFileStats` memoises on `(root, window, HEAD)` and a live session's window moves every
turn, so it misses every time — 15.327 ms on the measured machine, now the dominant cost of that
path. The journal makes it addressable (git facts become events emitted once per commit rather than
a query per rebuild); doing so is its own task.

## 44. Observability of Agentistics itself

Counters exported through the existing OTel surface and surfaced in the health panel: ingestion
latency, events accepted / deduped / rejected (by reason), adapter errors by adapter and version,
projection lag per projection, reconciliation divergences by class, journal size and write errors,
provider errors and retries, scheduler queue depth and rejections. **A dropped event is a counter,
never a log line nobody reads**, and a projection that is behind says so on the surface that reads it.

## 45. Versioning

Five versioned things, each independently:

```
CANONICAL_EVENT_SCHEMA   the event envelope
adapterVersion           per harness integration (on every event)
projectionVersion        per projection (bumping re-projects)
sourceFormatVersion      what we believe the harness's format to be, when it states one
providerSchemaVersion    per provider client's usage mapping
```

Rules: an old event is never rewritten; a reader tolerates every schema it has ever written; a
bumped `projectionVersion` triggers a rebuild rather than a silent reinterpretation; and the
`DATE_FIELDS` discipline extends to any new Mongo collection.

## 46. Migration — two tracks, one contract

**Revised 2026-09-19 after review.** The first draft put the native harness last, in one queue. That
is wrong for a reason the owner named: **a chat that talks to an API *is* the harness** — there is no
way to have the second without the first. So the work runs as two tracks that share exactly one
thing, the event contract from A1.

```
            A1  canonical types + journal (SQLite) + append/read     ← the only shared dependency
             │
   ┌─────────┴──────────────────────────────┐
   │ TRACK A — observability                │ TRACK B — runtime
   │                                        │
   A2  claude adapter emits in shadow       B1  ProviderClient + Anthropic, no streaming
   A3  the other five adapters + import     B2  streaming (deltas, tool calls)
   A4  projections + parity matrix + query  B3  tool loop + policy (the ToolRuntime)
   A5  live ingestion (hooks, OTLP)         B4  session + resume + persistence
                                            B4-CTX  the context manager (own spec, 2026-09-25)
                                            B5  the other providers
                                            B6  subagents · browser · MCP · ALM dispatch
                                            B7  the optional gateway
```

- **A1 is small**: pure types, one SQLite table, append + cursor read, an id derivation. Both tracks
  need it and neither can start without it.
- **Track B does NOT wait for parity.** It emits native events from its first turn, which is also
  the best test the canonical model can get: native telemetry is exact, so if the model cannot hold
  it, that is discovered in week one rather than after five phases of adapters.
- **Track A does NOT wait for the harness.** Every phase of it improves the product that exists
  today (durable metrics, history that survives a cleanup, tool durations, a query API).
- **The convergence point is B4 + A4**: once the runtime owns sessions and the projections serve
  metrics, the three chat mechanisms (§10) become one object and the Web/CLI/TUI share it.

Sequencing rule: **no phase of either track may ship with a `regression` row in the parity matrix**,
and at every point the legacy path can still serve the whole product on its own.

## 47. Feature flags

```
AGENTISTICS_JOURNAL=0|1                 write canonical events
AGENTISTICS_JOURNAL_ADAPTERS=claude,…   which adapters write them
AGENTISTICS_PROJECTIONS=0|1             serve projections instead of the legacy build
AGENTISTICS_PROJECTIONS_SURFACES=…      per surface rollout
AGENTISTICS_INGEST=0|1                  the collector endpoints exist at all
AGENTISTICS_INGEST_CHANNELS=hook,otlp   which channels are accepted
AGENTISTICS_RUNTIME=0|1                 the runtime API
AGENTISTICS_NATIVE_HARNESS=0|1          the native harness
AGENTISTICS_GATEWAY=0|1                 the provider gateway
```

Absent reads as **off** for every one of them (the `chat-gate.ts` reading, stated per switch as §4.7
requires): a machine must not start writing a journal, opening an ingestion port or spawning an
agent because it was upgraded.

## 48. Rollback

Each phase rolls back by turning its flag off, and nothing it wrote breaks the machine: the journal
is additive (a file that can be deleted), projections are derived (rebuildable), ingestion endpoints
are inert when disabled, and installed hooks are removed by the same idempotent uninstall that
installed them. **A phase whose rollback requires deleting user data may not ship.**

## 49. Native harness roadmap (Track B)

Each step is usable on its own, and each emits canonical events from the first turn.

| Step | What it delivers | The moment it becomes useful |
|---|---|---|
| **B1** | `ProviderClient` + Anthropic, request/response, API key from the user | the first cost figure in this product that comes **from the provider** rather than a table |
| **B2** | streaming of text and tool-call deltas | the chat is usable; one stream that Web, CLI, TUI and API all read |
| **B3** | the tool loop + `PolicyRuntime`: read, write, patch-edit, shell, search, git | the agent stops talking and starts **delivering**; tool durations exist for the first time |
| **B4** | session persistence, resume, shared access | a session belongs to the runtime, not to a tab — the convergence point with Track A |
| **B5** | OpenAI, Google, OpenRouter, LiteLLM, Ollama | provider becomes a real dimension; OpenRouter gives in-band cost |
| **B6** | subagents, browser, MCP, ALM dispatch, artifacts/evidence | fan-out, POC/preview, delegation to external harnesses, evidence closing a criterion |
| **B7** | the optional provider gateway | only if something needs it; the direct path already produces every number |

**The old gate is removed.** The first draft required the parity matrix to be green before B1, which
would have blocked the harness behind five phases of adapter work for no benefit: the native harness
does not read anybody's files, so it has nothing to be at parity *with*. What it must do instead:

- emit the **same** canonical events an adapter emits, asserted by the same golden-fixture tests;
- be covered by the same invariants (§33) — one billed response counted once, no double-counted
  nesting, a gauge never summed;
- carry provenance `native` / `exact`, which is the strongest reading in the model and must earn it.

**B3 is where the product identity is decided.** The tool contracts (partial reads, patch edits,
persistent shell, git as a first-class tool, structured results) are what separate an agent that
talks from an agent that ships — see §24 and the tool catalogue that feeds it.

---

# PART IV — DECISIONS, ROADMAP, ACCEPTANCE

## 50. Decisions — the owner's answers of 2026-09-25, with the trade-offs that were weighed

Every entry below was decided by the owner on 2026-09-25; the record is
`2026-09-25-owner-decisions.md`. The question and its trade-offs are kept as the history of the
decision, not as a pending item.

**D1 · Canonical vocabulary: what is a "Session"?**
**DECIDED 2026-09-25 by the owner:** a Session is the runtime's unit of work; a harness conversation is
a **Run** inside it. Legacy data projects 1 Session → 1 Run, so nothing on screen changes until somebody
groups two runs. *Reason:* it is the only option that delivers the brief's objective C — one session
continued across Web, CLI and TUI. *Cost accepted:* "session" means slightly more inside the canonical
model than on today's screens; the docs say so in one place. **Rejected:** (b) Session stays the
conversation with a new entity above it — inverts the brief's Session → Run hierarchy, and every later
document would have to re-explain it; (c) Task as the only grouping — gives up the shared
multi-surface session outright.

*(a) a Session is the runtime's work container and a harness conversation becomes a
Run* (§13). Legacy projects 1 Session → 1 Run, so nothing on screen changes until somebody groups
two harnesses under one Session. Cost: "session" means something slightly different inside the
canonical model than in the UI, and the docs must say so in one place.
*(b) Session stays the conversation* and a new entity sits above it. Less renaming, but the prompt's
own hierarchy (Session → Run) is inverted and every future document has to re-explain it.
*(c) Task is the only grouping* — no multi-harness session at all. Simplest; gives up "CLI and Web
in one shared session" as a first-class idea.

**D2 · Journal storage.**
**DECIDED 2026-09-25 by the owner:** **SQLite WAL, one journal per machine.** *Reason:* measured on
this machine (`docs/superpowers/research/15-sqlite-journal-measurement.md`): 1/2/4/8 concurrent writer
processes, zero loss, zero duplication, zero surfaced `SQLITE_BUSY`, 29k → 60k rows/s; idempotency is
structural (`UNIQUE(event_id)`). **Rejected:** (b) JSONL segments + index — idempotency would become
code instead of a constraint; (c) Mongo everywhere — forces a database on every solo install of a
local-first product.
The options were: (a) SQLite WAL per machine · (b) JSONL segments + index · (c) Mongo everywhere.
Trade-offs in §19.2.

**D3 · Native harness base.**
**DECIDED 2026-09-25 by the owner:** **our own runtime**, with the provider layer built on the Vercel AI
SDK (Apache-2.0) **behind our own interface**, under the four conditions of §22.1.1 (capture raw per
step, read Anthropic's `iterations`, usage per step, own the retry with `maxRetries: 0`). OpenCode (MIT)
is read as architectural reference only; **no code derived from the leaked Claude Code source, under
any option** (§54). *Reason:* the architecture — session, loop, tools, policy, journal, context
manager — is ours; the SDK is only the narrowest layer, the HTTP dialect of each provider, and it is
swappable. **Rejected:** (b) fork OpenCode — inherits their session and event model, which collides with
the canonical journal, and a fast-moving dependency; (c) everything from scratch including provider
clients — five clients to maintain for no telemetry gain.
*Also decided 2026-09-25 (API cost and the first provider):* B1 starts with **Anthropic only, on the
owner's own API key, with a spend limit set in the provider console**. Other providers arrive in B5,
once the usage model has been reconciled against one real bill. *Reason:* a subscription cannot be used
by our own loop for Anthropic (§22.3/§22.4); B1's own delivery is recording the exact cost of each
call, so the first thing it proves is that number.
The options were: (a) our own runtime with the provider layer built on the
Vercel AI SDK (Apache-2.0) behind our own interface; OpenCode (MIT) read as architectural reference
only · (b) embed/fork OpenCode — fastest first run, inherits their session/event model and a fast-
moving dependency · (c) everything from scratch including provider clients — maximum control of
telemetry, most code to keep. **Excluded from every option: any code derived from the leaked Claude
Code source** (§54).

*Raised in review, 2026-09-19:* "OpenCode does not have Claude Code's efficiency, features or
architecture — why not use the leaked source as the base?" The answer is not that OpenCode is as
good; it is that **access contaminates authorship**. In a copyright dispute what counts is access
plus substantial similarity, so an implementer who has read that source cannot later argue
independent creation for a structure that resembles it — and this product ships a public binary and
image. The substitute that gets the same requirements list legitimately is a **behavioural study**:
Anthropic's own published documentation (the hook catalogue, the OTel schema, the stream-json
protocol, the Agent SDK) plus measurement of the transcripts Claude Code writes on this machine,
which this product already parses. That study is commissioned as its own piece of work and feeds
B3's tool catalogue. What is lost by not reading the source is *their* implementation under *their*
constraints; what is kept is what actually matters — what the agent must be able to do.

**D4 · Live ingestion priority.**
**DECIDED 2026-09-25 by the owner:** **hooks + a local OTLP receiver, with file-tail as the floor.**
**Rejected:** (b) ACP first — spawn-only, and lossy for Gemini's usage today; (c) file-tail only — stays
post-hoc. *Note:* installing a hook into a harness's settings remains an explicit act of the user
(CLAUDE.md, "Anything agentop writes OUTSIDE its own directories").
The options were: (a) hooks + a local OTLP receiver (covers Claude,
Gemini, Codex, Copilot; Claude's `api_request` gives per-call tokens) · (b) ACP first (uniform, but
spawn-only and lossy for Gemini's usage today) · (c) file-tail only, made incremental (zero config,
stays post-hoc). Note that (a) and (c) compose: (c) is the floor under (a).

**D5 · What may the journal store of conversation text?**
**DECIDED 2026-09-25 by the owner:** metadata + tool summaries by default for external harnesses. For
NATIVE executions the full raw content is stored locally in the content store, under the
context-manager design's §8 rules (never to a central, not in a backup by default, never into memory
without consent, redacted only where it leaves scope, `sensitive` executions excluded from every exit).
**Rejected:** full text for external harnesses — the harness already stores it, and a copy doubles the
sensitive surface.
The options were: Metadata only / summaries / full text under
consent. Recommendation: **metadata + tool summaries by default for external harnesses**, because the
harness already stores it and duplicating it doubles the sensitive surface. **Amended 2026-09-25 by
the context-manager design:** the full raw content of NATIVE executions is stored locally in the
content store, because recall does not work without it — under that design's §8 rules (never to a
central, not in a backup by default, never into memory without consent, redacted only where it leaves
scope, `sensitive` executions excluded from every exit). What stays optional is where it may go, not
whether it exists.

**D6 · Retention default.**
**DECIDED 2026-09-25 by the owner:** **events are kept forever**, with a size budget and a stated
compaction rule. Raw native content follows the context manager's retention (lives while the session
can be resumed, then expires by age or disk budget; an expired part says so). **Rejected:** a default
window with opt-out — it would delete history nobody asked to delete.
The options were: Keep events forever (it is the durability promise) with a
size budget and a stated compaction rule, or a default window with an opt-out.

**D7 · Does the central receive events?**
**DECIDED 2026-09-25 by the owner:** **not in the first phases.** Members keep pushing computed metrics;
an event delta push is phase 4+, behind its own flag, under the same sharing rules. **Rejected:** an
early event push — every privacy rule would need a second implementation.
The recommendation was: **not in the first phases.** Members keep
pushing computed metrics; an event delta push is phase 4+ behind its own flag, under the same
sharing rules. Widening the wire early makes every privacy rule a second implementation.

**D8 · Gemini tokens/cost.**
**DECIDED 2026-09-25 by the owner:** declare the capability **`partial`** and keep the money, with the
reconciliation against a bill written down. **First step, before anything is flipped:** the master spec
says the code already reports `true` while CLAUDE.md says the flags were deliberately left off — read
the code and record which is true. **Rejected:** turning the figures off until a bill is reconciled.
The question was: The code says `true`, the docs say "not yet", and the parser fills them
only for one of two file shapes (§17.4). Decide: declare `partial` and keep the money (with the
reconciliation written down), or turn it off until a bill has been reconciled.

**D9 · Plugin sandboxing.**
**DECIDED 2026-09-25 by the owner:** define the contract now; ship the loader when there is demand.
**Rejected:** in-process plugins now (trusted only, no isolation) and a child-process loader now (a cost paid before any demand).
The options were: In-process (fast, trusted-only) vs child process (isolated, slower) vs
none until there is demand.

**D10 · Where does a shared Session live in team mode?**
**DECIDED 2026-09-25 by the owner:** **local-only.** **Rejected:** relayed through a central — a
central-hosted session is a security model this product has never had.
The options were: Local-only vs relayed through
a central. A central-hosted session is a different security model from anything this product has.

**D11 · Provider gateway: ship it at all?**
**DECIDED 2026-09-25 by the owner:** spec it, build it last — the direct path already produces every
number. **Rejected:** building the gateway early — it duplicates what the direct path already measures.
The question was: It is optional by design (§22.2). Recommendation: **spec
it, build it last** — the direct path already produces every number, and a gateway is most valuable
for non-native harnesses that would have to be pointed at it deliberately.

**D12 · Browser implementation.**
**DECIDED 2026-09-25 by the owner:** Playwright as the default; the contract stays
implementation-agnostic. **Rejected:** a browser extension or a remote browser service as the default — the extension ties the runtime to one browser and to the user's profile; the remote service sends pages off the machine.
The options were: Playwright, a browser extension, or a remote
browser service. The contract is implementation-agnostic either way.

**D13 · Where the memory-write consent switch lives.**
**DECIDED 2026-09-25 by the owner:** its **own** `preferences.memoryEnabled`, absent reads as off for
inferred writes. **Rejected:** a fourth `archiveMode` value — retaining raw chat and deriving a durable
fact are different questions and deserve different switches.
The options were: (a) its own
`preferences.memoryEnabled`, absent reads as off for inferred writes; retaining raw chat and
deriving a durable fact are different questions and deserve different switches · (b) a fourth value
of `archiveMode`, reusing one mental model the user already has.

**D14 · May repository memory reach a central?**
**DECIDED 2026-09-25 by the owner:** **no, for now** — memory stays on the machine until a need is
stated. **Rejected:** opt-in per repository — memory facts are freer text than task metadata, and
inheriting `Task.shared`'s rule without its own redaction decision is the lenient default by another
door.
The options were: (a) no, for now; memory stays on the
machine until there is a stated need · (b) opt-in per repository, with its own redaction decision —
memory facts are freer text than task metadata, so inheriting `Task.shared`'s rule without thinking
would be the lenient default by another door.

**D16 · How does a central see a machine's fleet in real time?**
**DECIDED 2026-09-25 by the owner (issue #215):** **keep the existing relay and add a push of state
transitions only** — a small, bounded widening, under the same consent switches and sharing rules.
**Rejected:** (b) waiting for D7's event push; (c) leaving it unanswered.
The question was: Found by issue triage (2026-09-20,
issue #215): the spec closes both doors it could have used — the notification channel is
deliberately not widened (§8), and pushing canonical events to a central is D7, deferred. So the
question has no answer today, and it is a real product request. Options: (a) keep the
existing relay (the member answers a fleet query over its reverse channel, under the same sharing
rules and consent switches) and give it a push for **state transitions only**, which is a small,
bounded widening rather than an event firehose · (b) resolve it as part of D7, which means the
central waits for the journal to travel · (c) leave it unanswered and say so on the screen. Whatever
is chosen, the machine still decides: consent and the sharing rules bind the relay exactly as they
bind everything else (§23).

**D15 · Does semantic retrieval belong in v1?**
**DECIDED 2026-09-25 by the owner:** **no.** Ship structured facts, measure what they answer, add
retrieval deliberately with the reconciliation written down. **Rejected:** retrieval from the start
behind `archiveMode: 'full'`.
The options were: (a) no: ship structured facts, measure
what they actually answer, and add retrieval deliberately, with the reconciliation written down —
the rule this product already applies to Gemini's token flags · (b) yes, gated behind
`archiveMode: 'full'` from the start.

## 51. Architectural decisions (ADR summary)

| # | Decision | Rationale | Status |
|---|---|---|---|
| A1 | A canonical event journal is the source of truth; `SessionMeta` becomes a projection | durability, re-projection, one model for native + external | proposed |
| A2 | `Run` is a first-class entity between Session and Agent | reopen/resume, multi-harness sessions, per-execution provenance | proposed |
| A3 | One billed response = one `ModelInvocation`, keyed by the provider's own id | generalises `usage-dedupe.ts`'s measured rule | proposed |
| A4 | Capabilities become states with reasons, not booleans | `partial` and `unknown` already exist in reality | proposed |
| A5 | Every event carries `adapterVersion` + `confidence` | the missing re-projection lever | proposed |
| A6 | Adapters emit events; projections compute metrics | removes order-dependent correctness | proposed |
| A7 | Live ingestion is additive; file replay is the floor | zero-config must keep working | proposed |
| A8 | The gateway owns provider telemetry only | no layer may claim what it cannot see | proposed |
| A9 | No subscription OAuth, ever; API keys and legitimate integrations only | Anthropic's terms, quoted in §22.3 | **binding** |
| A10 | No code derived from the Claude Code leak | copyright, active DMCA | **binding** |
| A11 | The ALM gains prepared sessions + dispatch + acceptance criteria, and `TaskStatus` is not widened | a board vocabulary and a dispatch lifecycle are different things | proposed |
| A12 | Phases ship behind flags, each with an independent rollback | no big-bang | proposed |

## 52. Phase specs

This master document is the reference; the executable documents are written one phase ahead of
implementation, each with its own tasks, tests and acceptance criteria. **Numbered per track since
the 2026-09-19 revision (§46)**, and the two tracks run concurrently after A1:

```
A1  Canonical model + journal + append/read          ← shared foundation, write this one first
                                                        (currently specced as P1, with the Claude
                                                        adapter attached; split A1 out of it)
Track A — observability            Track B — runtime
A2  Claude adapter in shadow       B1  ProviderClient + Anthropic (no streaming)
A3  Five adapters + import         B2  Streaming
A4  Projections + parity + query   B3  Tool loop + policy
A5  Live ingestion                 B4  Session + resume + shared access
                                   B5  The other providers
                                   B6  Subagents · browser · MCP · ALM dispatch · squads
                                   B7  The optional gateway
```

Already written: `…-runtime-p1-canonical-journal.md` (= A1 + A2), `…-p2-adapters-import.md` (= A3),
`…-p3-projections-parity.md` (= A4). **To write next: B1, and the split of A1 from A2** — A1 is the
dependency of both tracks and must be shippable without any adapter attached to it.

Each phase spec must state: what changes, why, where, which contracts move, what is migrated, how
compatibility is preserved, how it is tested, how parity is proven, what the performance budget is,
and how it rolls back — the checklist `execucao.md` §4 asks for.

## 53. Acceptance criteria for the architecture

The architecture is adequate only if all of the following hold.

**Compatibility** — every current harness keeps working; a seventh is added without changing the
core (the §31 checklist is sufficient); capabilities are explicit, with reasons.
**Parity** — every metric in §40 is `equal` or `explained`; no `regression` row; the legacy path can
still serve the whole product at any point during migration.
**Granularity** — Harness, Provider, Model, Session, Run, Agent, Subagent, Tool, Task, Repository and
Project are independently filterable wherever the source distinguishes them.
**Durability** — deleting a harness's local artifacts after ingestion destroys no ingested data, and
the product says which sessions are now journal-only.
**Provenance** — every metric on every surface can answer the §17.2 question set.
**Native parity** — the native harness emits the same canonical events as the adapters, and its runs
appear in every existing surface without a special case.
**One runtime** — Web, CLI, TUI, VS Code and API drive the same session through the same event
stream; there is exactly one agent loop.
**Providers** — the native harness can use Anthropic, OpenAI, Google, OpenRouter, LiteLLM and a local
model through one abstraction, with per-provider usage mapping tested against fixtures.
**Gateway** — optional, additive, never the sole source of a number.
**Performance** — every §43 budget has a benchmark and passes; no path reads a whole transcript per
poll; no surface loads a whole history to show a window.
**Safety** — no credential is ever stored, logged or relayed; the capability guard and the exposure
profiles bind every new route; sharing rules bind events exactly as they bind sessions.

## 54. Appendix A — external sources and verification status

All accessed 2026-09-18 unless stated.

**Verified against a primary source**
- Claude Code hooks reference — `code.claude.com/docs/en/hooks` (~32 events, payload fields per event).
- Claude Code OpenTelemetry — metrics and events incl. `claude_code.api_request`
  (`request_id`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`).
- Claude Code CLI flags — local `claude --help` (`--output-format stream-json`,
  `--include-partial-messages`, `--include-hook-events`, `--session-id`, `--json-schema`).
- Claude legal and compliance (the OAuth restriction quoted in §22.3) — `code.claude.com/docs/en/legal-and-compliance`.
- Gemini CLI hooks (11 events incl. `BeforeModel`/`AfterModel`) — `geminicli.com/docs/hooks/reference/`.
- Gemini CLI telemetry (metric names, `logPrompts` default true) — `geminicli.com/docs/cli/telemetry/`.
- Copilot CLI hooks (13 events) and ACP server — `docs.github.com/en/copilot/reference/…`.
- Codex configuration reference (`[otel]`, `notify`) — `learn.chatgpt.com/docs/config-file/config-reference`.
- OpenRouter usage accounting (`usage.cost` in-band) — `openrouter.ai/docs/docs/guides/usage-accounting`.
- OpenCode license (MIT) — `github.com/anomalyco/opencode/blob/dev/LICENSE`; Vercel AI SDK
  (Apache-2.0) — `github.com/vercel/ai/blob/main/LICENSE`.
- Local `--help` output for `codex`, `gemini`, `copilot`, `agy`, `kimi`, `opencode` on this machine.
- The Claude Code source exposure (31 Mar 2026, `@anthropic-ai/claude-code` 2.1.88, ~59.8 MB source
  map, ~512k lines) — corroborated across Medium / Layer5 / TechRadar / InfoQ; the deobfuscation
  repository carries **no license grant**, and DMCA enforcement against "openclaude" forks is
  reported (secondary source). **Binding consequence: A10.**

**UNVERIFIED — must be re-checked before anything depends on it**
- ~~Anthropic's request-id header name~~ — **RESOLVED 2026-09-20: it is `request-id`**, confirmed on
  `platform.claude.com/docs/en/api/errors`. OpenAI's is `x-request-id`; Google and Ollama document
  none.
- Several Google and OpenRouter reference pages did not render through fetch (JavaScript-heavy), so
  three questions stay open and are flagged per-item in `findings/12-provider-apis.md`: whether
  Google's `promptTokenCount` includes cached tokens, whether Google streams cumulative or
  final-only usage, and an apparent contradiction in OpenRouter's own docs about whether Google
  caching needs an explicit `cache_control` when routed through them.
- Claude Code statusline JSON field list (search-synthesised, not fetched directly).
- Codex `notify` payload schema (the config key is confirmed; the JSON shape is not).
- Kimi hook event names and payloads (existence confirmed via PR titles only).
- Antigravity's claimed 5-event hook system (contradicted by local `agy --help`; **do not build on it**).
- Whether Claude Code's ACP bridge is first-party.
- OpenCode's SSE event schema (architecture confirmed, payloads not).
- Playwright MCP's own LICENSE file (inferred from Playwright's Apache-2.0).

## 55. Appendix B — the metric inventory

The per-metric lineage (metric → source → parser → field → transformation → aggregation →
projection → surface → capability → filters) is the companion document
**`2026-09-19-agentistics-metrics-inventory.md`**, beside this one. It is the input to the parity
matrix in §40: every row there is a row here, and a metric that cannot be traced to a source is a
finding in its own right.

Four findings from that inventory are load-bearing for this specification and are recorded here so
they are not lost in a 441-line table:

1. **There is no `provider` filter dimension anywhere.** `Filters` (`packages/core/src/types.ts:794-808`)
   and `FiltersBar`'s dimension list (`FiltersBar.tsx:70`) carry ten dimensions and none of them is
   the provider; `resolveProvider` is used only to group rows in `ModelBreakdown.tsx` and
   `PricingSettings.tsx`. §37's "added dimension" is therefore genuinely new work, not a rename.
2. **`cacheBlindScope` is an inline expression, not an exported function** (`useData.ts:1505-1511`),
   although the repo's own memory reads as though it were a shared helper. Any projection that has
   to reproduce the cache-vs-session split must take it from one place, or it becomes the ninth copy.
3. **The OTel exporter's top-level gauges are silently Claude-only** — `otel-watcher.ts` sources them
   from `~/.claude/usage-data/session-meta`, so non-Claude git/tool/file activity never reaches the
   unlabelled series; only the per-harness token/cost series covers every harness. A canonical
   projection feeding OTel fixes this by construction, and the change must be announced, because
   somebody's dashboard is reading those series today.
4. **Two concrete defects in the MCP server**, found by reading rather than by a report: two tools
   invert the cache-authority rule and fall back to a `StatsCache.allTimeTotals` field that does not
   exist, and the `HARNESS_IDS` enum omits `kimi`, so that harness cannot be queried through MCP at
   all. Both are pre-existing and outside this specification's scope; they are listed here so they
   are fixed deliberately rather than absorbed into a migration.
