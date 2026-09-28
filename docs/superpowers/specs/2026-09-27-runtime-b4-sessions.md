# Runtime B4 — sessions: lifecycle, persistence, resume, the shared session (2026-09-27)

Track B step B4 (master spec §49, §24, §24.3, §24.5; D1: a Session is the runtime's unit of work, a
harness conversation is a Run inside it). Builds on B3 (`loop/`, `policy/`, `tools/`).

This document is the CONTRACT the four items were built against, and the record of the decisions
the master spec did not fix. §24.5's memory rules are acceptance criteria, not aspirations.

## 1. Module layout

```
packages/runtime/src/session/        (D23: imports nothing from packages/server or packages/web)
  types.ts          SessionRecord / RunRecord / MessageRecord / AttachmentRef / ToolCallRecord / SessionStore
  content-store.ts  a file-backed, sha256-addressed ContentStore (put + get), host-given directory
  sqlite-store.ts   SessionStore on bun:sqlite (WAL), host-given path
  lifecycle.ts      PURE builders for session.started / session.ended / run.started / run.ended
  scheduler.ts      RunScheduler — a CEILING on concurrent runs, never a timer (§24.4)
  runtime.ts        createSessionRuntime — create / run / finish / fail / cancel
  resume.ts         open a stored session: metadata + a window; older turns on demand; repair
  hub.ts            SessionHub — one fan-out per session, N watchers; the input FIFO; HubAsker
  protocol.ts       the wire frames a surface reads and writes (versioned)
packages/server/server/
  runtime-host.ts         THE HOST SEAM: store path, content dir, journal, credential, policy, tools
  runtime-sessions-web.ts /api/runtime/* handler (§28 subset)
  cli-code.ts             `agentop code` (D24)
```

## 2. The records (B4.1)

- **SessionRecord** — `sessionId` (`ses_` + 32 hex), `createdAt`, `updatedAt`, `status`
  (`open` | `ended` | `failed`), `title?`, `workspaceRoot`, `cwd`, `provider`, `model`,
  `credential` (a `CredentialRef` — an id, never a key), `messageCount`, `lastSeq`, `runCount`,
  `lastRunId?`. **No message body and no attachment bytes, ever** (§24.5).
- **RunRecord** — `runId` (`run_` + 32 hex), `sessionId`, `startedAt`, `endedAt?`, `status`
  (core `RunStatus`: `running` | `completed` | `failed` | `abandoned` | `lost`), `stop?` (the loop's
  `ToolLoopStatus`), `sentence?`, `turns`, `toolCalls`.
- **MessageRecord** — `sessionId`, `seq` (1-based, dense, per session), `runId`, `role`,
  `content: ContentRef` (`{sha256, bytes}`), `createdAt`. The BODY (`JSON.stringify(ProviderMessage)`)
  lives in the content store; the session store holds only the reference.
- **AttachmentRef** — `storageId`, `mime`, `size`, `sha256`, `name?`. Bytes live in the content
  store; a session carries only the reference.
- **ToolCallRecord** — `runId`, `toolExecutionId`, `toolUseId`, `name`, `state`
  (`started` | `settled`), `result?: ContentRef` (the modelText the model read), `isError?`. Written
  when a call STARTS and when it SETTLES — the only way a process killed mid-tool can later say which
  calls ran, which were interrupted and which never started.
- **Lease** — one PROCESS drives a session at a time: `holder` (pid + a random token),
  `expiresAt`. Expired, or held by a pid that is not alive, is free. A second driver is REFUSED with
  a sentence naming the holder; watching is not driving and needs no lease.

Window reads: `listMessages(sessionId, { before?: seq, limit })` returns the NEWEST `limit` messages
with `seq < before`, ascending, plus `nextBefore` (absent when there is nothing older). `limit` is
clamped (max 200). There is no method that returns a whole history.

## 3. Lifecycle and events (B4.1)

| Transition | Journal | Store |
|---|---|---|
| create | `session.started` `{origin:'native', title?, projectPath}` | session `open` |
| run | `run.started` `{harness:'agentistics', conversationLink:'none', cwd}` | run `running` |
| run ends by the model / a bound | `run.ended {status:'completed'}` | run `completed`, `stop` + sentence |
| run: model failed / bad catalogue | `run.ended {status:'failed'}` | run `failed` |
| cancel | `run.ended {status:'abandoned'}` | run `abandoned` |
| found `running` with a dead holder (B4.2) | `run.ended {status:'lost'}` | run `lost` |
| finish | `session.ended` | session `ended` |
| fail | `session.ended` | session `failed` |

Ids: `deriveEventId({sourceKind:'runtime', sourceId:'agentistics', sourceRef, type})` with
`sourceRef` = `session:<sessionId>` / `run:<runId>` — nothing minted at emit time, so a re-emission
is a journal duplicate, not a second fact. Provenance `native` / `exact`. **The vocabulary is not
widened**: there is no `session.resumed` / `run.queued` in `EVENT_TYPES`; a resumed session is a
session with a new `run.started`.

