# ALM session linking — the `done` rule, subtask groups, and the UX outside `/tasks`

Extends `docs/superpowers/specs/2026-09-10-task-session-hierarchy-design.md` (the three filing
shapes and per-subtask rollup). That spec is unchanged by this one — read it first for the
vocabulary (`rowsOfTask`, `subtaskViews`, the `id: null` direct bucket) this document builds on.

This is task `t-918cc82233`'s third round: two pieces of user feedback (A, B) plus six UX reports
about task/subtask management **outside** the `/tasks` board (C), catalogued in comment
`c-8140507765`. Every file named below was opened and read in this worktree before it is named —
no filename is guessed.

## 0. What is already on `origin/dev` vs. still in a worktree

Checked directly rather than assumed, because three parallel sessions have been landing pieces of
the 2026-09-10 spec all at once:

- **On `origin/dev` already**: `task-attach.ts`'s reopened `{kind: 'task'}` branch (§4.1),
  `task-report.ts`'s `subtaskViews`/`SubtaskView` (§4.2), the `web/src/lib/tasks.ts` mirror, and
  `agentistics_task_session`'s MCP description. `agentistics_task_subtask`'s description still
  says "no cost of its own" — stale, not yet corrected (see §3's note).
- **Not yet on `origin/dev`**, still in their own worktrees: `SubtaskTable.tsx`'s cost/tokens
  columns (`s-2ed5531c53`, worktree `subtable-cost-ui`), and `SessionFiling.tsx`'s "direto na
  entrega" row (`s-eda72d6def`, worktree `session-filing-ui`, session `2c853d1993` — **running right
  now**). Every subtask below that touches `SessionFiling.tsx` is `blockedBy: ["s-eda72d6def"]`.

## A. `done` requires a linked session

### A.1 What happened

Four subtasks of this very task (`s-843b0dd3cb`, `s-b7392c752d`, `s-af6c8722f3`, `s-f61f59be4f`)
were marked `done` with no session filed under them — the work happened, but as a side effect of a
sibling subtask's session, or as a docblock-only commit, so the subtask record itself carries no
link. `SubtaskTable.tsx` renders these rows with a bare "filiar" control, same as a subtask nobody
has started (screenshot `698b9e38-image.png`).

### A.2 Where the rule binds

