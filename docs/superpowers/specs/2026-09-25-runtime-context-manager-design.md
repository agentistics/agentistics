# The native context manager — an index the model can reopen, instead of a summary it has to trust

**Part of `2026-09-19-agentistics-runtime-master.md`** — it is the design of the `ContextRuntime`
(§24), which the master spec names in one line and leaves empty. Designed in a brainstorm with the
owner on 2026-09-25; every decision below was either taken by the owner or delegated to the
recommendation written next to it ("take the decisions according to your recommendation").

**Status:** design, approved. Not filed on the board yet — see §12 for where it sits in the roadmap.
**Scope:** the NATIVE harness only. External harnesses manage their own window; we observe them.

---

## 1. The problem, measured

Every model call re-sends the whole conversation. The model keeps nothing between calls — the
harness rebuilds the window each time and the provider reuses the unchanged PREFIX from its cache.
So every token that entered the window is **paid again on every step** (as a cache read) and
**competes for attention** until something takes it out. Today the only thing that takes anything
out is compaction, which replaces everything at once with a summary and no index — which is where
"the model forgot what it already did" comes from.

Measured on this machine, 2026-09-25:

| Finding | Number | Source |
|---|---|---|
| Tool traffic dominates the transcript | tool results **55,6 %** + tool inputs **36,2 %**; the model's prose 6,4 %, the person 1,7 % | 487 Claude Code sessions, last 30 days, ~36 M tokens |
| The same shape in a second vendor's harness | file reads 36 %, grep 7,5 %, commands 7,3 %; the model's response ~20 % | 61 Antigravity conversations, 18 MB |
| A long tail | results > 8 KB (~2k tokens) are **3,1 %** of results and carry **36 %** of result bytes | same 487 sessions |
| Inputs matter as much as outputs | shell scripts 60 % of input bytes, `Write` 15 % (whole files, avg 5,8 KB), `Edit` 13 % | same |
| Re-reading the same file is rare | exact re-reads = **2 %** of read bytes | same |
| One message is several calls, each re-sending everything | this design conversation: 214 calls, **114 M input tokens**, 97,5 % from cache, 304k output | this session's own `usage` |
| A third of the window is fixed baggage | the first call carried 147k tokens before any work | same |

Codex, Kimi, Copilot and Gemini samples on this machine were too small (1–2 MB, mostly harness
bookkeeping) to conclude anything, and are not used. The mix differs by harness — Claude Code's
weight is the shell, Antigravity's is file reading — so **nothing here may be tuned to one tool**.

Prior art, and what it tells us. Letta/MemGPT pages memory in and out with tools (2023). SWE-agent
masks old observations; OpenHands records each condensation as an event. Anthropic's API clears old
tool results server-side (`context-management-2025-06-27`, beta). *The Complexity Trap* (arXiv
2508.21433) found simple observation masking **matched LLM summarisation at 52 % lower cost** and
+2,6 % solve rate over an unmanaged context. What none of them does is the combination this design
adds: a deterministic index that reopens exactly the piece asked for, in layers, without duplicating
what is already in the window; eviction driven by real work boundaries (the plan, the ALM); one
mechanism for our loop, our subagents and the other harnesses we delegate to; and a per-call log
that makes the whole thing measurable rather than believed.

## 2. Principles

1. **Self-sufficient and provider-agnostic.** The manager behaves identically on every provider.
   No provider feature is used (not Anthropic's server-side clearing, not any vendor's memory tool)
   — other systems are precedent, never a dependency. It is also what keeps the metrics comparable
   across providers.
2. **An index, not a summary.** What leaves the window is replaced by a line built from FACTS plus
   the INTENT the acting model declared. No second model writes anything the window will trust.
3. **Leaving is reversible.** Because the index stays visible and `recall` exists, a wrong eviction
   costs one call, not the task. That is what lets the eviction rules be aggressive.
4. **Cache-aware.** The provider's cache is a prefix: editing anything invalidates everything after
   it. So edits happen in batches, at chosen moments, never one per step.
5. **Measured, not assumed.** Every call records what was in its window. Thresholds start as
   defaults and are tuned by experiment (§10).

## 3. The unit — one execution record

