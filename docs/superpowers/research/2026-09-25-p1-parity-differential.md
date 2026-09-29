# P1 parity differential (A2.5) — legacy vs projected `SessionMeta`, and budgets 2 and 4

**Date:** 2026-09-25 · **Spec:** `specs/2026-09-19-runtime-p1-canonical-journal.md` §1.6, §8, §9, §12
**Base:** `feat/journal-shadow` @ c8fd16ff + `feat/projection-session-meta` (84fd431a) + replay 9eabfe0f
(Claude adapter 1.1.0, emits `context.compacted`). **Harness:** `packages/server/server/projections/differential.ts`.

This report names session ids and field names only. The real store (`~/.claude/projects`) was read only;
every measurement ran with an isolated `AGENTISTICS_DIR` in a scratch directory.

## 1. The rule

Counters are compared with `===`. There is no tolerance anywhere. A row is one of:

- `equal`
- `explained`: the two sides differ, an independent recount of that session's raw bytes reproduces
  **both** sides exactly, and the reason is one sentence in `EXPLANATIONS`
- `bug`: they differ and nothing proves why
- `not-projectable` / `partial`: declared by the projection (`NOT_PROJECTABLE` / `PARTIAL_FIELDS`)

The legacy side is `parseSessionJsonl` (the `jsonl.ts` walk plus subagent enrichment) over the same
transcript. It is not the consolidate store and not `cachedEnrich`. See §6.

## 2. Result

| run | sessions | with a `bug` row |
|---|---:|---:|
| fixture `claude-replay` | 1 | 0 |
| fixture `claude-replay-compact` | 1 | 0 |
| this machine's real store | 488 (0 live, 0 unreadable) | **10** |

### Real store, per field (rows that are not all `equal`)

| family | field | equal | explained | bug | not-proj. | partial |
|---|---|---:|---:|---:|---:|---:|
| tokens | input / output / cacheRead / cacheWrite / cost / model | 488 each | 0 | 0 | | |
| tokens | `cache_creation_1h/5m_input_tokens` | 484 | 4 | 0 | | |
| time | start / end, `daily.<day>.tokens` | all | 0 | 0 | | |
| time | `duration_minutes` | 487 | 1 | 0 | | |
| time | `active_minutes`, `rounds`, `user_message_count`, `message_hours`, `daily` (msgs/hours) | | | | 488 | |
| tools | `tool_counts`, `tool_errors`, categories, `uses_*`, `context_tokens`, `context_window`, `compact_dropped_tokens` | 488 each | 0 | 0 | | |
| tools | `compact_count`, `compact_ms` | 487 | 1 | 0 | | |
| tools | `agentMetrics.invocations[].totalTokens` | 33 | 460 | **18** | | |
| tools | `agentMetrics.invocations[].toolStats` / `.totalToolUseCount` | 509 | 2 | 0 | | |
| tools | `agentMetrics.totalTokens` | 5 | 41 | **10** | | |
| tools | `agentMetrics.totalCostUSD` | 5 | 41 | **10** | | |
| tools | `agentMetrics.totalInvocations` / `.unmeasuredInvocations` | 56 | 0 | 0 | | |
| tools | `lines_added`, `lines_removed`, `files_modified` | | | | | 488 |

The main-transcript counters are equal on all 488 sessions. This includes the four token counters,
cost, the TTL split (apart from the four explained rows), the context gauge, compactions and tool counts.
A2.2 measured the main transcripts as byte-identical repeats, and that holds on the whole store.

## 3. Explained differences (each one is proven per session)

1. **`firstWins`.** 460 invocation rows and 41 session totals. **LEGACY DEFECT**, already confirmed
   by the coordinator. `countUsage` keeps the first usage line of a streamed `message.id`, and in
   subagent transcripts that line is partial. The replay keeps the last line, as `usage-dedupe.ts`
   documents. On this store the defect appears in subagent transcripts only.