Two independent entry points move a task or subtask to `done`, and both must refuse — this is the
same shape as `blocked_needs_reason` (`task-web.ts`'s `markTask`, §"Important rules" in CLAUDE.md),
checked server-side so it binds the browser, the CLI and the MCP alike, never only the button.

**Subtask**: `task-web.ts`'s `patchSubtask` (line 388) and `setSubtaskDone` (line 434). Today both
return a bare `Promise<boolean>` — no refusal reason travels at all. This has to become a typed
result, the same shape `markTask` already returns (`{ok: boolean; message?: string}`), because a
route that can refuse and a function that can only report `false` cannot tell "no such subtask"
from "needs a session" from "wrote fine."

```ts
export async function patchSubtask(subtaskId: string, patch: {...}): Promise<
  { ok: true } | { ok: false; message: 'no_such_subtask' | 'done_needs_session' }
> {
  const w = await loadTaskWorld()
  const found = w.book.subtasks.find(t => t.id === subtaskId)
  if (!found) return { ok: false, message: 'no_such_subtask' }
  const status = patch.status ?? found.status
  if (status === 'done' && found.status !== 'done') {
    const hasSession = w.rows.some(r => r.subtaskId === subtaskId)
    if (!hasSession) return { ok: false, message: 'done_needs_session' }
  }
  ...
}
```

The guard is `found.status !== 'done' →` (a status PATCH that is not actually changing to `done` —
editing the due date of an already-done subtask — must not re-trigger the check) and it only looks
at `w.rows.some(r => r.subtaskId === subtaskId)` — the exact same predicate `subtaskViews` already
filters on (`task-report.ts` line ~224), so this is not a second definition of "has a session," it
is the same one read at write time.

**Task**: `markTask` (`task-web.ts` line 663) already has `w.rows` in scope at the point it decides
`done` (it computes `rowsOfTask(task, w.rows)` right after, for the delivery-evidence block at line
746 — the check can sit immediately before that, reusing the same call rather than adding a second
one):

```ts
if (to === 'done') {
  const mine = rowsOfTask(task, w.rows)
  if (mine.length === 0) return { ok: false, message: 'done_needs_session' }
}
```

`rowsOfTask` counts a session **anywhere** under the task — filed directly, or under any of its
subtasks — so this one check is correct for a task with subtasks, without subtasks, or a mix, with
no new counting logic.

### A.3 The two open questions from the task detail — decided

**"A task with no subtasks and no direct session — refused on `done`?"** Yes, by the same rule
above: `rowsOfTask` returns nothing either way, and there is no special case for "this task never
had any subtasks." A task that was never worked cannot be delivered.

**"A task with every subtask `done` but no session of its own — does it count as having a
session?"** Yes — and this needs no extra logic to make true. `rowsOfTask(task, rows)` matches
every row whose `taskId` equals the task's id, **regardless of `subtaskId`** (§4.2 of the
2026-09-10 spec: this was already true before this change, it is what makes the task total sum
both branches). A task whose subtasks each have a session already has sessions under it by this
same test — "the task has a session of its own" was never the right question to ask; "does
`rowsOfTask` return anything" is, and it already answers both cases identically. This is also why
the task-level check must be `rowsOfTask`, never `w.rows.filter(r => r.taskId === task.id &&
!r.subtaskId)` (sessions filed *directly*) — that narrower test would refuse a task whose delivery
is entirely accounted for by its subtasks, which is the ordinary, common shape (§2 of the
2026-09-10 spec, shape #2).

### A.4 Wire and surfaces

- `index.ts`'s `subtasks` verb (lines 1701–1727) currently does `json({ ok: await
  mod.patchSubtask(...) })` / `json({ ok: await mod.setSubtaskDone(...) })` with no status code
  branch. Once `patchSubtask`/`setSubtaskDone` return the typed result, this becomes the same
  422-on-refusal shape the `sessions` verb already uses two blocks above it (line 1685-1688):
  `json(result, result.ok ? 200 : (result.message === 'done_needs_session' ? 422 : 404))`.
- `markTask`'s `done_needs_session` rides the exact channel `blocked_needs_reason` already uses —
  `web/src/lib/tasks.ts`'s `markTask()` (line 354) returns `boolean` today from `res.ok`; nothing
  there needs to change shape, only the caller reads the same 422 it already has to plan for.
- **UI**: wherever a "done" tick or status move can be pressed without a session yet —
  `SubtaskTable.tsx`'s status pill, `DeliveryDetail.tsx`'s status dropdown — the refusal has to
  surface as a sentence, not a silently-failed request. The natural spot is the same one
  `BlockedDialog.tsx` already exists for `blocked_needs_reason`: a small dialog naming the rule
  ("esta subtarefa/entrega precisa de uma sessão filiada antes de ser marcada como entregue") with
  the filing control (`SessionFiling`/`SubtaskSessions`' "filiar") one click away, not a toast that
  disappears.
- **MCP**: `agentistics_task_status` and `agentistics_task_subtask`'s descriptions gain one
  sentence each, matching how `blocked`'s requirement is already documented in both — "**`done`
  REQUIRES the task/subtask to have at least one session filed under it** and is refused (422,
  `done_needs_session`) without one." While in that file, fix `agentistics_task_subtask`'s stale
  "no cost of its own" line (packages/mcp/agentistics-mcp.ts line 246) — the rollup work already
  shipped and this sentence was never updated; it is the same kind of drift `s-843b0dd3cb` already
  fixed in `task-model.ts`/`SubtaskTable.tsx`, just missed in this one file. Also fix
  `task-web.ts`'s own stale comment at line 594 ("A DELIVERY DOES NOT TAKE SESSIONS: without a
  subtask this refuses") — `attachSession` no longer refuses a bare task target; the comment
  describes the pre-§4.1 behaviour.

## B. Subtask groups — one session, several subtasks, no double counting

### B.1 The feature

A session can be assigned to a **group** of subtasks instead of one, and every subtask in the
group automatically counts that session as its own. The open question the user flagged and asked
to be resolved: if every subtask in the group showed the session's full cost, summing the group's
N subtasks would multiply the cost by N.

### B.2 Decision: `Subtask.groupId`, not a new entity

Rejected: a `SubtaskGroup` record of its own (id, title, its own rollup, its own store). It would
duplicate exactly the shape `Subtask` already has, need its own CRUD surface, and buy nothing a
plain field does not already buy — a group here is not a piece of work with its own status or due
date, it is a **label two or more subtasks share**.

Adopted: one new optional field on `Subtask` (`task-model.ts` line 289), alongside the existing
optional columns:

```ts
export interface Subtask {
  ...
  /**
   * Subtasks that share a `groupId` are read as ONE bucket for rollup: a session filed under any
   * member counts for all of them, and their `subtaskViews` rollup is the SAME object, keyed by
   * the group id rather than by each subtask's own id — never summed per member, which is what
   * would multiply a shared session's cost by the group's size. Absent = today's behaviour
   * unchanged: every existing subtask, with no `groupId`, is its own group of one.
   */
  groupId?: string
}
```

No migration: absent reads as "not grouped," exactly the same rule `Subtask.blockedBy`,
`Task.shared` and every other optional column in this codebase already follow. Minted the same way
subtask/task ids are (`mint('g')` in `task-model.ts`, beside `newSubtaskId`).

### B.3 The rollup: one bucket per group, never per member

This is route (1) from the task comment — **the group's rollup is the source of truth; a member
subtask's own row is a reference to it, never a second sum.**

`subtaskViews` (`task-report.ts` line 216) buckets by **effective key**: a subtask's own id when it
has no `groupId`, or the `groupId` when it does. Two or more subtasks sharing a `groupId` therefore
collapse into **one** `SubtaskView` in the returned list — not one per member — which is what keeps
the existing guarantee intact ("every row of a task falls into exactly one bucket," stated in the
current docblock at line ~190 of `task-report.ts`): a session filed under any group member's
`subtaskId` is counted in that ONE bucket, once, regardless of which specific member the session's
`subtaskId` happens to name.

```ts
export function subtaskViews(task, subtasks, rows, metas, costOf): SubtaskView[] {
  const mine = subtasks.filter(s => s.taskId === task.id)
  // Effective bucket key: the group id when grouped, the subtask's own id otherwise.
  const keyOf = (s: Subtask) => s.groupId ?? s.id
  const groups = new Map<string, Subtask[]>()
  for (const s of mine) {
    const k = keyOf(s)
    groups.set(k, [...(groups.get(k) ?? []), s])
  }
  const views: SubtaskView[] = [...groups.entries()].map(([key, members]) => ({
    id: key,
    // A session's subtaskId can name ANY member — the union is the group's rows.
    rollup: rollupAttempt({
      sessions: rollupSessionsFor(
        rows.filter(r => members.some(m => m.id === r.subtaskId)), metas, costOf,
      ),
    }),
  }))
  const direct = rows.filter(r => !r.subtaskId)
  if (direct.length > 0) views.push({ id: null, rollup: rollupAttempt({ sessions: rollupSessionsFor(direct, metas, costOf) }) })
  return views
}
```

`SubtaskView.id` was already `string | null`; a group's id is just another string in that same
slot, so `TaskDetail.subtaskRollups`'s shape (and its wire mirror in `web/src/lib/tasks.ts`) needs
no change at all — only the function that builds it.

**A reader resolves "my rollup" by the same effective key**: `SubtaskTable.tsx` (once
`s-2ed5531c53`'s cost columns land) looks up a row's rollup via `subtaskRollups.find(v => v.id ===
(subtask.groupId ?? subtask.id))`, never via `v.id === subtask.id` alone — the same one-line change
in the one place that reads the list, rather than a second copy of the bucketing rule.

### B.4 The session-chip list also needs group-awareness

`SubtaskSessions.tsx` (line 43: `mine = p.sessions.filter(s => s.subtaskId === p.subtaskId)`)
filters by the exact subtask id — so today, a session filed under group member A would show only
on A's row, not on sibling B's, even though B's cost column (per §B.3) would already include it.
That mismatch — a number that counts a session no chip on the row names — is exactly the kind of
inconsistency this codebase's N/A-vs-confident-number rule exists to prevent.

So `subtaskSessions` needs the **member set**, not a bare id, to filter by:

```ts
export interface SubtaskSessionsProps {
  /** This subtask's own id, plus every sibling sharing its `groupId` — the id alone when ungrouped. */
  subtaskIds: readonly string[]
  ...
}
export function subtaskSessions(p: SubtaskSessionsProps) {
  const mine = p.sessions.filter(s => s.subtaskId && p.subtaskIds.includes(s.subtaskId))
  ...
}
```

`SubtaskTable.tsx`/`TaskTable.tsx` (both callers) compute the member set once per row: `subtask.groupId
? subtasks.filter(s => s.groupId === subtask.groupId).map(s => s.id) : [subtask.id]`. This makes
every member of a group show the identical chip list and the identical cost — the same session,
named the same number of times as subtasks it belongs to, which is the feature as described ("todas
as subtasks do grupo passam a contar essa sessão").

### B.5 Forming a group — the write side

`patchSubtask` gains `groupId?: string | null` (`null` clears it — the same "empty string clears a
column" convention `dueDate`/`assignee` already use, except `groupId` is not free text so `null` is
the honest "remove" rather than an empty string). `index.ts`'s `subtasks` verb passes it through
like every other optional column.

The **UI gesture** — "put this subtask in the same group as that one" — is a picker inside
`SubtaskTable.tsx`'s row menu (wherever "Filiar"/session actions already live): pick a sibling
subtask, and the two of them are stamped with the same freshly-minted `groupId` (if neither already
has one) or the target's existing `groupId` (if it does — joining an existing group). This is new
UI surface, not covered by any subtask already filed; §5 below files it.

**Out of scope for this round**: a human-readable group name. The group is identified by which
subtasks share the badge (`SubtaskTable.tsx` shows a small "grupo" chip on every member row,
listing the sibling titles on hover) — the same "no invented state beyond what is needed" reasoning
that kept `Task.hierarchyMode` out of the 2026-09-10 spec applies here: a name is a field that can
drift from what the group actually contains, and nothing asked for one yet.

## C. UX outside `/tasks` — six points

### C.1 The filing modal (`SessionFiling.tsx`) is hard to use

Confirmed component from screenshot `7f06ed4a-image.png`: the "SUBTAREFAS — A SESSÃO FICA EM UMA
DELAS" dialog is `SessionFiling.tsx`'s "delivery itself" face (line ~196 in this worktree's
pre-`s-eda72d6def` version). **This file is being edited right now** by session `2c853d1993`
(`s-eda72d6def`, adding the "— direto na entrega —" row above the subtask list) — every subtask
below that touches it is `blockedBy: ["s-eda72d6def"]`.

What is concretely wrong, read against the component as it stands (plus the pending direct-row
change):

- **No distinction for a grouped subtask.** Once §B ships, a subtask row here needs to say it is
  part of a group (so choosing it is understood to also affect its siblings) — otherwise filing a
  session "into one subtask" silently changes N rows' totals with nothing on screen saying so.
- **No search inside a long subtask list.** The list scrolls (`maxHeight: 260`) but has no filter —
  fine for the six subtasks in this very task, not fine for a task broken into thirty.
- **"Trocar de entrega" is a full re-pick, with no fast path back to the CURRENT delivery's other
  subtask.** Moving between two subtasks of the SAME delivery already works (click the other row);
  the friction is specifically leaving-and-returning to a different delivery, which requires the
  search-and-pick flow every time even for a delivery visited a minute ago (no "recent" list).

**Recommendation**: the group badge (concrete, blocked on B) and a search field over the subtask
list (concrete, useful today) are the two changes worth making now; "recent deliveries" is a
smaller, separable convenience that can wait — flagged here rather than speced in full, since it
touches the same file as the group badge and should not be a third overlapping PR on it.

### C.2 Creating a task together with a new session — confirmed root cause

This is a real, reproducible defect, traced to a specific gap rather than "something in
`fleet-spawn.ts`."

**The flow**: `TasksPage.tsx` → `NewTaskWizard` → `TaskComposer`'s "create, then start a session"
button (line 405, `onCreateSession`) → `TasksPage.tsx` line 264's handler, which does:

```ts
onCreateSession={(taskId, taskTitle) => {
  setOpen(false)
  setStarting({ taskId, title: taskTitle })
}}
```

→ opens `NewSessionModal` with `initialTask={starting.title}` (line 276) — **a bare string, the
task's TITLE, never its `taskId`**.

`NewSessionModal` only ever attaches a spawned session to a real task record through its
`subtaskTarget` state (`{taskId, subtaskId}`, both required — set exclusively by `TaskPicker`'s
`onPick`, line 1063). `initialTask` feeds only the free-text `task` field (line 133:
`useState(initialTask ?? '')`), which becomes the `task` string sent to `POST /api/fleet/new` — a
**display label** on the spawned session, nothing more (`fleet-spawn.ts` line 137-146 just carries
it through as `plan.task`). Since `subtaskTarget` is never set on this path, `start()`'s attach
block (line 589: `if (subtaskTarget && json.id) { attachSession(...) }`) never runs. **The session
is created, but never actually filed under the task the wizard just made.**

Why this reads as invisible on the surface but real underneath: `rowsOfTask` (`task-report.ts` line
102-106) matches a session either by `taskId` (the real link, never set here) OR by
`legacyTaskId(r.task) === task.id` — a fallback for sessions filed before real task ids existed.
`legacyTaskId(name)` (`task-model.ts` line 422) is `` `legacy-${sha256(name).slice(0,10)}` ``, a
**different id format** from a real task's `` `t-${uuid}` `` (`newTaskId`, line 383-385). A task
just created via `createTask()` always has a `t-` id, so `legacyTaskId(title)` can never equal it —
the fallback exists only for tasks that were themselves migrated from free-text names, never for a
freshly-created real `Task`. **The session's `task` label matches the new task's title in every UI
that joins by string (`SessionFiling`'s `filed`, `SessionTasksTab`'s `current`), so it LOOKS filed
in the aside and the delivery panel — but `rowsOfTask` never finds it, so the task's rollup, its
`sessionsUsed` count, and `agentistics_task`'s `sessions` list are permanently silent about a
session that was created specifically for it.**

**The same root cause also affects `suggestDelivery`'s auto-fill** (`NewSessionModal.tsx` lines
199-206): accepting a suggested task title (never dismissed, never routed through `TaskPicker`)
sets `task` without ever setting `subtaskTarget`, for any REAL (non-legacy) task the suggestion
names. This is pre-existing, silent, and shares the identical fix.

**The fix** (implementation, not this round's work, but specified so a subtask can be filed
precisely):

1. `NewTaskWizard`'s `onCreateSession` and `TasksPage.tsx`'s handler already have `taskId` — thread
   it through as a new `initialTaskId?: string` prop on `NewSessionModal`, alongside the existing
   `initialTask` (kept as the label pre-fill, unchanged).
2. Generalize `subtaskTarget: {taskId, subtaskId}` to allow `subtaskId` to be **absent** — `{taskId,
   subtaskId?: string}` — since §4.1 of the 2026-09-10 spec makes a bare task-level attach valid.
   On mount, if `initialTaskId` is given and no `TaskPicker` selection has overridden it, seed this
   state with `{taskId: initialTaskId}` (no subtask — the wizard from `/tasks` never asked for one).
3. `start()`'s attach block (line 589) already gates on `subtaskTarget && json.id` — with the type
   widened, it becomes `attachSession(taskId, json.id, subtaskId)` (subtaskId possibly `undefined`,
   which the existing client (`web/src/lib/tasks.ts` line 513) already sends as a bare
   `{sessionId}` body when absent — no change needed there).
4. The suggestion-acceptance path (§199-206) gets the same treatment: when the suggested title
   matches an existing task row in `taskRows`, resolve its real id and set the SAME state
   (`{taskId}`, no subtask) instead of only writing the free-text label.

This turns `task` (the free-text field sent to `/api/fleet/new`) into what its own name always
implied but never guaranteed: a **display label**, always backed by a real `attachSession` call
when the label was chosen from something real — never the only record of the intent.

### C.3 Task name above the session title, in the list

Confirmed component: `SessionFacts.tsx` — the row shared by the open aside list (`SessionsAside.tsx`
line 938) and the collapsed rail's tooltip (per its own docblock). Today the delivery is a small
`Bookmark`-prefixed segment on the META line, below and same-size as the title (lines 44-116).

**Change**: when `session.task` is set, render it as its own line **above** the title —
small/muted, matching the visual weight `microLabel` already gives other row-level context — and
bump the title's `fontWeight`/`fontSize` slightly (the request: "título um pouco maior"). The
existing `Bookmark` segment on the meta line, and its `onFile` click target, are UNCHANGED — that
one already does its job (open the filing picker) and stays where a reader expects a click-to-file
control; this is purely about WHERE the delivery's NAME is read, not about adding a second control
for the same gesture.

```tsx
<span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
  {session.task && (
    <span style={{
      fontSize: 9.5, color: 'var(--text-tertiary)', fontWeight: 600,
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    }}>{session.task}</span>
  )}
  <span style={{ fontSize: session.task ? 13.5 : 12.5, fontWeight: ... /* unchanged rule */ }}>
    {session.title}
  </span>
  {/* meta line: unchanged */}