Three sources produce the same record: a tool result, a subagent's return, and a **delegation to
another harness** (the master uses Claude Code, Codex, … as tools — master spec §24.7). For a
delegation, the "raw content" is the delegate's own transcript, which the existing adapters already
read.

```ts
interface ExecutionRecord {
  id: string                    // '#41' — short, sequential per session, stable for its lifetime
  sessionId: string; runId: string
  stepId: string                // the work step it belongs to — drives eviction (§6)
  intent: string                // declared by the acting model; a REQUIRED field of every tool we ship
  tool: string                  // canonical tool name; 'delegate:<harness>' for a delegation
  target?: string               // command summary (commandSummary) or path
  outcome: {
    exit?: number
    error?: string              // first error-looking line, deterministic
    files?: string[]
    linesChanged?: [added: number, removed: number]
  }
  size: { bytes: number; tokens: number; lines: number }
  parts: { id: string; sha256: string; tokens: number }[]   // '#41.1', '#41.2', … fixed-size parts
  input?: { sha256: string; bytes: number }                 // the INPUT is offloaded too (§4.3)
  sensitive: boolean            // §8.4
  expiresAt?: string            // when the raw content expires (§8.2); the record itself does not
}
```

It is emitted as canonical events (`tool.executed`, `context.*`) into the A1 journal. The raw bytes
live in the content store (§8.1), never in the journal row.

## 4. Entering the window

### 4.1 Small or large

- **Small** (below the entry threshold — initial value **~2k tokens / ~8 KB**, the knee in the
  measurement): enters whole.
- **Large**: enters as a **preview**, built from facts with no model — size, line count, the first N
  and last N lines, the error-looking lines, and the outcome. The full content goes to parts on
  disk. This is what keeps a 50k-token log from ever entering at all.

### 4.2 The index line

Every execution, small or large, gets the same line:

```
run the billing suite → Bash · bun test · exit 1 · 3 failures · 12k tok · #41
^ intent (the model's)   ^ facts (measured by the ToolRuntime)            ^ handle
```

### 4.3 Inputs leave too

The input of a tool call (a `Write`'s whole file, a long script) is offloaded at eviction time like
a result: the window keeps `wrote src/x.ts (6 KB, sha 3fa2…)`. The file on disk or the content store
is the full record.

## 5. The index and recall

### 5.1 Where the index lives

**The index is not a separate block. It is the lines themselves, at the position where each
execution happened.** When an execution leaves the window its content is replaced by its line in
place; when a step closes, its lines are replaced by one group line. A table of contents at the top
would change on every step and invalidate the whole cached window each time; in-place replacement
only edits the history during the batches of §6. The model reads its history in order.

### 5.2 Layers

```
group     step 3 · migrate schema · 14 executions · touched billing.ts, schema.sql · 1 failure resolved → #g3
line      run the billing suite → Bash · bun test · exit 1 · 3 failures · 12k tok · #41
part      #41.2  (lines 400–799 of the output)
```

Each level shows just enough to decide whether to go one level down.

### 5.3 The two tools

```
recall('#g3')                      → the LINES of the group (not their content)
recall('#41')                      → the preview
recall('#41.2')                    → one part
recall('#41', { grep: 'ERR' })     → only matching lines
recall('#41', { lines: [200, 260] })
find({ target: 'billing.ts' })     → the index lines of everything that touched this target
```

`find` is a query over the journal's graph view (execution → target → step → task) — a projection,
not a graph database.

### 5.4 Rules

- **Every answer has a ceiling.** Beyond it, the answer ends with `N more lines — refine`. Never a
  giant block.
- **Nothing is sent twice, nothing is missing.** The runtime assembles the window, so it knows
  exactly which parts are present (the *residency set*). `recall('#41')` "whole" when `#41.1` and
  `#41.3` are already in the window returns only `#41.2`, plus `parts 1 and 3 are above`. If one of
  them was evicted in the meantime, it comes back. Deterministic, not heuristic.
- **What recall returns is an execution like any other** (`#57`) and obeys §6. Fetching back cannot
  snowball.

## 6. Leaving the window

### 6.1 Primary rule — work boundaries

Every record carries the step it belongs to. Three deterministic signals close a step:

- a plan item marked done;
- an ALM subtask closed;
- a subagent or a delegation returning (its internal executions never entered the parent's window —
  only its return and its line did).

At a boundary, everything the step executed becomes one group line: **one cache break, at the moment
the next step starts anyway.**

### 6.2 Safety net — inactivity, only under pressure

Only when the window passes its budget threshold: evict, in **one batch**, the parts not recalled or
cited in the last **K** calls, oldest first. A batch must free at least a minimum size, so each
cache break pays for itself. "Cited" is checkable: the `#id` or the target path appeared later in the
model's output or in a tool input.

### 6.3 What never leaves

- the objective, the brief and the decisions taken;
- the index itself (it is compacted into groups instead — §6.4);
- everything from the step in progress;
- whatever was recalled in the current turn;
- **the last result of an unresolved failure** — it stays until the same command runs again and
  exits 0.

### 6.4 The index compacts itself

By **step** (the boundary rule produces exactly that), with the facts of the step's targets inside
the group line. When the index itself passes its own budget, groups fold again: the steps of a closed
subtask become the subtask's line. Grouping by target was rejected (a step touching five files would
be scattered into five pieces with no order); grouping by time says nothing about content.