2. **`apiErrorOnly`.** 4 sessions (2b6a45f5, 32d4f58b, 626e097d, b6ad99a8). **LEGACY DEFECT.** The
   only usage line in each transcript is a synthetic `isApiErrorMessage` record whose `cache_creation`
   object is all zero. `jsonl.ts` never checks `isApiErrorMessage`, so it reports an observed 0/0 TTL
   split. The replay emits nothing for that line because no real model precedes it.
3. **`emptyTranscript`.** 1 session (f455dc9a). **LEGACY DEFECT.** The transcript is 0 bytes.
   `finishClaudeSession` writes `duration_minutes: 0` and `compact_count/compact_ms: 0` without
   checking whether any line was walked. The projection reports those fields as absent.
4. **`nestedRollup` / `nestedRollupCost`.** This covers the rows where the two sides disagree about
   which subagent transcripts belong to an invocation:
   - Legacy finds descendants by scanning each transcript for `childAgentIds`.
   - The replay follows each file's own `meta.parentAgentId`.
   - The replay's `model.completed` is keyed on `message.id` alone, so a response that appears in two
     files counts once.

   Two real shapes produce the difference:
   - A background fork that no parent's content names. Legacy misses it.
   - A conversation fork (`meta.isFork`) that replays its parent's `message.id`s. Legacy counts them
     twice. In one root this was 156,120,428 tokens for legacy against 106,446,703 for the replay,
     from 166 shared ids.

   The recount reproduces both sides exactly. **Owner decision needed:** a response billed once and
   counted twice is, in my reading, a legacy over-count. The sentence in `EXPLANATIONS` stays neutral
   until the owner rules on it.

A related pairing fix: an invocation with no subagent transcript is named by
`fallbackSubagentAgentId(conversationId, toolUseId)` in the replay. The harness now tries that id too.
This removed 6 rows that showed up on one side only (f32ddf59, 05554774).

## 4. Unexplained (bugs), for the coordinator

In `agentMetrics`, 10 sessions have 18 invocation `totalTokens` rows, plus that session's `totalTokens`
and `totalCostUSD`. The independent recount reproduces **neither** side on these rows, so they stay
`bug`:

| session | invocation(s) (harness agent id) |
|---|---|
| 4a57e60c-f38c-4775-89fb-0b8bf9b47303 | a7ed8864dfd162600, aff78ea94a0c83b2e |
| e40a8cd0-dfa4-478a-92f8-3baf85aa9a12 | af19e4294d581e64d |
| 62ec3fd0-d4c6-4f3f-add5-512b4b5c9160 | ae66fe6d39062f2fb |
| 813e0cce-3e92-4cee-b154-a47bb8d256ef | a719fc42d5edb2e62, aa07b578c0171d31b, aa3fa14971f30dbb9, abf76e168a8038050, a6f9a1d172c695060, ab4b71232d0896c2b, a008d2f672d57bdb5 |
| 3c724061-66b7-40b3-82cc-59e38e0abba0 | a6970d8ecc92fcaad |
| 50feb1c7-f2e1-4519-951c-eaa519ea8e44 | a6d7ec16c2f904dff |
| 922179a6-b685-4740-b133-fa97d99fcbf9 | a05b015b0bde016dc |
| ec2208b6-53f3-4ac3-a467-36202e5a6755 | a1a220db5b4948cb2, abb677b1d245d0837 |
| bc2f6dbb-88ba-45f1-adcd-2e3c4b7e5a77 | a5f4fba490a6268a8 |
| 7c821040-9570-4130-acc5-15e2e8f45924 | ac83206bae2493f03 |

**Unverified hypothesis (A2.5c):** the recount approximates `replay-model.ts`'s HOLD state machine as
"last occurrence per id within a file". A `message.id` that repeats NON-contiguously inside one file
would then be counted differently. Nobody has checked this.

**Latent order-independence risk (P1 §8), not observed:** `model.completed` is keyed on `message.id`
alone. If two files ever carry the same id with DIFFERENT usage, the projection keeps whichever event
arrived first. The harness checks for this, and it found 0 such conflicts on this store.

## 5. Budgets (P1 §9), re-measured on replay 9eabfe0f