</span>
```

Because `SessionFacts` is the ONE component behind both the open list and the rail tooltip, this
one change covers desktop and mobile — `SessionsAside.tsx` renders the same rows on both layouts
(the mobile branch of `SessionsPage.tsx` mounts `SessionsAside` directly, line 1036). No separate
mobile version to write.

### C.4 The "Entregas" panel dumps raw markdown

Confirmed: `SessionTasksTab.tsx` renders `DeliveryDetail` in `dense` mode (line 138-144) — the
exact component `/tasks/:id` renders — and `DeliveryDetail.tsx`'s description block (the
`!editing` branch, line 869-888) shows `task.detail` through `CommentBody`/`ReactMarkdown` with no
folding at all. The 974-character description on this very task (`e66414ca-image.png`, matching
the char counter in the SAME component's edit view, line 930) renders as one unbroken scroll —
confirmed directly against `t-918cc82233`'s own `detail` field, which is exactly the four
paragraphs shown unfolded in screenshot `263c7eef-image.png`.

**Design decision: fold by markdown heading when the text has any, otherwise a single
expand/collapse — never invent section boundaries prose does not have.** This task's own
description uses **bold inline lead-ins** ("**Possibilidade nº1 (mais simples)**: ..."), not `#`
headings — splitting on bold spans would be guessing at structure the author did not declare. So:

- If `task.detail` contains one or more markdown heading lines (`/^#{1,6}\s+.+$/m`), split on them
  and render each section as a `RailSection` (`packages/web/src/components/tasks/RailSection.tsx`
  — already the primitive `DeliveryDetail`'s own rail uses for Tokens/Links/Bloqueada por, per
  screenshot `3895ea5b-image.png`; `id`/`title`/`badge`/`defaultOpen`/`children`, already
  remembers its open state per browser). Content before the first heading (if any) renders
  un-folded, as a lead paragraph.
- If it contains none — this task's own case — the WHOLE description becomes one collapsed block: a
  short preview (first ~2-3 lines) plus "mostrar tudo / show all," expanding in place. This is a
  single `RailSection`-shaped disclosure, not N invented sections.
- Either way, this is **read-only presentation**. The edit view (`editing` branch, unchanged) keeps
  editing the whole string as one textarea — folding is not a second data model, it is how the
  same string is DISPLAYED.

This lives entirely in `DeliveryDetail.tsx`'s non-editing branch (a new small helper, e.g.
`DescriptionView`, replacing the bare `<CommentBody>` call at line 874) — and because
`SessionTasksTab` renders the identical component, this fixes the aside panel and the `/tasks/:id`
page's own description at once, on both desktop and mobile (`dense`/non-`dense` is layout-only per
the component's own docblock, line 16-19).

