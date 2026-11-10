# Deterministic registration and approximate delivery forecasts

Date: 2026-11-09. Status: proposed implementation design; no runtime change in this document.
Tracking: Agentask `t-e1dea7cd6f` / `s-0836fc80ad` (REGISTRO.DETERMINISTICO).
Static baseline: `f8f2cdad0`, v2.204.2, branch `docs/registro-deterministico`.

## Outcome and boundaries

The server guarantees registration and a visible approximate forecast without relying on an
assistant remembering instructions. New tasks and subtasks require an explicit priority; workers
must have a valid subtask before execution; filing starts the work automatically; a leader doing
otherwise unregistered implementation gets its own piece. Every open piece has a computed range
on Live and Calendar. An optional stated deadline takes display precedence over that range.

These are the owner's decisions recorded on 9 November, not alternatives for reconsideration.
Titles, scope boundaries and the truth of an assistant's delivery still need judgment. A forecast
is an approximation, never a promise of publication or evidence of progress.

This is a documentation-only delivery: static reading, no installations, application execution,
tests or PR. Implementation changes public schemas and launch behavior: the implementation leader
must link an Ideas Discussion and a scoped Issue before code, following AGENTS.md. The existing
Agentask piece is the durable record for this design. Open Issues and the GitHub project were
inspected; this document does not create a second implementation issue or open a PR.

## What exists, and where it falls short

Paths below are relative to the repository. `S/` means `packages/server/server/`.
Names marked **new** are proposed functions/files, not claims about the baseline.

| Existing source | Current behavior and reuse |
| --- | --- |
| `S/sessions/task-web.ts`: `createTask`, `addSubtask`, `editTask`, `patchSubtask` | Shared mutations for HTTP and the engine board. Creation defaults task priority to `low`; subtasks have no priority column. |
| `S/sessions/task-model.ts`: `migratePriority`, `statusAfterAttach`, `marksStart` | Missing/unknown legacy priorities read as `low`. Filing advances `todo`/legacy backlog, and status transitions stamp first start. Keep these transition predicates. |
| `S/sessions/task-store.ts`: `createTaskStore`, `sanitizeTask`, `sanitizeSubtask` | Persistence and whitelist parsing. A new stored column needs round-trip support here, not only in a response. |
| `S/sessions/spawn-filing.ts`: `planFiling`; `spawn-filing-io.ts`: `planSpawnFilingSafe`, `checkAttach` | Shared launch filing. `checkAttach` skips a worker with no task; an inherited task without subtask becomes an unfiled worker with a warning. An explicitly named task without subtask is refused. |
| `S/sessions/cli-session.ts`: single and batch starts; `S/cli-start.ts`: `spawnSession` | Both ask the filing planner. `spawn-configuration.ts` configures the already running child and can report configuration pending. That is too late for mandatory worker filing. |
| `S/sessions/task-attach.ts`: `planAttach`, `directFilingAllowed` | Pair consistency, blockers and group membership already have one planner. Worker direct filing is checked separately by `attachSession`. A group member cannot hold a session; its group can. |
| `S/sessions/task-web.ts`: `attachSession`, `attachConversation`, `fileNativeSession`, `detachSession` | Fleet filing advances both task and subtask when unstarted. Native filing advances the task only. Existing in-progress records missing a start stamp are not repaired merely by reattaching. Historical filing must remain historical. |
| `S/sessions/task-live-steps.ts`: `sessionActivityOf`, `deriveStep` | Shared normalized edit counts, test counts and commit-command counts feed Live steps. These are observations, not write interception or proof a git command succeeded. |
| `S/sessions/task-report.ts`: `buildTaskDetail`; `task-times.ts`: `pieceTimes` | Session metadata provides activity; piece timing prefers linked sessions over status stamps. Keep observed start/active time distinct from any forecast. |
| `S/sessions/task-live.ts`: `buildLive`, `estimateEta`, `stageTypicals`, `estimateStages` | Total median from at least three samples matching harness/model, then harness; stages compose into `publishEta`, with total fallback. Missing history, no start and overruns return `none`. Some open pieces are hidden by queue/live-session filters. |
| `S/sessions/task-web.ts`: `liveReplyForBook`, `liveDeliveries` | One cached source for Web and MCP; source-version invalidation, five-second maximum age and in-flight sharing already exist. Extend this cache instead of adding per-card reads. |
| `S/delivery/calendar.ts`: `readCalendarSources`, `deliveryCalendar`; `packages/core/src/deliveryCalendar.ts`: `buildCalendar`, `piecePresence` | Calendar consumes Live `publishEta`. No forecast means activity blips rather than future placement. Some record-only pieces get `none`; task deadlines are carried separately. |
| `packages/web/src/components/tasks/liveCardModel.ts`: `etaBoxes`; `liveDeliveryModel.ts`: `etaText`; `components/calendar/CalendarDetail.tsx` | Existing estimate displays must render the same range and source. No browser-side estimate formula. |

EVOLUCAO.ETA is the queued piece `s-86df3291ae`: save ETA and confidence in `DeliveryRecord`
at dispatch so Evolution can measure forecast accuracy, plus owner-request preparation counts.
The code does not yet provide that frozen dispatch prediction. Reuse the forecast below for its
snapshot; do not introduce a second ETA algorithm. Request preparation counts remain outside this
spec. `docs/delivery-flow.md` remains the reference for delivery phases, gates and Live projection.

