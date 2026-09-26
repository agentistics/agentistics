# Idle sessions — notice, review, file and end

Date: 2026-09-25. Status: approved design, not yet planned.

## Problem

Sessions accumulate. A session the user stopped talking to hours ago keeps its assistant process
alive — memory, CPU, a row in every fleet view — and nothing in the product says so. The user
wants to be told, shown which sessions they are, and able to end them in one confirmed step
without losing track of them (filed into a group so they can be found and reopened later).

Two smaller asks ride along:

- The Sessions workspace header has no notification bell (the dashboard header has one; the two
  headers are mutually exclusive and the bell was never added to the sessions one).
- Hardware figures should inform the suggestion (which sessions are heaviest, and suggest sooner
  when the machine is under memory pressure).

## Decisions (made with the owner, 2026-09-25)

| Question | Decision |
|---|---|
| What is "idle" | X time since the user's LAST MESSAGE **and** the session is stopped waiting on the user. A session that is working, or asking for approval, is never idle. |
| Role of hardware | Time triggers; hardware ORDERS the list (heaviest first), shows what ending frees, and SHORTENS X while RAM is under pressure. |
| Default X | 2 h; 30 min under RAM pressure. Both adjustable in Settings; the feature can be switched off. |
| Per-session actions | **File & end** (default) / **End only** / **Keep**. "Keep" silences that session until the user sends it a new message. |
| Architecture | Hybrid: the server exposes the missing facts on the fleet row; the rule is a pure core function; the web derives candidates live and owns notification, banner and modal. |

## Architecture

### 1. Facts on the fleet row (server)

`ControlSession` (the `/api/fleet` row) gains, for managed rows with an EXACT conversation link
(the same links `metricsOf` accepts — never the harness-and-directory inference):

- `lastUserMessageAt?: string` — the last entry of that conversation's
  `SessionMeta.user_message_timestamps` (the person's turns only; `isHumanUserEntry` already
  refuses `isMeta` / compaction summaries).
- `lastPrompt?: string` — the text of that turn, passed through `sessionLabel`-style wrapper
  stripping and `redactSecrets`, truncated to 200 chars.
- `taskId?: string` — the id behind the existing `task` label (`ManagedSession.taskId`).

Absent means **unknown**, never "long ago". `pid` / `cpuPercent` / `rssBytes` already travel.

The machine→central relay row (`reduceMachineFleetRow`) is an ALLOWLIST and does NOT gain these
fields — `lastPrompt` is chat-derived and must not cross.

### 2. The rule — `packages/core/src/idleSessions.ts` (pure)

```ts
idleCandidates(rows, {
  now, thresholdMs, pressureThresholdMs, underPressure,
  openSessionId,            // the one on screen — never suggested
  kept: Record<sessionKey, keptAtIso>,
}): IdleCandidate[]
```

A row is a candidate only if ALL hold:

1. managed by agentop (external rows cannot be ended from here);
2. state is `waiting` (not `working`, not `waiting-approval`, not ended/lost/exited);
3. `lastUserMessageAt` is present and `now - lastUserMessageAt >= effective threshold`
   (`pressureThresholdMs` when `underPressure`, else `thresholdMs`);
4. it is not `openSessionId`;
5. it is not kept, or its `lastUserMessageAt` is AFTER the keep (a new message lifts the keep).

`IdleCandidate` carries `idleMs`, `rssBytes`, `cpuPercent`, and `reasons` (see §6). Ordering:
task-delivered first, then by `rssBytes` desc (unknown last), then `idleMs` desc.

`suggestGroup(candidate, groups, rows)` (same module, pure):
1. an existing user group holding ≥1 session of the same `taskId` → that group (the one holding
   the most; ties → the most recently created);
2. else, if the session has a task → a NEW group named after the task;
3. else → a NEW group `Idle · <yyyy-MM-dd>` (reused if it already exists that day).

### 3. Web — watch, notify, banner, modal

`hooks/useIdleSessionsWatch.ts` runs on every fleet poll (local machine only; OFF on a central):

- computes candidates via `idleCandidates`;
- **notification**: one per BATCH, code `sessions.idle`, `meta` = count, names, freed memory.
  Re-notifies only when a session not in the last notified set joins; never per poll. Persisted
  through the existing `pushNotification` (server dedupes).