Every message the loop appends is persisted AS IT IS APPENDED (the loop's `onHistory` hook), not at
the end of the run: a run killed mid-tool keeps the assistant turn that asked for the tool.

## 4. Resume (B4.2)

- Opening a session reads metadata + the newest window (default 50). Older turns: `listMessages`
  with the cursor. Never the whole history.
- **Context sent to the model on the next run** is the newest `contextMessages` (default 200)
  messages, trimmed forward to a CLEAN boundary (a user message that is not only tool results), and
  never a `tool_use` without its `tool_result`. Stated limit: the context manager
  (`2026-09-25-runtime-context-manager-design.md`) replaces this rule; B4 only keeps it bounded.
- **Repair of an interrupted run** (a run `running` whose holder is gone): for the last assistant
  message's `tool_use`s — a `settled` call gets its REAL result back from the content store; a
  `started` call gets `isError` + "This call was interrupted: the process running the session ended
  before it finished. It may or may not have taken effect — check before repeating it." and a
  `tool.failed {status:'cancelled', errorClass:'killed'}` (no `durationMs` — not measured); a call
  that never started gets "Not run: the process ended before this call started." Then
  `run.ended {status:'lost'}`. The repaired `tool_result` message is persisted, so the model reads
  what happened on the next run. Idempotent: a second open repairs nothing.
- **Session approvals ("allow for this session") are NOT carried across a restart.** A resumed
  session starts with the policy's rules and no session approvals — the safer direction.

## 5. The shared session (B4.3)

- **One fan-out per session**, never per watcher: events are pushed once into the session's hub;
  each watcher has a BOUNDED queue. A watcher that falls behind gets a `gap` frame (how many it
  missed) and continues from the live edge — the hub never buffers without bound and never slows
  the run for a slow reader. A bounded ring (replay) lets a late watcher start from a cursor.
- **Input FIFO**: every input gets an ack (`queued` with its `inputSeq`, or `refused` with a code
  and a sentence: `queue-full`, `session-closed`, `not-driver`). Inputs run one run at a time, in
  order. A second surface is an additional VIEW of the same session, never a second session.
- **HubAsker**: a policy ask is broadcast to every watcher; the first answer wins; no watcher, a
  cancel or a timeout is `answered:false` — a DENIAL, never an approval.
- **Cross-process**: a hub lives in the process that holds the lease. A second process may drive
  only after the lease is free; live watching from another process is UI round 2 / the server
  hosting the session. Stated, not papered over.

## 6. `agentop code` (B4.4, D24)

`agentop code [prompt]`, `agentop code --resume <id> [prompt]`, `agentop code ls`. Streams text as
it arrives, one line per tool call, and routes every policy ask to the person in the terminal
(`TerminalAsker`): no tty, EOF, or no answer in time is a DENY. The start line states **"no sandbox:
tools run as you, in <workspace>; everything not allowlisted asks"** (B3-SEC F5).

## 7. The host seam (integrator)

`runtime-host.ts` builds everything the runtime may not know (D23): the session store path
(`<AGENTISTICS_DIR>/runtime/sessions.db`), `CONTENT_DIR`, the journal, the credential resolver
(`hostCredentialResolver`), `MINIMAL_TOOL_ENV`, the workspace root, and the policy with
`protectedPaths` = every harness credential file this machine's backup plan marks `secret`
(`HARNESS_SECRETS` + `EXCLUDE_RULES`), plus `agentisticsDir` when `AGENTISTICS_DIR` relocates the
data dir. Routes are `localShell` in `capability-guard.ts`, authenticated, refused on a central,
and admitted by the `RunScheduler` ceiling plus `admitSpawn`'s memory check.

## 8. Built — and the decisions integration had to take (2026-09-28)

| Decision | Where |
|---|---|
| A lease holder is probed with a real `kill(pid, 0)` by the HOST (`pidAlive`); the store's own default treats every holder as alive, which left a session whose driver was SIGKILLed un-resumable for a whole TTL | `runtime-host.ts` |
| A held lease is REFRESHED every TTL/3 while this process holds it; without that, a run longer than 60 s handed the session to the next process that asked | `runtime-host.ts` |
| `host.journal` PUBLISHES what it takes on the hub. A repair (B4.2) writes outside the runtime's own tee, and the M1 e2e caught a second watcher missing exactly the `tool.failed` + `run.ended {lost}` of the repair | `runtime-host.ts` |
| Per-session asker (`askerFor`) and stream events carrying `{sessionId, runId}`: one process hosts many sessions, so neither a person nor a delta may be routed by "whoever is watching" | `session/runtime.ts` |
| `agentop code` and every `/api/runtime/*` route refuse while `AGENTISTICS_PROVIDER` is off (BETA, absent reads OFF), BEFORE any session exists | `cli-code.ts`, `runtime-sessions-web.ts` |
| `--model` is required: the provider layer has no default model and guessing one is a billing decision | `cli-code.ts` |
| Only `anthropic` is driven for now (`clientFor` refuses any other provider in words); B5 widens it | `runtime-host.ts` |
| HTTP refusal codes are spelled through `rc('…')`: `notificationCoverage.test.ts` reads any `code: '<x>'` literal in the server as a NOTIFICATION code | `runtime-sessions-web.ts` |
| The interrupted call's `tool.failed` is built with `deriveEventId` directly (same inputs the loop hashes) because `ToolEventSink.failed` requires a `durationMs` the contract says to omit | `session/resume.ts` |
| Session approvals are not carried across a restart; a resumed session gets a fresh policy | `runtime-host.ts` `hostPolicy` |

**Stated limits.** A hub lives in the process holding the lease: the web can watch a session the SERVER
drives, not one `agentop code` drives in a terminal (that is UI round 2 / the server hosting CLI
sessions). A pid reused by an unrelated process after a crash blocks a resume until the TTL expires.
The context sent on a resumed run is the newest 200 messages trimmed to a clean boundary — the context
manager replaces this. No audit event is written for creating/driving a session yet.