## Shared policy and write boundary

Add **new** `S/sessions/task-registration.ts` as the pure registration policy. Its functions return
typed plans/refusals; they do not perform IO. `task-web.ts` owns applying those plans for every
write surface. Routes, MCP, CLI, UI and engine host bindings never decide the rules independently.
Existing `planAttach`, `statusAfterAttach` and `marksStart` are called, not copied.

Add **new** `applyRegistration` in `task-web.ts`, backed by a serialized registration operation in
`createTaskStore`. It coordinates task/subtask writes, registry/native filing, status/start stamps,
events and an idempotency key. Current board and registry files are separate: a series of awaits
is not a transaction. Persist a small registration intent before cross-file writes, mark completion
only after both persist, and recover incomplete intents before launch/resume admits model input.
The intent belongs with existing board persistence, not in the analytics event journal. A crash
must leave a recoverable intent, never an executing unfiled worker. Replays produce one piece and
one start event. Unrelated board writes must share the existing store serialization and cannot
overwrite the operation with an old book snapshot.

The analytics journal remains observational. Do not fail journal append or discard genuine
historical events because a board registration is missing. A separate idempotent consumer repairs
registration from accepted activity, as described below.

### Rule 1 — explicit priority on creation

One decision: **new** `requirePriority(raw)` in `task-registration.ts`, invoked by `createTask` and
`addSubtask` before deduplication or any write. Validate supplied values on priority edits too.
Accepted values are the existing `urgent | high | medium | low`; no numeric P0 inference.
Omission, null, empty string, `none` and unknown values refuse. Parent priority is not silently
inherited on a *new* subtask request. A UI may offer "Use parent priority" only as a visible choice
that sends the actual value. An auto-created leader piece explicitly copies the known parent
priority and records `source: parent` in the creation event.

Add required `Subtask.priority` to new records and task detail, shared-task transfer and Live
projection; a subtask's own priority wins over the task's. Groups and members also require it.
For task edits, omitting priority means leave it alone; explicitly clearing it refuses. Return a
structured result from creation instead of turning all failures into `title_required`/null.

| Code / HTTP | English | Portuguese |
| --- | --- | --- |
| `priority_required` / 422 | Priority is required to create a task or subtask. Send urgent, high, medium or low. | A prioridade é obrigatória para criar tarefa ou subtarefa. Envie urgent, high, medium ou low. |
| `bad_priority` / 422 | Priority must be urgent, high, medium or low. | A prioridade deve ser urgent, high, medium ou low. |

Use shared localized refusal formatting; preserve the code in HTTP JSON, MCP error data and CLI
JSON/nonzero exit. Remove `index.ts`'s separate priority decision, which currently returns 400 only
for unknown supplied values. Domain validation must also refuse direct engine board calls.

Breaks and migration:

- `packages/mcp/agentistics-mcp.ts` task-create schema/handler currently makes priority optional;
  task-subtask schema/handler drops priority entirely. Require and forward it on creation; offer
  it on edits. A schema error must still identify the missing field, and bypassing the schema
  reaches the identical domain refusal.
- `S/index.ts` task/subtask POST routes, `S/engine/engine-board.ts` host interface and forwarding,
  Web `lib/tasks.ts`, `TasksPage.tsx` create/accept-suggestion/import/group handlers and task
  creation/detail dialogs need the field. Audit TUI task editors and VS Code consumers as well.
- `packages/server/scripts/e2e-native-chat.ts` currently creates both
  records with titles only. Update this and creation fixtures/call sites; do not make a test-only
  bypass. `agentop task` currently has no create/subtask command: do not invent one in the proof;
  exercise its actual mutations, session launches and CLI delivery preparation instead.
- Existing `migratePriority` stays a *legacy reader*, not a new-request validator. Run an
  idempotent schema-versioned migration before strict writes: missing/invalid task priority gets
  `low`; subtasks missing priority get the parent's migrated value. Preserve explicit valid values,
  archived work, identifiers and timestamps. One migration event records counts and source; no
  invented user triage, no per-poll writes. A parent edit does not later rewrite child priority.
- `ensureLegacyTasks`/`migrateLegacyTasks`, shared imports and restore paths must be identified
  migration operations that supply normalized priority explicitly. They are not public switches
  permitting new callers to bypass `requirePriority`.

### Rule 2 — worker filing before launch, without exceptions

One decision: **new** `requireWorkerTarget(role, resolvedTarget)` in `task-registration.ts`.
`planFiling` calls it after resolving inherited task and explicit/predecessor subtask references.
It requires both a real task and a session-bearing subtask/group of that task for every effective
worker. `planAttach` still validates blockers and group rules. Remove the inherited-unfiled warning
branch from `checkAttach` and its no-task early escape. `--shared-cwd` controls checkout sharing
only; it never relaxes filing. `--force` memory overrides, batch, reopen, replacement, account
switch, `--handoff`, direct HTTP and engine entry points cannot relax this rule.

