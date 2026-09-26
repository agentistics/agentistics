# P1 — Canonical model, event journal, and the Claude adapter in shadow

**Phase 1 of the roadmap in `2026-09-19-agentistics-runtime-master.md` (§46).** Read that document
first; this one only says what P1 builds, how it is proven and how it is undone.

> **Revision note, 2026-09-19.** §46 now runs two concurrent tracks, and this document covers
> **A1 (the shared foundation: canonical types + journal) plus A2 (the Claude adapter in shadow)**.
> A1 is the dependency of the runtime track as well, so it must be shippable **without any adapter
> attached** — §1 items 1-3 are A1, items 4-6 are A2, and they are separate deliverables even
> though one spec describes both.

**Status:** specification, ready for an implementation plan.
**Flag:** `AGENTISTICS_JOURNAL` — absent reads as **off**.
**Ships nothing to a user's screen.** P1 is measurable from tests and from `agentop` verbs only.

---

## 1. What P1 delivers

1. The canonical **types** (`Session`, `Run`, `Agent`, `ModelInvocation`, `ToolExecution`,
   `Artifact`) and the **event envelope**, as pure modules in `@agentistics/core`.
2. The **capability declaration** (`CapabilityState`) beside today's booleans, with a mechanical
   migration and no behaviour change.
3. A **durable event journal** (SQLite WAL) with append, cursor read, structural idempotency and
   counters.
4. The **Claude integration's replay path**: its existing resumable transcript walk also emits
   canonical events.
5. A **shadow writer**: while the flag is on, `buildApiResponse` additionally feeds the journal. The
   legacy path is untouched and keeps serving every surface.
6. An **offline projection + differential**: a projection that rebuilds `SessionMeta` from the
   journal, compared field by field against the legacy `SessionMeta` for every fixture and for a
   real machine's store. This is the first, still-offline, row of the parity matrix.

**Explicitly not in P1:** no surface reads the journal; no other harness emits; no live ingestion;
no provider code; no ALM change; no wire change to a central.

## 2. Why this order

The journal is the only piece every later phase needs, and the Claude adapter is the one with the
richest data and the only existing per-agent/per-invocation detail — so it is the adapter that can
falsify the model. Building a second adapter first would mean discovering the model's gaps twice.

## 3. Where the code goes

```
packages/core/src/canonical/
  entities.ts        PURE — the entity types (§13 of the master spec)
  event.ts           PURE — AgentisticsEvent<T>, the EventType union, EventData per type
  event-id.ts        PURE — deriveEventId(), the deterministic identity
  capabilities.ts    PURE — CapabilityState, fromLegacyCapabilities(), capabilityReason()
  projection.ts      PURE — the Projection<S> contract (empty/fold/finish + version)

packages/server/server/journal/
  schema.ts          the DDL + open/migrate (bun:sqlite, WAL)
  journal.ts         IO — append(events), readFrom(cursor, limit), stats()
  journal-plan.ts    PURE — what an append does with a duplicate, a too-old schema, a bad row
  shadow.ts          IO — the buildApiResponse hook, flag-gated, failure-isolated

packages/server/server/integrations/
  types.ts           HarnessIntegration + INTEGRATIONS: Record<HarnessId, HarnessIntegration>
  claude/replay.ts   PURE fold: Claude transcript entries → canonical events
  claude/index.ts    IO — discovery + cursor, reusing transcript-cursor/transcript-state

packages/server/server/projections/
  session-meta.ts    PURE — events → SessionMeta (the legacy shape), version 1
  differential.ts    IO — legacy vs projected, field by field, for the parity report
```

Nothing under `packages/web` or `packages/tui` changes in P1.

## 4. Contracts created

### 4.1 `deriveEventId` — identity, not a random id

```ts
deriveEventId(input: {
  sourceKind: string; sourceId: string; sourceRef: string; type: EventType; ordinal?: number
}): string   // sha256 hex, truncated to 32 chars
```

Rules, each of which makes replay converge with live ingestion instead of doubling it:

- `sourceRef` must identify the **record**, not the file: `claude:<conversationId>:<lineNo>` for a
  transcript line, `claude:<conversationId>:<messageId>` for a model invocation.
- A **`ModelInvocation` is keyed on the provider's own id** wherever one exists
  (`message.id` for Claude), so the same billed response read from a transcript, a hook and a
  gateway is one event with one id. This is `usage-dedupe.ts`'s measured rule, generalised.
- `ordinal` disambiguates two events of the same type legitimately produced by one source record.
- The function is pure, total and tested against a table of real record shapes.

### 4.2 The journal

```ts
interface Journal {
  append(events: readonly AgentisticsEvent[]): Promise<AppendResult>
  readFrom(cursor: number, limit: number): Promise<{ events: AgentisticsEvent[]; cursor: number }>
  stats(): Promise<{ rows: number; bytes: number; firstAt?: string; lastAt?: string }>
  close(): void
}
interface AppendResult { written: number; duplicates: number; rejected: Rejection[] }
```

- **Idempotency is structural** — `UNIQUE(event_id)` plus `INSERT OR IGNORE`; `duplicates` is
  counted and exported, never silent (§44 of the master spec).
- **A rejected row is named** (`schema-too-new`, `missing-adapter-version`, `bad-timestamp`,
  `unknown-type`) and never dropped silently; a rejection is a bug in the producer and must be
  visible as one.
- **The cursor is the `rowid`.** Reads are pages; no method returns "everything".
- **A journal that cannot be opened degrades to a no-op** with a counter and a health issue, exactly
  as `parse-cache.ts` already does: the cost is the feature, never a failed build.

### 4.3 The integration registry

