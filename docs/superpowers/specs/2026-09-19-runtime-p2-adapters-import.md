# P2 — The other five harnesses in shadow, and the historical import

**Phase 2 of `2026-09-19-agentistics-runtime-master.md` (§46).** Depends on P1 shipping with its
acceptance criteria met.

**Flags:** `AGENTISTICS_JOURNAL` (from P1) plus `AGENTISTICS_JOURNAL_ADAPTERS=claude,codex,…` —
absent reads as `claude` only, so an upgrade changes nothing for a machine already running P1.

---

## 1. What P2 delivers

1. A **replay integration per harness** — codex, gemini, copilot, kimi, antigravity — each emitting
   the same canonical events the Claude one emits, from the files it already parses.
2. An honest **capability declaration per harness** (`supported` / `partial` / `not_supported` /
   `unknown`, each with a reason), replacing the boolean read for canonical purposes.
3. A **historical import** (`agentop journal import`): the machine's existing artifacts and
   consolidate store, replayed into the journal as `mode: 'replayed'`, resumable and idempotent.
4. The **per-harness differential**: the P1 comparison run for every harness, producing the first
   full parity table.

Still no surface reads the journal. Still no live ingestion.

## 2. Per-harness work, and the trap each one carries

Each integration is written against the findings already recorded in this repo, and each has one
failure mode that a generic implementation would walk into:

| Harness | Events it can emit | The trap |
|---|---|---|
| **codex** | run, agent(main), model.completed, tool.* | usage is **cumulative, last-wins**; an event per `token_count` line would sum a running total. Emit **one** `model.completed` per turn with the *delta*, and mark `confidence: 'exact'` — a deterministic difference of exact cumulative counters (D17: no `derived`; it would be `estimated` only if the rule introduced an estimate). The harness does not state per-call usage, so the delta is per turn. |
| **gemini** | run, agent(main), model.completed (rich-JSON only), tool.* | **two file shapes**; the append-journal one carries no tokens at all. Tokens are `partial` and the shape is recorded per run, or a session silently reports zero. Its id stays the synthetic path id. |
| **copilot** | run, agent(main), model.completed (at shutdown), tool.*, mcp.* | tokens/lines exist **only at `session.shutdown`**. A crashed session emits `run.ended` with `status: 'failed'` and **no** invocation — never a zero-token invocation. |
| **kimi** | run, agent(main + one per agent id), model.completed, tool.* | the same usage appears twice (`usage.record` and the nested `step.end`); only the first family is read. Per-agent events are now possible where the legacy `SessionMeta` had none — that is an **improvement**, so the differential must expect it. |
| **antigravity** | run, agent(main), model.completed (per `gen_metadata` row), tool.*, error | `1.4.3` already contains `1.4.9`; `1.4.1` is a constant; `1.9.10.1` is a gauge. A child conversation becomes a **child `Agent` under the parent's run**, not a second run — which is what the legacy rollup was approximating. |

Every one of those rules already exists in the current parsers; P2 moves them, it does not rewrite
them, and the existing parser tests stay the guard.

## 3. Capability declarations to be written (and argued for) in P2

- `partial` is used where the code is already partial: gemini tokens/cost/model/tools (rich-JSON
  shape only), copilot tokens/gitLines (shutdown only), kimi agents (folded, no per-invocation
  breakdown in the legacy shape), antigravity gitLines (edit deltas, not `git diff`).
- `unknown` is used where nobody has measured, and says so.
- **The `daily`/hour-slice gap is declared** for the first time: per-UTC-day slicing exists only for
  Claude today. In the canonical model it comes free from event timestamps, so every harness gains
  it — an `explained` parity row, not a silent improvement (master spec §40).

## 4. The historical import

```
agentop journal import [--harness <id>…] [--from <date>] [--dry-run]
```

- Reads the harness's artifacts first and the consolidate store second: the store holds *computed*
  sessions, so it can only produce a coarse `run`+totals event set for conversations whose artifacts
  are already gone — `confidence: 'exact'` for the counters the store holds (a deterministic
  derivation of exact inputs) and `'estimated'` for anything priced from a table (D17: there is no
  `derived`). That is the honest
  floor and it is what makes months of history survive in the journal at all.
- **Resumable**: a cursor per source file; interrupting and re-running changes nothing
  (`UNIQUE(event_id)` plus the same derivation).
- **Bounded**: a batch size and a concurrency ceiling, reported live; the import is the one
  operation in this product that touches every transcript on the machine, and it must be
  interruptible at any moment.
- **Reports what it could not read** — a corrupt transcript, a locked SQLite file, a conversation
  with no timestamps — by count and by reason, never as silence.

## 5. Tests