Resolve effective role from verified parent/registry/stored role first. A caller cannot label a
parented worker as unknown/person/leader to skip it: an existing leader/handoff is verified under
the existing role policy; any requested promotion uses that policy and must not erase existing
worker registration. Turning an already running unfiled session into a worker requires a target
in the same operation or refuses (`session-roles.ts` setter included). A worker cannot detach
without an atomic move to another valid subtask; deleting its target must refuse while it runs.

| Code / HTTP | English | Portuguese |
| --- | --- | --- |
| `worker_needs_subtask` / 422 | A worker must start on a subtask. Create one with priority, then pass --task and --subtask (or taskId and subtaskId). | Um worker precisa iniciar em uma subtarefa. Crie uma com prioridade e envie --task e --subtask (ou taskId e subtaskId). |
| `worker_cannot_unfile` / 422 | This worker must stay on a subtask. Move it to another subtask or stop it first. | Este worker precisa permanecer em uma subtarefa. Mova-o para outra subtarefa ou encerre-o primeiro. |
| `registration_unavailable` / 503 | Registration could not be saved. No worker was started; retry this request. | Não foi possível salvar o vínculo. Nenhum worker foi iniciado; tente esta solicitação novamente. |

Launch sequence: resolve/validate target → reserve a child identity and registration intent →
persist filing and initial status/stamp → create process in a held state → complete registration →
release prompt/model execution. If backend creation fails, record failed launch and release its
reservation; if configuration fails, keep that exact child held and repair, never run unfiled or
spawn a replacement blindly. A backend without a held launch must commit registration before its
spawn call. Keep existing spawn outcome handling, but do not treat "running, filing pending" as
an acceptable worker outcome. Preflight refusal creates neither process nor phantom live row.

ENGINE worker migration is explicit: the initiating leader creates a priority-bearing subtask
first, then starts its engine-worktree session with
`agentop session <harness> --task t-… --subtask s-… --cwd <engine-worktree> --shared-cwd …`.
The task may belong to the public host repository while work is in the engine repository: use an
explicit server-known allowed checkout/repository association for that task's staged piece, rather
than lying about cwd or adding an "engine worker" filing exception. The existing explicit-task
repository check otherwise refuses this combination. Such an association must be scoped to that
piece and authorized by its task leader, audited, and preserved in the staged launch; inherited
repository warnings are not authority to override it. This adds a launch-plan contract, not a
blanket repo-check override. Until supplied, refuse the launch and name the checkout mismatch.

Update these callers before enabling the gate: `sessions/cli-session.ts` single/batch/reopen;
`cli-start.ts` `spawnSession` and native-session creation/filing; `delivery/host.ts` staged dispatch;
Web/TUI/VS Code wizard payloads; `spawn-row.ts` role resolution; `engine/load.ts` host task bindings.
Native `ses_…` sessions need a trusted effective role/target at creation, not a caller assertion in
`fileNativeSession`. Their run/compose admission must require the same validated registration.

Existing running unfiled workers are not killed or given permission to remain an exception:
reconcile before accepting their next managed input/run. If their verified parent has a task,
create one recovery subtask per worker (title `Recovered work: <session title or id>`, explicit
parent priority), attach and record provenance. Do not guess which sibling they meant. Without a
verified task, hold further managed execution and expose the refusal/repair through MCP and UI.
Stopped historical conversations remain historical and can be repaired without starting work now.

### Rule 3 — attachment starts the piece

One decision: **new** `planAttachedStart` in `task-registration.ts`, reusing `statusAfterAttach` and
`marksStart`; applied by `applyRegistration` for fleet and native filing and spawn reservation.
`todo`/legacy backlog becomes `in_progress`; an empty `startedAt` is filled on successful live
filing even if status already reads in-progress/review. Never overwrite an existing stamp or move
review/blocked/completed work backward. Stamp the parent if empty as existing subtask progress
does. Use one server timestamp for the new filing and start event. Session-derived historical
start in `pieceTimes` remains a distinct read fact and can be earlier.

Successful reply returns `taskId`, `subtaskId`, effective status and `startedAt` (and existing
`movedFrom`). A refused target writes no start. No additional refusal code for a valid attachment;
invalid/blocked/other-task/member targets keep `planAttach`'s existing named refusals and localized
sentences. IO failure uses `registration_unavailable` above and leaves a recoverable intent.

Breaks and migration: replace the scattered post-attach nudges in `attachSession` and
`fileNativeSession`; callers must not issue a second manual status update just to start work.
`attachConversation` uses historical evidence and must not stamp "now" as historical work's start.
Repair missing starts on already-linked open work from earliest valid linked-session start, else
first recorded real-progress event, else recovery time explicitly labeled as recovery. Do not
claim a recovered timestamp was observed in the past. Repeated filing returns the same stamp.

### Rule 4 — leader implementation acquires a piece

One decision: **new** `planLeaderWorkRegistration` in `task-registration.ts`; one IO consumer
**new** `reconcileLeaderWork` in `task-web.ts` uses the same `applyRegistration`. It takes trusted
session identity, effective role, current filing and a normalized observed activity id/time.

A leader is covered if filed on its own open session-bearing subtask, or it coordinates an open
piece through a persisted delivery `leaderSessionId` or verified live child on that same task.
An arbitrary open sibling, matching title or browser filter is not proof of coordination. When
coordinating, keep the task-level leader filing and record the activity's coordinated piece ids;
do not guess one child to move onto. A closed piece does not cover new implementation.