`INTEGRATIONS: Record<HarnessId, HarnessIntegration>` — total, so the compiler fails when a harness
is missing. P1 fills `claude` and leaves the other five as `{ id, version, capabilities }` with no
`replay` and no `live` yet; a missing `replay` is a declared absence, not a crash.

## 5. What P1 changes in existing code

| File | Change | Risk |
|---|---|---|
| `data.ts` | one call to `shadow.ingest(...)` after sessions are built, inside a `try` that can only log | a throw here must never break a build — asserted by a test that injects a failing journal |
| `types.ts` (core) | `HARNESS_CAPABILITIES` gains a derived `CAPABILITY_STATES` beside it; the boolean table is untouched | none — nothing reads the new table in P1 |
| `jsonl.ts` | no behaviour change; its fold gains an **optional** event sink | a sink that throws must not affect parsing — same test shape |

There is deliberately **no change** to the consolidate store, the wire, the API or any surface.

## 6. Data and migration

- P1 writes a new file (`~/.agentistics/journal.db`) and reads nothing new.
- No existing store is read differently, rewritten or migrated.
- Backfill of history is **P2**; P1's shadow writer only covers what `buildApiResponse` reads while
  the flag is on.
- `backup-plan.ts` gains one row for the journal with its reason (`metrics` layer, included), so a
  backup taken during P1 carries it rather than silently omitting it.

## 7. Compatibility

- Flag off: not one byte differs from today.
- Flag on: one additional SQLite file and a bounded amount of extra work per build (§9).
- No surface, no API, no wire, no Mongo collection and no MCP tool changes shape.

## 8. Tests

**Pure (unit)**
- `deriveEventId`: stability across runs, distinctness across record shapes, and the
  same-id-from-three-sources property for a model invocation.
- The event union: every event type has a `data` type, and a lint-style source test fails if a field
  named `action` / `command` / `instruction` appears (§38 of the master spec).
- `journal-plan`: duplicates, rejections and schema comparison.
- `claude/replay.ts`: transcript entries → events, over checked-in fixtures.
- `projections/session-meta.ts`: events → `SessionMeta`, over the same fixtures.
- `capabilities.ts`: the boolean migration is exactly the old table, entry for entry.

**Property**
- **Chunk independence:** folding a fixture split into N arbitrary chunks yields the same events as
  folding it whole (the differential `transcript-cursor.ts` already runs, applied to events).
- **Idempotency:** appending the same event stream twice leaves the projection identical.
- **Order independence where it must hold:** shuffling the ingestion order of events that carry
  distinct source ordinals yields the same projection.

**Differential (the offline parity row)**
- For every fixture and for a real machine's Claude store: `projected(SessionMeta)` vs
  `legacy(SessionMeta)`, field by field.
- Counters must be **equal**, not close. Any difference is either a bug or an `explained` row with a
  one-sentence reason in the report — the §40 vocabulary, used from the first phase.

## 9. Performance — budgets and how they are measured

| Budget | Target | How |
|---|---|---|
| journal append | ≤ 2 ms p95 per batch of 100 events | benchmark test, WAL, one transaction per batch |
| shadow ingestion added to a full `buildApiResponse` | ≤ 10 % of the current build time on this machine's store | measured before/after on the same store, reported in the PR |
| memory during a shadow build | no unbounded accumulation: events are batched and flushed, never collected into one array | a test that ingests a synthetic 1 M-event stream under a bounded heap |
| journal size | ≤ 2 KB/session/day for a typical Claude session, measured, reported, and used to size §36's retention | measured on the real store |

**If the shadow build exceeds its budget, P1 does not ship** — a journal that makes the dashboard
slower is a journal nobody will leave on.

## 10. Observability

`agentop journal status` prints: rows, bytes, first/last event, events written/deduped/rejected by
reason since boot, and the projection's differential summary if one has been run. A health issue is
raised when the journal is unwritable — the same shape the archive and parse-cache failures already
use.

## 11. Rollback

Turn `AGENTISTICS_JOURNAL` off. Optionally delete `~/.agentistics/journal.db`. Nothing else in the
product knows the file exists; no data that any surface reads was written or changed by P1.

## 12. Acceptance criteria

1. With the flag off, the product is byte-identical in behaviour (asserted by the existing suite).
2. With the flag on, a full build writes events for every Claude session it read, and appending the
   same build twice changes no projected number.
3. The projection reproduces `legacy(SessionMeta)` on every fixture, field by field, with no
   unexplained difference — including the four token counters, `active_minutes`, rounds,
   `tool_counts`, the agent rollup and the context gauge.
4. Every event carries a non-empty `adapterVersion`, a `confidence` and a `sourceRef` that can be
   re-read.
5. Every budget in §9 is met and the measurement is in the PR.
6. `agentop journal status` answers on a machine that has never had the flag on, saying so rather
   than failing.
7. The five not-yet-implemented integrations are declared absences, and the build fails if one is
   removed from the registry.

## 13. Decisions P1 encodes, and the ones it defers

- **D1** (Session/Run vocabulary) and **D2** (storage) from the master spec's §50 were **DECIDED
  2026-09-25 by the owner** (`2026-09-25-owner-decisions.md`): a Session is the runtime's unit of work
  and a harness conversation is a Run inside it, with legacy data projecting 1 Session → 1 Run; the
  journal is SQLite WAL, one per machine. They are the two decisions P1 encodes — the types and the
  DDL are written against them.
- **D5/D6** (what text is stored, retention) can be deferred: P1 writes **no** conversation text —
  only counters, ids, names and summaries — which is the strictest reading and can only be widened
  later, deliberately.
