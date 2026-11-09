# The delivery flow (FLUXO.ENTREGA-DSL)

Every delivery — one subtask — walks ONE fixed table, kept by the server:

```
fila → executando → qa → { APROVADO: revisao_lider | REPROVADO: ajuste }
ajuste → qa                                  (never straight to the review)
revisao_lider → { ok: pr_merge | change requested: ajuste }
pr_merge → { merged: ci | failed (checks, conflict, deletion): revisao_lider }
ci → { release.yml green + tag: publicado | release failed: revisao_lider }
bloqueado ← any phase but publicado, and back to the STORED origin only
```

A transition outside the table is refused with HTTP 422 `fase_pulada` and a sentence naming what
is missing. Since FLUXO.CICLO-COMPLETO the review has one more exit: `revisao_lider → ci` when the
tick finds the piece's PR already MERGED (the merge is the leader's review; the same `delecoes` +
`mergeado` gates prove it).

## Coverage — who or what moves each stage (FLUXO.CICLO-COMPLETO)

No stage depends on someone remembering: each one either moves on evidence the minute tick reads, or
has a timed reminder to the LIVE leader of the task (never the owner).

| stage | moved by | if nobody acts |
|---|---|---|
| pedido (owner message) | the composer records it (`owner-message.ts`); the engine's `pedido-do-dono` / `encaixe-do-pedido` place it; the leader stages the piece (`agentistics_task_stage`, `pedidoId`). What is NOT a request (hand-off texts, answered questions) is FLUXO.AVISOS's | an unstaged request → the live leader is reminded after 10 min, then every 30 min (`watchRequests`) |
| fila | `fila-proximo`: the queue asks the leader `sim / nao / agendar` | autonomous mode: the 10-min timeout carries on as `sim`; OFF: reminded every 10 min |
| executando | the author (`agentistics_task_phase to=qa`; `salvo` gate) | the block watch if blocked; the Live shows the derived step |
| qa | the QA session's verdict (`to=revisao_lider` / `to=ajuste`, `qa-modelo` gate) | — |
| ajuste | the author back to `qa` (`salvo`) | — |
| revisao_lider | the leader (`to=pr_merge` / `to=ajuste`), **or the tick** when it finds the PR merged (→ `ci`) | reminder to the live leader at 30 min, then every 2 h, max 3 |
| pr_merge | `agentop flow merge`, **or the tick** when it finds the PR merged (→ `ci`) | a refused merge gate is recorded as the tick note and reminded like a review |
| ci | **the tick**: the first tag that contains the merge, its release.yml run green (→ `publicado`) | a red run is recorded and reminded (a declared or detected piece is never bounced back) |
| publicado | — | — |

### Merge detection

Each tick looks up at most 10 pieces in `revisao_lider` / `pr_merge` (never looked up first, then
the oldest look-up), with a back-off of a tenth of the time in the phase (1–10 min).
`findMergedPr` (`gates.ts`) asks gh, in this order, using only what the piece records: its PR
number, its branch (`pr list --state merged --head`), the PR that contains the sha QA approved or the
pushed head (`commits/<sha>/pulls`), and the branch its author worktree still sits on. Exactly one
MERGED PR must remain (one from the approved sha wins); two are ambiguous and prove nothing. The
transition to `ci` then runs the edge's own gates — a merge from another sha, not on main, or one
that deleted files is refused, the sentence is stored as the piece's `tickNote` (`tickReason` in
`agentistics_task_phase action=get`), and the piece stays where it is. A detected piece carries
`mergeDetected`: like a declared release it is published by the first tag that CONTAINS the merge
(a planned `versionTarget` is a plan, not proof) and never bounced back by a red run of the merge
commit.

### Reminders to the leader

`planReviewNudges` (`delivery/ciclo.ts`, pure): a piece in `revisao_lider` — or in `pr_merge` / `ci`
with a refused gate — waiting ≥ 30 min since it entered the phase (a leader action on it restarts
the clock) gets one reminder, then one every 2 h, at most 3 per phase and revision. The target is
the newest LIVE leader of the task (the successor after a hand-off), else the recorded leader if
alive; with none, the attempt is stamped and retried in 30 min. One message per leader per tick
lists every due piece with the tick's reason. The owner is never reminded.

### Backfill — `agentop flow reconcile --release`