On the first edit/commit signal without such coverage, create and file one ordinary subtask:
`Implementation: <leader title or session id>`, explicit parent priority, open status and server
start, event carrying source activity id. Key deduplication by task + session + uncovered-work
episode, not by title. Concurrent edit and commit signals, process restart and event replay must
converge. Closing this piece and doing more work creates a new episode. The leader retains its
leader role and delivery authority after gaining a subtask. With no valid task/priority or a failed
write, managed tool/run admission refuses or holds until registration is repaired; no arbitrary
task is invented.

| Code / HTTP | English | Portuguese |
| --- | --- | --- |
| `leader_work_needs_task` / 422 | Register this leader on a task with priority before editing or committing. | Vincule este líder a uma tarefa com prioridade antes de editar ou fazer commit. |
| `leader_work_registration_pending` / 503 | Implementation registration is pending. Repair the reported task link before the next managed action. | O registro da implementação está pendente. Corrija o vínculo informado antes da próxima ação gerenciada. |

#### Real signals and harness coverage

`S/harness-activity.ts` already provides `canonicalTool` and `countGitCommands`. `task-report.ts`
passes metadata through `sessionActivityOf`; `deriveStep` consumes it. Reuse that vocabulary for
registration, but consume activity during ingestion/managed execution, **not inside GET Live**.
Read requests must never create subtasks. Persist a cursor/event key; compare against a baseline
on the current filing episode so old lifetime counters do not create new pieces on every poll.

| Harness | Existing observable source | Necessary treatment |
| --- | --- | --- |
| Claude Code | `S/jsonl.ts` Edit/Write/MultiEdit calls and shell commands → `tool_counts`/`git_commits` | Consume normalized observations. `claude-hooks.ts` installs SessionStart/Stop hooks, not a universal pre-edit hook; do not claim it blocks writes. |
| Codex | `S/adapters/codex-parse.ts`; `sessions/codex-chat.ts`; aliases `apply_patch` → Edit, `exec_command`/`exec` → Bash | Inspect structured shell arguments when present. Nested orchestration summaries may hide commands; missing data means unknown. |
| Gemini | `S/adapters/gemini-parse.ts`; `sessions/gemini-chat.ts`; write/replace tools and `run_shell_command` | Both current and older transcript shapes need fixtures. Some fallback parsing returns zero commit counts; not proof no commits occurred. |
| Copilot | `S/adapters/copilot-parse.ts`; `sessions/copilot-chat.ts`; `apply_patch`/shell aliases | Same shared normalization, no Copilot-specific policy. |
| Antigravity | `S/adapters/antigravity-parse.ts`; `sessions/antigravity-chat.ts`; write/replace and run-command tools | Parsed artifacts can expose activity; `adapters/antigravity.ts` also has metadata paths returning zero. Preserve unknown coverage. |
| Kimi | `S/adapters/kimi-parse.ts`; `sessions/kimi-chat.ts`; Claude-style edit names and shell totals | Reuse parsed calls, not title or terminal-text heuristics. |
| OpenCode | `S/sessions/opencode-chat.ts` / `opencode-store.ts` normalize tool parts; `adapters/opencode-parse.ts` currently emits empty tool counts and zero commits | Feed normalized tool-part activity into the shared observation stream; metadata alone is insufficient today. |
| Native Agentistics / other registered harnesses | Managed tool execution and canonical `tool.requested`/`tool.completed` events; `engine/load.ts` host bindings | Gate before dispatch where supported. A new harness must declare activity coverage or acquire a piece before any managed implementation run. No harness-name exemption. |

Canonical journal events (`packages/core/src/canonical/event.ts`) and `journal/import.ts` replay
are reusable transport with event ids. They are not complete command evidence: `projections/
session-meta.ts` explicitly lists `git_commits` as unavailable from shell summaries. Use original
structured tool input at ingestion when available; do not add command/secret payloads to events
just for this feature. Emit only activity kind, session identity, timestamp, source id and coverage.
Counters denote attempts: a failed edit/commit can acquire a piece harmlessly. A confirmed commit
requires successful tool outcome or repository evidence, separately from this registration trigger.

For managed engine execution, register before dispatching edit or commit tools. For external CLI
harnesses, transcript observation occurs after the action: automatically create/file upon ingest,
then hold the next managed action if repair fails. At leader task-only registration on a backend
that cannot observe activity reliably, acquire its implementation subtask conservatively before
the next managed run. This is the portable fallback, not "no activity seen means no work".
An external process with no interceptable input can still write before the server sees it; a
server policy is not an OS filesystem sandbox. This limitation is explicit in acceptance/reporting.

Existing leaders with uncovered activity are reconciled once from available signals; unknown
coverage uses conservative registration before their next managed run. Do not reinterpret old
coordination counters as fresh edits or move an unrelated historical delivery.

## Rule 5 — one server forecast, including cold starts and overruns

