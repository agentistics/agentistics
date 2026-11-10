# Explicit composer task registration

Tracking: [design discussion #1375](https://github.com/agentistics/agentistics/discussions/1375),
[composer #1376](https://github.com/agentistics/agentistics/issues/1376),
[navigation #1377](https://github.com/agentistics/agentistics/issues/1377),
[status feedback #1378](https://github.com/agentistics/agentistics/issues/1378).

The session composer's clipboard button marks one message as work. It starts off, offers an
explicit priority (medium initially) and an optional ISO calendar deadline, and turns off when
the message is submitted. A refused delivery restores the marked draft and its message id for
retry. A subsequent successful, deliberately repeated message gets a fresh id.

Web desktop, phone, Nay's shared SessionChat and the native runtime's NativeChatHost use the
same controls. The VS Code extension has its own DOM composer, so it does not inherit this
button; this change does not claim VS Code coverage.

## Registration and retry

Managed sends carry `messageId` and `asTask: { priority, dueDate? }` through `/api/fleet/act`.
Native chat uses `/api/tasks/from-message` before its normal native send. The host resolves the
addressed session's task, then its parent task, then an unambiguous same-project leader's task.
It refuses when no task is available or multiple unrelated leader tasks would require guessing.

The board store inserts a subtask and its creation event under its existing file lock. The
message id is the durable deduplication key, shared across retries and handoffs; conflicting text
under an existing id refuses. The subtask contains:

- The trimmed first line, capped at 120 characters, as title; full text in `notes` and original
  request metadata.
- Explicit priority, optional due date and initial `assignee: leader`.
- Original message/session/conversation ids, timestamp and deterministic `p-…` request id in
  `ownerRequest`.
- `todo` until dispatch/filing. Ordinary managed filing starts the piece, preserving the first
  `startedAt` and mirroring it into `startDate`; a filed worker changes the assignee to `worker`.
  Native filing also starts these explicitly registered pieces. Historical filing is unchanged.
- Actual completion remains the normal system `deliveredAt` stamp when the piece reaches done.

The host directly runs the existing `pedido-do-dono` and `pedido-link` operations. It does not
emit the automatic placement event: that older placement can skip a free leader and hardcodes
high priority. Direct registration records one linked pedido without creating another subtask.
Crash recovery retries those operations with the original saved timestamp and text. The board
and private flow documents are separate transactions: a failed flow leaves a recoverable saved
subtask and a visible refusal; retry finishes it. Registration precedes delivery, so a failed send
may leave the already registered request on the board.

The message still reaches the addressed session, with a short agentistics registration note.
The existing `agentistics_task` detail includes the new fields; Live includes registered queued
pieces even before a session is filed. Live uses subtask priority before parent priority, and
Calendar carries subtask priority/deadline with the same precedence.

Forecasts are not calculated by the browser. The single `requestForecast` call in
`server/flows/composer-task.ts` names `feat/registro-previsao` / slice 6 as its pending integration.
Until that branch lands, existing server forecast behavior remains; this change does not invent
an estimate or claim no-history forecast coverage.

## Optional suggestion

Unflagged composer messages and handoff replay never emit a new owner request. The existing
classifier remains available only as a nonblocking draft hint. The machine preference
`taskMessageSuggestions` is false when absent; Settings → Sessions provides its switch. The
suggestion endpoint performs no board writes. Accepting the hint arms the clipboard button;
the explicit send performs registration. Existing legacy pedidos remain readable.

Autonomous leaders receive one bilingual registration paragraph: each piece needs a prioritized
subtask, start, assignee and filed session, moving `in_progress → in_review`; a leader implementing
directly files itself on its own subtask first. Workers do not receive that paragraph.

## Navigation and status feedback

Calendar (`CalendarDays`, `/tasks/calendar`) and the delivery Live board (`Activity`, `/tasks/live`)
are destinations on the session panel icon rail and phone switcher. The session's former Live
panel is labelled Files/Arquivos with `FileDiff` to distinguish it. Main area headings toggle
their children; only child pages and leaf areas navigate. The area rail no longer expands on
hover/focus. Its 32px expand control is first, labelled Collapse/Recolher when open. The header
panel control closes both the area menu and sessions list when both are open, persisting both
states through the existing local state mechanisms.

Expanded task details are refreshed on expansion, without inspecting the parent's status, and
display loading/errors explicitly. Status requests keep the affected controls pending and
disabled until the response; failed writes use the existing local notification toast. A parent
review move refuses with `open_subtasks` and the open top-level ids, unless all open rows are group
members or `allowOpenSubtasks: true` is explicit. The UI offers Move anyway/Mover mesmo assim.
HTTP, MCP and the native host use the same guard; the store rechecks inside its write lock.
Explicit overrides are recorded in the status event.

Static inspection found no parent-status-dependent subtask filter in this baseline. The
unconditional `details.has(id)` expansion cache could retain an empty/old detail; this change
removes that shortcut and adds feedback. Reproduction of the owner's precise empty-review case
still belongs to independent QA; the regression fixture compares the same 740 children before
and after a review transition.

## Storage cost and attribution audit

No timings were measured by the static author. `markTask` loads/seeds the task world and registry,
then `patchTask` locks, rereads/parses/sanitizes the whole book and serializes it with indentation
into a temporary file before rename. `logEvents` repeats a whole-book read/write; terminal status
changes can also update attempts, preferences and evidence. A 15 MB board therefore incurs more
than one complete parse/serialization/write per logical status change, with lock wait and
projection-cache invalidation adding latency. A future scoped improvement is one atomic mutation
for status plus event, followed by profiling compact serialization or indexed storage; storage
has not been rewritten here. Measure a copy under `agentop run --rm`, never the live board.

`actor: you` is a fallback label, not proof of a human. Writers include:

- `task-web.ts` `markTask`, `editTask` and `moveTask` when actor is absent.
- Generic task POST/status/move/edit routes in `index.ts`, which accept an actor without session
  proof; MCP `agentistics_task_status` forwards an optional actor through that route.
- `sessions/cli-task.ts` status changes, which call `markTask` without an actor.
- Web TasksPage, TaskChips, TaskComposer and StopSessionConfirm status callers, which omit actor;
  TasksPage and TaskHero rename callers explicitly send `you`.

The event at 08 Nov 18:16Z cannot be assigned to a particular person/process from that label alone.
Native host/flow writers normally provide explicit `native:…` / `flow:…` labels. Attribution
authentication is a separate concern; this change reports the ambiguity instead of rewriting
historical actors.

## Validation handoff

Tests are authored for reset/retry, real shared send registration, board-lock deduplication,
unflagged phrases, suggestion defaults, bilingual leader injection, MCP detail visibility,
Calendar precedence, navigation and pending/override behavior. No install, test, typecheck, build,
server, benchmark or commit was performed by the author. The runner must execute appropriate
checks in an isolated run; independent QA must inspect desktop and 390px phone layouts and the
real private-flow integration before release.
