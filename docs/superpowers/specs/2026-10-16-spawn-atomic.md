# Atomic spawn, leader hand-off and stuck activities — design

Task `t-67a9e7ff87` (subtasks `s-e6cdf97ab0` cwd/folder · `s-8adb061d6d` role/task/subtask ·
`s-3c7e645a58` hand-off · `s-94dfdcb1ca` stuck activity). Base: `origin/dev` 5c33238a.
Plan: `docs/superpowers/plans/2026-10-16-spawn-atomic.md`.

## 0. Summary

The four problems the owner reported are one problem seen four ways: **the CLI spawn and the web
spawn are two implementations of one gesture, and only the web one files anything.** Leaders use the
CLI (that is what the briefing tells them to run), so every leader-made session lands with a correct
briefing ("you are working on task X / subtask Y") and an empty filing. Hand-off exists only as a
flag on `POST /api/fleet/new` and stops halfway (no predecessor retirement). The stuck activity is a
separate, fully reproduced chat-reader defect: a background task whose `<task-notification>` never
arrives is drawn `running` forever, and `TaskStop` never produces one.

The fix is one pure **filing plan** shared by all three spawn sites, a **server-owned hand-off** that
retires the predecessor only once it is provably quiet, and a **settle rule** for background tasks
that accepts the three ways a task really ends.

## 1. Problems → root causes (evidence)

### P3 — a new session is not filed on its task/subtask (subtask 3)

- `cli-parse.ts:233-241`: `--task <v>` is stored as `cmd.task` (free text). `cmd.taskId` is declared
  (`cli-parse.ts:29`) and **never assigned anywhere** (grep: no `cmd.taskId =` in `server/` or `bin/`).
- `cli-session.ts:384`: the CONTEXT resolves the task and subtask by id-or-title
  (`resolveContextTaskByRef`, `spawn-context.ts:29-45`) — so the briefing tells the session it is
  filed on task X / subtask Y.
- `cli-session.ts:423-426`: the REGISTRY row gets `task: cmd.task` and `taskId` only if `cmd.taskId`
  (always undefined) — and **no `subtaskId` field at all**. `--task t-67a9e7ff87` therefore records a
  task NAME `"t-67a9e7ff87"`, which matches no title; the conversation is owned by nobody
  (`conversationOwners` name tier).
- `cli-session.ts:610` / `:638-641` (`batch`): `--subtask` reaches only the context; the row gets
  `taskId` but never `subtaskId`. Batch sessions land on the task, never on the subtask.
- Contrast `cli-start.ts:4527-4593` (`spawnSession`, the web/VS Code path): resolves the task, maps a
  group MEMBER to its group, and calls `attachSession(taskId, id, {subtaskId})` (NW-02). The CLI has
  none of this — **two implementations, one of them complete.**

Net effect: the session *believes* it is filed (its briefing says so), the board says it is not. The
briefing rule "file each opened session on its subtask" (`agentistics-context.ts:102`) cannot be
followed with the command the same line tells the leader to run.

### P1 — wrong cwd/worktree and wrong folder (subtask 1)

- `cli-session.ts:370`: `cwd = cmd.cwd ? resolve(cmd.cwd) : process.cwd()`. No check against
  `Task.repo` (`task-model.ts:353-354`, a `normalizeGitRemote` key). A leader in
  `~/agentistics-workspace` that forgets `--cwd` starts its worker in the workspace; one that passes
  the wrong clone (`~/agentistics` vs `~/agentistics-engine`) is accepted silently.
- Nothing refuses the shared main checkout when another live session already works there, which
  CLAUDE.md § "Concurrent work" names as the cause of four real corruptions.