One source: extend `task-live.ts`'s `estimateEta`/`estimateStages`, with **new**
`resolvePieceForecast` composing their result. `buildLive` calls it for all open pieces before
visibility filtering. Calendar calls the same server projection for record-only/idle pieces;
`buildCalendar` only maps and places its result. Never implement another estimator in core,
the browser, MCP, CLI or Evolution. `publishEta` remains the publication forecast; stage ETA is a
different milestone. Add interval/source metadata to the existing estimate variants rather than
creating an unrelated `predictedDueDate` stored on each task.

### Population, method and range

Forecast wall-clock time to publication, including QA/review/release stages; active minutes are
displayed separately. The current total samples use session-based `PieceTimes.durationMs`, whose
completion may precede publication. Keep that dataset labeled `work-span`, never call it measured
publication time. Prefer completed delivery records with real first-start and `publishedAt` for
end-to-end samples; use closed stage visits for stage samples. Do not mix the two endpoints in a
single average. If only work spans exist, use them as a low-confidence fallback with the general
widening below and label the basis. Do not infer completion from handback.

Build bounded cohorts from the latest 500 valid terminal pieces in the last 90 days. Positive,
finite, ordered timestamps only; exclude abandoned pieces, recovered/fabricated spans and
duplicate parent/group rollups when their leaf/session-bearing pieces are already sampled.
Multiple sessions on one piece produce one sample. Keep blocked waits in wall-clock publication
history, with reason metadata; do not silently erase long outcomes. Bound sample *count*, not
duration, and expose sample count/exclusions in diagnostic data.

1. Similar = same task type and lifecycle endpoint, harness and model; at least **3** samples.
   Relax to same type + harness, then same harness with the same endpoint, still at least 3.
   Avoid title similarity or embeddings. Missing type/model simply skips that cohort.
2. With sufficient similar history, center = median; lower/upper durations = p25/p75, widened
   to at least 25% of the median on either side and a minimum 15-minute half-width. Quantiles
   use existing linear interpolation. Confidence uses the existing sample-count/spread rule:
   high at n ≥ 8 and IQR/median < 0.6, medium at n ≥ 4 and ratio < 1.2, otherwise low.
3. Without a sufficient similar cohort, use the **arithmetic mean** of the general cohort with
   the same endpoint (minimum **3**). Center = mean; lower = min(p25, mean/2), upper =
   max(p75, mean*2). For 3–7 samples or work-span-only history, widen further to
   lower ≤ mean/4 and upper ≥ mean*3. Confidence is always low and source says general average.
4. If even the general cohort has fewer than 3, use a versioned bootstrap policy, **4 h center,
   1–12 h range**, source `bootstrap`, n = 0 usable samples, low confidence. This is a declared
   planning assumption, not a learned average. The server must still produce an approximation;
   zero history cannot produce a blank card. Keep constants in the estimator module.
5. Existing stage composition remains preferred when every required stage has sufficient visits.
   Sum remaining-stage centers and bounds, including the remainder of the current stage; use
   the minimum component confidence/sample count. Stage intervals must receive the same
   quantile/minimum-width treatment. If any stage is unknown, resolve the whole-piece fallback
   once; never add a complete work-span estimate to already elapsed stages.

For a started piece not past its upper duration, subtract elapsed wall time from duration bounds,
floor the remaining lower bound at 15 minutes, keep upper ≥ lower + 15 minutes, and clamp the
center into the resulting interval. If the original median is already past, mark `overrun: true`;
do not return `none` or show "approximately now" indefinitely. Once elapsed reaches the upper
bound, choose the general fallback's *remaining* center/range, anchored to a persisted overrun
bucket boundary, mark `revised-overrun`, and widen its upper remaining duration by
`min(4, 1 + elapsed / originalUpper)`. Reevaluate at most hourly, not on every poll. Persist only
the bucket anchor in the forecast cache so a restart does not roll the date forward arbitrarily.
This is deliberately weak evidence: display "longer than usual; revised approximation".

For queued/unstarted pieces, anchor to the server's existing staged schedule/active queue hold
`until`, bounded below by now; absent a known schedule, anchor to now and mark
`queue-time-unknown`. Say "if started now" rather than inventing a start date or queue capacity.
Blocked work always retains its range and block reason, with `conditional: blocked`; it is an
approximation **after resumption**, not a scheduled unblock date. The calendar renders this
conditional range distinctly and does not treat it as a confirmed commitment.

### Worked examples

At 10:00, a running piece started at 09:00. Four comparable published pieces took
3, 4, 4 and 5 hours. Median = 4 h, p25 = 3.75 h, p75 = 4.25 h. Minimum proportional widening
gives 3–5 h total, so 2–4 h remain, center 3 h: **approximately 12:00–14:00, center 13:00**.
n = 4 and IQR/median = 0.125 give medium confidence. The display says it is based on four
similar published pieces. It does not say the piece is 25% complete.

For a new harness with no similar history, general publication durations 2, 4 and 6 h give
mean 4 h; the small general sample widens to **1–12 h**. At 10:00, an unstarted piece therefore
shows **approximately 11:00–22:00, if started now**, low confidence, general average, n = 3.
With no usable history it has the same initial range, but source explicitly says bootstrap and
n = 0. These two sources must not look like the same level of evidence.

### Payload, deadlines, visibility and screens