### 6.5 Rejected

- **A model writing summaries** (rejected by the owner): one extra call per execution — 65k tool
  results on this machine in 30 days — a "which model?" routing problem per provider, and above all
  **unverified text entering the window as fact**. The Complexity Trap result says it does not buy
  quality either. A model may later earn a place ONLY in grouping old lines, if measurement shows the
  deterministic grouping fails.
- **Re-injection chosen by the manager** each turn: can be wrong and breaks the cache every time.
- **The model releasing things explicitly** (`release(#41)`): models forget, the same way they would
  forget to search.
- **De-duplicating re-reads**: 2 % of read bytes. Not worth a mechanism.

## 7. What each provider allows us to rewrite

Some providers sign the model's reasoning, and editing earlier turns can invalidate a later
assistant's reasoning blocks (Anthropic's documentation says so for client-side edits on its newest
models). This is an API contract to respect, not a feature to depend on. So:

- Each provider adapter (`ProviderRuntime`, ours) declares an **edit policy**: which kinds of content
  may be replaced in place (tool results, tool inputs, reasoning blocks, assistant text).
- The context manager **never edits a kind its provider declares immutable.** For such a provider,
  those items leave only at a boundary through the edits it does allow, and the manifest (§9) says
  so.
- Each policy is **verified by measurement** (send an edited history, check it is accepted and the
  reasoning survives) and dated, the way `attention-rules.ts` records each harness's dialogs.
- Assistant prose is never rewritten; it is 6 % of the volume and it is the model's own reasoning
  trail.

## 8. Storage and privacy

### 8.1 Content store

Raw content lives in files **addressed by content**: `~/.agentistics/content/<sha[0:2]>/<sha256>`,
mode 0600. The journal holds references only (`sha256`, size, mime) — the rule master spec §24.5
already sets for every attachment, so there is one rule, not two. Identical content is stored once.

### 8.2 Retention

- The **record** (the event, the index line) is small and kept forever (D6).
- The **raw content** is heavy (~80 MB/month of results on this machine) and sensitive: it lives while
  the session can be resumed, then expires by age or by a disk budget, whichever comes first.
- An expired part is never silence: its line says `content expired on <date>`.

### 8.3 Nothing leaves the machine by default

- **Never to a central.** Members push computed metrics, never chat — unchanged.
- **Not in a backup by default.** `backup-plan.ts` gets an explicit rule for the content store with
  its reason; `backup-coverage.lint.test.ts` already makes an undecided path impossible. (The Copilot
  token found in the `raw` layer during this investigation is the reason this is stated, not assumed.)
- **Never becomes memory** without the D13/D14 consent.
- **The redactor runs only where content leaves scope** — an export, a display outside its own
  session. The model's window is never redacted: the model may legitimately need the value it just
  printed, and `redactSecrets` is deliberately a net for accidental pastes, not a guarantee.

### 8.4 The `sensitive` mark

Executions that are known to touch secrets — reading `.env`, `printenv`, credential paths — are
marked `sensitive` on their record. That excludes them from every exit path even if an exception is
opened later.

This amends the master spec's D5: full text of native executions IS stored locally, under the rules
above, rather than "only under the archive consent" — recall does not work without it. What stays
optional is where it may go.