- Golden fixtures per harness (master spec §42's coverage list), each with its expected event stream.
- The P1 property tests, re-run per harness: chunk independence, idempotency, order independence.
- **Differential per harness**: projected `SessionMeta` vs legacy `SessionMeta` on this machine's
  real store, field by field, with a generated report.
- **Import idempotency**: importing twice yields identical projections and zero net new rows.

## 6. Performance

| Budget | Target |
|---|---|
| import throughput | ≥ 20 MB/s of transcript on this machine, single pass, bounded memory |
| import memory | flat — no accumulation across files |
| shadow ingestion with all six adapters | ≤ 15 % added to a full build (the P1 budget, widened once for five more harnesses, and measured) |
| journal growth after a full import | measured and reported; it is the number §36's retention policy is decided against |

## 7. Rollback

Per-harness: remove it from `AGENTISTICS_JOURNAL_ADAPTERS`. Wholesale: the P1 rollback. An import
that went wrong is undone by deleting the journal and re-importing — which is safe precisely because
nothing reads it yet.

## 8. Acceptance criteria

1. Every harness has a replay integration or a declared, reasoned absence.
2. Every capability entry is `supported`/`partial`/`not_supported`/`unknown` with a reason, and the
   set of `false` entries in the old boolean table maps exactly onto the new one.
3. The differential passes for every harness: equal, or explained in one sentence.
4. `journal import` is resumable, idempotent and reports its failures by reason.
5. The budgets in §6 are met and measured.
6. No surface, API, wire or store has changed shape.

## 9. As built (A3, 2026-09-27)

Wave 1 delivered a replay integration and a per-session parity differential for all six harnesses,
run against this machine's real store (`AGENTISTICS_DIR` isolated, read-only).

### Parity table

| harness | adapter version | sessions | bug rows | explained rows (proven per session) |
|---|---|---|---|---|
| claude | 1.5.0 | 494 (2 live skipped) | 0 | (the P1 set) |
| codex | 1.0.0 | 19 | 0 | `duration_minutes` rounding (19); model/`costUSD` on usage-less sessions (5); `user_interruptions` — legacy hard-codes 0 (5); `daily` new (14) |
| gemini | 1.0.0 | 22 | 0 | duration rounding (12); `tool_errors` — a genuine toolCall error (1); `daily` new (12); the turn family is not-projectable (no turn events in adapter 1.0.0) |
| copilot | 1.0.0 | 13 (18 directories with no `events.jsonl`, skipped exactly as legacy does) | 0 | model/`costUSD` on a named-but-never-billed model (3); `tool_errors` from a `session.error` with no tool call (4); duration rounding (13); `daily` new (6); the turn family is not-projectable |
| kimi | 1.0.0 | 14 (2 with zero prompts, dropped exactly as legacy does) | 0 | `daily` new (5); the turn family is not-projectable (`turn.prompt`/`turn.ended` exist but are deferred — legacy `active_minutes` uses a dense per-line reconstruction, unverified against `activeMinutesOf()`) |
| antigravity | 1.0.0 | 57 (0 one-sided) | 0 | `childRollup` (1: legacy folds the child into the parent, the replay makes it a child Agent); `childAgentNew` agentMetrics (1); duration rounding (35); `daily` new (48); `user_interruptions` not-projectable (legacy hard-codes 0, 15) |

Every row not listed above under "explained" reads `equal` — no tolerance anywhere. Zero `bug`
rows on this machine's store, across all six harnesses.

### Capability refinements actually made (`packages/core/src/canonical/capabilities.ts`)

- `codex.tokens` -> `partial`/`exact` — three of four counters; the cache-write counter is not read.
- `codex.cost` -> `partial`/`estimated` — priced from the table over those three counters.
- `gemini.tokens` -> `partial`/`exact` — rich-JSON chat shape only; the append-journal shape's
  per-record tokens are deliberately not read (see the owner finding below).
- `gemini.cost` -> `partial`/`estimated` — same shape restriction, priced from the table.
- `gemini.model` -> `partial`/`exact` — rich-JSON chat shape only.
- `gemini.tools` -> `partial`/`exact` — rich-JSON chat shape only.
- `copilot.tokens` -> `partial`/`exact` — one cumulative report at `session.shutdown` only; a
  crashed session has none (absent, never zero).
- `copilot.cost` -> `partial`/`estimated` — priced from the table over the shutdown-only totals.
- `copilot.gitLines` -> `partial`/`exact` — one aggregate for the whole session at shutdown, no
  per-call attribution.
- `kimi.agents` -> `partial`/`exact` (**pinned upgrade from legacy `false`**) — the replay emits
  one Agent per agent id with its own usage; legacy still folds every agent into one session total.
- `antigravity.agents` -> `partial`/`exact` (**pinned upgrade from legacy `false`**) — an
  `invoke_subagent` child becomes a child Agent under the parent's run, linked to its launch only
  by `INVOKE_SUBAGENT` content, with no duration or agent type.
- `antigravity.gitLines` -> `partial`/`exact` (**pinned upgrade from legacy `false`**) —
  request-time line counts from edit payloads, not `git diff`.

### Owner findings (decisions, not fixes)

- `CLAUDE.md`'s Antigravity paragraph said children are "never rolled up into the parent" — this
  was stale (legacy `rollUpAntigravitySessions` / `mergeAntigravityChild` DO fold the child into the
  parent); the paragraph has been rewritten as part of this task.
- Gemini's append-journal records carry `tokens{…}` per record that are deliberately not read —
  turning them on changes money on every cost surface and needs its own reconciliation; left to the
  owner, unchanged by P2.
- Kimi's legacy `isToolError` checks `ev.isError` etc., but real errors set the nested
  `ev.result.isError` — a legacy parser bug (measured: 21 nested error flags, 0 detected). Fixing it
  changes the parser and the replay together, and is left open rather than silently patched inside
  the replay alone.
- Codex's `token_usage_record` (per response) and `item_completed` records are ignored because
  legacy ignores them; 5 of 19 codex sessions have zero `user_message` records.