Extend `LivePublishEta` estimate with `earliestAtMs`, `latestAtMs`, `confidence`, `basis`
(scope, endpoint, n, statistic, exclusions), `computedAtMs`, `methodVersion`, `overrun`,
`conditional` and `assumption`. Keep `atMs`, `source`, `n` and `parts` compatible during rollout.
Extend `LiveEta` basis scope for general/bootstrap and carry equivalent bounds so the Live summary
does not report "no delivery has an estimate" while its cards have forecasts. For terminal pieces,
`none: final` remains valid. An open piece can no longer have `none: no-history/not-started/
beyond-range` as its publication answer. Stage ETA can remain unknown with a reason.

Optional `dueDate` remains a stated date, stored independently of the computed range. Restore an
optional due-date control where necessary: the baseline model retains these fields while current
UI stopped offering them. Validate real ISO calendar dates. Precedence is subtask deadline,
then task deadline, then computed publication center for primary display/placement. Interpret
date-only deadlines in Calendar's existing BRT date semantics, never UTC midnight by accident.
Always retain/show the calculated range as secondary context, including a missed-deadline warning;
do not overwrite a user deadline when recomputing. Extend Calendar's subtask input to carry its
own deadline and priority; currently `readCalendarSources` sends only id/task/title for subtasks.
Deadline setters remain available through MCP task/subtask edits and use the same validation.

Use a server projection for the primary deadline/forecast selection; Web and MCP render its same
fields. A stated deadline is not labeled approximate. A forecast never becomes confirmed merely
because confidence is medium/high: Calendar's current confidence-derived `confirmed` needs to
distinguish evidence confidence from an actual commitment. Published evidence stays confirmed;
an explicit deadline is a stated target, not evidence of release.

| Situation | English screen text | Portuguese screen text |
| --- | --- | --- |
| Similar history | Approximate: 2–4 h · 4 similar pieces | Aproximada: 2–4 h · 4 peças semelhantes |
| General history | Approximate: 1–12 h · general average · low confidence | Aproximada: 1–12 h · média geral · confiança baixa |
| Bootstrap | Approximate: 1–12 h · initial planning range · no history | Aproximada: 1–12 h · faixa inicial de planejamento · sem histórico |
| Unstarted | Approximate: 1–12 h if started now · queue wait unknown | Aproximada: 1–12 h se iniciar agora · espera na fila desconhecida |
| Blocked | Approximate after resumption: 1–12 h · blocked: dependency | Aproximada após retomar: 1–12 h · bloqueada: dependência |
| Overrun | Longer than usual · revised approximation: … | Mais demorada que o habitual · previsão aproximada revista: … |
| Deadline present | Due: 12 Nov · approximate forecast: … | Prazo: 12 nov · previsão aproximada: … |

Tooltips/detail show endpoints, basis, n, confidence, method version and computation time. Calendar
uses the same earliest/latest range as an expected band and places the center (or stated deadline)
on its day. Preserve real activity presence separately from expected future placement: forecasts
must not fabricate past work. Day, Week, date filters and export all reuse `piecePresence`/shared
core placement logic; no separate phone rule.

Coverage means **all open pieces**, including idle/no-session tasks, unstaged subtasks, blocked
pieces and record-only pieces. `buildLive` must stop discarding these before a forecast can exist.
Expose them in the complete projection and Live's All view; preserve explicit stage/task/date
filters with counts explaining exclusions. An in-progress piece without a current session remains
visible as unattended rather than vanishing. Draft/backlog/unknown custom status has a queued or
unplaced presentation with its real status and forecast, never a fake running phase. Group members
remain readable as members with forecasts, not duplicate executable delivery cards; group/parent
completion uses the latest member upper bound (parallel assumption, labeled), not a sum of them.
A task-level leader coordination card is not an extra forecast sample or duplicate work piece.

No refusal for absence of history; bootstrap is mandatory. Client attempts to set calculated ETA,
range, basis or confidence refuse with `forecast_read_only` / 422:
EN "Forecasts are calculated by the server. Set an optional due date instead."
PT "As previsões são calculadas pelo servidor. Defina um prazo opcional."
This applies to HTTP, engine host mutations, CLI payloads and MCP handlers, not just disabled inputs.

### Request cost and EVOLUCAO.ETA reuse

Preindex bounded cohorts and sorted distributions once per source revision; one lookup per piece,
not a filter/sort across all history for each card. Cache in the existing `liveReplyForBook` lifecycle
and invalidate on book/registry/delivery changes plus activity/forecast revision. Keep five-second
result freshness and in-flight sharing. Overrun anchors may update in the background/hourly bucket;
GET does not mutate board state or issue network/git/transcript scans for forecasting. No extra
filesystem probes per piece, model calls or database per-card queries. Cold cohort work is bounded
to 500 samples; warm additional CPU target ≤10 ms and ≤5% of the baseline Live request p95 on
the same fixture/machine. If either limit fails, precompute the cohort snapshot in the existing
background cycle before release. Benchmark isolated baseline/change, report p50/p95 and sample
count; do not claim a measurement in this static design delivery.

