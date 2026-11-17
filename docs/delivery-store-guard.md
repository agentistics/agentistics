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
nothing. `on` applies. S7b (`leads()` accepting the custodian, wake routing, check-in, SessionStart) and S7c (UI, verbs) are
NOT in this slice.

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
   as forged. Shadow recovers intents too.
2. **Every piece, against its checkpoint** — no "changed since" filter and no event: the checkpoint, not the 2 000-event feed,
   authorizes. A document above the checkpoint's current phase/status is reverted to it (`above_checkpoint`); an authorized
   retreat lowers the checkpoint, rather than retaining its historical maximum. Groups are derived: the sweep judges and
   repairs each member's stored status against the group's checkpoint, never the group's ignored stored status. An identical
   plan that would leave the derived group rank unchanged is not written or commented again. No checkpoint means rank 0
   (`no_checkpoint`) only after both safety locks below pass. Rank ≥ 1 whose evidence ids/hashes are gone, point at other bytes, belong to an earlier capture round, or
   whose record HEAD moved goes back to rank 0 (`evidence_stale`: board `in_progress`, phase `ajuste`, a new round). The
   `ci` signal alone counts as rank (the Live moves on it) and is cleared by a revert.
3. **One write per document.** All reverts of the tick land in one `deliveries.json` write and one `tasks.json` write
   (`applyBoardReverts`, comments and events included); no per-tick cap for authorized checkpoints. A revert only lowers a rank, so no guard context is
   needed. A retreat to a RANK-0 phase bumps the revision; a retreat to a ranked phase keeps it (a changed revision on a ranked
   phase is a new binding to the guard). The history entry is appended; every revert comments on the piece in EN and PT.
   `deliveredAt` is preserved and the previous timestamp is also recorded in the revert event.
4. **Board catch-up.** Board below the checkpoint while the phase is at it: `setPhaseStatus` is re-applied (never a violation).
   The engine can reuse the authorization for that exact record revision/phase, like a grandfathered checkpoint; it does not
   reclassify a removed worker checkout. Failure (returned or thrown) leaves one `sweep-catch-up-failed <piece>: <code>` line
   per piece/code until it changes or clears. Another phase/binding still needs the normal evidence check.
5. **Loop guard.** The second revert of a piece inside 24 h also moves it to `blocked` (`externo: an unknown writer keeps
   moving this piece`), logs a WARN and shows it in health until a quiet day. Memory lives in `guards.json` (`sweep.reverts`),
   written after the documents and pruned on quiet ticks. Board-only loops also block an existing delivery record. The board
   carries `blockedReason: 'externo: an unknown writer keeps moving this piece'`. Health shows ONE aggregated `sweep-loop`
   WARN with full piece ids, its own EN/PT sentence, and the guide `agentop flow guarantee off a`.
6. **An `owner` / `override` checkpoint is never reverted**, whatever its `via`. `by.kind: owner` is also exempt; the guarded
   writer records `{kind: 'owner', via}` when the requesting principal is the owner (the initial evidence gate still applies).

Every revert comment and the loop WARN name the escape: `agentop flow guarantee off a`. S10 writes grandfathered checkpoints
and a sealed `guards.json` migration stamp: `migrations: { a: { version: 1, at: <ISO timestamp> } }`. Caller-supplied activation
facts never create that stamp. With A on and no stamp, the sweep reports `sweep-skipped: migration_missing` + WARN and writes
nothing. Even with the stamp, more than 20 `no_checkpoint` reverts OR more than 5% of all pieces in one tick trips the breaker:
`sweep-skipped: no_checkpoint_breaker` + WARN, no writes/comments. Intent recovery remains first in the plan but is persisted
only after those locks pass. Shadow writes no document, including intents or loop memory.

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
Assignment destructuring (`({ constructor: C } = x)`) is refused too, including computed literal keys.
This includes `Reflect.construct`/`Reflect.apply` with `Function` as the target. Other runtime-built strings and data-URL
imports remain outside this round's threat model. Exemptions remain fixed by exact path and digest.