Method: the same machine, a fresh process for each build, an isolated `AGENTISTICS_DIR`, and an
isolated `AGENTISTICS_JOURNAL_DIR`. The flag was off or on, and 613 sessions were built. Other sessions
were running during the measurement, so builds were noisy.

| run | build ms | shadow ms |
|---|---:|---:|
| off 1 / 2 / 3 | 75,606 / 45,345 / 66,559 | none |
| on, first ingest (empty journal) | 64,400 | **49,194** (488 sources, 408,855 events, 407,143 written, 1,712 duplicates, 0 rejected) |
| on, steady 1 / 2 | 65,192 / 67,550 | 101 / 88 (488 skipped) |

- **Budget 2, steady state: MET.** 0.1–0.2 % of a build.
- **Budget 2, first ingest: NOT MET.** 49.2 s is 76 % of the flag-on build it rode along with, and
  65–108 % of the flag-off builds. It happens once per journal and is not awaited, but it is a second
  full read of the store inside the server process. A2.3 measured 71 % on replay 191f0eda.

**Budget 4, journal size: NOT MET, by about 218×.** The journal holds 264.5 MB plus a 6.9 MB WAL. That
is 407,143 events over 622 session-days in 487 sessions: **436 KB/session/day** against a budget of
2 KB, or 667 B/event on disk. A2.3 measured about 409 KB.

| event type | count | avg `data` B | avg other columns B |
|---|---:|---:|---:|
| tool.requested | 101,429 | 157 | 273 |
| model.completed | 99,971 | 270 | 274 |
| model.invoked | 99,971 | 100 | 272 |
| tool.completed | 97,672 | 66 | 273 |
| tool.failed | 3,729 | 68 | 271 |
| agent.started / agent.ended | 1,034 / 1,033 | 90 / 22 | ~263 |
| run/session started/ended | 487 each | 2–203 | ~228 |
| model.failed | 310 | 93 | 269 |
| context.compacted | 46 | 61 | 275 |

Where the bytes go: column payload is 171 MB, which is 63 % of the file.
- `data` is 60 MB (22 %).
- The envelope columns are 111 MB (41 %). The largest are `source_ref` (23 MB), `event_id` (13 MB),
  and `session_id`, `run_id` and `agent_id` (11 MB each). `occurred_at` and `recorded_at` are 9.8 MB each.
- About 93 MB (35 %) is the row and b-tree overhead of the table plus its three indexes: UNIQUE
  `event_id`, `events_run` and `events_type`. `dbstat` is not compiled into bun's SQLite, so that
  figure is the file minus the payload, not a per-index measure.

**What this means for the decision.** The four per-call types make up 98.6 % of the rows. `data` alone
is about 96 KB/session/day, so no change to envelope encoding or indexes reaches 2 KB/session/day. The
drivers are granularity (one event per tool call and per model response, ~655 per session-day) and
retention (D6). Nothing was tuned.

## 6. Scope and assumptions

- "Legacy" is `parseSessionJsonl` over the transcript, which is the same bytes the replay reads. What a
  surface shows for a meta-sourced session goes through `cachedEnrich` and the consolidate store. That
  path is not compared here.
- `rounds` is not a stored `SessionMeta` field, so its row shows no legacy value.
- A transcript written in the last 60 s is skipped as live. That was 0 on the final run and 1 on the
  first run.
- `journal.db.stamps.json` and `journal.db.status.json`: `backup-plan.ts` carries `.agentistics/journal.db`
  as an exact file source. `carried()` matches only equal paths or `rel + '/'` prefixes, so neither
  file is carried. Neither is excluded either. Both are **undecided** backup paths. The lint cannot see
  them because they are template strings. No row was added.

## 7. The 10 residual sessions, root-caused (A2.6, 2026-09-26)

**Result: all 18 invocation rows and the 10 session totals (tokens and cost) belong to ONE class, and
they are now `explained` with a per-session proof. After this, the real store has 0 `bug` rows.**
The new sentences are `forkReplaysMain` / `forkReplaysMainCost` in `EXPLANATIONS`. Nothing about
money changed. `jsonl.ts`, `subagent-parse.ts`, `usage-dedupe.ts`, the replay and the projection are
untouched.