At dispatch, EVOLUCAO.ETA calls `resolvePieceForecast` with the dispatch snapshot and stores an
immutable prediction on `DeliveryRecord`: interval, center, confidence, basis, method version and
forecast timestamp. Repeated live recomputation does not replace this snapshot. New run/revision
gets its own keyed snapshot. Evolution compares actual `publishedAt` with this saved publication
prediction, reports interval coverage and absolute error by source, and separates bootstrap/work-
span/conditional forecasts from learned publication forecasts. Old records without a snapshot
stay "unmeasured"; never backfill an accuracy prediction using the known outcome.

Breaks and migration: ETA union types/tests, Web model mirrors, MCP Live/Calendar responses,
`task-live-view.ts` leader aggregation, `delivery/calendar.ts` adapters and core Calendar types,
confirmed filters, summary counters, record-only construction and presence tests all need updates.
No forecast field needs backfilling on every task: compute on read from the migrated open-piece
projection. Freeze snapshots only on future dispatch; legacy no-forecast pieces use general/
bootstrap immediately. Do not rewrite dates/statuses just to put a forecast on screen.

## MCP and operational caller contract

MCP must offer the complete workflow, backed by the same mutations and projection:

- `agentistics_task_create`: priority required; `agentistics_task_subtask`: priority required only
  for creation, available for edits, also on groups. Return machine-readable refusals and repair
  fields (`missing`, allowed values, target ids), plus the same localized sentence as HTTP.
- `agentistics_task_session`: successful link returns the system start/status and moved target;
  worker detach/direct filing uses the shared policy. Native engine bindings use the same source.
- `agentistics_session_role`: worker transition enforces registration; callers cannot promote or
  clear role as a filing bypass. Errors identify the actual target that needs repair.
- Session launch uses existing `agentop session`/host launch surfaces; do not claim an MCP spawn
  tool exists. MCP can prepare task/subtask and staged session using the current queue tools,
  then `agentistics_task_phase action=stage-run` passes through the same launch admission.
- `agentistics_task`, `agentistics_live_delivery`, `agentistics_delivery_calendar` expose priority,
  effective deadline, full forecast/basis and registration pending/coverage diagnostics. Repairs
  use create/link/role/staging operations, not a second hidden "override invariant" tool.

Update managed operational text alongside each gate: `S/briefing-flow.ts`, `briefing.ts`,
`briefing-installer.ts`, `claude-skill.ts` (its batch example uses only a task), `cli-hooks.ts` help,
session CLI help, MCP descriptions, `docs/session-manager.md`, `docs/claude-integration.md`,
`docs/delivery-flow.md`, task examples and AGENTS.md managed templates. Installed
agentistics-session-flow / board-agentask / sessions-hand-offs skills and leader worker-brief
templates currently describe linking after start: their source templates must instead prepare
priority + subtask before launch. Installation/update can replace managed text under its normal
ownership rules; this worker must not rewrite installed skills or leader workspace files.
The leader owns migrating its external briefs, including engine starts with no `--task`; code must
refuse outdated callers even if that rollout is incomplete. Do not add a temporary worker exception.

## Rule 6 — proof by attempted bypass

One behavioral contract suite per rule, parameterized over actual doors. Shared pure policy tests
are necessary but insufficient. Run implementation tests only with `agentop run --rm -- <command>`
and fixture HOME/ports; UI QA is independent, using a different author/QA model and desktop plus
390px mobile evidence. No tests were executed for this documentation-only delivery.

| Rule | Bypass attempts and required assertions |
| --- | --- |
| Priority | HTTP task/subtask/group POST omits/nulls/empties/invalidates priority; direct engine board call bypasses route; raw MCP invocation bypasses schema; actual UI form submitted without selection, suggestion acceptance and group creation. All refuse with the same code and no writes. Test typed API creation consumer rather than inventing an `agentop task create` command. If a CLI/flow prepares a record, omitted priority there must reach the same refusal. Duplicate-title create without priority still refuses. Legacy migration can read old records, but cannot validate new omitted input. |
| Worker target | Single CLI, batch entries, web/VS Code HTTP spawn, TUI wizard, staged `stage-run` through CLI/MCP/HTTP, native host run and reopen/switch: try no task, inherited task only, `--shared-cwd`, `--force`, forged person/leader role, wrong task, blocked target and member. No invalid worker executes model input. Inject failure/crash between intent/file/process steps; restart recovers one registered child or none. Try detach, delete target and role change to orphan a live worker; refuse. Valid engine-worktree start has an authorized checkout association and explicit target. |
| Auto start | Attach todo subtask through HTTP session-link, MCP link, native host, wizard launch and CLI flags without a manual status call. Assert linked pair, status and nonempty start in the same completed operation. Repeat/retry, attach an in-progress row missing its start, race two links, move targets, and inject IO failure. Preserve old timestamps/review/blocked statuses; historical link must not stamp now. |
| Leader implementation | For each harness, feed actual normalized edit and commit fixtures while the leader is only on task. Include OpenCode tool parts and unknown summaries. Concurrent signals, duplicate events, restart/replay and changed filing episode produce exactly one correct piece per episode. Try HTTP/MCP/native role/filing changes to evade admission. Coordination exemption requires real open relationships. Live/Calendar GET must not create work; next managed run cannot skip a pending repair. A parser fixture is not proof of pre-write interception; capture that limitation in QA. |
| Forecast | Through Live HTTP, MCP Live, Calendar HTTP/MCP, CLI `agentop flow calendario` and rendered Live/Calendar, create open pieces without due date/history/model/session; also stale idle, blocked, record-only, group member and overrun pieces. Every piece in the complete projection has an approximate range with consistent center/source across surfaces. Try setting ETA via raw mutation payload; refuse. Set explicit subtask/task deadline and verify precedence, BRT day, missed-deadline text and optional removal. Frozen dispatch snapshot never changes with polls or outcome; legacy accuracy remains unmeasured. Date filters and 390px Day/Week place the same range. Measure warm p95 budget. |