### C.5 The panel shows TASK-wide fields when filed under a SUBTASK

This is the clearest, most concrete of the six reports, and it is exactly what `SessionTasksTab.tsx`
already has the pieces to fix — it just does not use them yet.

**What's wrong today**: `SessionTasksTab.tsx` (line 64) fetches the WHOLE `TaskDetail` via
`useTaskDetail(current?.task.id)` and passes it straight to `DeliveryDetail` unfiltered (line 138).
`DeliveryDetail` then renders the TASK's own status/priority/assignee/dates (screenshot
`3895ea5b-image.png`) and the TASK's own delivery-evidence numbers (files 123, errors 22, lines
+7922/-771, tokens 153.9M — matching `t-918cc82233`'s own `stats` block exactly, confirmed against
the task's real numbers read via `agentistics_task` above) — **even when the session is filed under
one specific subtask**, where the honest numbers are that subtask's own `subtaskRollups` entry, not
the task's.

**The component already computes the right answer and throws it away.** `here` (line 75-78) already
resolves the exact subtask title the session sits in — it is used only for the small "na parte X"
pill (line 104-108) beside the filing buttons, and nowhere else.

**The fix**: when `here` resolves to a subtask (not the direct branch), the panel needs a
subtask-scoped view, not the full `DeliveryDetail`:

- **Status/priority/assignee/dates**: the SUBTASK already carries its own `status`, `assignee`,
  `dueDate`, `startDate` (`task-model.ts`'s `Subtask`, line 289-315) — a subtask-scoped header shows
  THESE, not the task's `TaskFieldPatch`-driven status dropdown. (There is no subtask `priority`
  field today — that column is task-only, so a subtask-scoped view either omits the priority row
  entirely or states in words that priority is set at the delivery level; omitting is the honest
  choice, matching the same "N/A over a confident but wrong number" rule this codebase applies
  everywhere else, rather than showing the task's priority as if it belonged to the subtask.)
- **Delivery-evidence numbers (files/errors/lines/tokens/commits)**: these come from
  `TaskStats`/`DeliveryEvidence`, computed over `rowsOfTask(task, rows)` — the WHOLE task's rows.
  There is no subtask-scoped equivalent of `taskStats` today; one is needed
  (`packages/server/server/sessions/task-stats.ts`), filtering the same computation to
  `rows.filter(r => r.subtaskId === thisSubtaskId)` (or the group's member set, once §B ships) —
  the identical partition `subtaskViews` already applies to the ROLLUP, extended to the other stats
  block. **This is new server-side work**, not a client-side re-filter — the underlying commit/file
  scan (`getCommitsInWindow`, git stats) has no per-session granularity to filter after the fact
  client-side; it has to be recomputed over the narrower row set.
- **Comments**: `TaskComment` (`task-model.ts`) carries no `subtaskId` today — comments are task-wide
  by design (they are the delivery's log, not a per-piece one). **This part of the request is
  therefore out of scope as stated** — scoping comments to a subtask would need a new field on
  every comment and a decision about where a comment made "about the subtask" should show when read
  from the task's own page, which the six existing subtasks and this task's own comments never
  needed to answer. Flagged rather than silently dropped: the panel should keep showing every
  comment (task-wide), and a future request to scope comments is its own, separate piece of work.

**Component shape**: rather than teaching `DeliveryDetail` a `scopeToSubtask` prop (which would
mean every one of its many internal reads — status, dates, the rail sections, the table rows —
individually branching on it, spreading the concept through a 1420-line component that today never
needs to know about a single subtask), `SessionTasksTab.tsx` should render a **new, smaller,
subtask-scoped view** when `here` names a subtask — reusing pieces of `DeliveryDetail` where they
already work unmodified (e.g. `SubtaskSessions` for the chip list, `RailSection` for the stats),
rather than teaching the big component two contradictory modes at once. This is the shape
`SessionTasksTab`'s own docblock already half-describes ("what stays local is the FILING... the one
thing this tab answers that the page does not") — this extends that same local half rather than
threading a new mode through the shared page component. Naming and exact composition are an
implementation decision; this spec commits to the DATA answer (subtask-scoped status/dates/stats,
task-wide comments) and the STRUCTURAL one (a sibling view, not a mode flag on `DeliveryDetail`).

**Mobile**: `SessionTasksTab` already renders inside the mobile aside exactly as it does on
desktop (it is the tab content, not a layout branch) — no separate mobile version needed beyond
whatever `RailSection`/`SubtaskSessions` already handle (both already `isMobile`-aware).

### C.6 A flag icon near the session title — linked / unlinked

**Placement, decided**: the OPEN session's own title bar, not the aside list row. Point C.3 already
covers the LIST ("na lista/cards de sessões... mostrar o nome da task"); this point names "perto do
título da sessão" without "lista," and its behaviour — "clique sem task → abre modal de criar task;
clique com task → abre o aside da entrega" — is a per-open-session action, which only the header of
an OPEN session has room to mean unambiguously. Putting a second delivery-control on the already
dense aside-row meta line (which already has the `Bookmark` control from C.3) would be two icons
doing adjacent things on one crowded row.

**Three places currently render an open session's title**, confirmed by reading each:

- Desktop shared header: `App.tsx`, lines 3055-3073 (`selectedFleetSession.title`).
- Mobile panel header: `SessionsPage.tsx`, lines 796-812 (the `panel && selected` branch).
- Mobile dedicated-terminal header: `SessionsPage.tsx`, lines 704-716 (the `dedicatedTerminal &&
  selected` branch).

All three currently duplicate the same title+state markup inline. Rather than pasting a fourth copy
of "flag icon, filled orange when `task` is set, dotted outline otherwise, opens `NewTaskWizard`
or `SessionTasksTab`'s panel depending on state" into three places (which is exactly the kind of
duplication CLAUDE.md calls out for `task-reopen.ts`/`session-table.ts` elsewhere — "one gesture
implemented twice is the bug this exists to have fixed once"), extract a small shared
`SessionTitleFlag` component (or fold the flag into a slightly generalized version of
`SessionFacts`'s title rendering, since that already has the exact `session.task` check needed) and
use it in all three headers.

- **No task** (`session.task` unset): outlined/dotted flag. Click → opens `NewTaskWizard` (already
  exists, already supports a `session` pre-link prop per its own signature at line 28) — this is
  the SAME dialog `SessionTasksTab`'s own "Nova tarefa para esta sessão" button opens (line 177),
  so no new creation flow, only a new entry point into the existing one.
- **Has task** (`session.task` set): filled orange flag. Click → opens the session's own aside on
  the Deliveries tab — on desktop this is `openArtifacts('tasks')`-shaped (matching the pattern
  `chatNote.ts`'s `systemRef` navigation already uses for "open this tab of the aside," per
  CLAUDE.md's "A SYSTEM NOTE... GOES WHERE ITS ACTION IS" section); on mobile, wherever the
  Deliveries tab is already reached from (the artifacts pane/tab bar for that session).

This needs no server change — `session.task` is already on the wire (`ControlSession.task`,
`session-fleet.ts` line 596) and is exactly the fact the icon's two states are keyed on.

## D. What this spec does NOT decide

- **C.1's "recent deliveries" list** — named as a smaller follow-up, not speced in full (§C.1).
- **Comment scoping to a subtask** (part of C.5's original ask) — out of scope, reasoned in §C.5.
- **A human name for a subtask group** — deliberately absent, reasoned in §B.5.
- **The preset/wake session idea** (`s-d85c7d9d9d`) — untouched, a different topic per the task's
  own history.
- **Sending group rollups or subtask-scoped stats to a central** — neither travels today (the
  2026-09-10 spec's §4.3 already draws this line for the plain per-subtask rollup); extending
  central sync for either is separate work if wanted later.

## E. Subtasks filed from this spec

Each is independent where the dependency graph allows, and named for the one file/behaviour it
changes — see the board (`t-918cc82233`) for exact ids and `blockedBy` wiring.