`agentop flow reconcile --release [--apply] [--json]` (HTTP `POST /api/deliveries/reconcile`
`{apply}`, MCP `agentistics_task_phase action=reconcile apply=true|false`) matches every piece in
`revisao_lider` / `pr_merge` / `ci` — and every board subtask shown there with no record yet — to
its merged PR (the routes above plus a merged PR whose title/body names the subtask id) and the
first release tag that contains the merge. Dry run by default: a report of what would move (`→ ci`
or `→ publicado`) and what could not be proven, with the reason. `--apply` (a leader of the task or
the owner) writes it through the ordinary transitions, whose gates run; the writes are attributed
to `flow:reconcile`, which wakes nobody and rings no bell per piece. Running it again changes
nothing.

**CICLO.RECONCILE-2 — what counts as proof, and who runs it.**

- *Who may be moved.* A piece with a **live session** is never moved, whatever a PR says, and a piece
  with a **record** in `revisao_lider` / `pr_merge` is proven only by its own PR (`findMergedPr`,
  which checks the sha QA approved): a batch PR must never go over a real review.
- *Strong evidence moves a piece; free text never does.* Legacy pieces shipped inside a batch release
  PR and carry no pr/branch/sha of their own. `batch-proof.ts` reads what the piece's **own handbacks
  declared** (a branch WITH its commit, a full sha, a PR number; `hintsFromText`) and `matchBatchPr`
  (pure) checks it against gh's facts of a PR that merged into a default branch (**a PR into `dev`
  proves nothing**) of the **card's own repository**, after the card existed: (1) a declared commit
  that is one of the PR's real commits, read from gh (`loadPrCommits`; a short sha resolves to a full
  one, so a squash does not hide it); (2) the PR whose head is the declared branch, merged after that
  declaration; (3) a PR number the handback states, unambiguous across the card's repositories. Task ids, session ids, flow keys, a
  sha the card was compared with or based on, and a file path are never read as anything. Several
  PRs at one tier are **ambiguous = not proven**, unless all of them shipped in one release.
- *Weak evidence is a suggestion.* The piece's id or the card's whole `CODE.NAME` in a PR's text, or a
  declared branch named there, moves nothing: it is shown beside the card in "Antigas", with a one-click "Publicar na vX".
  A later round of a card (`MOBILE.BARRA r3`) is not the round the PR shipped.
- *The release.* The merge commit is the PR's own. A public PR needs the first green release tag
  containing it; an **engine** PR the first public tag whose `engine.pin` contains it
  (`findEnginePinTag`); any other repository is read in that repository, and with no release to read
  a merged PR stays a suggestion: **a user's repository gets correct proof or none, never ours**. A
  green tag declares the piece exactly as `flow release` does (one atomic write, attributed to
  `flow:reconcile`, with a comment "publicado na vX.Y.Z — prova: PR #N, <which commit>"). A red run is
  `→ ci (release vermelha)`; a run that could not be READ is `unknown` and the piece does not move.
- *Cost.* What gh answered is kept in `<dataDir>/delivery-proof-cache.json` and survives a restart:
  commits, ancestry and a green tag never change; PR and tag lists are read again after an hour. A
  second run asks almost nothing (measured on a real board of 262 pieces: 360 calls cold against the
  2.771 of the first version, 5 warm). Each run has a budget (`AUTO_RUN_GH_BUDGET`, 250 calls, about
  10 % of the hourly quota); on the budget or a rate limit it stops at once, judges nothing it did not
  read, and the next run continues.
- *Scope.* The backfill looks up only pieces with a delivery record, touched on the board within 30
  days, or proven by a release PR (`antigas.ts` `inReconcileScope`); older ones spend no gh call.
- *It runs by itself.* The running server's tick starts a reconcile (apply, proven pieces only) after
  it boots, single-flight, in the background, at most every 30 min and at least 3x what the last run
  took; a rate limit, or a quota below a third, doubles the wait up to 6 h. The server's log carries
  one `auto-reconcile …` line per run. With no gh token nothing is proven and nothing breaks. Never in
  a CLI one-shot (`agentop flow tick`), off with `AGENTISTICS_AUTO_RECONCILE=0`.