Negative cases must assert persistent state, event count, child process count/admission and reply
codes, not just a disabled button or a function call count. Cross-door parity fixtures should
exercise `index.ts` handlers, real MCP forwarding and the CLI parser/host path. UI tests submit
requests with browser-side validation deliberately bypassed. Include every installed harness in
the activity fixture matrix; unsupported data must exercise conservative admission, not silently
pass a zero-counter assertion. No test may add a force flag that bypasses these rules.

## Delivery slices, in order

Each slice is one author worker plus one independent QA; keep the strict gates staged behind a
server-owned rollout version until dependent callers are updated. The rollout switch controls
deployment sequencing, is not a public per-request override, and must be removed at activation.

| Order | Slice and owned boundary | Done criteria |
| --- | --- | --- |
| 1 | Registration schema/policy and migration: `task-registration.ts`, model/store/types | Explicit priority validator; Subtask priority round-trips; migration reruns without changes; shared refusal dictionary and registration intent/recovery primitives have failure/replay proof. Discussion/Issue linked before implementation. |
| 2 | Priority callers and strict creation: task mutations/routes, MCP, Web/TUI/engine board | Every real creation door sends/validates priority; priority bypass matrix passes; managed examples updated; desktop and 390px form QA. Activate strict priority only after caller rollout. |
| 3 | Filing/start transaction: `applyRegistration`, live/native/historical adapters | Live attach/launch reservation starts task and subtask once; historical dates remain historical; registry/book crash recovery and reattachment proof pass. |
| 4 | Worker launch admission: planner, CLI/batch/host/staged/reopen/role paths | No worker prompt runs before valid filing; inherited/no-task holes closed; ENGINE checkout association and explicit-subtask recipe work; detach/delete/role bypass and crash proof pass. Existing workers reconciled or held. |
| 5 | Harness-neutral leader registration | Shared activity consumer and before-managed-run fallback cover all harnesses; uncovered leader creates one piece, verified coordination does not; unknown coverage visible; replay/failure tests pass. |
| 6 | Forecast calculation and snapshots: `task-live.ts`, delivery dispatch | Bounded cohorts, general/bootstrap/overrun intervals and immutable EVOLUCAO.ETA snapshot share one method; worked examples pinned; endpoint provenance and no-history proof pass; no runtime UI math. |
| 7 | Forecast projection and UI parity: Live view, Calendar/core, MCP/CLI | All open pieces appear in complete projection; deadline precedence, group/member handling, confirmed semantics and identical range placement pass; measured request budget and desktop/390px evidence attached. |
| 8 | Rollout verification and operational migration | Independent QA runs the whole door matrix on candidate commits, checks migration report and updates managed skill/brief sources. Leader records acceptance and remaining external-process limitations. No implementation piece marked done by its author; handback is in_review. |

Slices 4 and 5 touch engine host contracts: the leader must coordinate the corresponding engine
repository worker through its own scoped subtask. This spec worker changes only this document.
Do not ship a "completed" registration feature while native or staged launch is still exempt.

## What can still escape, and remaining verification

- The model still chooses titles, task decomposition, priority value and delivery claims. The
  server can require a value, not certify good triage or meaningful scope.
- A direct external harness, shell alias, embedded script or manual editor can modify files before
  transcript ingestion, or without any recorded tool. Failed command counters are not commits.
  Observed repair and conservative managed-run admission are deterministic within their stated
  boundary; full prevention needs execution/OS enforcement outside this design.
- Missing/corrupt transcripts, unrecognized tool names and unavailable private-engine integrations
  limit activity evidence. Show unknown coverage; do not report zero as proof of no work.
- Direct manual edits to stored files or an older binary can violate invariants. Versioned
  migrations and recovery detect/repair supported data; they are not a security boundary against
  someone modifying storage. Cross-process writers must honor shared serialization.
- Forecasts can be wrong: slow review, quota pauses, external dependencies, queue waits, abandoned
  work bias and an empty history are real uncertainty. Overrun revisions must remain visible;
  never retroactively improve the saved prediction used for accuracy.
- Explicit user filters can hide a piece intentionally. The complete source and All view retain
  it; counts explain filtering. A forecast is not a fabricated historical work interval.

No product decision is left for the owner to answer in this delivery. The leader/implementation
QA must verify three integration facts not provable from this public checkout: which private
engine hook can hold model/tool dispatch before filing; which private harness integrations emit
structured activity with stable ids in production; and where their managed brief/skill templates
live. The public host already exposes the listed binding points. These are implementation
verification items, not permission to waive the rules. If a backend cannot hold a launch, commit
its registration before starting it; if activity is incomplete, conservatively register the leader
before its next managed run. Record any still-unmanaged process limitation in the QA handback.