### 7.1 §4's hypothesis is refuted, and so is "neither side reproduces"

- **The legacy side always reproduced.** Legacy's own recount (`legacyRootEvidence`) equals the legacy
  value on all 18 rows. Only the projected recount missed, and it always missed HIGH. The projected
  value sat below the recount by a whole response's tokens, never by a partial-vs-final delta.
- **The cause is not a non-contiguous repeat inside one file.** Every one of the 18 invocations is a
  **single file** (no nested members). Its missing tokens are one `message.id` that **the main
  transcript also carries**.

### 7.2 The class: a subagent transcript that carries a main-transcript response

All 18 roots are top-level `meta.isFork: true` launches. In each one, exactly one real (non-synthetic)
`message.id` appears both in the fork's transcript and in the main transcript. The difference is:

- **Replay.** The main transcript is folded BEFORE any subagent (`integrations/claude/index.ts`,
  `doReplay` then `runSubagentPass`). `model.completed` is keyed on the provider response id alone
  (O-8), and the projection's `s.seen` is session-wide. So the fork's copy is the same event id as the
  main transcript's and is dropped. The response is reported once, under the main transcript.
- **Legacy.** `summarizeSubagentTranscript` dedups with a set that is local to ONE file
  (`subagent-parse.ts:168`, `countedUsageIds`). It has no view of the parent's ids, so the response is
  counted inside the invocation as well as in the main transcript's totals.

The per-root recount that A2.5 wrote deduped within a root only. It never pre-claimed the main
transcript's ids, so it could not reproduce the projected side. `globalDedupPerModel` now takes the
main transcript's ids as `preclaimed` and counts how many it hit (`RootEvidence.mainSharedIds`). A row
gets `forkReplaysMain` only when legacy equals its recount AND projected equals the main-aware
recount AND at least one id was pre-claimed. Otherwise the old sentences apply unchanged. For every
root that shares no id with the main transcript, the main-aware recount is identical to the old one,
so the 460 + 41 rows that were already explained are unaffected. On the full store they still come
out explained: 478 = 460 + 18 invocation rows, and 51 = 41 + 10 totals.

### 7.3 Per-invocation proof (numbers only)

`deficit` = main-unaware projected recount − projected value. It equals the four-counter sum of the
single shared id in every row. `shared` = the number of real ids the fork shares with the main transcript.

| session | invocation | legacy | projected | shared | deficit |
|---|---|---:|---:|---:|---:|
| 4a57e60c | a7ed8864dfd162600 | 2,493,272 | 2,277,395 | 1 | 222,436 |
| 4a57e60c | aff78ea94a0c83b2e | 3,799,786 | 3,172,690 | 1 | 629,980 |
| e40a8cd0 | af19e4294d581e64d | 36,819,990 | 36,406,430 | 1 | 456,416 |
| 62ec3fd0 | ae66fe6d39062f2fb | 3,540,358 | 3,193,278 | 1 | 347,345 |
| 813e0cce | a719fc42d5edb2e62 | 2,075,653 | 2,001,183 | 1 | 78,678 |
| 813e0cce | aa07b578c0171d31b | 1,880,579 | 1,801,901 | 1 | 78,678 |
| 813e0cce | aa3fa14971f30dbb9 | 2,102,289 | 2,025,817 | 1 | 78,678 |
| 813e0cce | abf76e168a8038050 | 1,697,020 | 1,621,497 | 1 | 78,678 |
| 813e0cce | a6f9a1d172c695060 | 2,380,538 | 2,308,487 | 1 | 78,678 |
| 813e0cce | ab4b71232d0896c2b | 600,837 | 518,919 | 1 | 83,409 |
| 813e0cce | a008d2f672d57bdb5 | 1,270,789 | 1,177,930 | 1 | 95,232 |
| 3c724061 | a6970d8ecc92fcaad | 1,738,229 | 1,392,648 | 1 | 345,581 |
| 50feb1c7 | a6d7ec16c2f904dff | 11,643,190 | 11,620,756 | 1 | 76,201 |
| 922179a6 | a05b015b0bde016dc | 14,061,869 | 14,020,288 | 1 | 87,090 |
| ec2208b6 | a1a220db5b4948cb2 | 14,680,702 | 14,652,739 | 1 | 76,680 |
| ec2208b6 | abb677b1d245d0837 | 4,861,063 | 4,635,965 | 1 | 244,327 |
| bc2f6dbb | a5f4fba490a6268a8 | 441,974 | 368,808 | 1 | 76,676 |
| 7c821040 | ac83206bae2493f03 | 426,830 | 358,938 | 1 | 73,242 |