## 9. Observability — the literal log, as a feature

Because we assemble every request, every model call can record exactly what it contained. That is
the "literal, deterministic log" the owner asked for while designing this, delivered as product:

- `context.manifest` per `ModelInvocation`: which blocks, lines and parts were in the window, tokens
  per category (fixed prefix, conversation, whole results, previews, index lines), and the provider's
  own usage (fresh / cache write / cache read / output).
- `context.evicted`, `context.grouped`, `context.recalled`, `context.expired` events.

## 10. Measurement is the acceptance criterion

Nobody can state how much context a model "needs" in general, and this design does not invent a
number. It makes the question answerable:

1. **Baseline first.** A fixed set of real tasks run with the manager OFF (plain window + the
   harness's compaction). Record solve rate, total input tokens, cache share, compactions.
2. **Pre-register the bar before tuning.** The acceptance thresholds are written into this document
   from the baseline, **before** the manager is tuned — so the bar cannot move to meet the result.
3. **Then vary** the entry threshold, K, the pressure threshold and the batch minimum, and report
   recalls per task and the cache effect alongside.

It ships only if it meets the pre-registered bar.

### 10.1 Starting values — placeholders for the measurement, not claims

| Parameter | Starting value | Why this one |
|---|---|---|
| entry threshold (whole vs preview) | 2k tokens | the knee measured in §1 (3,1 % of results carry 36 % of bytes) |
| part size | 2k tokens | same unit as the threshold, so one part ≈ one "small" result |
| preview | first 20 + last 20 lines + every error-looking line | enough to choose a selector without seeing the body |
| recall ceiling per answer | 2k tokens | a recall must never re-create the problem it answers |
| K (calls without citation) | 8 | ≈ two human turns at the measured 4–5 calls per turn |
| pressure threshold | 70 % of the window budget | leaves room for one large step before compaction would trigger |
| batch minimum | 5 % of the window budget | each cache break must free enough to pay for itself |

Every one of these is replaced by the §10 measurement; none of them may be cited as a finding.

## 11. Failure handling

| Failure | Behaviour |
|---|---|
| a part is missing or its sha256 does not match | `recall` says so in words (`content unavailable: …`), never empty |
| the content store cannot be written | **nothing is evicted whose content was not confirmed written**; the window keeps it, a health issue is raised |
| the journal is unwritable | the manager degrades to no eviction — the plain harness behaviour — plus a health issue; content is never lost to save space |
| a provider rejects an edited history | revert that call to the unedited history, disable that edit kind for the provider, record it |
| an unknown `#id` | said in words |

## 12. Dependencies and place in the roadmap

Needs A1 (journal, `Artifact`), B1/B2 (per-call usage), B3 (the tool catalogue — the `intent` field
must be in it from day one) and B4 (sessions and steps). It is a new phase **B4-CTX**, after B4 and
before B6 — memory (B6) derives from the same journal and must not need a second write path.

**Recorded as follow-up, out of scope here:** the fixed prefix (147k tokens before any work in the
measured session) — tool definitions and instructions loaded on demand rather than all at once.

## 13. Tests

- **The planner is pure**: given a window manifest, the rules and a trigger, what to evict/group —
  exhaustive table tests, including every "never leaves" rule.
- **Residency properties**: recalling "whole" after any sequence of partial recalls and evictions
  yields every part exactly once in the window; nothing is sent twice, nothing is missing.
- **Cache-aware batching**: no eviction outside a boundary or pressure; every batch frees at least the
  minimum.
- **Replay**: a recorded session run through the manager is deterministic — same input, same window.
- **Privacy**: the content store is excluded from backup (coverage lint), a `sensitive` record never
  reaches an exit path, the window is never redacted.
- **Edit policy**: a provider marked immutable for a kind never sees that kind rewritten.

Sources: [The Complexity Trap (arXiv 2508.21433)](https://arxiv.org/abs/2508.21433) ·
[JetBrains Research, efficient context management](https://blog.jetbrains.com/research/2025/12/efficient-context-management/) ·
[OpenHands condensation events (PR #7311)](https://github.com/OpenHands/OpenHands/pull/7311) ·
[Claude context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) ·
Letta/MemGPT in `docs/superpowers/research/09-agent-memory-architecture.md`.