- Folder: `cli-session.ts:208-216` + `cli-folder.ts:122-131`: with no `--folder`, a leader caller gets
  one stderr line (`NO_FOLDER_WARNING`) and the session stays loose. There is no default derived from
  the task — the information exists (the folder the task's other sessions are in) and is not read.

### P2 — hand-off does not create the successor right nor close the predecessor (subtask 2)

- CLI: no hand-off verb at all (`cli-parse.ts:157-218` lists every verb).
- Web: `fleet-spawn.ts:212` accepts `handoff: true`; `cli-start.ts:4533-4590` inherits the parent's
  task/subtask and folder (`handoff-group.ts`). It does **not** set the leader role unless the label
  carries the prefix (`fleet-spawn.ts:210`), does not default the cwd to the predecessor's, and
  **nothing anywhere retires the predecessor**.
- A leader that does it by hand needs 5–6 separate calls (spawn, role POST, folder, task_session,
  wait for `waiting`, `kill --folder`). Worse: the natural last step — the predecessor killing
  ITSELF (`agentop session kill <own id>`) — kills the process in the middle of its own Bash tool
  call, so that call never gets a result (see P4-c). `kill` (`cli-session.ts:1239-1268`) does not
  refuse or defer a self-kill.

### P4 — "in progress" activity stuck forever after creating/stopping a session (subtask 4)

Reproduced on real transcripts (script: bg tool_use vs `<task-notification>` vs `TaskStop`):

| transcript | background calls | ended by notification | stuck |
|---|---|---|---|
| workspace `44d60eb5…` | 7 | 6 | 1 (classifier-denied call) |
| upx `a8b6cc39…` | 4 | 2 | 2 (both stopped with `TaskStop`) |

- `chat-tail.ts:189-202` `extractBackgroundTask`: every `tool_use` with `run_in_background: true`
  becomes a `task: {running: true}` status line.
- `chat-tail.ts:224-228` `taskNotificationFor`: the ONLY end signal is a `<task-notification>`
  naming the launching `tool_use` id.
- `chat-tail.ts:617-625` and `:767-775` (two copies: `readTurnsFromTail` and `readChatWindow`):
  "an id that never arrives stays running … for one whose session ended mid-flight there is nothing
  better to say".

Three real ways a background task ends without that notification:

- **(a) `TaskStop`**. Its `tool_result` is `{"message":"Successfully stopped task: <shellId> (…)"}`
  and no `<task-notification>` follows (both upx orphans, both stopped). The shell id
  (`b14ngvjin`) is the one the LAUNCH's own `tool_result` announced: `Command running in background
  with ID: b14ngvjin`. The pairing exists; nobody reads it.
- **(b) the launch never started** — its `tool_result` is an error/denial (`Permission for this
  action was denied by the Claude Code auto mode classifier…`). Drawn running forever.
- **(c) the session ended** (killed, exited, lost) with the task in flight — including the
  self-kill of P2. The row is `exited` and its chat still says a watcher runs.

The same readers are mirrored byte-equal in the engine (CLAUDE.md § engine slot / chat channel), so
the fix must land in both trees.

## 2. Design

### 2.1 One filing plan for every spawn (P1, P3)

New pure module `packages/server/server/sessions/spawn-filing.ts`:

```ts
export interface FilingInput {
  role: 'worker' | 'leader'
  taskRef?: string; subtaskRef?: string         // id or exact title
  folderRef?: string                            // explicit --folder
  cwd?: string                                  // explicit --cwd (already absolute)
  callerCwd: string
  handoffOf?: ManagedSession                    // predecessor, for a hand-off
  book: Pick<TaskBook, 'tasks' | 'subtasks'>
  rows: readonly ManagedSession[]               // registry (for folder/cwd defaults)
  groups: SessionUserGroupsValue
  repoOf: (dir: string) => RepoFacts | null     // injected, memoized repo-facts
  liveInCwd: (dir: string) => number            // running sessions already in that dir
}
export type FilingPlan = {
  ok: true
  taskId?: string; subtaskId?: string           // subtask MEMBER → its group (same rule as cli-start.ts:4542)
  folderId?: string; folderSource: 'explicit' | 'task' | 'parent' | 'none'
  cwd: string; cwdSource: 'explicit' | 'caller' | 'predecessor'
  role: 'worker' | 'leader'
  warnings: string[]                            // e.g. no folder could be derived
} | { ok: false; code: FilingRefusal; detail: string; candidates?: string[] }
export type FilingRefusal =
  | 'no_such_task' | 'no_such_subtask' | 'subtask_needs_task' | 'ambiguous_task'
  | 'cwd_missing' | 'cwd_wrong_repo' | 'cwd_needed' | 'cwd_shared_checkout'
```

Rules (each one a test):

1. **A reference that resolves to nothing is REFUSED, never kept as a name.** `--task X` that matches
   no id and no exact title → `no_such_task` naming the closest titles. Two exact titles → ambiguous.
   (Today it becomes a phantom name.) `--subtask` without `--task` is resolved board-wide and refused
   when ambiguous; with `--task` it must belong to it.
2. **The filing is written ON THE ROW at creation** (`taskId`, `subtaskId`, `task` = the task's real
   title) — the same moment `taskId` is already stamped — and then `attachSession` is called exactly
   as `spawnSession` does, so `planAttach`'s refusals (`subtask_in_group`, …) apply identically. A
   failed attach after a successful spawn is reported, never retried into a second session.
3. **cwd**: worker → explicit `--cwd`, else the caller's cwd **only if** it belongs to the task's repo.
   When the task has `repo` and the chosen cwd's remote (`repo-facts.ts`) differs → `cwd_wrong_repo`
   with `candidates` = known checkouts/worktrees of that remote (`project-search.ts` by remote). No
   `--cwd` and the caller is outside the repo → `cwd_needed` with the same candidates. Never guessed.
   A task with no `repo` accepts any existing directory (`cwd_missing` otherwise).
4. **Shared checkout**: a worker whose cwd is a repo's MAIN checkout (not a worktree) while
   `liveInCwd(cwd) ≥ 1` → `cwd_shared_checkout` ("use a worktree: `git worktree add …`"). Override
   `--shared-cwd`. Leaders are exempt (the workspace is not a repo).
5. **Folder**: explicit `--folder` wins. Else **`task`**: the folder holding the most recent
   still-filed session of the same subtask, else of the same task (read off `groups` +
   `sessionIdentityKey`; finished folders are skipped — a folder whose name matches the
   finished-folder rule in 2.2). Else **`parent`**: the caller's folder when the caller is filed on
   the same task. Else `none` + the existing warning. Nothing is stored on the task: the default is
   derived from where the work already is, so moving sessions moves the default.
6. **Role**: `--role` explicit; otherwise unchanged (parent present → worker; leader prefix → leader).
   A hand-off is always `leader`.

Callers: `start`, `batch` (per spec) and `spawnSession` (web/VS Code) all call `planFiling` BEFORE the
memory gate, so a refusal spawns nothing. `spawnSession` loses its private copy of the member→group
and hand-off-parent logic (moved into the plan). The CLI gains `--shared-cwd`; `--task`, `--subtask`,
`--role`, `--folder`, `--cwd` keep their names and become real.

`--json` output of `start`/`batch` gains `{taskId, subtaskId, folder: {id, path, source}, cwd,
cwdSource}` so a leader script can verify the filing without a second call.

### 2.2 Hand-off as one verb, retirement owned by the server (P2)

```
agentop session handoff [--to <harness>] [--model m] [--effort e] [--name "<title>"]
                        [-p "<prompt>"] [--from <ref>] [--finished-folder <ref>]
                        [--quiet-for 60s] [--deadline 30m] [--no-retire] [--json]
```

- `--from` defaults to the CALLER (`AGENTOP_MANAGED_ID`, verified with `callerHoldsIdentity`); a
  hand-off of a session that is not the caller requires `--from` and that the caller is a verified
  leader (or a person at a terminal with no `AGENTOP_MANAGED_ID`).
- **Successor** (one `planFiling` with `handoffOf`): harness = `--to` else the predecessor's;
  model/effort = flags else the predecessor's; cwd = the predecessor's cwd (`cwdSource:
  'predecessor'`); task/subtask = the predecessor's filing; folder = the predecessor's folder; role =
  leader (`ensureSpawnRole` + `applyRoleTitle`, so the title wears the prefix); away = inherited;
  prompt = `-p` else a fixed sentence: "Leader hand-off from <pred id/title>. Read <handoff file>
  (`findHandoffFile(cwd)`) and take over task <id>; the predecessor is retired automatically." The
  hand-off file path is added to the briefing context (`agentistics-context.ts`, a `handoff` field).
- The successor must pass `spawnFailure` (running) BEFORE anything is scheduled for the predecessor.
- **Retirement is a stored request, not a wait in the caller.** The predecessor IS usually the
  caller, mid-tool-call: a CLI that waited for it to go quiet would wait on itself forever, and one
  that killed it would cut its own tool call (P4-c). So the verb writes
  `ManagedSession.retire = { requestedAt, by, successorId, folderId?, quietForMs, deadlineAt }` on
  the predecessor's row and RETURNS. The predecessor finishes its turn normally.
- The **session hub** (`session-hub.ts`, the one poller per server — never a second poller) evaluates
  pending `retire` requests every tick through the pure `retire-plan.ts`:

  ```ts
  decideRetire(req, obs, now): 'wait' | 'retire' | { expired: true }
  obs = { activity, activitySinceMs, bgTasksRunning, children: ChildProc[], successorAlive }
  ```
  `retire` only when ALL hold: `activity === 'waiting'` (not `waiting-approval`, not `working`)
  confirmed on two consecutive polls (the `event-plan.ts` rule) and stable for `quietForMs`
  (default 60 s); `bgTasksRunning === 0` (the settled count from 2.3 — which is why P4 is a
  dependency); no **work child** in the pane's process tree (2.4); the successor still alive (a
  successor that died cancels the retirement — never leave the task leaderless). Then
  `backend.kill` → `retireSession` → `fileInFolder(finished)` → a fleet event + a comment on the
  task ("leader <pred> retired after hand-off to <succ>"). Past `deadlineAt` (default 30 min):
  nothing is killed; the request becomes `expired` and a `waiting-approval`-class notification says
  why in words ("still working / a background task runs / child process X"). Never a forced kill.
- `--no-retire` spawns and files the successor only. `agentop session retire <ref> [--cancel]`
  exposes the same request for any session (the worker equivalent of "kill when you are done"), and
  `kill <own id>` from inside the session itself becomes `retire` with a stderr sentence instead of
  cutting its own tool call.
- **Finished folder**: `--finished-folder` explicit; else a folder whose name is exactly
  `Finalizadas` / `Finished` (case-insensitive) under the predecessor's top folder, else at the top
  level; else none and the result says so. The rule is one pure function shared with 2.1's skip.
- Persisted on the row → survives a server restart; with no server running the CLI says the
  retirement waits for `agentop server` (the hub owns it) and prints the `retire` command.

**Server route** `POST /api/fleet/handoff` (`fleet-web.ts`, rides the `/api/fleet` prefix in
`capability-guard.ts` — `localShell`) takes the same fields and is the one implementation; the CLI
calls the planner + spawn in-process (as `start` does today) and writes the same `retire` record, so
it works with the server down for the spawn half.

**MCP**: `agentistics_session_handoff` calling `POST /api/fleet/handoff`, refused unless the caller is
a VERIFIED session (`session-proof.ts`) whose stored role is `leader` and the `--from` is itself or a
session it started. ⚠ Decision D1 (for the leader): CLAUDE.md records that session-starting verbs are
deliberately NOT MCP tools (Bash's permission prompt is the consent gate). The hand-off replaces one
leader with exactly one leader on the same task, does not widen the fleet, and the brief asks for an
MCP equivalent — so it is designed but sits in its own slice (S7) that can be dropped without
touching the rest. Recommendation: ship it, restricted as above.

### 2.3 Background tasks settle on every real end (P4)

Pure `bg-settle.ts` (shared by both loops in `chat-tail.ts`, and mirrored into the engine reader):

- **(a)** read the launch's own `tool_result` for `Command running in background with ID: <x>` (and
  Monitor/agent equivalents: any `ID: <x>` / `task_id` in that result) → `shellId`; a later
  `TaskStop` (`tool_use` input `task_id`/`shell_id`) whose `tool_result` reports success for `x`
  settles it as `stopped`. A `KillShell` (older name) likewise.
- **(b)** the launch's `tool_result` has `is_error: true` or carries no background id → never
  started; drawn as not running (label kept, `running: false`, no `pending`).
- **(c)** the reader is told the ROW is not running (`exited`/`lost`/`closed`): every unsettled task
  is `running: false`. `chat-web.ts` already knows the row state when it serves a chat; it passes
  `sessionEnded: boolean` into the reader (`readChatWindow`/`readRecentChatTurns` options).
- `ChatTurn.task` gains optional `ended?: 'done' | 'stopped' | 'never-started' | 'session-ended'`
  (core `chatTurn.ts` + `EngineChatTurn` mirror; `engine-api-mirrors.test.ts` keeps them equal), so
  `ChatBubble.tsx:545` can say "stopped" rather than "finished". Absent = today's meaning.
- `bgTasksRunning(path)` (count of unsettled tasks in the tail) is exported for 2.2.

Harnesses: the background-task concept is Claude's (`run_in_background`); the other five readers
emit no `task` turns (grep: no `running:` in `codex-chat.ts`, `copilot-chat.ts`, `kimi-chat.ts`,
`gemini-chat.ts`, `antigravity-chat.ts`), so for them `bgTasksRunning` is `0` by construction and the
retire rule relies on activity + children. Stated, not assumed: if a harness later grows background
tasks its reader must report them or retire stays blind to them.

### 2.4 "No work child" — per harness, measured

`retire` needs "the session is not running a command". Activity alone is not enough (Claude reads
`waiting` while a `run_in_background` shell still runs). Children alone are not enough (every harness
keeps MCP servers as children). Pure `work-children.ts`:

`workChildren(tree, harness)` = descendants of the pane pid, excluding (1) the harness's own process
chain (the `holders` already measured in `process-transcript.ts` for codex/kimi/agy), (2) any process
whose argv is an MCP launch the harness was configured with (`agentop mcp`, and argv matching the
harness's MCP config read by `mcp-list.ts`), (3) a per-harness `HELPER_PROCESSES` table
(`Record<HarnessId, RegExp[] | null>` — the build forces a decision per harness). `null` = not
measured → children are ignored for that harness and the retire result SAYS "child processes not
checked for <harness>". Each entry must be filled by observing a live idle session (S3 QA step).

### 2.5 Briefing

`agentistics-context.ts:102` and `:134` are rewritten to the new verbs: workers via
`agentop session <h> --bg --role worker --task <id> --subtask <id> --cwd <worktree> -p …` (folder now
defaults from the task); leader hand-off via `agentop session handoff`; ending a worker via
`agentop session retire <id>` (or `kill <id> --folder …` for one that is already idle). The
`agentistics-sessions-hand-offs` managed skill gets the same lines. Old flags keep working.

## 3. Failure modes

| situation | behaviour |
|---|---|
| `--task` unknown / ambiguous | refused before the memory gate; closest titles listed |
| `--subtask` is a group member | filed on its group (same as web), stated in the output |
| cwd in the wrong repo / outside it | refused with candidate worktrees; `--cwd` fixes it |
| main checkout already used by a live session | refused (`--shared-cwd` overrides) |
| attach to board fails after spawn | session kept, filing failure printed + `--json` field; no retry |
| successor fails to start | nothing scheduled; predecessor untouched; exit 1 |
| successor dies before predecessor is quiet | retire request cancelled, notification |
| predecessor never goes quiet | `expired` after deadline, notification naming the reason, no kill |
| predecessor on a permission dialog | `waiting-approval` never retires |
| server down | spawn + filing still done in-process; retirement waits for the hub, said in words |
| two hand-offs on one predecessor | second refused `handoff_pending` (successor id named) |
| caller kills itself | converted to `retire`, stderr sentence |
| TaskStop / denied launch / ended session | the background line stops saying running |

## 4. Harness matrix

| harness | spawn filing (2.1) | successor (2.2) | quiet signal | bg tasks (2.3) | children table |
|---|---|---|---|---|---|
| claude | ✓ | ✓ | screen/adapter state | read (run_in_background) | measure |
| codex | ✓ | ✓ | adapter `state` / screen | none (0) | measure (native binary under node shim) |
| gemini | ✓ | ✓ | screen only (no state declared) | none | measure |
| copilot | ✓ | ✓ | adapter state / screen | none | measure |
| kimi | ✓ | ✓ | adapter state / screen | none | measure |
| antigravity | ✓ | ✓ | adapter state / screen | none | measure |
| opencode | no spawn spec → refused in words (unchanged) | — | — | — | null |

Everything in 2.1/2.2 is harness-agnostic code; the only per-harness tables are `HELPER_PROCESSES`
and whatever `attention.ts` already knows. No harness is a default.

## 5. Test plan

Unit (pure, no fs mocks): `spawn-filing.test.ts` (every refusal; member→group; folder derivation
order incl. finished-folder skip; cwd/repo match incl. worktree sharing the remote; leader exemption),
`retire-plan.test.ts` (two-poll confirmation, quietFor, waiting-approval never, successor dead →
cancel, deadline → expired, bg>0 → wait), `bg-settle.test.ts` (fixtures cut from the two measured
transcripts, redacted: TaskStop pair, denied launch, ended session; notification path unchanged),
`work-children.test.ts`, `cli-parse.test.ts` (new verbs/flags), registry round-trip of `retire`,
`engine-api-mirrors.test.ts` (ChatTurn.task.ended).

Integration (`agentop run --rm`, throwaway HOME, own tmux socket): spawn with `--task/--subtask`
→ `task show` lists the session under the subtask; wrong `--cwd` refused; hand-off from a fake
predecessor → successor leader in same folder/task, predecessor retired only after it goes idle.

**Live QA (another model than the implementer; ≥3 harnesses: claude, codex, gemini — plus kimi if
time):** for each harness, (1) worker spawn filed on a subtask, folder defaulted from the task, cwd
refused in the wrong clone; (2) `handoff --to <harness>` from a claude leader and from a codex
leader: successor titled `[ LEADER ]`, filed, same folder; predecessor retired into Finalizadas
only after its turn ended; a predecessor kept busy past a short `--deadline` is NOT killed; (3)
TaskStop a background `sleep` in a claude session → the chat line stops saying running; kill a
session with a running background task → same. Throwaway sessions only, never the owner's live ones;
stop only by saved id.