- *Antigas sem registro.* A record-less piece in review, untouched for over 24 h, with no live session
  and no proof is a decision to make. **Age alone does not put real work there**: a piece whose
  delivery handed back in the last 7 days stays in review unless the reconcile suspects it shipped
  (`isAntiga`, the one rule the Live and the reconcile share). They stay in the "Tudo" tab, marked, at
  the bottom of "Revisão do líder", and the "Antigas" button in that tab's bar opens the group: one click per card and
  for the group, **Marcar concluído** (optional version in the comment) and **Arquivar** (abandoned, reason in the
  comment). Never deletes. The group asks first; the number it shows is the list of ids it sends, 5 at
  a time, so it shows progress and can be stopped between two batches. HTTP `POST /api/deliveries/antigas`
  `{action: publish|archive, ids | all, expect?, version?, reason?}`, MCP `agentistics_task_phase
  action=antigas antigasAction=… subtaskIds|all expect?`, CLI `agentop flow antigas publish|archive
  (--subtask S[,S…] | --all [--expect N])`. `all` answers from the board, no reconcile inside the
  call, and leaves out what the last run proved; `expect` refuses (409 `count_changed`) when the group
  is not the size the person saw; a client that gave up stops the work. A piece with a delivery record
  is refused (it is not "antiga"). "Mark published" on a piece with no session is refused by the board's
  own rule, in a sentence with its way out (archive, or open the task and file the conversation).
  A missing repository is normal for non-code work: it prevents automatic release proof, but does
  not prevent the age rule or either manual action. GitHub failures and exhausted budgets remain
  unchecked until a later lookup. `isAntiga` checks the same status, children, handback, liveness,
  record and proof facts for the screen, reconcile and click; the old-review list is not capped.
  Tasks without subtasks use their task id through the same actions. A task with open subtasks is
  a container, not another card in Leader review, and the write refuses to close open children.
  Group candidates use the same member-derived status as the Live; an empty group keeps its own
  stored status. A manually completed piece has stage `completed` ("Concluído · sem prova de release")
  in Tudo, with no publication window and no queue membership. Only a release proof projects it to
  Publicado. An old `deliveredAt` is never rewritten to make it look newly published.

`server/delivery/machine.ts` is the table (pure); `gates.ts` checks evidence;
`service.ts` is the one door every surface uses; `store.ts` keeps one record per subtask in
`<dataDir>/deliveries.json` under the cross-process file lock.

## Gates — the evidence each edge needs (checked by the host, never passed by the caller)

| edge | gates / evidence |
|---|---|
| fila → executando | `predispatch` (staged session with prompt, harness, model, effort, account) + `vaga` (fresh plan_limits: 5 h < 85 %, week < 95 %; < 4 workers on the machine; the provider's top-tier cap; ≥ 3 GB free) |
| executando → qa, ajuste → qa | `salvo`: the author's HEAD is on origin (`git ls-remote`), clean tree, feature branch, and EVERY check run on it concluded green (failed, still pending, absent or unreadable all refuse) |
| qa → revisao_lider | verdict APROVADO + findings, and `qa-modelo`: QA model ≠ author model from the session registry, never Sonnet over Sonnet |
| qa → ajuste | verdict REPROVADO + findings (handed to the author) |
| revisao_lider → pr_merge | the leader reviewed the very sha QA approved (`reviewedSha == qaSha`) and `cabeca`: `git ls-remote` NOW says the branch still sits at that sha |
| pr_merge → ci | `delecoes`: the PR deletes no file outright (unless the leader allowed those paths, with a reason) + `mergeado`: gh says the PR is MERGED, its merge commit is on origin/main and the PR head is the sha QA approved. The merge sha is read from the PR; a `mergeSha` the caller states is ignored |
| ci → publicado | `release`: release.yml for the merge sha finished `success` AND the batch's tag exists (the tag named by `tag` / a numeric `versionTarget`, else the OLDEST tag that contains the merge) |

Every transition runs its own gates, so a caller never brings proof. The QA and the author are never stated either: the host records them from the sessions it opened, and a recorded id counts only while the registry files that session on THIS subtask (the leader is neither). `configure` and `unblock` are the leader's of the task (or the owner's); an owner-decision block is lifted by the owner alone. Each result is stored on the
record with the revision it was checked at; an older result does not count.

## The Live is a projection

The record's phase decides the Live stage (`task-live.ts` `PHASE_STAGE`); the board status is also
moved (QA, Ajuste, PR · merge and CI · publicando statuses are created when missing). The CI signal
(`{mergedMain, releaseGreen, tagPublished, tag, pr}`) is written onto the subtask, and `step` events
feed the per-phase percentage. Every change emits `entrega.etapa` on the engine bus.

Cards with a percentage show the current round's elapsed time beside it, with the round number
when there has been more than one. `round.startedAtMs` and `round.number` are projected once by
`buildLive` and carried unchanged by the Web API and `agentistics_live_delivery`. For running,
adjustment and QA, a round is the latest live session of that role (or the latest filed session
when none is live); author and QA sessions have separate round counts. Its session creation time
starts the clock and bounds reported steps, handbacks and gates; only that session's activity
advances the observed percentage. Other stages retain the recorded status stamp, falling back to
the latest logged stage entry when it is missing. An unknown start displays `—`, never a borrowed historical time.
Cards without a percentage keep their stage-time wording. The tooltip explains that this stage
clock measures time since the last status change and can span earlier rounds; the card's total
continues to mean measured work time.

