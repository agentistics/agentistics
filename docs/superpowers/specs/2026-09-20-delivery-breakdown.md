# Delivery breakdown — how this project is filed on the board

**Companion to `2026-09-19-agentistics-runtime-master.md` and the phase specs.** This document says
how the work is cut into Tasks, Subtasks and groups, which model each piece gets and why, and what a
session must carry before it is dispatched. It encodes the owner's rules, stated 2026-09-20:

> **No subtask without a session. Every step traceable. A group is usually ONE session that runs
> subagents inside it. The Task is the delivery.**

## 1. The three levels, and what each one means here

| Level | Means | Rule |
|---|---|---|
| **Task** | a DELIVERY — something that is shippable and verifiable on its own | has acceptance criteria; closes only when they are met |
| **Subtask** | one unit of work | **always has a session**; a model chosen by difficulty and recorded |
| **Group** | a bundle of subtasks executed together | **one session**, which uses subagents internally; the members carry no session of their own |

That last row matches what the board already enforces: only a group or a loose subtask may hold a
session, a member of a group may not, and `done_needs_session` is skipped for a member precisely
because it could never satisfy it.

## 2. Model selection — the rule, applied

| Model | For | Examples in this project |
|---|---|---|
| **Haiku** | mechanical, localised, low-risk | moving a constant into a Record; adding a capability entry with its reason; writing a fixture; a doc page that follows an existing one |
| **Sonnet** | implementation from a written spec; multi-file reasoning; tests | every pure module (`event-id.ts`, `journal-plan.ts`, a projection); an adapter's replay path; a provider client; a route with its guard |
| **Opus** | only with explicit approval, and a recorded reason | a decision that changes the canonical model; a migration that touches existing data; a defect nobody can reproduce |

Every dispatched session records `model`, `modelSelectionReason`, and — for Opus —
`approvalRequired`, `approvedBy`, `approvalAt`. **Opus is never the default**, and "it is better" is
not a reason.

> **Note, 2026-09-25 (D18, `2026-09-25-owner-decisions.md`) — supersedes the table above where they
> conflict.** Opus 5.5 costs less than Opus 5 and its cache read costs the same as Sonnet 5's
> (US$0,20/MTok; source platform.claude.com/docs/en/about-claude/pricing, read 2026-09-25). So:
> integrating sessions run on `claude-opus-5-5`; an item that **writes a file** runs on Sonnet 5 or
> Opus 5.5; **Haiku only on a read-only item** — two Haiku subagents of the A1.0 session reported
> edits that were not on disk; the per-item approval for Opus now applies to Opus 5.5, and the model
> and the reason are still recorded per item.

## 3. What a session carries BEFORE dispatch

Non-negotiable, because a session that has to rediscover its own brief is a session that will drift:

```
harness · model (+ reason) · the objective in one sentence
the prompt, complete
the spec section it implements (file + §)
the files it may touch, and the ones it must not
acceptance criteria, copied from the Task
constraints (no commit without approval · worktree · tests must pass)
expected result (what "done" looks like, concretely)
```

## 4. The breakdown — Track A first phases

### Task A1 · The canonical model and the journal
*Delivery: a machine can write and read canonical events; nothing else changes.*

| # | Subtask / group | Model | Why that model |
|---|---|---|---|
| A1.1 | `packages/core/src/canonical/` — entities, event envelope, event union | Sonnet | it is the contract everything else is written against |
| A1.2 | `event-id.ts` + its property tests (stability, distinctness, three-sources-one-id) | Sonnet | small but subtle; the whole idempotency story rests here |
| A1.3 | **Group** — the journal: schema, open/migrate, append, cursor read, stats, rejection codes | Sonnet | one session, subagents for (a) DDL+open, (b) append/read, (c) tests |
| A1.4 | `capabilities.ts` — `CapabilityState` + the mechanical migration from the booleans | Haiku | a table transcribed with its existing reasons |
| A1.5 | `agentop journal status` + the health issue when the journal is unwritable | Haiku | follows an existing verb and an existing health shape |
| A1.6 | Benchmarks for the §9 budgets, reported in the PR | Sonnet | measurement design, not typing |

### Task A2 · The Claude adapter writes events in shadow
*Delivery: with the flag on, a build writes events for every Claude session it read; appending twice changes no number.*

| # | Subtask / group | Model | Why |
|---|---|---|---|
| A2.1 | The integration registry (`Record<HarnessId, …>`, five declared absences) | Haiku | mechanical, compiler-checked |
| A2.2 | **Group** — Claude replay: fold transcript entries → events, reusing the resumable cursor | Sonnet | the hard one; subagents for run/agent, invocations, tools |
| A2.3 | The shadow writer in `data.ts`, failure-isolated, flag-gated | Sonnet | it touches the build path; the failure test matters more than the code |
| A2.4 | `projections/session-meta.ts` — events → the legacy shape | Sonnet | this is what parity is measured against |
| A2.5 | **Group** — the differential: fixtures + a real-store comparison + the report | Sonnet | subagents per field family (tokens, time, tools, agents) |

### Task B1 · The provider client and the first real call
*Delivery: the product can call Anthropic with the user's API key and record the exact usage of that call.*

| # | Subtask / group | Model | Why |
|---|---|---|---|
| B1.1 | `ProviderClient` interface + the usage mapping type | Sonnet | the contract five providers will implement |
| B1.2 | **Group** — the Anthropic client: request, response, usage, request id, errors | Sonnet | subagents for the call, the usage mapping, the error taxonomy |
| B1.3 | Credential handling: entry, storage (0600), never logged/audited/returned | Sonnet | security-shaped; the existing `envelope-keys.ts` discipline is the model |
| B1.4 | `model.invoked` / `model.completed` emission into the journal | Sonnet | the join between the two tracks |
| B1.5 | Fixtures from recorded responses + the usage-mapping tests | Haiku | transcription once the shapes are known |

## 5. Rules that apply to every session in this project

1. **A worktree per session**, branched from `origin/dev`. The repo's own rule; several agents will
   be running at once.
2. **Stage explicit paths.** Never `git add -A` — the diff is not only yours.
3. **A red test may not be yours.** Check before assuming, and say so in the handback.
4. **Commit and PR approval (D19, 2026-09-25).** The coordinator may release a commit on a feature
   branch after checking the evidence (a red → green test, `tsc`, the handback). A PR into `dev`
   stays the owner's, approved in one batch once a day.
5. **The handback states what was NOT done**, what was assumed, and what it could not verify. A
   report that only lists successes is a report that hides the next defect.
6. **Evidence closes a criterion**: tests, a benchmark, a screenshot, a parity row — attached to the
   task, not pasted into a chat.

## 6. What is still undecided and blocks filing

- **The bootstrap question** (owner's decision): work with the board as it is — session created
  first, attached second, prompt living outside the board — or make the ALM's own upgrade
  (prepared sessions, dispatch, acceptance criteria) the first Task, so that every later subtask is
  tracked the way this document describes.
- ~~The §50 decisions that gate A1 (D1 vocabulary, D2 storage) and B1 (D3 base, D4 ingestion).~~
  **DECIDED 2026-09-25 by the owner** — see `2026-09-25-owner-decisions.md`; they no longer gate filing.
- ~~The B3 catalogue's own three (sandbox timing, git as a tool, browser placement).~~ **DECIDED
  2026-09-25 by the owner** (D-T5/6/7). B3 is still not filed until the research wave lands.