Why legacy can sit below the projected recount while being above the projected value (for example
e40a8cd0: 36,819,990 < 36,862,846 but > 36,406,430): the `firstWins` defect (§3.1) and this class stack
on the same file. Legacy keeps the partial first line of each streamed id, and it also keeps the
shared id.

**Independent byte check (Sonnet 5 subagent, its own script, read-only).** It re-derived every row
from the raw JSONL without using the differential's code. It confirmed `isFork: true` and exactly one
shared real id on all 18, with every deficit equal to the fork's last-line four-counter sum. The shared
id is always the fork file's **first** assistant usage line: line 2, right after a `fork-context-ref`
line 1. In the main transcript, that id is the parent turn whose `tool_use` launched the fork, and the
launch line (`meta.toolUseId`) is one of that id's own lines. All ids are `claude-sonnet-5`. So a
forked transcript opens with the launching response under its original `message.id`: one billed
response, written in two files.

**Five of the 18 copies are NOT byte-identical.** 813e0cce launched six forks from ONE streamed
parent response. The main transcript writes that response over 8 lines and settles at 83,409. Forks
a719fc42, aa07b578, aa3fa149, abf76e16 and a6f9a1d1 were launched from earlier lines of that response,
and each carries the earlier snapshot 78,678. Only ab4b7123, launched from the last line, carries
83,409. For those five the harness sets `conflict: true`. They are still `explained`, because both
sides reproduce exactly under the replay's real claim order (see §7.4). What legacy double-counts
there is a **partial** copy of the response, not the final one.

### 7.4 Which side is wrong — for the owner, not fixed here

In my reading, **the legacy invocation total over-counts** by one billed response per fork launch.
It is the same response that the main transcript's totals already carry, and `message.id` is one API
response and one billing event (CLAUDE.md, "One billed response is counted ONCE"). This is the
main↔subagent twin of §3.4's fork double-count, which is still pending the owner, and the same
decision covers both. The fix would sit in `subagent-parse.ts` (dedup across the parent's ids as well
as the file's own). It changes money on every agent surface, so it is not made here.

One property of the replay side is worth naming. Which copy the projection keeps depends on claim
order. The main transcript is folded first, so it wins. That order is structural: it comes from
`doReplay`, which folds the main transcript before `runSubagentPass`, not from a directory listing.
The recount therefore models it, and I treat it as proof rather than coincidence. It is still an
order dependency.
- **The per-invocation split** would flip if the order ever changed.
- **The totals** would also move on the five 813e0cce forks. Their copy differs from the main
  transcript's (78,678 against 83,409), so the value kept would change with it.

This is P1 §8's "latent" cross-file risk, now **observed** on this store. It is 5 conflicting ids, all
on the main↔fork boundary, and still 0 between subagent files. The explanation is applied with
`conflict: true` present. If the coordinator reads that as order-dependent rather than proven, those
five rows and 813e0cce's total go back to `bug` with `CROSS_FILE_CONFLICT_REASON`. That is a one-line
guard in `compareTools`.

### 7.5 Run

Base `feat/parity-differential` @ 7529bc53, isolated `AGENTISTICS_DIR`, real store read-only. Before:
10 sessions with `bug` rows (reproduced exactly as in §4). After: 487 compared, 2 skipped as live, 0
unreadable, **0 with a `bug` row**. The store grew by one session since A2.5's run. The two live ones
are sessions being written right now and are none of the ten.