## The release says what it published — `agentop flow release`

A release assembled from many merged branches, with conflict fixes, squashed into one commit, cannot be matched
back to its pieces by git (worker shas, patch-ids): the Live's "Publicado" used to guess and miss. So the
leader DECLARES the contents, after the release is merged (or even before the tag is out):

```
agentop flow release --version 2.201.0 --merge-sha <main sha> --subtask S1 --subtask S2 …
```

(MCP: `agentistics_task_phase action=release` with `version`, `mergeSha`, `subtaskIds`; HTTP:
`POST /api/deliveries/release`.) For each subtask the record is ensured (a legacy piece is adopted from its
board status), `versionTarget`, `mergeSha` and `tag` (`v<version>`) are set and it is put in `ci`. When
`release.yml` is already green for that sha and the tag exists, the same call moves it to `publicado`;
otherwise the minute tick does. `publishedAt` is the green run's completion — the Live's 24 h Publicado
window starts there, so declaring late does not restart it. The host still reads the release evidence from
gh; the caller names the pieces, never that it is green. A `done` (unless already published for this same
version, SHA and repository), `abandoned`, unknown, blocked or
other-task piece refuses the whole batch before anything is written; a piece already published in another
release is refused; a second run for the same release changes nothing. Pieces with no record at all keep
the old git guess as the fallback.

The repository defaults to `agentistics/agentistics`; pass `--repo owner/name` to declare another one.
Published idempotency requires the same version, full merge SHA and repository. The flow itself sets
published pieces to `done` on the board, so that status allows an exact retry; `abandoned` and `blocked`
still refuse it. The host looks up the exact tag and searches at most 10 run pages and 150 ancestry
comparisons per poll. An unfinished search reports its progress and resumes next poll; a changed first
page restarts the cursor. Negative ancestry facts are cached by repository and resolved tag SHA, while
run verdicts are read fresh. Pieces of one release share the search in each tick.

Declaration and immediate publication are prepared together, then committed for the entire batch in one
atomic store write. A write error leaves every piece unchanged and emits no board updates, comments or
notifications. Board and notification effects run only after that commit and report failures as warnings.
Each actual transition gets its own effect/comment (`→ ci`, then `ci → publicado`), including immediate
publication. A human publication gate keeps the declaration in `ci`, reports the refusal as a warning,
and rings the owner's bell once per revision. Approval and a later tick/retry finish publication.

## The queue leaves by priority — `fila-proximo` (FILA.PRIORIDADE)

"Na fila" has ONE order, and it is the order pieces leave in: the TASK's priority (urgent → low), then the time the piece
entered the queue, then its id (`orderQueue`, `delivery/fila-proximo.ts`). Changing a priority — on the board, on the task
page's Fila tab or on the Live "Na fila" card — reorders the exit. There is no second list.

The flow is deterministic and spends no model. It runs when a worker session ends or is stopped (`queue-kick.ts`, coalesced),
on the minute tick and after every answer. For each task with no open question it takes the best candidate (pre-dispatch
complete, not on hold) whose **slot gate** passes — a question already open or an approved piece not yet started counts as
a running worker, so two questions never promise the same last slot — and puts ONE system question to the task's leader,
headed `[from flow fila · confirmar]`, with the piece, its place, the harness/model/effort/account it will open and why it
is next. The leader answers with `agentistics_task_queue_answer` or `agentop flow fila responder --subtask S "<answer>"`:

| answer | effect |
|---|---|
| `sim` | the session opens (the same claim-guarded `stage run`; if no slot is free right now the approval is kept and the tick opens it) and the leader is told it started |
| `nao <motivo>` | the piece stays queued with the reason on its card; the flow moves on to the next piece |
| `agendar <ISO> <motivo>` | stays queued, a candidate again only from that FUTURE instant; the card says "começa às HH:MM" |

No answer in 10 minutes: with autonomous mode ON the flow carries on as `sim` (no gate waits for anyone) and records it;
with it OFF it keeps waiting and reminds the leader every 10 minutes. Every question and decision is a comment on the
subtask (who, why, when). The start is idempotent: the claim is taken under the store lock before anything is spawned, so
two ticks, a tick racing a `sim`, or `stage run` called twice open exactly one session. Reads and actions are the same
everywhere: `GET /api/deliveries/queue[/<taskId>]` (the Fila tab, the Live card, `agentop flow fila`, MCP `agentistics_task_queue`).

