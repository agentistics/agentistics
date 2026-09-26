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