- **click**: `notificationLink` gains `sessions.idle` → opens the review modal (a CustomEvent,
  the same mechanism `app.update_available` already uses).
- **banner**: shown at the top of the Sessions workspace while candidates exist AND the user has
  dismissed or declined the modal (or never opened it). Recomputed from the live list, so it
  disappears on its own when the sessions end, resume work or receive a message. Actions:
  **Review** and **Snooze 1 h** (snooze stored per tab in `sessionStorage`; guarded try/catch).

`components/sessions/IdleSessionsModal.tsx` — one row per candidate: name, idle time, last
prompt, memory/CPU, the action select (File & end / End only / Keep) and the group select
(pre-filled by `suggestGroup`, editable, "New group…" allowed). Footer: "Ends N sessions · frees
~X GB". Full-screen on mobile; ≥44px targets; inputs ≥16px.

### 4. Executing a confirmation

Per session, sequentially, stopping that session's sequence at the first failure:

1. **Re-check** against a FRESH fleet read: still a candidate? If the user sent a message or it
   started working since the modal opened → skipped, reported as such.
2. **File** (File & end only): create the group if needed (or recreate one deleted meanwhile),
   then `moveSessionToGroup` (groups are keyed by `sessionIdentityKey`, so filing survives the
   reopen).
3. **End**: `POST /api/fleet/act {id, action:'kill'}`. Success only on `{ok:true}`.
4. **Keep**: write `kept[sessionKey] = now` to preferences (`idleSessions.kept`).

A failure on step 3 leaves the session filed and running, and the modal reports which one failed
and the server's own sentence. Other sessions continue. Result list rendered in the modal:
ended / kept / skipped (why) / failed (why).

### 5. Preferences

`preferences.idleSessions = { enabled, thresholdMin, pressureThresholdMin, kept }`.
**Absent reads as ON with 120 / 30** (it only suggests; nothing is ended without a confirmation).
Settings → Sessions: switch + the two numbers. `kept` is pruned of sessions no longer in the fleet.

Under-pressure = `lib/hardwarePressure.ts`'s RAM level ≥ `warn`, from the snapshot
`useHardwarePressureWatch` already polls — no second probe.

### 6. Smart extras (in the modal, all derived, none automatic)

- **Task delivered**: a session whose task is `done` is listed first with "task already delivered".
- **Context nearly full** (≥ 85 % via `contextFraction`): "ending and reopening is cheaper".
- **Unsent draft**: if the composer holds an unsent draft for that session → warning, default
  action switched to Keep.
- **Freed memory** total in the header and footer.

### 7. Bell in the Sessions header

`NotificationBell` placed beside the magnifier in `sessionTopBar` (desktop, App.tsx) and beside
`magnifierButton` in `SessionsPage` (mobile). No new state — same store.

## Edge cases (each gets a test)

- Unknown `lastUserMessageAt` (no exact link, or a harness with no human-turn timestamps) → never a
  candidate.
- `waiting-approval` → never a candidate (it is blocked on the user, not idle).
- Row ended between notification and confirm → skipped, banner gone on next poll.
- Two tabs confirming the same batch → the second kill answers "not running"; reported as skipped,
  not failed. Group moves are idempotent.
- Group deleted while the modal is open → recreated on confirm.
- Keep then a new message → candidate again after X.
- Central → the watch does not run; `/api/fleet` is refused there anyway.
- Clock: all arithmetic in epoch ms; `lastUserMessageAt` is ISO with offset.

## Out of scope

- Notifying with no browser open (the daemon can call `idleCandidates` later; not now).
- Ending external (non-managed) sessions.
- Auto-ending anything without confirmation.

## Testing

- `idleSessions.test.ts`: every rule in §2, ordering, `suggestGroup` precedence, keep lifting.
- Server: the three new row fields, present only on exact links, absent on the relay row
  (`machineFleet.test.ts` allowlist assertion extended).
- Web: batch-notification dedupe (pure helper), execution sequencing with a failing kill (pure
  reducer over action results), banner visibility (pure).
- Manual: headless-browser run at 1440px and 390px (no horizontal scroll).