## Non-blocking

Nothing waits. Each transition wakes whoever owns the next step: ready for QA → the leader; QA
approved → the leader; QA failed / change requested → the author with the findings; merge or
release failed → the leader with the reason. The engine's default-on `entrega-vigiar` timer (one
minute) moves `ci → publicado` on the release signal and keeps blocks moving.

## Blocks

Closed reasons: `dependencia` (lifts itself when its sibling finishes), `pedido_de_bloqueio`,
`limite`, `maquina`, `externo`, `fora_das_autorizacoes`. Everything but a dependency is the
leader's to lift; the leader is woken on entry and every 30 minutes, and past two hours the piece is
DEFERRED to the next batch: it LEAVES Bloqueado for `fila` (Na fila, board status To do) with
`versionTarget = next`, the block kept in the record as history, a comment "adiada para o próximo
lote (bloqueio de N h: motivo)" and one last wake of the leader — a card is never parked in Bloqueado
with nobody chasing it. With autonomous mode on, reason 6 is deferred the same way (the leader does not
perform the action and nobody calls the owner). Only with autonomous mode OFF does it become
`decisao_do_dono`, sent to the owner.

The vigia also chases blocks the flow never made (BLOQUEIO.ORFAO): every piece the board holds in
`blocked` and the Live shows — a subtask, a GROUP (a blocked member counts for its group; a member is
never a delivery of its own) or a task with no subtasks (keyed by the task id) — is ADOPTED at
`bloqueado` (`adopted: 'board'`), at most 20 per tick, oldest first. One tick sends ONE message per
leader listing the pieces (not one per piece); a leader that died is replaced by the live one before
the wake, and a wake that did not reach anybody is stamped (`lastWakeAttemptAt`) so it waits its 30
minutes instead of retrying every minute. An adopted piece the board moved to done/abandoned leaves
the flow quietly (the record is dropped); one the board unblocked returns to its origin phase.

## Human gates

A delivery may name phases the owner must approve before it enters them (`humanGates`, off by
default). Autonomous mode ON: skipped and recorded `pulado: modo autônomo`. OFF: the transition is
refused with 409 `aguardando_dono` until the owner approves (only a request with no session proof
can approve — the board's own convention, so with autonomous OFF the gate is advisory against a session that goes out of its way to omit its proof). The owner is asked ONCE per (delivery, phase, revision), and answers on the Live card (Approve / Reject), with `agentop flow approve` or with the MCP `approve` action; an answer to a question that was never asked is refused (409 `nao_perguntado`). The engine's flows apply the same rule to their own owner steps (`ownerOrLeader`).

## Hardening notes

- An unreadable `deliveries.json` (a torn or hand-edited file) keeps a copy (`deliveries.json.unreadable.bak`) and REFUSES writes (503 `store_ilegivel`); it is never replaced by an empty book. A record this build cannot read (a newer phase) is kept verbatim.
- A subtask already past `todo` on the board when its record is first created is ADOPTED at that phase instead of re-entering at `fila`.
- A failure edge (`pr_merge → revisao_lider`, `ci → revisao_lider`) needs only a sentence: bouncing a piece back is the safe direction, so it is accepted without evidence.
- A wake that does not reach the leader is not counted as a wake. The `ci` poll backs off (a tenth of the time in `ci`, 1–10 min) and publishes on the one release read it just made.
- Memory for the `vaga` gate is the machine's AVAILABLE memory: `/proc/meminfo` on Linux, `vm_stat` on macOS (free + inactive + speculative + purgeable pages).

## Doors

- HTTP: `GET /api/deliveries[/<subtaskId>]` (the list also carries `questions`; one record also
  `tickReason`), `POST /api/deliveries/<subtaskId>` (`action`), `POST /api/deliveries/tick`,
  `POST /api/deliveries/reconcile` — `localShell`.
- MCP: `agentistics_task_phase`, `agentistics_task_stage`.
- CLI (`agentop flow --help` lists them): `agentop flow gate|phase|entrega|stage run|qa open|ajustes open|wait qa-verdict|merge|block|unblock|approve|release|tick`,
  `agentop task stage <subtaskId> …` (exit 0 = passed).
- Engine flows: `entrega`, `entrega-portao`, `bloqueio`, `desbloqueio`, `entrega-vigiar`.
