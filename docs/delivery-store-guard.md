# Delivery store guard (rule A)

**Rule OFF is the base, locks included (S2a r3, QA N2).** Every write first peeks rule A. With A `off` (the default,
and every machine that never turned it on) a board write takes only the tasks file lock through `withFileLock` — it
proceeds after its wait and re-runs once, exactly as before S2a — and a delivery write takes only what the base took
(`withFileLock`, or the evidence path's own locks). It never waits on deliveries/guards, never fails closed after 5 s
and never loses a write. A pending, sealed delivery journal is an already committed write: even OFF must roll it
forward under deliveries → guards before applying another mutation. With no journal, OFF retains the base locks.
With A `shadow`/`on` the envelope below applies unchanged.

The switch itself is safe: `activation.ts` `setState` takes the full tasks → deliveries → guards envelope, so a rule
move cannot land while a writer genuinely holds its file lock. A writer that peeked `off` and then finds that its
write raises a piece re-reads the rule under its lock; a board writer that finds it moved retakes the full envelope and
is judged, a delivery writer fails closed with `guard_busy` (its callback is not re-run). From `off` the only reachable
state is `shadow` (`on` needs 24 h of shadow), and shadow refuses nothing, so a write that ran unlocked after a
contended wait can at worst miss one checkpoint — never bypass a refusal.

With A shadow/on the task store acquires tasks → deliveries → guards before reading a mutation's inputs. The delivery
store acquires deliveries → guards. Activation is authenticated inside that lock set, including the
integrity witness and process generation latch; absence of the two JSON documents and key is not
proof of a new machine. A genuinely new machine remains OFF and creates no guarantee/checkpoint files.

Operations that also apply board effects use `withGuardTransaction` (rule-aware: OFF runs the operation with no
envelope at all; `withGuardEnvelope` is the unconditional one). Its async context records the exact
three paths and an active lease, so the stores can reuse locks during the operation without recursive acquisition or
waiting behind a queued writer that is itself waiting for the transaction. Ordinary `withGuardLocks`
still rejects reentrance and reversed order. Escaped async continuations lose both leases when the
operation exits and must acquire fresh locks. Each acquisition times out after five seconds, failing closed.
Release probes run before the critical section; the final CAS, guarded write and board effects run
together under the complete set. Concurrent external probes therefore cannot deadlock each other.

The guard detects rank increases, newly exposed pieces after group/child removal, advanced adoption,
and protected binding changes (task/subtask, revision, HEAD and evidence ids/hashes). The `evidence`
update option selects strict parsing; it never suppresses detection. An advanced adoption needs the
same current evidence as another protected write. Backup restore cannot reconstruct authorizations:
while A is ON it refuses the WHOLE restore when the archive would replace tasks.json or deliveries.json, decided
before a single file is written, under the full lock set, with one sentence in EN and PT (`GUARD_RESTORE_REFUSAL`) that
the CLI and the web job both print through `restoreReason`.

Grandfathered checkpoints preserve the state migrated at activation. They authorize no new progress;
the next write authorizing new progress classifies the checkout and validates evidence again. Such a write replaces
the inherited authorization with the evidence that actually passed.

Evidence belongs to a capture round. Every phase transition increments the delivery revision, but only
an entry into `ajuste` starts a new round. Its durable history revision is the minimum evidence revision
accepted by the guard and `evidencia` gate. Earlier items stay visible/auditable and remain in the reuse
history, but cannot authorize another review at the same HEAD. Fresh captures can be reused throughout
normal phase advances within the round.

That floor cannot be erased (r3, QA N1): `deliveryTamper` makes the history, the evidence history and every existing
evidence item APPEND-ONLY for every writer at every rank, and a revision never goes back. Adding or removing evidence,
or removing a record that carries any, needs a guard context (the service doors always carry one). With A on such a
write is refused (`evidence_binding_protected`, EN/PT); shadow reports it; off writes it as the base did.

The delivery floor and the serialized pending ledger are sealed together before the ledger rename. Readers use the
pending bytes; the next writer materializes them and clears the journal after the rename. Every authenticated rule
move resolves the journal before changing the rule, including moves to OFF. Unreadable guards only warn on delivery
reads, which fall back to the ledger; guarded writers still fail closed. OFF reads cache the rule by the policy file's
inode/size/mtime/ctime, invalidated by `setState`; after warmup they read only ledger bytes. The metadata stamp also
detects another process's policy replacement without reading the policy file on every OFF read.
OFF writers check for a pending journal with the same inode/size/mtime/ctime cache strategy. A missing guards file
does not cause a journal read or parse; policy authentication keeps its existing sibling-seal check. A new or replaced
journal invalidates the cache and is materialized before the OFF mutation.

Floors judge records changed by this write against its persisted before image. An unchanged record or a phase
retreat cannot freeze unrelated writes. On OFF → shadow, the present ledger becomes the new sealed floor; the rule
audit records which floors dropped and why. This permits the documented OFF → restore → shadow → ON recovery. ON
still requires a fresh shadow period and new progress still needs evidence.
Floors survive shadow → ON and ON → shadow unchanged. The re-seal audit also names pieces that climbed a phase or
were created in a ranked phase while OFF; `guaranteeWarnings` retains the latest re-seal until ON.

Pure board adoptions (`isPureAdoption`, with no evidence or evidence history) acquire no floor. Releasing and adopting
one again is ordinary bookkeeping. Evidence and ranked history still keep their floors after deletion, including
floors sealed by older builds. The minute tick isolates guard refusals per piece and continues its remaining steps;
it records the piece and refusal code in a tick note (a board note when there is no writable delivery record).
OFF retains its batch writes. The tick HTTP door returns a structured code and sentence for guard refusals and uses
`safeError` for unexpected failures.

The manual `reconcile` verb isolates a refusal per piece exactly as the tick does: the refused entry reports
`applied: false` with the code and sentence, the other pieces still move, and the route answers a structured code with
the sentence in English and Portuguese (`safeError` for anything else, never the runtime's error page). A piece whose
refusal persists leaves ONE board note per (piece, code), in both languages, until the refusal changes or clears
(a tick in which it is not refused) and returns; a delivery record's `tickNote` is overwritten, never accumulated.

## Custody clocks (S7a, spec §5.1–§5.2) — rule C

A piece whose leader stopped acting returns to the project leader's queue. The decision is the PURE `custody.ts`
(`planCustody`); `custody-tick.ts` reads the facts, writes the patches in ONE `deliveries.json` write per tick and tells
each custodian. Rule C `off` (the default) does nothing at all: no read, no stamp, no clock, no message — a test builds the
same history with and without the custody step wired and compares the bytes. `shadow` reports (`custody would-…`) and writes
nothing. `on` applies. S7b's authority is the section below; S7c (UI, verbs) is not built yet.

Three separate clocks. **Liveness** (the row is alive) is necessary, never sufficient. **Piece activity**
(`record.leaderActivityAt/By`) is the last task-scoped board action of a leader or custodian on the piece — a guarded
transition, a gate run, a block/unblock, a configure, an evidence attach/remove or a release declaration — written by the
service only when the actor leads the piece (or holds its custody) and rule C is not off. Plain comments, `lastSeenMs`,
heartbeats, status words and transcript writes are not inputs of the planner at all (a transcript is per conversation, not per
task). **Absence** (`record.leaderAbsentSince`) is persisted, set and cleared only by the tick: it is set when a piece at a
running stage (`executando`/`qa`/`ajuste`) or at rank 1–3 has no live leader (filed, custodian, or a live leader of its task)
with activity within N, anchored at the moment the activity STOPPED (so a zombie that has not acted for N + 1 min is an orphan
on the tick that sees it). A never-led piece is anchored at its stage entry; a led piece with no activity on record anchors at
the first tick that sees it absent, so turning the rule on never takes pieces over on day one. A restart changes nothing (it is
a stored ISO), and an unreadable fleet changes nothing (`custody-skipped`; no clock advances or clears). N = 4 h,
`preferences.delivery.orphanAfterHours` (1–48).

Past N the piece gets `record.custody = { sessionId, since, via, project }` — per piece, never filing. The custodian is the
project leader: a live leader with piece activity in the last N on any piece of the same project (ties → most recent activity,
then the smaller id; the piece's own filed leader and the custodian it just lost are never candidates). The project is
`normalizeGitRemote(Task.repo)`, else the repository of the piece's own sessions, short-keyed `org/repo` on both routes; an
unknown project is queued, never handed to anybody. No project leader → `{ sessionId: null, via: 'queue' }`, re-evaluated on
every tick, assigned (and messaged) on the first tick a candidate exists. ONE message per custodian per tick; an assignment
that did not arrive is retried (`notifiedAt` is stamped only after a delivered message). A custodian holds for N after its
assignment or its own last piece action and loses custody when it dies or goes quiet longer than that; the filed leader acting
on the piece again, or `publicado`, ends custody (every change is in `custodyLog`, capped). Custody is an authorization of the
actor, never evidence or proof — guard A/B still judge every rank raise. `custodyView` says `no-leader` only while
now − leaderAbsentSince ≤ N.

### S7b — custody authority (spec §5.2.2–4, acceptance §5.4.6–8)

Everything below needs rule C `on`. Under `off`/`shadow` a custody field on a record (left over, or written by hand) changes
no door — `custody-s7b.e2e.test.ts` forges one and proves it per door.

- **`leads()` accepts the custodian of THAT piece** (`service.ts`), so it may configure the piece, lift a leader-owned block,
  answer for it and declare its release (the release check no longer pins a custodian to its own task's pieces). It is still
  an authorization of the actor: raising the piece into review with no evidence is refused `evidence_required` like anyone's.
  Custody never touches filing (`conversationOwners`).
- **Wakes route to the custodian**: `wake()`, the blocked-piece batches, the review nudge (a live custodian first) and the
  "board refused the requeue" notice read `custody.sessionId` before `leaderSessionId`.
- **Check-in**: the leader's round lists the pieces it holds in custody and its project's queue (`custodyCheckinLine`), and a
  new custody is never idle-skipped (it joins the round's fingerprint only when present, so no existing fingerprint moves).
- **Discovery vs assignment (§5.2.4).** A LEADER that starts in a project whose queue holds orphan pieces reads them in its
  SessionStart context (`custodyQueue`, computed once at the spawn by `withCustodyDiscovery`). Discovery grants nothing. The
  next tick ASSIGNS the custody and messages the leader — that assignment is the authority `leads()` and the wakes read, and it
  wins whenever the two disagree; the start context is never changed afterwards. To make that "next tick" real, a live leader
  that STARTED within N in the project (its own task's project) is a project-leader candidate as well as one with piece
  activity — a decision S7b took because §5.4.8 requires a fresh leader to be assigned before it has acted on anything; a leader
  older than N with no piece activity is still never a candidate.
- **Known limit kept**: a co-leader's eligibility is read from its registry row; if that row is purged before any tick saw its
  death, its decision/block stops anchoring the absence (see the comment in `custody-tick.ts`). Not closed here: §5.4 has no
  acceptance item for it, and it needs the author's verified role and task stored on the comment.

### S7a r2 — what the independent QA changed (F1–F6)

- **The tick decides AND applies inside the envelope (F1/F2).** Rule C `on` takes the shared fail-closed envelope
  (tasks → deliveries → guards) BY ITSELF — whether rule A is on, shadow or off — reads the documents under the locks,
  plans, and recomputes the plan once more INSIDE the delivery write, so a leader action (or a publish, or a retreat) that
  landed in between always wins. Only the assignments the write actually committed are messaged. A busy envelope SKIPS
  the tick (`custody-skipped: … guard_busy`); it never writes after the wait expired while the lock is still held.
  Rule C `off` keeps the old locking untouched. The `notifiedAt` mark takes the envelope too; if it is busy it waits for
  the next tick (at-least-once: a duplicate message is possible, a lost one is not).
- **Only a semantic, authorized change is activity (F3).** The stamp is a `store.update` option (`stamp`), applied only
  when the write changed the record beyond `updatedAt`/`leaderTouchedAt`/the activity fields (`semanticallyChanged`). An
  empty, invalid or idempotent `configure` — and the board comment `configure` itself writes — are not activity; a refused
  transition is not either (`when`).
- **The stamp is part of the action's own write (F4).** No second best-effort write: a crash cannot separate an action from
  its stamp. The board-side sources that already exist count too, read by the tick under the tasks lock
  (`boardActivityOf`): a thread comment of kind `decision`/`block` by a verified session (`role: 'session'`) on that
  task/piece. Plain comments, notes, handbacks, owner posts and transcripts stay
  excluded. The board comment is itself the durable fact, so there is no second write to lose.
- **Project (F5, §5.2.6).** `custody-project.ts`: Task.repo → the repo of the piece's sessions (ANY session filed on the piece,
  the leader's own included: the spec says "the piece's sessions", it does not exclude leaders) → the sidebar folder of those
  sessions (the TOP-level folder: a nested `Project/Active` names `Project`; key `folder:<name>`, never `org/repo`) → `''`.
  Two repos or two folders among a piece's sessions are a conflict, not a vote: `''`, and the piece is queued.
- **Absence anchor.** The plan anchors absence at the moment the activity STOPPED, not at "now" as §5.1 reads literally: a
  zombie that has not acted for N + 1 min must be an orphan on the tick that sees it (§5.4.2). A led piece with no activity
  on record still anchors at the first tick that sees it, so it gets its full N.
- Stated limits: there is no exactly-once delivery of the assignment message.

### S7a r3 — what the second independent QA changed (N1–N4)

- **N1 — doors are fail-closed under rule C.** A write carrying a custody stamp (built only while rule C is on) takes the
  fail-closed lock set (`deliveries` + `guards`) whatever rule A says, and a busy file answers 409 `guard_busy` with nothing
  written — it never goes ahead after the lock wait while another process holds the file. Rule C `off` keeps the old path.
- **N2 — only an eligible actor anchors activity.** The latest activity of a piece (record stamp or board comment) is taken
  among the piece's ELIGIBLE actors only: its filed leader, its current custodian, or a live leader of its task. A worker's
  verified `block`/`decision` never masks the custodian's or the leader's activity, never erases the filed leader's project
  candidacy and never anchors the absence at the worker's time.
- **N3 — the board `status` event is NOT a custody source (dropped).** Its `actor` is free text from REST (`markTask`) and the
  event is written even for an idempotent re-mark, so it proves neither who acted nor that anything happened (a zombie leader
  could be kept "present" forever). It may return as a source only once a producer stores a VERIFIED principal on the event
  and only for `from !== to`. Until then the board sources are the verified `decision`/`block` thread comments.
- **N4 — tests.** The delivery mark lands only on the custodian that was told (custody changing between the message and the
  mark leaves `notifiedAt` unset) and the release declaration stamps exactly the pieces it changed; both have tests and mutants.

## The sweep (S2b, spec §2.6)

Every minute tick starts with `guardSweep` (`sweep.ts` logic, `sweep-plan.ts` pure plan; the service injects the stores, so
the writer inventories see neither module as a writer). **Rule OFF: it does nothing at all.** Rule shadow: report-only
(`sweep would-revert <piece>`), nothing reverted. Rule on, under the full envelope (tasks → deliveries → guards, 5 s each; a
busy file skips the tick with a named line, never proceeds unguarded):

1. **Intent recovery first.** An intent a crash left is committed when the documents already show its target (board status
   and/or delivery phase) and dropped when they do not, so a legitimate move that crashed before its commit is never judged
   as forged. Shadow only reports the proposed recovery and writes nothing.
2. **Every piece, against its checkpoint** — no "changed since" filter and no event: the checkpoint, not the 2 000-event feed,
   authorizes. A document above the checkpoint's current phase/status is reverted to it (`above_checkpoint`); an authorized
   retreat lowers the checkpoint, rather than retaining its historical maximum. A board-only retreat retains the authorized
   delivery phase and its rank; it never invents a delivery-phase retreat. Owner retreats carry the owner authorization too.
   Groups are derived; their ignored stored status is never repaired. A group checkpoint carries
   `members: { <id>: { status, at } }`, recording each accepted member change in the same intent/envelope as the board write,
   even when the aggregate rank stays unchanged. An individual member can therefore finish while its siblings remain open.
   A raw advance beyond a member's recorded authority is repaired even after an earlier chunk lowers the aggregate rank.
   The target is the member's recorded status, independent of the group's rank (`abandoned` stays `abandoned`), subject to
   the evidence checks below. Chunk expectations advance only for changes caused by that chunk; concurrent writes still invalidate them.
   The member record (`members`) is written ONLY by the guarded store, in the same write as the change: a status the write
   set, a member it created, a member that left the group (dropped from the record). A member the write only MOVED into a
   group keeps the status it already had, accepted only as far as an authority covers it (its old group's accepted record,
   else its old group's or its own checkpoint; rank 0 needs none), so a status a raw writer forged before the move is never
   laundered by it. The sweep never adds, changes or removes a member it merely observed on the board.
   **Migration window** (a group checkpoint with no `members` record at all, i.e. an older store): members are never
   reverted; a divergence is reported as `sweep would-revert <id>: no_member_baseline`. Only a quiet tick, with no
   divergence signal and the aggregate rank inside the checkpoint's authority, writes the group's first record, whole.
   That is the only record the sweep ever writes; once a group has one it is never rewritten from the board, so a lateral,
   lower or higher divergence is never consolidated. A report that persists for 60 minutes of consecutive unaccepted reports
   (`SWEEP_NO_BASELINE_WARN_MS`, a clock, not a tick count) raises a health WARN `sweep no_member_baseline: <ids>` until it stops.
   Residual migration risk (declared): a raw writer active before the upgrade can leave a forgery that a quiet migration
   tick accepts as its initial baseline, and a group forged above its checkpoint before the upgrade is reported (and,
   after an hour, WARNed) but never repaired by the sweep. This is intentional: migration must never undo legitimate
   deliveries by board order; a person repairs it by hand.
   **Baselined group** (it has a `members` record): a member the record does not name was created by a raw writer. It is
   reverted (`above_checkpoint`) when it lifts the group's derived rank above the checkpoint, otherwise reported every tick
   as `sweep report <id>: unaccepted_member`, and never recorded. A group whose derived rank is above its checkpoint
   because accepted members were deleted or moved out is never left silent: a moved-out member gets its `parentGroupId`
   (and, if it was forged above it, its accepted status) back (`member_moved_out`); a deleted member is written back as a
   placeholder under the same id carrying only what the record holds — id, accepted status, group (`member_removed`); its
   other data is gone. The group's status is a pure function of its members, so this is the one way to bring the derived
   status back to its checkpoint for the board and for release. Only members whose accepted status can lower the derived
   status are restored (a `done` or non-real one never can). Both leave a revert comment, count toward the loop guard and
   raise a health WARN `sweep members: group <id> lost accepted members …` for 24 h. Shadow only reports them.
   **Restored placeholder (S2b.1, B4; r2).** A piece is a placeholder ONLY when the sweep's own LEDGER says so. Every restoration is
   recorded in the sealed `guards.json` (`sweep.placeholders[<subtask>]`: group, task, `restoredAt`, a random restoration id), written by
   the sweep under the guards lock BEFORE the placeholder lands; the `restoredBy: 'guard'` flag in `tasks.json` is a label and is never
   trusted on its own. Everything that treats a placeholder specially (the delivery facts behind `stage` → `guard_placeholder` and the
   delivery queue, the dismissal door and its `placeholder_protected` refusal) asks the ledger. A piece carrying the flag with NO
   ledger record is a real piece: normal rules apply, the dismissal door refuses it (`not_a_placeholder`), the sweep reports it every
   tick (`forged_restore_mark`, health WARN `sweep-forged-restore-mark:<id>` for 24 h) and the flag is stripped on the next write.
   The placeholder says plainly that a raw write deleted it, that it is NOT work, and how to dismiss it. It has no delivery record, and
   `task_next` and `task_claim` act on tasks only. The task leader (a proven session that leads THAT task; a leader of another task is
   refused) or the owner dismisses it through the placeholder-only door — MCP `agentistics_task_subtask` with `dismissPlaceholder: true`
   and `id`, CLI `agentop task subtask dismiss <task> <subtask> [--owner]`, REST `POST /api/tasks/<task>/subtasks {id, dismissPlaceholder:
   true}` (the board's remove button reaches the same rule) — never a general remove. The write raises nothing, needs no
   classification, takes the member out of the accepted record and marks the ledger record dismissed in the same locked section, so
   the sweep does not bring it back. Any other actor is refused (`placeholder_protected`, 422).
   **Removing an accepted member (r3).** The general removal door (`remove: true` / `removeSubtask`, REST, MCP, CLI) refuses a group
   member that carries an acceptance checkpoint (its status `done` in the group's accepted record) for EVERY session principal — leader
   or worker, of any task: 422 `member_accepted` ("the piece was accepted, so only the owner may remove it"). The OWNER path is
   explicit: `remove: true` from a caller with no session (loopback / the browser, proving ownership) removes it, and the removal is
   recorded in the guard ledger (`sweep.ownerRemoved[<id>]`) in the same locked section, so the sweep neither restores it nor raises
   the group's derived status. An accepted (`done`) member that disappears WITHOUT that record (a raw write) can never be restored
   (`done` never returns): it is reported every tick (`sweep report <id>: accepted_member_missing`, health WARN
   `sweep-accepted-member-missing:<id>`) and the group's status is never raised because of it. Open members keep the old door.
   Every sweep WARN carries its own `guide` (none points at turning the guard off).
   **The owner's proof is not a browser header (r4).** Removing an ACCEPTED member needs an owner proof that does not come from the
   client: the vault grant (a fresh `delivery` grant, scope `subtask:dismiss`) or the `required` owner-proof mode with a verified owner.
   In the default `legacy` mode the `legacy-browser` heuristic (own `Origin` + `Sec-Fetch-Site: same-origin`) is NOT enough for this
   one move — any process on the machine can send those two headers — and is refused 403 `owner_proof_required` with a sentence
   saying the piece was accepted and how the owner removes it (turn on the owner proof, or use the grant); the member stays. Other
   legacy-browser moves are unchanged. The service door repeats the rule (`owner_proof_required`), so no adapter can skip it.
   **The placeholder door obeys the same rule (r5).** `dismissPlaceholder` (REST `dismissPlaceholder: true`, MCP, CLI) judges an ACCEPTED member
   BEFORE its placeholder branch: a session (leader or worker) gets 422 `member_accepted`, a header-only owner 403 `owner_proof_required`, and only the
   vault-proven owner removes it, recorded as `sweep.ownerRemoved` exactly like `remove`. The index keeps no legacy-browser fallback of its own for it.
   Removing an open member goes through the same door with the caller's guard context; a guard refusal is a 422 with its sentence,
   never a 500.
   **The owner-removal ledger exists only while the rule is on (r4).** `sweep.ownerRemoved` is written inside the guarded section, so
   with the rule `off` an owner removal leaves no record (there is no sweep to keep quiet). If the rule is turned on afterwards, the
   removed accepted member still has a `done` entry in its group's checkpoint and appears as `accepted_member_missing` (a WARN, never
   a restore); the owner sees it once, resolves it by re-checking the group, and nothing is raised.
   **Moved to another task (B3).** A member a raw writer moved out of its group into ANOTHER task comes back to the group AND
   to the group's task (`member_moved_out`, event detail `crossTask: true`). Declared limit: only an OPEN member comes back — a
   `done` member moved out is never restored (`done` never returns), and it is lowered at its destination by `no_checkpoint`.
   **Forge carried by a guarded write (B2, declared residual risk).** A member forged to a higher status and then carried
   to another group by a guarded SESSION write is not reverted unless it lifts that group: it is reported every tick
   (`unaccepted_member`), and after 60 minutes of consecutive unaccepted reports (`SWEEP_UNACCEPTED_WARN_MS`: a clock, not a tick count, so a gap in the ticks can bring it earlier) a health WARN
   `sweep-unaccepted-member` asks a person to check and repair it by hand.
   No checkpoint means rank 0
   (`no_checkpoint`) only after both safety locks below pass. Rank ≥ 1 whose evidence ids/hashes are gone, point at other bytes, belong to an earlier capture round, or
   whose record HEAD moved goes back to rank 0 (`evidence_stale`: board `in_progress`, phase `ajuste`, a new round). The
   `ci` signal alone counts as rank (the Live moves on it) and is cleared by a revert.
3. **Bounded apply chunks.** Planning reads snapshots outside the locks. Reverts land in chunks of at most four, each with
   one `deliveries.json` write and one `tasks.json` write (`applyBoardReverts`, comments and events included). Each chunk
   re-reads both books and the sealed checkpoint/memory under tasks → deliveries → guards, and skips any piece whose state,
   group rank, authorization or revision changed. Unrelated accepted writes are retained. The tick itself holds no outer
   envelope: adoption, probes and session wakes cannot extend a sweep chunk's lease. The target maximum hold is about two
   seconds; replaying QA's 18 MB board with twenty first-time and twenty loop repairs measured a maximum of 577 ms.
   A retreat to a RANK-0 phase bumps the revision; a retreat to a ranked phase keeps it (a changed revision on a ranked
   phase is a new binding to the guard). The history entry is appended; every revert comments on the piece in EN and PT.
   `deliveredAt` is preserved and the previous timestamp is also recorded in the revert event.
4. **Board catch-up.** Board below the checkpoint while the phase is at it: `setPhaseStatus` is re-applied (never a violation).
   Only when the board is below the rank of the board status the checkpoint RECORDED (r4, R3-3): a guard-accepted drag back
   (owner, session or unattributed) recorded a lower status and is never undone, and `abandoned` is a decision, never caught up.
   The engine can reuse the authorization for that exact record revision/phase, like a grandfathered checkpoint; it does not
   reclassify a removed worker checkout. Failure (returned or thrown) leaves one `sweep-catch-up-failed <piece>: <code>` line
   per piece/code until it changes or clears. Another phase/binding still needs the normal evidence check.
5. **Loop guard.** The second revert of a piece inside 24 h also moves it to `blocked` (`externo: an unknown writer keeps
   moving this piece`), logs a WARN and shows it in health until a quiet day. Memory lives in `guards.json` (`sweep.reverts`),
   written after the documents and pruned on quiet ticks. Board-only loops also block an existing delivery record. The board
   carries `blockedReason: 'externo: an unknown writer keeps moving this piece'`. **Why a whole group can show as `blocked`
   (B1):** a restored placeholder reverted twice in 24 h is blocked like any piece, and a group's status is derived from its
   members, so the group is `blocked` too. The sweep never unblocks it: a person sets the status back on the board; the
   health WARN says so in both languages. Health ids are STRUCTURED (B6): `sweep-loop`, `sweep-breaker`, `sweep-members:<group>:<actions>`, `sweep-no-member-baseline`, `sweep-unaccepted-member`, never parsed from the text, and they are not rendered under the "owner turned this rule off" frame. Health shows ONE aggregated `sweep-loop`
   WARN with full piece ids, its own EN/PT sentence, and a guide that says how to release it (no text or guide cites turning the guard off, r4).
   Leaving `blocked` clears the stale reason on both normal subtask writes and sweep repairs.
6. **An `owner` / `override` checkpoint is never reverted**, whatever its `via`. `by.kind: owner` is also exempt; the guarded
   writer records `{kind: 'owner', via}` when the requesting principal is the owner (the initial evidence gate still applies).

Every revert comment and the loop WARN say that only raw writes are reverted and to make the change through the board, MCP or CLI (r4: they no longer point at turning the guard off). S10 writes grandfathered checkpoints
and a sealed `guards.json` migration stamp: `migrations: { a: { version: 1, at: <ISO timestamp> } }`. Caller-supplied activation
facts never create that stamp. With A on and no stamp, the sweep reports `sweep-skipped: migration_missing` + WARN and writes
nothing. Even with the stamp, more than 20 `no_checkpoint` reverts OR (more than 5% of all pieces AND more than five candidates) in a tick trips
the breaker (r4, R3-2: reverts that HAVE a checkpoint — `above_checkpoint` / `evidence_stale` — are never counted, so a few
checkpoint-less forgeries cannot switch the repair of the others off and a small store is never left only reporting). The
compatibility action remains `sweep-skipped: no_checkpoint_breaker`; the checkpoint-less pieces are then left alone (report-only)
while the checkpointed repairs of the same tick still land. The checkpointed reverts have their own absolute ceiling
(`SWEEP_CHECKPOINT_CEILING` = 100 per tick, `sweep-skipped: checkpoint_ceiling`, a wholesale rewrite rather than a forgery):
past it nothing is repaired in that tick. Only the sealed `sweep.warning` is updated. Health shows its own `sweep-breaker` WARN with the count,
an EN/PT explanation and a guide that tells the person to find who writes the file raw and to make the change through the board, MCP or CLI (r5: never `guarantee off`). The first tick of an episode logs it and notifies each affected
task's leader (deduped across leaders); repeated ticks do neither. A normal tick clears the warning. Intent recovery is
planned first but persisted only after the safety checks pass. Shadow writes no document, including intents or loop memory.

Guard contention is a structured 409 `guard_busy` with a code and EN/PT sentence through REST (comments included), MCP and
CLI. Unexpected route errors pass through `safeError`; the HTTP boundary never exposes Bun's source/error page.
Reads can also acquire the envelope when seeding a legacy vocabulary: MCP GET errors retain their code/sentence, and CLI
task reads use the same structured refusal as task writes (exit 2, including `--json`).

The supplementary inventories parse executable TypeScript/JavaScript ASTs. Context must occupy the
writer's actual context argument; words in comments, titles and callbacks do not count. The historical
call identities and raw writer identities from `1b1c8a941` live in `guard-inventory.fixture.json` and have
an independently pinned SHA-256 in `guard-inventory.testing.ts`. Current sites must be a multiset subset:
removing sites is allowed, adding/replacing sites or raising a live count is not. Raw writer inventory
covers all packages and root scripts, JS/TS/TSX, workers, aliases, namespace calls, Bun.write and computed destinations.
Add guarded store calls with contexts instead of growing the fixture. S2c removes the remaining
historical context exemptions and makes the context parameter required.

r3 (QA N3) closes the inventory by DENY-BY-DEFAULT rather than by chasing syntax. (1) The writer detector also sees
destructuring renames from `require`/`import()`, element access, the Bun global however reached (`globalThis.Bun`, an
alias), `Bun.file().write`, `Bun.$`, child processes (`cp`/`mv`/`install` via `execFile`/`spawn`/`Bun.spawn`) and
`link`/`symlink`; the sites of those forms that already existed are pinned in `guard-inventory-r3.fixture.json`
(own SHA-256), shrink-only. (2) Every reference that can REACH the books — their file names, the data directory, the env
overrides and the path helpers — is pinned per module, shrink-only: retargeting an inherited call at a book, or handing
a book path to a new module, grows it and fails, whatever the call looks like. (3) No production module may import a
`*.testing` / `*.fixture` / `*.test` module, by any route, so moving a writer into a helper hides nothing. Stated limit:
a book name assembled at runtime from fragments (`'tas' + 'ks.json'`) in a module that already reaches the data dir is
not seen by a text scan; such a module is in the pinned reach list and is reviewed as such.

The module and helper ceilings also follow transitive re-exports to a fixed point. Runtime code generation is
forbidden: any `eval` or `Function` identifier reference, `vm`/`node:vm`, `process.binding`, and computed members
on `global`, `globalThis`, `self` or `Bun`, including TypeScript wrappers. Module loaders include `import.meta.require`,
`module.require` and `process.getBuiltinModule`. A directory named `e2e` grants no production exemption. One existing,
unshipped Playwright driver is exempted by exact path and source digest; changes to it undergo the normal check.
`Reflect.get` with a literal or statically computed `constructor` key is refused, including string aliases and concatenation;
fixed safe keys and ordinary Proxy forwarding remain allowed.
Literal `.eval`/`.Function` and `['eval']`/`['Function']` accesses on those global receivers are also forbidden, as are
`.constructor`/`['constructor']` on function or arrow literals and on `Object.getPrototypeOf` of such a literal.
On ANY receiver, a `.constructor` / `['constructor']` access (or a destructured `constructor`) is forbidden unless its only
use is an identity comparison (`=== !== == !=`) or a `.name` read: `x.constructor(...)`, `new x.constructor`,
`x.constructor.constructor`, `Reflect.construct(x.constructor, …)`, an alias or an argument all reach `Function`.
Assignment destructuring (`({ constructor: C } = x)`) is refused too, including computed literal keys, nested array targets
(`[{ constructor: C }] = [x]`) and for-of targets. Destructured `Reflect.get` aliases and
`Reflect.apply(Reflect.get, null, [x, 'constructor'])` are refused too. Constructor name/identity comparisons and ordinary
reflection with a safe key remain allowed.
This includes `Reflect.construct`/`Reflect.apply` with `Function` as the target. Other runtime-built strings and data-URL
imports remain outside this round's threat model. Exemptions remain fixed by exact path and digest.

## Accepted pieces: delete and reopen (S2b.1 r7)

Enforced at the store write (`task-store.ts`), so REST, MCP, CLI and a direct store call are all covered:

- Deleting a task, or a group, that holds an ACCEPTED member (`done` in the group's sealed checkpoint) answers 422 `accepted_members` for every session (leader, worker, other task, legacy header, forged) and for any principal that is not the owner with a vault proof. Nothing is deleted. The vault-proven owner deletes it; each accepted member is recorded in the ledger (`ownerRemoved`) and a WARN is logged.
- Reopening an accepted piece (`done` to any other status) or taking it out of its group (`parentGroupId` cleared or changed) answers 422 `accepted_reopen` unless the owner has a vault proof. This is checked by the store itself, independent of the classification guard.
- `POST /api/tasks/<ref>/subtasks` refuses (422 `subtask_not_in_task`) a subtask id that belongs to another task than `<ref>`.

### r8 (re-QA r7)

- An individual ACCEPTED member is removed only by the vault-proven owner (`removeSubtask`, with or without opts).
- The vault-proven owner reopening an accepted piece, or moving it out of its group, is exempt from guard A classification for that one operation (`exemptClassification`; never a session, never the legacy header).
- A malformed %-escape on a task path answers 400 `bad_path`; the MCP tick (`{id, done, session}`) now works instead of a silent no-op.
