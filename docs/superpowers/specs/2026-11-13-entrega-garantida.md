# ENTREGA.GARANTIDA — server-enforced delivery rules the model cannot skip

Date: 2026-11-13. Status: specification, revision 3. r1 was rejected by an independent Codex review
(`leader/qa/review-entrega-garantida.md`, 12 findings, §11); r2 was approved with adjustments by an
independent Sonnet review (`leader/qa/review-entrega-garantida-r2.md`, D1 residues + vault gap + N1–N9,
§11.1). No runtime change in this document.
Tracking: Agentask `t-e1dea7cd6f` / `s-1961340554`. Baseline: `origin/main` @ `53f9c7898` (v2.210.1).
Paths: `S/` = `packages/server/server/`, `C/` = `packages/core/src/`.

## 1. Why, and what "cannot skip" means here

The owner, 2026-11-13 ~03:20Z: deliveries should be made "guaranteeing quality, traceability,
deterministic flows, delivery forecasts … and none of that is being met". The board at that moment
proved it: 27 cards in *Revisão do líder*, 20 in *Sem líder*, and 157 of 191 in-review pieces with no
publish forecast. The 2026-11-13 evidence pass (`leader/qa/evidencia-entregas.md`) found that most
of those cards were already published, or were branches nobody merged, or had never produced any
proof that the thing works.

None of that was missing *machinery*. The delivery state machine (`S/delivery/machine.ts`), its gates
(`S/delivery/gates.ts`), the minute tick (`S/delivery/service.ts`, `S/delivery/ciclo.ts`), squash
detection (`S/sessions/release-squash.ts`), tag inference (`S/sessions/release-tags.ts`), the forecast
estimator (`S/sessions/task-live.ts`) and the calendar (`C/deliveryCalendar.ts`) all exist. What is
missing is that **every rule has a side door**:

| Rule the flow already states | The side door that empties it |
|---|---|
| QA before review, with findings | A `handback` moves the subtask `in_progress → in_review` directly (`statusAfterHandback`, `S/sessions/session-message.ts:217-220`), and `patchSubtask`/`markTask` accept `in_review` from anyone. Neither consults the delivery record. |
| Only the owner approves a human gate / validates | No principal exists: `markTask` records `actor?.trim() \|\| 'you'` (`S/sessions/task-web.ts:1631`), the REST route forwards `body.actor` verbatim (`S/index.ts:2685`), the MCP's `agentistics_task_status` sends no session proof at all (`packages/mcp/agentistics-mcp.ts:1231-1238`) and the delivery routes read *no proof* as the owner (`S/delivery/web.ts:47-51`). The `local` profile has no login (`S/index.ts` host-gate note; the team central and its accounts were removed in 2.207.0, `418fae359`). Any same-user process is "the owner" by omitting a field. |
| `ci → publicado` on release evidence | Needs GitHub (`gh` release run + tag). A squash-merged legacy piece has no record and no version, so it sits in review after shipping. Nothing checks that the *installed* binary carries the change. |
| A leader reviews | "Sem líder" is a presentation stage (`task-live-view.ts` `leaderForTask`) with no consequence and no clock. |
| Every open piece has a forecast | `resolvePieceForecast` returns `none: beyond-range` past a stage boundary, and the calendar independently turns every overdue piece into `none: overdue` (`C/deliveryCalendar.ts:185`) and every record-only piece into `none: not-started` (`C/deliveryCalendar.ts:222`). |

"Cannot skip" in this spec has a precise meaning:

1. Each rule lives in **one pure decision function**, enforced at the **persistence choke point**
   (the task store's single `write()` and the delivery store's `update()`), by **diffing the semantic
   stage** of each piece before and after the write — not at a list of call sites a future door can
   forget (§2.5).
2. The authorization a write carries is checked against a **trusted principal** the caller cannot mint
   by omitting or forging a field (§2.3).
3. Every authorized move leaves a **durable per-piece checkpoint** outside the bounded activity feed;
   the minute tick compares the *current* state of every piece against its checkpoint and reverts any
   divergence (a hand edit, an older binary, a writer that bypassed the store), in one batch, every tick
   (§2.6).
4. Each rule has an **anti-bypass suite** that attacks every door and the storage itself, with a
   **mutation control** that disables the guard and names the assertion that must then fail (§7).

What this spec does **not** claim: that a screenshot is truthful, that a probe covers everything a
change does, or that a same-user process can be told apart from the owner on a machine running
`ownerProof: legacy` (the default wherever the vault cannot produce a fresh human proof, D1). Evidence is checked for *shape, binding and uniqueness*; truth is the job of
the cross-model QA gate (`qa-modelo`) and the owner. Stated again in §10.

### 1.1 Threat model

The adversary is an assistant (worker or leader) that wants a piece to *look* further along than it is.
It can call every MCP tool, every CLI verb and every REST route reachable from its pane (including a raw
`curl` to the local port with any body, any `actor`, and with or without a session proof), in any order.
It can write files in its worktree, attach them, and edit `~/.agentistics/*.json` directly.

It **cannot**: type the vault's own password, or perform the owner's presence gesture (Windows Hello,
Touch ID, a FIDO2/passkey) — the vault's human wrappers (`PRESENCE_IDS = hello | fido2 | touchid |
password`, `packages/vault/src/vault.ts:67`). There is no TOTP authenticator anywhere in this design
(owner, 07/11). It **can**, in principle, read the session-identity key (same uid) and forge another
session's proof; this spec therefore never lets a *session* identity grant more than a session may do —
the only identity that unlocks owner-only moves is the owner proven by a **fresh vault credential**
(§2.3, §2.3.1).

Consequence, stated plainly, per `delivery.ownerProof` mode (D1):

- **`required`** (opt-in): an owner-only move without a fresh vault proof is refused; no process the
  adversary controls can produce one.
- **`legacy`** (the default, and the only possible mode where the vault has no human wrapper): a
  browser-originated loopback request with no session field is treated as the owner (`via:
  'legacy-browser'`). A same-uid `curl` that forges those headers **can** act as the owner — this is the
  narrower threat model, stated in the health panel as **WARN `delivery-owner-unproven`** for as long as
  the mode is on. Everything that is not an owner-only move (guards A/B, evidence, proofs, custody) binds
  identically in both modes.

## 2. Shared pieces

### 2.1 The piece

A *piece* is what the Live draws: a subtask that is not a group member, or a task with no subtasks
(`boardReviewTargets`, `review-board.ts`). Group members inherit their group's rules. Every rule addresses
a piece by `<taskId>/<subtaskId>` or `<taskId>`. A piece with no delivery record is adopted on first
contact (`newDelivery` + `adoptPhase`, unchanged).

### 2.2 The guarded stage ladder — semantic, not literal ids

Statuses are editable and `stageOfStatus` (`S/sessions/task-live.ts:249-262`) classifies ids **and
labels** (`review|revis` → leader, `\bci\b|publicando` → ci, …), so a custom status labelled "Review
ready" or "Shipped" is a door, and renaming a label can reclassify existing cards without a transition.
Two changes close that:

- **The stage of a status is stored, not re-derived.** `TaskStatusDef` (`C/taskStatus.ts:21`) gains
  `stage: LiveStage`, computed once by `stageOfStatus` when the status is created (and backfilled once
  for existing statuses by the activation migration, §2.7). Every consumer reads the stored `stage`.
  A label edit never changes it. Changing `stage` of a status in use is refused
  `status_stage_in_use` (422, naming the usage count); creating a status whose stage is guarded is
  allowed — the guard binds the stage, not the id.
  **Downgrade safety (review r2 N1):** whether the v2.210.1 task-store serializer keeps an unknown field on
  a status object is not assumed. The stored stage is therefore **mirrored** in `guarantees.json`
  (`statusStages: Record<statusId, LiveStage>`, a file an older binary never opens). On load, a status
  whose `stage` is missing is restored from the mirror, never re-derived from its label; a status absent
  from both (created by an older binary after the migration) is classified once by `stageOfStatus` and
  written to both — the guard still binds whatever stage it gets, so a status labelled "Shipped" created by
  an old binary is a guarded rank-4 status, never a door. An older binary may draw `published` by label or
  as unknown; its writes are unauthorized by definition and reverted by the sweep (§2.6).
- **One guarded ladder** for both documents:

| Ladder rank | Board stage (stored `stage`) | Delivery phase | Guard required to *enter* |
|---|---|---|---|
| 0 | queue, running, qa, adjust, blocked | `executando`, `qa`, `ajuste`, `bloqueado` | none |
| 1 | leader | `revisao_lider` | **A** (evidence, §3) |
| 2 | merge | `pr_merge` | A still current |
| 3 | ci | `ci` | A + release candidacy (§4.3) |
| 4 | published | `publicado` | **B** (inclusion proof for this release, §4.3) |
| 5 | completed (`done`) | — | B + verification outcome + owner validation (§4.7; how the owner is proven depends on `ownerProof`, §2.3) — or the non-code completion path (§3.6) |

A write is guarded when it **raises** a piece's rank on either document, or changes the authorization
bound to a rank ≥ 1 (a new HEAD under a piece in review). Lowering a rank (to `ajuste`, `blocked`, back to
`in_progress`) is never refused.

### 2.3 The request principal — identity the caller cannot mint by omission

`actor` stays a **display string only**. Every write path resolves a `RequestPrincipal`:

```ts
type RequestPrincipal =
  | { kind: 'owner'; via: 'vault-credential'; grantId: string }          // fresh vault password / Hello / Touch ID / passkey (§2.3.1)
  | { kind: 'owner'; via: 'legacy-browser' }                             // ownerProof: legacy only — unproven, WARN (§2.3.2)
  | { kind: 'session'; id: string; via: 'token' | 'process-tree' }       // proven pane / structured session
  | { kind: 'flow'; engine: 'entrega' | 'verificacao' | 'custody' }      // IN-PROCESS only, never from a body
  | { kind: 'unattributed' }                                              // anything else
```

Resolution, per adapter:

- **REST** (`S/index.ts`, `S/delivery/web.ts`), in this order: (1) a valid `delivery` grant (§2.3.1) →
  `owner / vault-credential`; (2) `body.session` that proves (`verifySessionIdentity`) → `session` — a
  proof that fails is still 403 `unverified_sender`; (3) **only when `ownerProof === 'legacy'`** and the
  request is browser-originated (loopback peer, `Origin` equal to this server's own web origin,
  `Sec-Fetch-Site: same-origin`, no `session` field, no reserved `actor`) → `owner / legacy-browser`;
  (4) otherwise `unattributed`. **No proof never means owner in `required` mode; in `legacy` mode only the
  narrow browser shape of step (3) does, and it is WARN-flagged.** `delivery/web.ts:51`'s `session ??
  'owner'` is replaced by this resolution, and `leads()` (`S/delivery/service.ts:260`) stops returning
  true for anything but a proven leader/custodian session, `flow`, or an `owner` principal.
- **MCP**: every task, subtask, evidence, phase and comment write attaches `sessionProof(process.env)`
  (the MCP already does it for the delivery tools, `agentistics-mcp.ts:1200,1449-1493`; the task tools at
  `:1231-1238`, `:1336`, `:1349`, `:1396` do not).
- **CLI** (`S/sessions/cli-task.ts:117` calls `markTask(ref, to)` with no actor): resolves
  `callerProof` / `callerSessionFromTree` (`S/sessions/session-identity.ts:146,…`); proven → `session`,
  else `unattributed`. The CLI can obtain `owner` only through an interactive TTY step-up
  (`--owner`, prompts for the vault password or triggers the presence gesture; never a flag value, never
  stdin from a pipe). The CLI never gets `legacy-browser`.
- **Engine flows / tick / verifier / custody**: pass a `{ kind: 'flow' }` object in-process. A body
  `actor` that *starts with* `flow:` or equals `owner`, `you`, `dono` is refused `reserved_actor` (400)
  — it can no longer impersonate the engine or the owner in the log either.

**Decision D1 (leader, 13/11 04:30Z, binding; owner order 07/11: the vault has NO authenticator;
reversible by the owner):** the owner proof is a **fresh proof of the vault's own credential** — the
vault password, or a presence gesture of a wrapper the vault already has (Windows Hello / Touch ID /
FIDO2 passkey) — never a TOTP code and never an enrolment step, which would lock our ~18 non-technical
users out of their own board. `delivery.ownerProof: 'legacy' | 'required'`; an absent preference reads as
**`legacy`**. `required` is opt-in, and only offered where the vault has a human wrapper (§2.3.1);
switching `required → legacy` is itself an owner-only move (a fresh vault proof), switching `legacy →
required` too (so a worker cannot flip either way). Sessions are never the owner, and `unattributed` and
reserved actors stay refused, in both modes.

#### 2.3.1 The vault primitive S0a must build — a fresh-credential owner proof

Today's gate does **not** offer this (review r2 §2.2, verified at `53f9c7898`): `VAULT_ACTION_ROWS`
(`S/vault/gate.ts:83`) rows are `{code, gesture, grant: 'read' | null}`; a row asking neither passes
whenever the vault is merely **open** (`gate.ts:437-490`, the tail `if (row.code || row.gesture)
noteVaultActivity(); return { ok: true }`); a gesture row on a vault with no presence wrapper is skipped
(`if (row.gesture && hasPresence(o.vault))`); `policyRow`/`ACTION_KIND_OF` (`:151,176`) let the person
lower a kind to `none`; and grants are only `'read'`, 5-min, per browser session. The ingredients do exist:
`proveGesture` already treats the vault password as a proof, tried first when the request carries one
(`provePassword`, `gate.ts:347-390`, COFRE.DESBLOQUEIO 2026-11-07), with the unlock's own back-off. S0a
adds:

1. **A dedicated gate, `requireDeliveryOwner(ctx, scope)`** (modelled on `requirePersonalReveal`, not a
   plain row): it always runs `proveGesture` **fresh** against the open vault's DEK (password first when
   typed, else the gesture of the vault's own presence wrapper), so "the vault is open" is never sufficient. A `VaultAction
   'delivery-owner'` row `{ code: false, gesture: true, grant: null }` is added so the `Record` compiles and
   the vault screen can draw it; `requireVaultStepUp('delivery-owner')` refuses `bad-request` ("use
   requireDeliveryOwner") so the generic tail can never pass it vacuously.
2. **No human wrapper → no proof.** If `!hasPresence(vault)` (only silent wrappers — keychain, DPAPI,
   libsecret, systemd-creds — which any same-uid process can ask), the gate refuses
   `owner-proof-unavailable`, never passes. Such a machine runs `legacy` (and cannot select `required`).
3. **A `delivery` grant class.** `grant` widens to `'read' | 'delivery'`. A `delivery` grant is minted only
   by `requireDeliveryOwner`, bound to (browser session, loopback, `scope = { pieceKey, move }`), TTL
   ≤ 5 min, **single-use**: consuming it for one validate/approve/override deletes it, and a grant whose
   scope differs from the request's is refused `grant-scope`. A `read` grant never stands for it and it
   never stands for a `read` action.
4. **Immune to policy lowering.** `delivery-owner` has no `ACTION_KIND_OF` entry and no `REMOTE_ROWS`
   entry; a test asserts both (`set-auth-policy` with every kind at `none` still asks the fresh proof).
   A non-loopback caller is refused `owner-proof-local-only` (the phone path is out of scope here).
5. **Transport.** The grant id travels in a request header (`X-Agentop-Owner-Grant`), never a URL or a
   log line; the audit event `delivery.owner-proof` records the scope and grant id hash, never the
   credential. A same-uid `curl` can send any body but cannot produce the credential, so it cannot mint
   a grant; reading a live grant out of the browser process is outside the stated threat model.
6. **Inventory.** The vault row inventories (`save-no-proof.test.ts`, `review-2-103-2.test.ts`) gain the
   row; their expectations name it as "dedicated gate, never generic".

Behaviour per vault state, per mode:

| Vault state | `required` | `legacy` |
|---|---|---|
| no vault set up | n/a — `required` cannot be selected | owner-only moves via `legacy-browser`; WARN `delivery-owner-unproven` ("set up the vault") |
| open, human wrapper (password / Hello / Touch ID / FIDO2) | fresh proof → `delivery` grant → owner | fresh proof accepted and recorded as `vault-credential` (stronger); an unproven browser click still passes as `legacy-browser`; WARN suggests `required` |
| open, silent wrappers only | n/a — cannot be selected | as "no vault"; WARN names "add a password or Hello to the vault" |
| locked | refused `locked` ("unlock the vault") — nothing written | `legacy-browser` still passes; a requested vault proof refuses `locked` |
| frozen (`stepup-frozen`) | refused `stepup-frozen` | `legacy-browser` still passes; WARN also names the freeze |
| recovery mode | refused `recovery-mode` | `legacy-browser` still passes |
| password back-off (`passwordPaused`) | refused with the pause sentence | same as locked |

#### 2.3.2 What each principal may do — by mode (enforced by the guard, §2.5)

`owner` below means `owner / vault-credential` in both modes, **plus** `owner / legacy-browser` in `legacy`
mode only. In `required` mode a browser request without a grant is `unattributed`.

| Move | session (worker) | session (leader/custodian) | unattributed | owner — `required` | owner — `legacy` | flow |
|---|---|---|---|---|---|---|
| rank 0 moves, lowering a rank | yes | yes | yes | yes | yes | yes |
| enter rank 1–3 | with guard A | with guard A | with guard A | with guard A | with guard A | with guard A |
| enter rank 4 | no | with guard B | no | with guard B | with guard B | with guard B |
| enter rank 5 | no | non-code path only (§3.6) | no | B + verification, fresh proof | B + verification (`legacy-browser` recorded) | no |
| approve a human gate | no | no | no | fresh proof | yes (`legacy-browser` recorded) | no |
| override (typed reason) | no | no | no | fresh proof, scope = that piece | yes, **WARN-counted separately** | no |
| change `ownerProof` mode | no | no | no | fresh proof | fresh proof where the vault has a human wrapper; else not offered | no |

**Override** is the only exemption, and it is visible: an owner principal may move a piece past a missing
guard with a typed reason; the checkpoint records `auth.kind = 'override'` with the principal's `via`, the
card wears "forçado pelo dono" (plus "sem prova" for `legacy-browser`), and the health panel counts
overrides by `via`. No other principal can override. The sweep **never reverts** a move authorized by an
`owner` checkpoint of either `via` (review r2 N4) — it reverts only divergences from the checkpoint.

**Health.** `legacy` mode → WARN `delivery-owner-unproven`: "Any local process can act as the owner on
this machine. Set up the vault (or add a password/Hello to it) and switch to required." The WARN is
permanent while the mode is `legacy`; it is not an error and blocks nothing.

### 2.4 Where things live (all public repo, none frozen)

| Concern | Module |
|---|---|
| Principal resolution (pure + adapters) | **new** `S/delivery/principal.ts`; adapters in `S/index.ts`, `S/delivery/web.ts`, `S/sessions/cli-task.ts`, `packages/mcp/agentistics-mcp.ts` |
| Owner proof (dedicated gate + `delivery` grant + row) | `S/vault/gate.ts` `requireDeliveryOwner`, `VAULT_ACTION_ROWS['delivery-owner']`, grant class `delivery` (§2.3.1) |
| Owner-proof mode | `delivery.ownerProof` preference (absent = `legacy`), health check `delivery-owner-unproven` |
| Stored status stage | `C/taskStatus.ts` `TaskStatusDef.stage`; `S/sessions/task-web.ts` create/edit status |
| Store-level guard (pure decision) | **new** `S/delivery/guard.ts` `checkTransition(before, after, principal, auth, facts)` |
| Store hooks | `S/sessions/task-store.ts` `write()` (the one write every task-store method reaches, `:955-962`); `S/delivery/store.ts` `update()` |
| Durable checkpoints + intents | **new** `S/delivery/guards-store.ts` → `<dataDir>/guards.json` |
| Rule activation | **new** `<dataDir>/guarantees.json` (read by `S/delivery/activation.ts`) |
| Evidence model + validators | **new** `S/delivery/evidence.ts`; storage on `DeliveryRecord.evidence` (record-level, survives older writers — §2.7) |
| Piece classification | **new** `S/delivery/classify.ts` (pure) + `classify-host.ts` (git IO) |
| Inclusion proof | **new** `S/sessions/release-proof.ts`; `squashPublishedIn` becomes a wrapper |
| Release manifest + install ledger | **new** `S/delivery/releases.ts` (pure) + `release-store.ts` (`<dataDir>/releases.json`, `<dataDir>/installs.jsonl`) |
| Verification jobs + verifier | **new** `S/delivery/verify.ts` (pure) + `verify-host.ts` + `<dataDir>/verify-jobs.json` |
| Orphan custody | **new** `S/delivery/custody.ts` (pure) + tick step in `service.ts` |
| Forecast projection | **new** `C/pieceForecast.ts` (pure, the ONE projection) consumed by `task-live.ts` and `C/deliveryCalendar.ts` |
| Reconciler | `service.ts` tick, step `guardSweep` |

### 2.5 The store-level guard — one choke point, two documents

Every task-board writer in this process *and in every CLI process* ends in `task-store.ts`'s `write()`
(it is how `logEvents`, `patchTask`, `upsertSubtask`, `seedStatuses` persist; the cross-process lock wraps
it). Every delivery writer ends in `delivery/store.ts` `update()`. The guard is a hook inside both:

1. Before persisting, the hook computes, for every piece touched by the write, `rank(before)` and
   `rank(after)` using **stored** status stages (§2.2), phases, **and the subtask's `ci` signal** —
   the Live moves a card to Publicado on `ci` alone (`task-web.ts:1830-1833`), so the rank reads it
   exactly as the Live does.
2. If any piece's rank rises (or its rank-≥1 binding changes), the write must carry a
   `GuardContext { principal, auth: Authorization[] }` and `checkTransition` must accept it. A write
   with no context that raises a rank throws `GuardRefused` → the door returns 422 with the rule's
   sentence. **A door that forgot to pass a context therefore fails closed**, rather than writing an
   unauthorized state the sweep later has to find.
3. On acceptance the hook writes the **intent** to `guards.json` first, then the document, then commits
   the checkpoint (§2.6).

This covers, without a per-door list: `markTask` (`task-web.ts:1608`), `patchSubtask`,
`setSubtaskDone` (`S/index.ts:2564`), parent auto-completion (`task-web.ts:969`, which calls `markTask`
with the subtask title as actor — it now inherits the child write's context, and refuses if the child's
guard does not cover the parent's rank), the CI signal (`setSubtaskCi`, `task-web.ts:1836`, which writes
via `upsertSubtask(next)` with no status argument — the diff sees the stage change the `ci` field causes in
the Live), engine board writes (`S/engine/engine-board.ts:78`), cockpit completion
(`S/cli-start.ts:4298`), `antigas` (`S/delivery/host.ts:263` `closeLegacyPiece`), `flow release`
(`service.ts:688-740`), `transition` (`service.ts:332-361`), reconcile, tick, unblock and adoption.

**Inventory test** (`delivery/doors.lint.test.ts`) is now supplemental, not the guarantee: it asserts
(a) `task-store.ts` and `delivery/store.ts` are the only modules that call `writeFile`/`rename` on
`tasks.json` / `deliveries.json` (a new low-level writer fails the build), and (b) every caller of
`store.patchTask`/`upsertSubtask`/`update` passes a `GuardContext` argument.

**Staged tightening (review r2 N7).** Making `GuardContext` a required parameter in one PR touches dozens
of call sites and tests and collides with every other branch that edits `task-store.ts`. So: **S2a**
introduces it as an **optional** parameter — the fail-closed behaviour of point 2 above already holds at
runtime (no context + a rank raise = `GuardRefused`) — plus a lint (`guard-context.lint.test.ts`) that
lists every call site lacking the argument against a **shrinking allowlist** that may only lose entries;
**S2c** (a small follow-up) empties the allowlist and makes the parameter required, at which point the
compiler is the inventory.

**Cross-document consistency.** The delivery phase and the board status are two documents, and today a
board effect failure is only a warning (`service.ts:283`). After this spec, the checkpoint (§2.6) is the
single authority both are compared against: a phase advance whose board effect fails leaves the
checkpoint at the *phase's* authorized rank and the board behind it; the next tick re-applies the board
status (`setPhaseStatus`) because the board is *below* the checkpoint (never above — catching up is not a
violation). A board advance with no matching phase is a violation and is reverted.

### 2.6 Durable checkpoints, intents and the sweep

`<dataDir>/guards.json` (0600, its own lock, its own file — older binaries never read or write it, §2.7):

```ts
interface PieceCheckpoint {
  key: string                       // piece key
  rank: number                      // highest authorized ladder rank
  boardStatus: string; boardStage: LiveStage; phase: Phase | null
  revision: number                  // delivery revision at authorization
  headSha: string | null            // verified HEAD bound to the authorization (§3.2)
  auth: Array<                      // the COMPLETE set that authorized the current rank
    | { kind: 'evidence'; ids: string[]; sha256: string[] }
    | { kind: 'release'; releaseKey: string; proof: 'ancestry' | 'patch-id' | 'tree-holds'; containingCommit: string }
    | { kind: 'verification'; jobId: string; strength: VerifyStrength }
    | { kind: 'non-code'; reportId: string; qaVerdictRef: string }
    | { kind: 'owner'; via: 'vault-credential' | 'legacy-browser'; grantIdHash?: string }
    | { kind: 'override'; via: 'vault-credential' | 'legacy-browser'; grantIdHash?: string; reason: string }
    | { kind: 'accepted'; acceptedBy: 'qa-other-model' | 'owner' | 'leader-same-model'; by: string }   // §3.7
    | { kind: 'grandfathered'; at: string } >
  by: RequestPrincipal; at: string; transitionId: string
}
interface GuardsDoc { version: 1; checkpoints: Record<string, PieceCheckpoint>; intents: Record<string, { transitionId: string; target: PieceCheckpoint; at: string }> }
```

- **Two-phase commit.** Intent (guards.json) → document write(s) → checkpoint commit + intent removal
  (guards.json). A crash between steps leaves an intent: the tick commits it if the documents already
  show the target, drops it otherwise. A crash between status and event writes therefore is never a
  "violation" — events play no part in authorization.
- **Not the activity feed.** `TaskEvent` is capped at 2000 (`task-store.ts:79,960`); the checkpoint is
  per piece and never evicted while the piece exists, so an old authorization cannot age out.
- **The sweep** (`guardSweep`, every tick, `flow` principal): for **every** piece (no "changed since"
  filter, no event needed), compare current board stage + phase + HEAD binding against its checkpoint:
  - current rank > checkpoint rank, on either document → **revert** to the checkpoint's status/phase;
  - rank ≥ 1 and the evidence ids/sha256 in the checkpoint no longer exist on the record, or the record's
    verified HEAD moved → revert to rank 0 (`evidence_stale`, the piece goes back to `in_progress`);
  - board below checkpoint while the phase is at it → catch up the board (not a violation).
  All reverts of one tick are applied in **one write per document**; there is no per-tick cap. SLA:
  every divergence present at the start of a tick is repaired by the end of that tick (≤ 60 s + write
  time). Loop guard: a piece reverted twice in 24 h is moved to `blocked` (`externo: an unknown writer keeps
  moving this piece`) and a WARN names it.
- **Stale references**: a checkpoint names evidence by id **and** sha256; an id that still exists but now
  points at different bytes, or belongs to an earlier revision, fails the check.

#### 2.6.1 Lock order across the three files (review r2 N3)

`tasks.json`, `deliveries.json` and `guards.json` each keep their own cross-process file lock. Every
writer — store hook, delivery `transition` with board effects, the tick, the sweep, CLI processes —
acquires them in **one global order: tasks → deliveries → guards**, takes every lock the operation will
need **before** reading any of the three documents, and never acquires an earlier lock while holding a later
one (a writer that needs only `deliveries` + `guards` may skip `tasks`, but may not take it afterwards; if
it discovers it needs the board, it releases everything and restarts from `tasks`). The intent, the
document writes and the checkpoint commit of §2.6 all happen under the held set.

- The board hook inside `task-store.write()` already holds the tasks lock; it takes `deliveries` (when the
  diff touches a piece with a record) then `guards`.
- `delivery/store.update()` callers that apply a board effect (`transition`, `flow release`, adoption) are
  changed to take `tasks` first; the ones that do not touch the board take `deliveries` → `guards`.
- **Timeout fails closed.** Each acquisition waits at most 5 s; on timeout every held lock is released,
  nothing is written, and the door returns `guard_busy` (409, "another agentop process is writing the board;
  retry"). The tick and the sweep skip the tick (logged) rather than proceed unguarded. A write is never
  persisted without its guard because a lock was slow.
- A test (`guards-lock-order.test.ts`) runs two processes doing a board-raising write and a tick in a loop
  for N iterations and asserts no deadlock and no unguarded write; a lint asserts no module acquires the
  locks outside the shared `withGuardLocks(['tasks','deliveries','guards'], fn)` helper.

### 2.7 Activation, migration and downgrade

r1's single `guaranteedSince` in `deliveries.json` is withdrawn: the current parser keeps only
`deliveries`, `requestReminders` and `preserved` at the top level (`S/delivery/store.ts:51-63,76-81`), so
any older binary that writes the file drops a new top-level field. Instead:

- `<dataDir>/guarantees.json` holds **per-rule activation**: `{ rules: { a|b|c|d: { state: 'off' |
  'shadow' | 'on', since?: ISO, build: string } } }`. `shadow` runs the guard and the sweep in report-only
  mode (refusals logged as `would_refuse`, nothing reverted) — the measurement week of §10.2.
- **Absent file = every rule `off`** (review r2 N2), and so is an absent rule entry or an unparseable file
  (with a WARN naming the file). The first boot of every slice ships with its rules `off`; nothing ever
  moves a rule to `shadow` or `on` automatically — `shadow` is entered by `agentop flow guarantee shadow
  <rule>`, `on` only by `activate` below. An upgrade therefore never starts refusing a user's existing
  moves by itself.
- **Escape (review r2 N8):** `agentop flow guarantee off <rule>` (and the same switch in Settings) returns
  a rule to `off` at any time. It is an **owner-only move** under §2.3.2 — the CLI with an interactive vault
  proof where the vault has a human wrapper; otherwise only from the browser (`legacy-browser`), never from
  a session — and every change is logged and raises WARN `guarantee-off: <rule>, by <via>` until the rule is
  back on. (`shadow`/`activate` are owner-only moves too.) Every sweep revert and every
  `delivery-owner-unproven` / loop-guard WARN names this command, so a person whose hand edits keep being
  reverted is told exactly how to stop it.
- A rule moves to `on` only through `agentop flow guarantee activate <rule>`, which refuses unless (1) the
  running build declares every prerequisite capability of that rule (`build.capabilities`, §4.2), (2) the
  rule's migration ran (`guarantee-migrate`, §8 S10) and wrote its checkpoints, and (3) the rule spent ≥ 24 h
  in `shadow` with no unexplained `would_refuse`. Rule prerequisites: **a** ← S0–S2, S3; **b** ← a, S4–S6;
  **c** ← S7; **d** has no write guard (its invariant is a projection, §6) and is on when S8 ships.
- Migration writes a `grandfathered` checkpoint for every existing piece at its current rank, so nothing
  in flight is reverted and nothing depends on "events after cutover".
- **Record-level fields survive older writers**: `parseDeliveryDocStrict` keeps a valid record object
  verbatim (`out.deliveries[id] = r`, `store.ts:58`) and `service.ts` clones records with
  `structuredClone`, so `evidence`, `custody` and `verification` placed on `DeliveryRecord` survive.
  The downgrade test runs a **captured copy of the v2.210.1 parser/serializer** (fixture
  `delivery/store-v2210.fixture.ts`) over a document written by the new code and asserts the record
  fields and the separate files are intact.
- **`tasks.json` downgrade fixture (review r2 N1).** A second captured copy — the v2.210.1 task-store
  load/serialize path (`sessions/task-store-v2210.fixture.ts`) — round-trips a book written by the new code
  holding (i) statuses with `stage`, (ii) the new `published` status, (iii) a piece in `published` and one
  in `done`. The test records **what the old writer actually does** to `stage` (kept or dropped) and then
  asserts the new binary, loading the old writer's output, restores every stage from the
  `guarantees.json` mirror (§2.2), keeps `published` as a status, and that the sweep's next tick leaves the
  legitimately authorized pieces alone. It runs in S0b (fixture + mirror) and again in S5c (with the real
  `published` status).
- **Older writers are not prevented** (a binary already released cannot be changed). Their writes are
  unauthorized by definition and the sweep reverts them when the new binary next ticks — and because the
  checkpoints and activation live in files the old binary never opens, it cannot erase them.

## 3. Rule (a) — a piece enters review only with evidence attached

### 3.1 Evidence items (deterministic validators)

```ts
interface EvidenceItem {
  id: string                    // ev-<12 hex>
  kind: 'screenshot' | 'api-capture' | 'test-log' | 'report' | 'probe'
  fileId?: string               // TaskFile id
  repoRef?: { repo: string; sha: string; path: string }
  sha256: string                // of the bytes (or of the canonical probe JSON), computed by the server
  revision: number              // delivery revision at attach time
  headSha: string | null        // verified HEAD at attach time (§3.2); null only for `none-verified` pieces
  treeClean: boolean            // the checkout had no uncommitted non-doc changes at attach time
  width?: number; height?: number
  probe?: Probe                 // kind 'probe' only (§4.5)
  by: RequestPrincipal; at: string
}
```

| Kind | Valid when (all must hold) |
|---|---|
| `screenshot` | Magic bytes PNG/JPEG/WebP; decoded header ≥ 320 × 200; size ≥ 4 KB; width/height recorded. |
| `api-capture` | UTF-8 ≤ 1 MB with a request line, a status line or `"status": <int>`, and a non-empty body. `agentop evidence capture <url>` (inside the worker's own `agentop run` throwaway) produces exactly this shape. |
| `test-log` | A runner summary with zero failures and ≥ 1 pass (`bun test`'s `N pass` / `0 fail`, or the `agentop run` footer `exit 0`). |
| `report` | A markdown TaskFile ≥ 300 bytes with a line `^(Verdict\|Veredito\|Result\|Resultado)\s*:` — or a `repoRef` whose `sha:path` exists and whose sha is reachable from a remote branch. |
| `probe` | A well-formed `Probe` of the closed set (§4.5). |

**Binding** (replaces r1's attachment-time freshness, which reattaching old bytes could refresh):

- **Bound to HEAD**: the item's `headSha` must equal the piece's verified HEAD at the moment of the move,
  and the checkout must be clean (`treeClean`). A new commit, or uncommitted code changes, make it stale.
- **Unique forever**: a `sha256` may back evidence on at most one piece **and one revision**. Reattaching
  the same bytes to the same piece at a later revision is refused `evidence_reused` exactly like reuse on
  another piece. A new revision needs a new capture. (A pixel-identical new capture is practically
  impossible — the clock, cursor and data differ — and if it ever happens the worker recaptures.)
- The server never trusts a caller's capture time; time plays no part in validity.

### 3.2 Classification — derived from the verified checkout, `unknown` is not `none`

`classifyPiece(piece)` (pure over facts gathered by `classify-host.ts`) resolves the piece's **checkout**:
the `cwd` of the sessions filed under it (registry rows), through `repo-facts.ts`'s repository resolution;
then `HEAD`, `git status --porcelain`, and `git diff --name-only <merge-base with the release line>..HEAD`.
It runs **at every guarded move** (not only in the `salvo` gate — r1's flaw), cached by (repo, HEAD, dirty
hash).

| Result | When | Required at entry to review |
|---|---|---|
| `screen` | diff touches `packages/web/**`, `packages/vscode/**`, `packages/tui/**` | ≥ 1 screenshot width ≥ 1000 **and** ≥ 1 width ≤ 500, + ≥ 1 probe |
| `code` | any other non-doc path (server, CLI, MCP, `packages/core/**`, build/config, test-only) | ≥ 1 `api-capture` or `test-log`, + ≥ 1 probe — test-only/build-only diffs may use a `structural` probe (§4.5) |
| `docs` | only `docs/**`, `*.md` | ≥ 1 `report` |
| `none-verified` | a checkout was resolved, it is clean, and the diff against the base is **empty** | ≥ 1 `report` (and the non-code completion path, §3.6) |
| `unknown` | no checkout resolvable (no session with a repo cwd), repository unreadable, or base unresolvable | **refused** `classification_required`: "this piece's checkout could not be resolved; file the session that did the work, or declare it a non-code outcome (§3.6)" |

A dirty checkout with non-doc changes is refused `uncommitted_changes` regardless of category. A piece
whose sessions **never had a repository cwd** may only take the non-code path; it can never be classified
`docs`/`none-verified` by silence.

**Leader declaration (review r2 N9).** A piece stuck at `unknown` for a legitimate reason (session filed
late, worktree already removed) can be classified by its filed leader or custodian session with
`agentop flow classify <piece> --repo <path|remote> --head <sha>` / MCP `agentistics_task_phase { action:
'classify' }`: the server re-runs `classify-host.ts` against the named repository and commit (which must
exist and be reachable from a remote branch) — the declaration names *where to look*, never the category.
Each declaration is logged on the piece, counted in health (`classification-declared`, by leader), and
recorded on the checkpoint. A worker cannot declare.

### 3.3 The doors — all reach the store guard

Every door of §2.5 reaches `checkTransition`; rule A is `checkReviewEntry(record, classification,
checkpoint)` → `{ ok, auth } | { ok: false, code, missing[] }`. The handback auto-move
(`handbackSubtask`) passes a context too: when A refuses, the subtask stays `in_progress`, the handback
comment is still recorded, and the **reply to the worker** carries the refusal sentence.

Refusal (HTTP 422, code `evidence_required`):

> EN: "This piece cannot move to review yet: it changed a screen, so it needs a desktop screenshot (≥ 1000 px wide), a mobile screenshot (≤ 500 px wide) and one probe, all taken at the current commit 3f5f21a. Attached and current: none. Attach with `agentistics_task_evidence` or `agentop task evidence add`."
> PT: "Esta peça ainda não pode ir para revisão: ela mudou uma tela, então precisa de um print desktop (≥ 1000 px), um print mobile (≤ 500 px) e uma sonda, todos no commit atual 3f5f21a. Anexadas e atuais: nenhuma. Anexe com `agentistics_task_evidence` ou `agentop task evidence add`."

Other codes: `evidence_stale` (names both shas), `evidence_reused` (names the other piece/revision),
`evidence_invalid` (names the validator rule), `evidence_in_use` (409 on deleting a TaskFile that backs a
checkpoint), `classification_required`, `uncommitted_changes`, `reserved_actor`, `owner_proof_required`
(`required` mode, owner-only move without a valid `delivery` grant; the sentence names the vault state of
§2.3.1), `grant_scope`, `guard_busy` (§2.6.1).

### 3.4 Surfaces

- **MCP** **new** `agentistics_task_evidence { ref, action: add|list|remove, kind, fileId? | filePath? | repoRef? | probe? }` (with session proof). `filePath` uploads from the worker's worktree (8 MB cap).
- **CLI** **new** `agentop task evidence add|ls|rm`, **new** `agentop evidence capture <url> [--out f]`.
- **REST** `POST/GET/DELETE /api/tasks/<ref>/evidence` (existing `/api/tasks` capability entry; matched before the generic `<ref>` route).
- **UI** evidence chip on the Live card and subtask row (`📎 3 · desktop · mobile · sonda · @3f5f21a`), "handback retido: falta <x>", upload from the task view. Desktop and 390 px in the same slice.
- **Briefing** one line in the worker brief (`agentistics-context.ts`).

### 3.5 Anti-bypass suite (rule a)

`delivery/evidence-guard.bypass.test.ts` (pure) + `sessions/evidence-doors.e2e.test.ts` (real
`task-store` + `delivery/store` in a temp data dir, real routes through `handleRequest`, real MCP handler,
real CLI entry). **Setup for every negative**: the board has every semantic status seeded (`in_review`,
`pr_merge`, `ci`, `done`, plus custom statuses labelled "Review ready" and "Shipped"), the piece has a filed
session with a resolvable clean checkout whose diff touches `packages/web`, all other gates satisfied — so
the **only** missing thing is the evidence. Each negative asserts the exact code **and that both
`tasks.json` and `deliveries.json` are byte-identical** after the attempt.

1. MCP `agentistics_task_status {status: in_review}` → 422 `evidence_required`.
2. MCP `agentistics_task_subtask` edit `{status: in_review}` → 422.
3. REST `POST /api/tasks/<ref>` (status) and the web drag payload → 422.
4. CLI `agentop task mark <ref> in_review` → exit 2, sentence.
5. Handback → comment recorded, subtask still `in_progress`, reply names what is missing.
6. `flow phase qa→revisao_lider` APROVADO → refused `portao` (`evidencia`).
7. Jump doors: `pr_merge`, `ci`, `done`, the custom "Review ready" and "Shipped" statuses, `setSubtaskDone`, cockpit finish, engine board status, `antigas publish` → each refused with the guard's code (never `unknown_status`).
8. Relabel attack: rename the in-use status `in_progress` to "In review" → the piece's stored stage does not change; renaming a status's `stage` while in use → 422 `status_stage_in_use`.
9. Forged evidence: 1×1 PNG; renamed text file; test log `3 fail`; report with no verdict; unpushed `repoRef` → each `evidence_invalid`.
10. Stale: valid evidence, then a new commit → refused `evidence_stale`; valid evidence, then an uncommitted edit to a `.ts` file → refused `uncommitted_changes`.
11. Reuse: same bytes on a second piece → `evidence_reused`; **same bytes re-attached to the same piece after an `ajuste` (new revision)** → `evidence_reused`.
12. No-commit/no-salvo attack: worker edits `packages/web/x.tsx` without committing, attaches a `report`, marks review → `uncommitted_changes` (never treated as research).
13. Unresolvable checkout: piece with no filed session → `classification_required`.
14. Category lie: diff touches `packages/web`, only a `report` attached → refused naming the screenshots; only a desktop screenshot → refused naming the mobile one.
15. **Principal attacks, run once per `ownerProof` mode** (review r2 N4; the suite is parameterised `describe.each(['required', 'legacy'])` and every row states its mode-specific expectation):
    - (i) REST review move with no `session` field and **no browser headers** (a plain `curl`) → `unattributed` in both modes, refused `evidence_required`;
    - (ii) `actor: 'you'`, (iii) `actor: 'owner'`, (iv) `actor: 'flow:entrega'` → `reserved_actor` in both modes;
    - (v) the same move with forged browser headers (`Origin` = own web origin, `Sec-Fetch-Site: same-origin`, loopback) → `required`: `unattributed`, refused `evidence_required`; `legacy`: `owner / legacy-browser` — **still refused `evidence_required`** (the owner is not exempt from guard A);
    - (vi) `done` with no grant on a published + verified piece → `required`: refused `owner_proof_required`; `legacy` with browser headers: accepted, checkpoint `by.via = 'legacy-browser'`, and the next real `tick()` does **not** revert it;
    - (vii) `done` with a valid `delivery` grant scoped to **another** piece → `grant_scope` in both modes; the same grant reused a second time → refused (single-use);
    - (viii) a session-proven request carrying browser headers → `session`, never `owner`, in both modes.
16. Delete the backing TaskFile → 409 `evidence_in_use`.
17. **Forged state** against the real storage: write `status: in_review` (and separately `phase: revisao_lider` only, and separately both) into the files; run the real `tick()`; **reload from disk** → both documents back at the checkpoint, comment + history entry present.
18. Event eviction: authorize a review, then append 2 001 unrelated events (feed rolls over) → the next tick does **not** revert the piece (the checkpoint, not the feed, authorizes).
19. Crash between writes: inject a failure after the intent and after the task write → next tick commits the intent; inject after the intent only → next tick drops it; neither reverts a legitimate move.
20. **Positive control (evidence-only)**: valid desktop + mobile screenshots + probe at current HEAD → doors 1–6 succeed into review and the checkpoint carries `auth: evidence` with those ids. (Entry into `published`/`done` is a separate positive control under rule b.)
21. **Mutation control**: with `checkReviewEntry` stubbed to `ok`, cases 1–7 and 17 must fail (assert the test runner reports them failing — the suite runs itself once in mutation mode).

## 3.6 Non-code outcomes (research, measurement, decision)

A piece whose classification is `none-verified`, or whose sessions never had a repository cwd, completes
without a release: `report` evidence + a `qa-modelo` verdict (a QA session of a different model, the
existing gate) → checkpoint `auth: non-code` → it may move to `completed` (`done`). `release_required`
never applies to it. A piece classified `screen`/`code` can never take this path.

### 3.7 Who accepts when no second model exists (review r2 N5)

The non-code path (§3.6) and `structural` verification (§4.5) need an **acceptance** that the author
cannot give itself. It must never become a hard dependency that stalls honest work on a machine with one
harness. The acceptor, in order of strength, recorded on the checkpoint as `acceptedBy`:

1. **`qa-other-model`** — a QA session whose model (or harness) differs from the authoring session's (the
   existing `qa-modelo` gate). Strongest.
2. **`owner`** — any owner principal of §2.3.2 (its `via` recorded).
3. **`leader-same-model`** — the piece's filed leader or custodian session, which must not be one of the
   sessions filed under the piece. Allowed **immediately** when the machine cannot run a second model
   (only one harness installed and that harness exposes a single model family, read from the server's
   model catalog), and otherwise **after 24 h** in `awaiting-acceptance` with no QA session of another
   model having taken it.

The card and the checkpoint say which acceptor was used ("aceito pelo líder, mesmo modelo" is visibly weaker,
and the health panel counts them). Pieces awaiting acceptance appear in the Live band "Aguardando aceite"
with their age; > 24 h is a WARN; the forecast keeps running (Invariant F covers them, §6.2). The worker
cannot accept its own piece under any option.

## 4. Rule (b) — a release closes the cycle, verified on the installed binary

### 4.1 Outcome

Every piece **proven** to be in a release reaches `publicado`; each piece of a release of **the artifact
this host runs** is then verified against the installed binary; a failed check reopens it. Works with
squash merges and without GitHub, CI or tags. A release of another project is published on its own proof
and reported `verification: not-applicable` (typed, visible), never "verified".

### 4.2 Build identity and the install ledger

1. **Build identity.** `/api/version` gains `build: { repoKey: string | null; sha: string | null;
   tree: string | null; builtAt: string; capabilities: string[] }`, written by `build:assets` into the
   generated slot (`normalizeGitRemote` of the checkout's origin, `git rev-parse HEAD`, `HEAD^{tree}`;
   nulls outside a checkout). `capabilities` lists the guarantee slices compiled in (§2.7).
2. **Install ledger.** `<dataDir>/installs.jsonl`: on every boot, if `{repoKey, sha, version}` differs
   from the last line, append `{repoKey, version, buildSha, tree, firstSeenAt, previousBuildSha}`.
   Append-only, 0600, capped at 500 lines.

### 4.3 Releases keyed by repository + build; inclusion by proof

```ts
interface ReleaseEntry {
  key: string                     // `${repoKey}@${commit}` — identity; version is only a label
  repoKey: string                 // normalizeGitRemote
  version: string                 // label: '2.211.0' or '2026-11-13-a'
  mode: 'github' | 'local'
  commit: string                  // the exact release commit (tag commit, or the local branch HEAD at declaration)
  buildSha?: string               // from the ledger, when this host runs this repo
  candidates: Record<string, 'declared' | 'target' | 'range'>   // why a piece was CONSIDERED
  proofs: Record<string, { kind: 'ancestry' | 'patch-id' | 'tree-holds'; containingCommit: string }>  // why it is IN
  publishedAt?: string
}
```

- **Candidates are not proof.** `declared` (`flow release --subtask`), `target` (`versionTarget`) and
  `range` (every piece with a merge/HEAD in the repo between the previous release commit and this one)
  only nominate a piece. **A piece is published only with a proof** from `proveInclusion`.
- **`proveInclusion({ dir, repoKey, pieceShas, target: commit })`** (new, `release-proof.ts`) returns the
  proof kind and the containing commit, or `null`:
  1. `ancestry` — a piece sha is an ancestor of `target` (`merge-base --is-ancestor`);
  2. `patch-id` — a commit in `<previous release commit>..target` has the piece's patch-id (works with no
     tags at all; the range comes from the previous `ReleaseEntry` of the same repo, else the merge-base);
  3. `tree-holds` — the piece's combined diff (multi-commit squash) reverse-applies on `target`'s tree.
  Patch-id and ancestry are **confirmed by tree-holds on `target`**, so a change later reverted inside the
  range is not "in" the release. `squashPublishedIn(sha, dir, repoKey, nowMs)` (`release-squash.ts:136`,
  boolean over "any recent tag") becomes a wrapper over `proveInclusion` per tag; its callers keep working.
- **Publication.** `github` mode: the existing `release` gate (tag exists, `release.yml` green) **and** a
  proof against the tag's commit. `local` mode: the release commit is required (`flow release --local`
  resolves it to `git rev-parse <release branch>` in the resolved repo when not given — r1's "optional
  merge sha" is withdrawn) and publication is the declaration with proofs; for `repoKey` equal to this
  host's `build.repoKey`, the observed install of a build whose `sha` contains `commit` stamps
  `publishedAt = firstSeenAt`. A version label observed in the ledger **never** publishes anything by
  itself: the ledger must show a `buildSha` that `proveInclusion` accepts for each piece.
- Unknown build sha (`null`): pieces of that release stay `published` only on the github/declaration proof
  and their verification is `pending: unknown-build` — never counted as containment.
- Two repositories may both release `1.0.0`; their keys differ and neither touches the other's pieces.

### 4.4 Which pieces a boot verifies

On a boot whose ledger line is new: the releases of `build.repoKey` whose `commit` is an ancestor of the
running `buildSha` and **not** an ancestor of `previousBuildSha` (commit ancestry, never
`compareVersions`, which parses only numeric parts — `C/deliveryCalendar.ts:303`). A skipped
intermediate release is therefore included by ancestry. Non-numeric local labels work the same way.

### 4.5 Probes and verification strength

```ts
type Probe =
  | { kind: 'http'; path: string /* /api/… */; expect: { status: number; pointer?: string; equals?: unknown; matches?: string; exists?: boolean } }
  | { kind: 'bundle'; literal: string /* ≥ 12 chars, in embeddedDist */ }
  | { kind: 'cli'; argv: string[] /* READONLY_CLI_VERBS */; expect: { exit: number; stdoutMatches?: string } }
  | { kind: 'structural'; reason: string; testLogId: string /* a test-log evidence id at the piece's HEAD */ }
type VerifyStrength = 'discriminating' | 'regression' | 'unpinned' | 'structural'
```

- `http` GET in-process through `handleRequest` (never a socket, never a port); `bundle` reads
  `embeddedDist`; `cli` runs the installed binary with an allowlisted read-only verb; `structural` is for
  changes no read-only probe can observe (POST-only behaviour, environment-specific regressions, refactors,
  test-/build-only diffs): it carries a reason and a passing test log at the piece's HEAD, and **requires
  an acceptor of §3.7 to accept the reason** (recorded on the checkpoint with `acceptedBy`) — visible as
  "verificação estrutural".
- r1's attach-time `probe_not_discriminating` refusal is **withdrawn** (it judged a probe against whatever
  the mutable host happened to run, and rejected legitimate regression probes and recovery after an
  early upgrade). Strength is measured against **pinned builds** instead:
  - while the piece is unreleased, every boot runs its probes in **baseline** mode and records the result
    against that `buildSha`;
  - after a build containing the piece boots, the **candidate** result is recorded against that `buildSha`;
  - `discriminating` = baseline fail on a build that does not contain the piece **and** candidate pass;
    `regression` = baseline pass and candidate pass; `unpinned` = no baseline was recorded (the server was
    upgraded before the probe existed) and candidate pass; `structural` as above.
  - All four count as **verification pass**; the strength is on the card and on the checkpoint, so a weak
    verification is visible, never silent. A candidate **fail** reopens.

### 4.6 Verification jobs — persisted, retried, compare-and-set

`<dataDir>/verify-jobs.json`: one job per `(releaseKey, pieceKey, revision, probeId, buildSha)`:
`pending → running → pass | fail | superseded`. Jobs are created on the new-ledger-line boot **and**
re-scanned on every boot and every tick (so a restart before the 60 s delay, or a crash mid-run, simply
retries). A result is written only if the piece's `revision` and the job's `buildSha` still match (CAS);
when the piece's revision advances, its open jobs become `superseded` and their results can never reopen
the new revision. Retries: 3 attempts 10 s apart per run, then the job stays `pending` with the error and
is retried next boot. Pending is visible ("aguardando verificação"), never a failure; pending > 7 days is a
WARN.

### 4.7 The lifecycle table (replaces r1's contradictory publication/done text)

Today `PHASE_STATUS.publicado` is `done` (`S/delivery/machine.ts:455`), applied by the host
(`S/delivery/host.ts:39`), and `flow release` relies on it (`service.ts:693`). That collapses "shipped" and
"owner validated". This spec separates them:

| Delivery phase | Verification | Board status (stored stage) | Owner validation | What moves it next |
|---|---|---|---|---|
| `ci` | — | `ci` (ci) | — | inclusion proof + release published → `publicado` |
| `publicado` | `pending` / `pending: unknown-build` | **new** `published` (published) | not yet | verifier job |
| `publicado` | `pass` (any strength) | `published` | awaiting | an owner principal validates → `done` (completed); in `required` mode with a fresh vault proof, in `legacy` mode also by a browser click (`legacy-browser`, recorded). A session never completes a code piece; `published` is already outside Invariant F (§6.2), so an unvalidated piece is not "without forecast" |
| `publicado` | `not-applicable` (other project) | `published` | awaiting | same as above |
| `publicado` → `ajuste` | `fail` | `ajuste`'s mapped status (host `setPhaseStatus`) | — | reopened: revision + 1, `versionTarget = 'next'` |
| — | — | `done` (completed) | given | terminal |

- `PHASE_STATUS.publicado` becomes `{ id: 'published', label: 'Published' }`, created dynamically by the
  existing `setPhaseStatus` (`host.ts:33-45`) when missing; `stageOfStatus('done')` becomes `completed`.
- **Migration** (S10): existing `done` pieces with a `publicado` record stay `done` (grandfathered as
  completed, checkpoint `grandfathered`); `flow release`'s retry logic (`service.ts:693-700`, "publishing
  itself sets the board to done") is changed to accept `published`; the Live, the calendar, `antigas` and
  every consumer that reads `done` as "published" are listed in S5c and updated together.
- **The `done` consumer inventory (review r2 N1)** — the highest regression surface for the ~18 users.
  Measured at `53f9c7898` with `git grep -n "'done'"` excluding tests: **server 39 files / 123 hits, core 6 /
  11, web 54 / 115, tui 5 / 13, mcp 0** (≈ 262 hits; many are unrelated — a job's `done`, a phase step).
  S5c **starts** by checking in `docs/superpowers/research/2026-11-done-consumers.md`: every hit classified
  as (A) *terminal / completed* — keeps meaning `done`, unchanged; (B) *delivered / published* — moves to
  the stored stage `published` or to `stage ∈ {published, completed}`; (C) *unrelated*. Known (B)/(A)
  anchors that must appear in it: `C/taskStatus.ts:65` (protected id — stays A), `done_needs_session` and
  `statusAfterSubtaskProgress` (`task-model.ts`, A), `S/sessions/task-live.ts:255` (`stageOfStatus`),
  `:903,924,928,1006,1010` (Live "delivered" branches, B), `S/delivery/machine.ts:455` (`PHASE_STATUS`), `S/delivery/host.ts:39`,
  `S/delivery/service.ts:693-700` (`flow release` retry), `C/deliveryCalendar.ts` (shipped detection),
  `antigas` (`S/delivery/host.ts:263`), the web Live/calendar/board chips and the tui task views. Every B
  line is changed to read the stored stage (never a literal), and a lint (`done-as-published.lint.test.ts`)
  fails a new `status === 'done'` in `task-live*`, `deliveryCalendar*`, `delivery/**` and the web Live /
  calendar components unless tagged `@done-terminal` with a reason. The inventory is reviewed by the slice's
  QA row by row.
- Reopen on failure: new edge `publicado > ajuste` in `EDGES` (actor `flow:verificacao`, needs a failing
  job result), board status via `setPhaseStatus(ajuste)` (dynamic id, never a literal), comment with probe,
  expected/got, installed version + build sha, wake to the leader **or custodian** (§5). Loop guard: a piece
  reopened by verification twice for the same probe id goes to `bloqueado` (`externo`).
- **Legacy pieces** published before activation with no probe: verified by build containment only
  (`proveInclusion` against the running `buildSha`) and labelled "verificado: build" — weaker, said so.

### 4.8 Surfaces

- CLI: `agentop flow release --version X [--local] [--commit S] --subtask …`; **new** `agentop flow verify
  [--release K] [--json]`, `agentop flow installs`.
- MCP: `agentistics_task_phase action: release` gains `local: true`; read fields `verification`
  `{ state, strength, build }` on `agentistics_live_delivery` / `agentistics_delivery_calendar`.
- UI: Calendar version strip "publicada · instalada aqui em <t> · N/M verificadas (k estruturais)"; Live
  chips `verificado · discriminante|regressão|sem linha de base|estrutural`, `verificação falhou → reaberta`,
  `não aplicável (outro projeto)`.
- REST: `GET /api/deliveries/releases`, `POST /api/deliveries/verify` (localShell).

### 4.9 Anti-bypass suite (rule b)

`delivery/release-cycle.bypass.test.ts` (fixture repos built at test time with `gitTestEnv()`) +
`delivery/verify-host.e2e.test.ts` (in-process server, temp data dir, real stores, reload after tick):

1. **Squash**: commit A on a branch; main gets squash S; tag on S → `patch-id` proof naming S; `git tag --contains A` empty.
2. **Local squash, no tags, no remote**: P1 declared; **P2 undeclared but squashed into the release range** → both published by proof; P2's candidacy is `range`.
3. **Targeted but unmerged**: P3 has `versionTarget = X`, never merged → **not** published (negative control for any permissive target match).
4. **Same label, wrong content**: a build labelled `L` from a checkout that lacks P1's change → P1 not published, verification `fail: build does not contain this change`.
5. **Two repositories, same version** `1.0.0` → each release publishes only its own pieces.
6. **Null build sha** → pieces `pending: unknown-build`, never verified.
7. **Unrelated release contains the patch**: P's patch appears in repo B's release → P (repo A) unaffected.
8. **Multi-commit squash** → `tree-holds`; **revert inside the range** → not included.
9. **Skipped release by ancestry**: ledger build N → N+2 (non-numeric labels) → N+1's pieces verified on that boot.
10. **Failing probe** → piece in `ajuste`, board at the mapped adjust status (dynamic id), comment, `versionTarget: next`.
11. **Restart before 60 s**: kill the verifier before it runs; reboot with the **same** ledger line → the pending job runs and records.
12. **Old result vs new revision**: a failing job for revision 3 completes after the piece moved to revision 4 → discarded (`superseded`), revision 4 not reopened.
13. **Strength**: baseline fail/candidate pass → `discriminating`; pass/pass → `regression`; no baseline → `unpinned`; all three pass verification and the strength is persisted.
14. **Structural without acceptance** → not a verification pass. **Acceptor rules (§3.7)**: the authoring worker accepting → refused; a leader of the same model on a machine where a second model is available, before 24 h → refused, after 24 h → accepted with `acceptedBy: leader-same-model`; on a one-model machine → accepted immediately with the same label; a QA session of another model → `qa-other-model`; the label persists after reload.
15. **Done refusal isolated, per `ownerProof` mode** (`describe.each(['required', 'legacy'])`): every other gate satisfied (session filed, evidence current, an owner principal valid **for that mode** — a scoped `delivery` grant in `required`, browser headers in `legacy`) but no release proof → exact `release_required` in both modes; add a valid release + verification pass → `done` succeeds in both modes, checkpoint `by.via` = `vault-credential` / `legacy-browser` respectively, and a subsequent real `tick()` + reload leaves it `done`. The same with an `unattributed` caller (plain `curl`, no headers, no grant) → refused even with the release, in both modes; a proven **session** (worker or leader) → refused `owner_proof_required` in both modes.
16. **Caller cannot write verification**: POST a `verification: pass` / job result field via REST/MCP → ignored, job unchanged; then an executed host probe changes it, with result + provenance persisted after reload.
17. **Forged `publicado`** in `deliveries.json` only (phase-only edit) and **forged `published` status** in `tasks.json` only → real tick reverts each to the checkpoint.
18. Write probe (`http` non-`/api/`, `cli session kill`) → refused at attach.
19. **Mutation control**: with `proveInclusion` replaced by "true", cases 3, 4, 7 and 8 must fail.

## 5. Rule (c) — an orphan piece returns to the project leader's queue

### 5.1 Three separate clocks

r1 anchored absence to `lastSeenMs`, which is a poller's observation timestamp refreshed for every live
process, silent or not (`S/sessions/registry.ts:178-186`, and its own note at `:80-86`: "a heartbeat's age
is NEVER one of them"). A zombie leader never aged out. Now:

- **Liveness** — the row is alive (`isLiveState`). Necessary, never sufficient.
- **Piece activity** — a **task-scoped board action** by that session on the piece's task, read from the
  durable per-piece record, not the feed: a guarded transition it authorized, a delivery transition or gate
  run, an evidence attach/remove, a release declaration, a custody take/release, or a thread comment of kind
  `decision`/`block` on that task. Plain comments and **transcript writes do not count** (a transcript is
  per conversation, not per task — a leader replying about task X writes the same transcript as for Y).
  Stored as `record.leaderActivityAt` (updated by the store hook when the principal is the leader/custodian).
- **Absence** — `record.leaderAbsentSince: ISO | null`, persisted, set and cleared only by the custody tick:
  - set to *now* when the piece is at rank 0 with a running stage or at rank 1–3, and no live leader with
    piece activity within `N` exists, and it is currently `null`;
  - for a **never-led** piece (no `leaderSessionId`, no custodian ever), initialized to the moment the
    piece entered its current stage (from `record.history`, else `firstAt`);
  - cleared when a live leader (filed or custodian) performs a piece action;
  - **unchanged on restart** (persisted) and **unchanged when the fleet read is `unknown`**.
- **Orphan** ⇔ `now − leaderAbsentSince > N`; `N` = 4 h default (`preferences.delivery.orphanAfterHours`,
  1–48).

### 5.2 Custody per piece

1. Past `N`, the piece gets `record.custody = { sessionId, since, via: 'project-leader', project }` —
   **per piece**, so one task's pieces can have different custodians. **Custody is not filing**:
   `conversationOwners` is never touched.
2. **Custody is an authorization of the actor, never a substitute for evidence or proof**: the custodian
   passes `leads()` for that piece (`service.ts:260` gains `|| record.custody?.sessionId === actor`), may
   approve the leader-level gates and declare releases for it — and still needs guard A/B for every rank
   raise.
3. **Wake** routes to the custodian: `wake()` (`service.ts:276`) targets `r.custody?.sessionId ??
   r.leaderSessionId`; human-gate questions, check-in (`agentistics_checkin_report`) and the Live
   projection read the same field.
4. **No live leader in the project** → `custody = { sessionId: null, via: 'queue', project }`. Two
   distinct channels: **startup discovery** — a leader that starts in that project receives the queue in
   its SessionStart context (computed at its start); **assignment notification** — when the tick later
   assigns custody to it, it receives a message. A SessionStart context is never retroactively changed.
5. A custodian that loses liveness or piece activity past `N` loses custody (re-assigned or back to the
   queue). Custody ends when a filed leader of the task performs a piece action again (recorded) or the
   piece reaches `publicado`.
6. **Project** of a piece: `normalizeGitRemote(Task.repo)`, else the repo of the piece's sessions
   (`repo-facts.ts`), else the sidebar folder. **Project leader**: a live leader with piece activity in the
   last `N` on any task of that project; ties → most recent activity, then smaller id.

`displayStage: 'no-leader'` is valid only while `now − leaderAbsentSince ≤ N`.

### 5.3 Surfaces

- Live: "Sem líder (< N h)"; band "Fila do líder do projeto" grouped by project, with ages and custodian.
  Desktop + 390 px.
- MCP: `custody` field on Live/calendar pieces; check-in lists custody + queue for the caller;
  `agentistics_task_phase { action: 'custody', take | release }` (session proof; a take is a piece action).
- CLI: `agentop flow custody [--project P] [--json]`.

### 5.4 Anti-bypass suite (rule c)

`delivery/custody.bypass.test.ts` (pure, injected clock) + `delivery/custody-tick.e2e.test.ts` (real
stores, reload after tick). **Every negative control runs after a positive establishes custody** in the
same fixture, so a no-op implementation fails the positive first.

1. **Positive**: leader dies; at `N − 1 min` "Sem líder"; at `N + 1 min` custody = live same-project leader, message delivered, Live shows it.
2. **Zombie**: leader row alive (`waiting`), heartbeat refreshed every minute, no piece action for `N + 1 min` → custody assigned (the heartbeat does not reset absence).
3. **Keep-alive cheats** (each after positive #1 is reproduced): (a) plain comments on the **same** piece every hour → do not reset absence; (b) transcript writes about another task → do not reset; (c) a heartbeat-only zombie → does not reset; (d) a real authorized piece action by the original leader → resets and returns custody.
4. **Never-led** piece created in review → `leaderAbsentSince` = stage entry; custody after `N`.
5. **Restart**: absence persisted across a server restart; custody still assigned at the right instant.
6. **Custodian actually acts**: the custodian approves the leader gate and declares the release for the orphan → accepted by `leads()`; the same custodian moving it to review **without evidence** → refused `evidence_required` (custody is not evidence).
7. **Filing invariant**: after custody, `conversationOwners` maps the custodian's conversation to its own task.
8. **Queue**: no project leader → queue; a leader starts → its SessionStart context lists the piece; on the next tick it is assigned and messaged.
9. **Custodian dies** → re-assigned / back to queue.
10. **Cross-project** (after #1 shows same-project assignment works) → a leader of another repository never receives it.
11. **Fleet unknown** (after custody exists) → no change at all, absence clock not advanced or cleared.
12. **Mutation control**: with absence anchored to `lastSeenMs` (r1's rule), case 2 must fail.

## 6. Rule (d) — every active piece has a forecast from measured history

### 6.1 What is wrong today (all three layers)

- `resolvePieceForecast` (`task-live.ts`) returns `publishEta: none / beyond-range` when the stage is past
  its boundary, discarding the `total` estimate it computed (also in `fix/calendario-registro-real`,
  `task-live.ts:666-675` on that branch).
- The calendar **independently** suppresses estimates: overdue → `none: overdue`
  (`C/deliveryCalendar.ts:185`), record-only active piece → `none: not-started` (`:222`); both remain on the
  sibling branch.
- Version aggregation ignores piece due dates (`C/deliveryCalendar.ts:279-288`).

### 6.2 The invariant

**Invariant F**: every non-terminal piece (not `published`, `completed`, `abandoned`) carries
`publishEta.kind === 'estimate'` — **always**, unconditionally. A typed `dueDate` on the piece itself is
an *additional* primary date, never a replacement for the estimate (r1's "estimate **or** dueDate" is
withdrawn). The type narrows: `LivePublishEta = { kind: 'estimate', … } | { kind: 'none'; reason: 'final' }`.
Stage ETA and publication ETA stay **separate types**; only the publication one is narrowed — a stage with
no history may have no stage ETA, and the card then shows only the publication forecast, never "sem
estimativa".

### 6.3 One projection, every surface

`C/pieceForecast.ts` `projectPieceForecast(input, history, nowMs)` is the ONLY function that produces a
piece's `publishEta`. Inputs are the same for a Live piece, a hidden/record-only piece, a group member's
group, and a version member: `{ stage, stageSinceMs, startedAtMs | null, typeId, harness, model, dueDate }`.

- `task-live.ts` calls it for every Live piece; `C/deliveryCalendar.ts` calls it for **every** piece it
  emits, including record-only ones, and **deletes** its own overdue suppression (`:185`) and the
  record-only `none` (`:222`).
- **Method**, decided explicitly (aligned with the sibling, so rebasing does not change policy):
  cohort median (type + harness + model → type + harness → harness), each needing ≥ 3 samples of the
  publication endpoint, range p25..p75 widened to ≥ 25 % of the median and ≥ 15 min half-width;
  confidence **high** n ≥ 8 and IQR/median < 0.6, **medium** n ≥ 4 and < 1.2, else **low**. With < 3
  samples in every cohort: the sibling's **stage-ceiling** forecast (`stageCeilingForecast`), labelled
  `source: 'stage-ceilings'`, low confidence — r1's "general mean then 4 h bootstrap" is replaced by it;
  the 4 h bootstrap remains only for a machine where the stage typicals are themselves absent. Samples:
  newest 500 valid terminal pieces in 90 days.
- **Queued** piece: start = now (`if-started-now`), anchored to the hour bucket.
- **Blocked** piece (`blocked` / `bloqueado` — non-terminal, but no clock runs; review r2 N6): the
  forecast is "**if unblocked now**", never fabricated progress and never `none`:
  `atMs = max(hourAnchor(now) + Σ typical(stages from the stage it will resume, inclusive) + residual(that
  stage), blockerEta)`, where `blockerEta` is the latest publication estimate of the pieces named in
  `blockedBy` (computed by this same projection, cycle-safe; absent for a free-text reason).
  `source: 'if-unblocked'`, `blocked: true`, confidence **low**; the card reads "bloqueada · se desbloqueada
  agora ~16/11". The estimate moves forward with the clock while the block lasts, which is the honest
  reading. A piece whose block names a reason only (`externo`) uses the first term alone.
- **`stageCeilingForecast` dependency (verified):** it exists on the sibling branch
  `fix/calendario-registro-real` (`S/sessions/task-live.ts`); S8a rebases onto it and moves it into
  `C/pieceForecast.ts`, never reimplements it. If the sibling has not landed when S8a starts, S8a waits — it
  is on the rule-d chain only, not on the critical path.
- **Stage overrun** (current stage past its typical boundary, whole piece not yet over budget):
  `atMs = max(total.atMs, hourAnchor(now) + Σ typical(remaining stages after the current one) + residual(current))`,
  where `residual` = the stage's p75 − p50 (never zero), `source: 'revised-overrun'`, `overrun: true`, low
  confidence. **Whole-piece overrun**: same formula, `total.atMs` already in the past is ignored.
  So `revised-overrun` is produced whenever the *stage* is overdue, not only when the total is.
- **Due dates**: the piece's own `dueDate` is primary on the card and in placement; the computed estimate is
  secondary ("prazo 14/11 · previsão ~16/11, atrasaria"). The parent's `dueDate` is a mark, not the
  piece's date. **Versions** consume both: a planned version's date is the max over its active pieces of
  `max(estimate, dueDate when typed)`, basis `estimate` / `due-date` / `mixed` — never `none`/`partial`
  while it has active pieces.
- **Read-only**: a forecast is never writable (`forecast_read_only`, 422).
- `assertForecast(pieces)` in `buildLive`/`buildCalendar` is a **regression alarm** (health WARN
  `delivery-forecast-missing`), not the mechanism; the mechanism is the single projection + the type.

### 6.4 Anti-bypass suite (rule d)

`sessions/forecast-invariant.bypass.test.ts` (pure, one injected clock + history snapshot) + a surface test:

1. Every stage × {0, 1–2, ≥ 3, ≥ 8 samples} × {started, unstarted, blocked, overdue 10× median} → `estimate` with a finite `atMs`, a range and a `source`. **Blocked** additionally: `source: 'if-unblocked'`, `blocked: true`; blocked by a piece whose estimate is later than the if-unblocked term → `atMs` = the blocker's; a `blockedBy` cycle terminates and still yields an estimate; advancing the clock 1 day while blocked moves `atMs` forward.
2. Leader stage overdue 9 days → `source: 'revised-overrun'`; **stage overdue but total within budget** → still `revised-overrun`.
3. **Bucket stability**: two instants 10 min apart inside the same hour bucket → identical `atMs`; a separate case across the boundary → `atMs` moves by the hour.
4. Record-only, hidden, old-review, group-member, no-model, no-session, no-harness pieces → estimate, **through the calendar's own code path** (not only `task-live`).
5. Typed piece `dueDate` → primary date = due date, estimate still present; parent due date alone → no override; a version whose only active piece has a due date and an earlier estimate → version date = due date, basis `due-date`.
6. **F on each surface independently**, then parity: `/api/tasks/live`, `agentistics_live_delivery`, `agentistics_delivery_calendar`, `agentop flow calendario --json` — each asserted to satisfy F for every active piece; then compared for equal `atMs`/range/source under the same clock and snapshot.
7. Write attempts with `publishEta`/`eta`/`confidence` via REST/MCP/CLI → 422 `forecast_read_only` (adapter coverage; does not prove F).
8. **Mutation control**: restore the calendar's overdue suppression (`:185`) → cases 1, 2 and 6 must fail. Restore `beyond-range` in the projection → case 2 must fail.
9. Lint (supplemental): "sem estimativa"/"no estimate" only under a terminal/stage-ETA branch.

## 7. Rule (e) — the anti-bypass suites, common requirements

- Suites are `*.bypass.test.ts`, **not** in `scripts/slow-tests.txt`; `affected-tests.ts` maps
  `delivery/**`, `sessions/task-store.ts`, `sessions/task-web.ts`, `C/pieceForecast.ts`,
  `C/deliveryCalendar.ts` and the MCP to them.
- **Storage, not helpers**: every forged-state test writes the real files the branch uses, runs the real
  `tick()`, and **reloads from disk** before asserting (a cached or structured copy staying authoritative
  would otherwise pass).
- **Positive controls reach the exact authorization tested**, without mocks pre-authorizing it.
- **One mutation control per invariant** (§3.5.21, §4.9.19, §5.4.12, §6.4.8): the suite runs once with the
  guard/repair/projection disabled and asserts the named cases fail.
- The door inventory is the **type system** (`GuardContext` required on every store write) plus the
  low-level-writer lint (§2.5); an allowlist is not proof.
- From S3 on, every slice attaches its own evidence under rule (a) — the spec eats its own cooking.

## 8. Implementation plan — slices a Sonnet can build

Each slice is one PR to `dev`, one worktree, tests via `agentop run --rm -- bun test <files>`, typecheck
under the heavy lock. AI-hours = implementation + tests + evidence for a Sonnet-class worker at high effort;
**planning estimates, not measurements**. QA (cross-model, one session per slice) and release are on top.

| # | Slice | Builds | Tests | Depends on | AI-h |
|---|---|---|---|---|---|
| S0a | Principal model + vault owner proof | `principal.ts`; REST/MCP/CLI adapters incl. the `legacy-browser` shape; proof on every MCP task write; `reserved_actor`; `delivery/web.ts` and `leads()` stop reading "no proof" as owner; **the §2.3.1 primitive**: `requireDeliveryOwner` (fresh `proveGesture`, password first), `owner-proof-unavailable` on silent-only vaults, `delivery` grant class (scoped, single-use, ≤ 5 min, loopback, header transport), `delivery-owner` row refusing the generic gate, no `ACTION_KIND_OF`/`REMOTE_ROWS` entry; `delivery.ownerProof` preference (absent = `legacy`, mode switch is an owner-only move); health WARN `delivery-owner-unproven`; vault UI dialog wiring for validate/approve/override | §3.5.15 both modes; vault inventory rows (`save-no-proof`, `review-2-103-2`); policy-lowering immunity; per-state table §2.3.1 (no vault / silent-only / locked / frozen / recovery / back-off) × mode; grant scope + single-use + remote refusal | — | 9 |
| S0b | Activation + checkpoints | `guarantees.json` (absent = `off`, `statusStages` mirror, `off`/`shadow`/`activate` as owner-only moves), `guards.json` (intents, two-phase commit, recovery), `withGuardLocks` + global lock order + 5 s fail-closed timeout (§2.6.1); captured v2.210.1 **deliveries.json and tasks.json** fixtures + downgrade tests | §3.5.18–19; both downgrade round trips; `guards-lock-order.test.ts` | — | 6 |
| S0c | Stored status stage | `TaskStatusDef.stage`, backfill, mirror restore, `status_stage_in_use`, consumers read the stored stage | §3.5.8; mirror restore after old-writer round trip | S0b | 4 |
| S1a | Evidence + probe schema | `evidence.ts` validators (image header, test-log, report, repoRef), `Probe` shapes + attach validation (no runtime), uniqueness by sha256 per piece-revision | §3.1 table ±, §3.5.9, .11 | S0b | 4 |
| S1b | Classification | `classify.ts` + `classify-host.ts` (checkout from filed sessions, dirty check, categories, `unknown`), leader `flow classify` declaration (§3.2) | §3.5.10, .12–.14; declaration by worker refused, by leader logged + counted | S0b | 4 |
| S1c | Attach doors | REST/MCP/CLI evidence verbs, uploads, `agentop evidence capture`, `evidence_in_use` | §3.5.16 | S0a, S1a | 4 |
| S2a | Store guard, rule A | `guard.ts`, hooks in `task-store.ts` `write()` and `delivery/store.ts` `update()` (under `withGuardLocks`), **optional** `GuardContext` + fail-closed at runtime + shrinking-allowlist lint (§2.5), low-level-writer lint, handback hold, flow gate `evidencia` | §3.5.1–7, .20 | S0a–c, S1a–c | 6 |
| S2b | Sweep | `guardSweep` over checkpoints, one-write batch revert of both documents, board catch-up, loop guard (WARN names `guarantee off`), intent recovery, never reverts an `owner` checkpoint of either `via` | §3.5.17–19, .21 | S2a | 5 |
| S2c | `GuardContext` required | empty the allowlist, make the parameter required (compiler = inventory); rebase-friendly small PR | typecheck; lint allowlist empty | S2a | 2 |
| S3 | Evidence UI | chip, "handback retido", upload; worker brief line | component tests; 390 px | S1c | 4 |
| S4 | Build identity + ledger | `build {repoKey, sha, tree, capabilities}` in the slot and `/api/version`; `installs.jsonl`; `flow installs` | ledger idempotence/cap; additive payload | — | 3 |
| S5a | Inclusion proof | `release-proof.ts` `proveInclusion` (ancestry/patch-id/tree-holds, range without tags, revert-aware); `squashPublishedIn` as wrapper | §4.9.1, .2, .7, .8 | sibling `fix/calendario-registro-real` landed | 4 |
| S5b | Releases + publication | `releases.ts`/`release-store.ts` keyed by repo@commit; candidates vs proofs; local mode with required commit; publication by proof (+ ledger for own repo) | §4.9.3–6, .9 | S4, S5a, S2a | 5 |
| S5c | Lifecycle | **first** the classified `done` consumer inventory (§4.7, ≈ 262 hits) checked in; `published` status, `PHASE_STATUS` change, `stageOfStatus('done') = completed`, every B-class consumer read through the stored stage, `done-as-published` lint, `release_required`, non-code completion (§3.6) + the acceptor rules (§3.7) and "Aguardando aceite" band | §4.9.14–15 (both modes), .17; §3.6 positive; tasks.json downgrade round trip with the real `published` status | S5b, S0c | 7 |
| S6a | Verify jobs + verifier | `verify-jobs.json` (CAS, superseded, retries), `verify-host.ts` (http/bundle/cli/structural), baseline/candidate pinned results, strength | §4.9.11–14, .16 | S5b, S1a | 6 |
| S6b | Reopen + chips | edge `publicado > ajuste`, dynamic adjust status, loop guard, Live/Calendar chips | §4.9.10, .18, .19 | S6a, S5c | 4 |
| S7a | Custody clocks | `leaderActivityAt`, `leaderAbsentSince` rules, custody plan per piece, queue | §5.4.1–5, .9–.12 | S0a, S2a | 4 |
| S7b | Custody authority | `leads()` accepts custodian, wake routing, check-in, SessionStart discovery vs assignment message | §5.4.6–8 | S7a | 4 |
| S7c | Custody UI + verbs | Live band, MCP/CLI custody verbs | 390 px | S7b | 3 |
| S8a | Forecast projection | `C/pieceForecast.ts`; `task-live.ts` + calendar (incl. record-only) consume it; calendar suppressions deleted; stage-overrun revision; blocked "if unblocked now" (§6.3); versions use due dates | §6.4.1–5, .8 | sibling landed | 6 |
| S8b | Type + surfaces | narrowed `LivePublishEta`, web branches removed, surface F + parity, alarm WARN | §6.4.6, .7, .9 | S8a | 3 |
| S9 | Cross-door e2e on the binary | `agentop run --rm --serve -- <branch server command>`; MCP + CLI + REST + forged state + reload, per rule, in `shadow` then `on` | four suites green on the compiled binary | S2b, S6b, S7c, S8b | 5 |
| S10 | Migration + activation | `flow guarantee-migrate [--apply]` (grandfathered checkpoints, `published` status migration, triage comments from `leader/qa/triagem-sem-lider.md`), `flow guarantee shadow|activate|off <rule>` (owner-only) with prerequisite checks | dry-run on a throwaway copy reproduces the 27/20 classification, one triage comment per piece; activation refused without 24 h shadow | per rule (§2.7) | 6 |

**Total ≈ 108 AI-hours** over 23 slices (r1 said 52, r2 said 94; r3 adds the real vault primitive in S0a
+4 h, the lock order and the tasks.json fixture in S0b +1 h, the stage mirror in S0c +1 h, the staged
`GuardContext` tightening S2c +2 h, the `done` inventory and acceptor rules in S5c +3 h, blocked forecasts in
S8a +1 h, and the owner-only activation verbs and triage in S10 +2 h — review r2 N7 estimated 105–115 h).
Treat 108 h as the **planning figure** and 115 h as the ceiling. Add ≈ 1 h of cross-model QA per slice
(≈ 23 h) and serial integration.

**DAG and critical path.** Chains after S0: rule a = S0b → S0c; S0a ∥ (S0b → S1a/S1b) → S1c → S2a → S2b →
S3 (S2c any time after S2a, off the path); rule b = S4 + sibling → S5a → S5b (also needs S2a) → S5c → S6a →
S6b; rule c = S2a → S7a → S7b → S7c; rule d = sibling → S8a → S8b. **Critical path**: S0b 6 → S1a 4 → S1c 4
(S0a's 9 h run in parallel and finish first) → S2a 6 → S5b 5 → S5c 7 → S6a 6 → S6b 4 → S9 5 → S10 6 =
**53 h** serial implementation, + ≈ 10 h of QA on that path ≈ **63 h wall-clock with four workers**, provided
the sibling `fix/calendario-registro-real` has landed before S5a starts (S5a/S5b would otherwise move onto
the path). Rule a can be activated (`shadow` → `on`) after S2b + S3 + S10, without waiting for rule b
(≈ 35 h from start); rule d as soon as S8b ships.

Every slice: whatsNew pt+en only for user-visible slices (S3, S5c, S6b, S7c, S8b), mobile branch in the
same change for UI slices, Darwin-safe IO (classification and custody use git and the registry; the CLI
process-tree proof already has its macOS `ps` path).

## 9. Owner decisions this spec assumes (recorded on the subtask)

- **D1** owner proof = a fresh proof of the vault's own credential (vault password / Hello / Touch ID /
  passkey), never TOTP and never an enrolment (owner 07/11: the vault has no authenticator); absent
  preference = `legacy` with the permanent health WARN; `required` is opt-in and only where the vault has a
  human wrapper (§2.3, §2.3.1).
- **D7** (r3) absent `guarantees.json` / rule entry = `off`; no rule ever changes state automatically;
  `shadow`/`activate`/`off` are owner-only moves (§2.7).
- **D8** (r3) acceptance without a second model: owner, or after 24 h (immediately on a one-model machine)
  the piece's leader/custodian, labelled weaker (§3.7).
- **D2** `N = 4 h` for orphan custody.
- **D3** local-mode publication = declaration with inclusion proofs, plus observed install for this host's
  own repository; other projects are published but `verification: not-applicable`.
- **D4** `publicado` maps to a new `published` board status; `done` means owner-validated (by either
  owner `via`, recorded) — or a non-code piece completed through §3.6/§3.7.
- **D5** legacy pieces are migrated with grandfathered checkpoints, never reverted.
- **D6** every rule passes ≥ 24 h of `shadow` before `on`.

## 10. Risks and stated limits

1. **Evidence proves shape and binding, not truth.** A real screenshot of the wrong screen passes. Truth
   stays with `qa-modelo` and the owner.
2. **False refusals stall honest workers** (`classification_required` on a session filed late, a dirty
   tree with a scratch file). Mitigation: the `shadow` week counts every `would_refuse` by code; the
   refusal names the exact fix; a held handback still records the comment.
3. **Weak verification is possible but visible**: `regression`, `unpinned` and `structural` pass, and say
   so on the card and the checkpoint.
4. **Verification depends on the machine being upgraded**; pending is visible, > 7 days is a WARN, never a
   reopen. A machine that never upgrades stays `published · pending` locally — never "verified".
5. **The installed server checks itself.** A build that cannot boot leaves no ledger line; its release
   stays unverified and visible. Upgrades from pre-S4 binaries have no baseline: probes of pieces released
   before that read `unpinned`.
6. **Same-user processes and the owner.** In `ownerProof: legacy` (the default, and the only mode on a
   machine whose vault has no human wrapper) a same-uid process that forges browser headers can act as the
   owner for owner-only moves (validate, approve, rule switches, and override — the one visible exemption
   from guards A/B, which otherwise bind the owner too). Health says so permanently
   (`delivery-owner-unproven`), every `legacy-browser` override is counted and labelled "sem prova" on the
   card, and `required` closes it wherever the vault has a password or a presence wrapper. In `required`, a
   process that can read the browser's memory could replay a live `delivery` grant within 5 min for the one
   piece and move it was scoped to — outside the stated threat model.
7. **The sweep can fight a forgotten writer** — but every in-code writer goes through the store hook and
   fails closed; only out-of-process writers (older binaries, hand edits) are reverted, and the
   twice-in-24h rule turns a loop into a visible block.
8. **Custody needs a leader to exist.** With none, the queue grows, visible with ages; nothing pings the
   owner in autonomous mode.
9. **Forecast honesty.** Low-confidence numbers appear everywhere; `n`, scope and `source` stay on the
   card.
10. **Sibling work.** S5a and S8a both depend on `fix/calendario-registro-real` landing (its
    `firstTagContaining`, its stage-ceiling fallback and its calendar changes); rebase, never reimplement.
11. **Locks.** A slow or stuck writer makes guarded writes fail `guard_busy` (closed), never pass unguarded;
    a persistently busy lock is a WARN naming the holder pid.
12. **Acceptance without a second model is weaker** (§3.7): a same-model leader can wave through its own
    blind spot. It is labelled on the card and counted; it exists so that one-harness machines are not
    stalled forever, which is the failure the owner reported.

## 11. Review r1 → disposition

Every finding was verified against the code at `53f9c7898` before being dispositioned.

| # | Sev. | Finding | Disposition | Where / evidence |
|---|---|---|---|---|
| 1 | CRITICAL | Owner exemption bypassable by omitting identity or forging `actor` | **Accepted.** Verified: `index.ts:2685` forwards `body.actor`; `task-web.ts:1631` defaults to `'you'`; `cli-task.ts:117` passes no actor; `delivery/web.ts:47-51` reads no proof as owner; MCP `agentistics_task_status` sends no proof (`agentistics-mcp.ts:1231-1238`); no login exists since `418fae359`. Resolved with a trusted principal: owner = a fresh proof of the vault's own credential through a new dedicated gate and a scoped single-use `delivery` grant (§2.3.1, r3), no proof = `unattributed`, reserved actors refused; D1 (r3 wording) keeps `legacy` as the default where no human vault proof exists, narrowed to a browser-shaped request and WARN-flagged, so the narrower threat model is explicit, never silent. | §1.1, §2.3, §2.3.1–2, §3.5.15, S0a, D1 |
| 2 | HIGH | Door inventory misses semantic statuses and delivery-document writers | **Accepted.** Verified: `stageOfStatus` classifies labels (`task-live.ts:249-262`); `transition` stores the phase before board effects (`service.ts:332-361`), effects only warn (`:283`); `setSubtaskCi` uses `upsertSubtask(next)` (`task-web.ts:1836`). Resolved by stored status stages, a semantic two-document ladder, and the guard at the store choke point (fails closed), with the compiler as the inventory and a low-level-writer lint. | §2.2, §2.5, §3.5.7–8, S0c, S2a |
| 3 | HIGH | Guarded events are neither durable authorization nor sufficient reconciliation | **Accepted.** Verified: `MAX_EVENTS = 2000` with oldest dropped (`task-store.ts:79,960`); status and event are separate writes (`task-web.ts:1608,1631`). Resolved by per-piece checkpoints in `guards.json` bound to revision, HEAD and the complete authorization set; two-phase intents; a sweep over current state of every piece; custody never substitutes evidence/proof; SLA = one tick, no per-tick cap. | §2.6, §5.2.2, §3.5.17–19, S0b, S2b |
| 4 | HIGH | No verified HEAD is an evidence-category escape hatch | **Accepted.** Resolved: classification at every guarded move from the resolved checkout; `unknown` refused (`classification_required`); dirty trees refused; non-code outcomes are an explicit path; core/build/test-only defined; binding by HEAD and uniqueness per piece-revision replaces attachment-time freshness. | §3.1, §3.2, §3.6, §3.5.10–13 |
| 5 | HIGH | The reused squash helper cannot prove inclusion in a particular build | **Accepted.** Verified: `squashPublishedIn(sha, dir, repoKey, nowMs)` returns a boolean over the newest tags and `false` with none (`release-squash.ts:136-150`). Resolved with `proveInclusion` against an exact target commit returning kind + containing commit, used for both linking and verification (no later HEAD-ancestry requirement), revert-aware. | §4.3, §4.4, §4.9.1–2, .7–8, S5a |
| 6 | HIGH | Release labels and intentions treated as proof of contents | **Accepted.** Verified: r1 let `declared`/`target` win and published on an observed label; releases already carry a repo (`service.ts:688,723`). Resolved: releases keyed `repoKey@commit`, version only a label; candidates vs proofs; null build sha never counts; installed verification scoped to this host's artifact, other projects `not-applicable`; skipped releases by ancestry, not `compareVersions` (`deliveryCalendar.ts:303`). | §4.2–4.4, §4.7, §4.9.3–6 |
| 7 | HIGH | Mandatory discriminating probes reject legitimate fixes and recovery | **Accepted.** Resolved: attach-time `probe_not_discriminating` withdrawn; strength measured against pinned baseline/candidate builds (`discriminating`/`regression`/`unpinned`); `structural` verification with QA-accepted reason; non-code outcomes complete without a release. | §3.6, §4.5, §4.9.13–14 |
| 8 | HIGH | Publication, owner completion and verification reopen contradict current state | **Accepted.** Verified: `PHASE_STATUS.publicado = done` (`machine.ts:455`), applied in `host.ts:39`, relied on in `service.ts:693`. Resolved with the lifecycle table, a `published` status, the consumer migration, persisted CAS'd verify jobs with retry and supersession, dynamic adjust status. | §4.6, §4.7, §4.9.10–12, S5c, S6a |
| 9 | HIGH | Custody's inactivity clock contradicts the zombie test and lacks an origin | **Accepted.** Verified: `lastSeenMs` is a poller timestamp (`registry.ts:80-86,178-186`); `leads()` and `wake()` know only the recorded/filed leader (`service.ts:260,276`). Resolved with liveness / task-scoped piece activity / persisted `leaderAbsentSince`, transcript writes excluded, never-led and restart rules, per-piece custody through `leads()`, wake, check-in and projection; startup discovery separated from assignment. | §5.1, §5.2, §5.4, S7a–b |
| 10 | HIGH | S8's implementation does not establish the forecast invariant | **Accepted.** Verified: calendar suppressions at `deliveryCalendar.ts:185,222` (also on the sibling); sibling keeps the stage-ceiling fallback; versions ignore due dates (`:279-288`). Resolved with one core projection for every piece and surface, suppressions deleted, policy decided (stage ceilings below 3 samples), stage-overrun revision defined, estimate unconditional with due date additional, versions consume due dates. | §6.2, §6.3, §6.4, S8a–b |
| 11 | MEDIUM | Cutover and slice dependencies can enforce rules before prerequisites | **Accepted.** Verified: the parser keeps only known top-level fields (`store.ts:51-63,76-81`). Resolved with per-rule activation in a separate file, `shadow` mode, prerequisite-checked activation, captured older-parser downgrade test, explicit statement that older writers are not prevented; probe schema / runtime split; S5a and S8a both depend on the sibling; DAG and hours recomputed (r2: ≈ 94 h / 47 h; r3: ≈ 108 h / 53 h, §8). | §2.7, §8 |
| 12 | MEDIUM | Several anti-bypass assertions do not isolate the intended rule | **Accepted, row by row.** Jump doors: all semantic + custom statuses seeded, both documents asserted unchanged (§3.5 setup, .7). Positive control split evidence-only vs publication (§3.5.20, §4.9.15). No-GitHub: undeclared squashed P2 + wrong-content same label (§4.9.2, .4). Forgotten piece: targeted-unmerged P3 negative (§4.9.3). Done refusal: all other gates satisfied first (§4.9.15). Read-only verification: unchanged + executed probe changes it, after reload (§4.9.16). Keep-alive: same-piece no-op comments, transcript writes, heartbeat zombie, real action (§5.4.3). Filing/cross-project/unknown after an established positive (§5.4 preamble). Write refusal kept as adapter coverage only (§6.4.7). String lint supplemental; F asserted per surface (§6.4.6, .9). Forged state against real storage with reload, event retention, phase-only edits (§3.5.17–18, §4.9.17, §7). Bucket test fixed (§6.4.3). One mutation control per invariant (§7). | §3.5, §4.9, §5.4, §6.4, §7 |

No finding was rejected: each claim reproduced against the cited lines.

### 11.1 Review r2 → disposition

Review r2 (Sonnet 5.5, `leader/qa/review-entrega-garantida-r2.md`): **APROVADO COM AJUSTES**. Every item
was re-checked against the code at `53f9c7898` before being dispositioned; the leader's binding decision
on D1 (owner order 07/11) frames items D1.x and V.

| # | Sev. | Finding | Disposition | Where |
|---|---|---|---|---|
| D1.1–D1.9 | HIGH | TOTP / enrolled-authenticator residues contradict D1 (header note, §1, §1.1, principal type, owner paragraph, table, §3.5.15 / §4.9.15, §10.6, thin S0a row) | **Accepted.** All rewritten: no TOTP or enrolment anywhere; owner = fresh proof of the vault's own credential; `legacy` default with permanent WARN, `required` opt-in; leader note deleted. §1.1 now states the consequence per mode (no longer "no owner exists"). | header, §1, §1.1, §2.3, §2.3.2, §3.5.15, §4.9.15, §10.6, §9 D1 |
| V | HIGH | The vault has no step-up by unlock credential; a no-proof row passes on an open vault; a gesture row is skipped without presence; policy can lower a kind; grants are only `read` | **Accepted, verified** (`gate.ts:83,151,176,437-490`; `proveGesture`/`provePassword` `:347-390` already accept the password as a proof; `PRESENCE_IDS` includes `password`). S0a builds `requireDeliveryOwner` (always a fresh `proveGesture`), `owner-proof-unavailable` on silent-only vaults, a scoped single-use `delivery` grant, header transport, immunity to `ACTION_KIND_OF`/`REMOTE_ROWS`, a per-state × mode table, inventory rows. S0a re-estimated 5 → 9 h. | §2.3.1, §8 S0a |
| N1 | HIGH | Stored `stage` + `done` remap: consumers not enumerated; old binaries may drop `stage`; tasks.json not in the downgrade test | **Accepted.** Measured inventory size (≈ 262 literal `'done'` hits; server 123 / web 115 / tui 13 / core 11 / mcp 0), anchors named, A/B/C classification checked in first by S5c, `done-as-published` lint; `stage` mirrored in `guarantees.json` and restored on load, never re-derived from a label; captured v2.210.1 task-store fixture round trip in S0b and S5c. | §2.2, §2.7, §4.7, S0b, S0c, S5c |
| N2 | HIGH | Absent `guarantees.json` semantics unstated; `legacy` REST semantics contradict "no proof never means owner" | **Accepted.** Absent file / entry / unparseable = `off`; nothing changes state automatically; switches are owner-only. REST resolution order made explicit: grant → session → (`legacy` only) browser-shaped loopback request → `unattributed`; the forging `curl` is the stated legacy threat. | §2.3, §2.7, §9 D7 |
| N3 | MED | Lock order across three files; deadlock risk | **Accepted.** Global order tasks → deliveries → guards, all locks taken before reading, restart-from-the-top rule, 5 s timeout failing closed (`guard_busy`), `withGuardLocks` helper + lint + two-process loop test. | §2.6.1, §3.3, §10.11, S0b |
| N4 | MED | Suites not parameterised by `ownerProof`; sweep could revert a legacy owner `done` | **Accepted.** Mode columns in the principal table; §3.5.15 and §4.9.15 run `describe.each(['required','legacy'])` with per-mode expectations; the sweep never reverts an `owner` checkpoint of either `via`, asserted after a real tick + reload. | §2.3.2, §3.5.15, §4.9.15, S2b |
| N5 | MED | `structural` / non-code stall on a missing `qa-modelo` | **Accepted.** Acceptor ladder: another-model QA, owner, or the piece's leader/custodian (not a filed session) after 24 h — immediately on a one-model machine — labelled weaker, counted, "Aguardando aceite" band with age, WARN > 24 h. | §3.7, §4.5, §4.9.14, §9 D8, §10.12 |
| N6 | MED | Invariant F vs blocked pieces; `stageCeilingForecast` existence | **Accepted.** Blocked = "if unblocked now", max with the blocker's estimate, `source: 'if-unblocked'`, low confidence, cycle-safe; test rows added. `stageCeilingForecast` verified on `fix/calendario-registro-real` (`task-live.ts`); S8a rebases onto it. | §6.3, §6.4.1, S8a |
| N7 | MED | Slices mis-estimated; required `GuardContext` is a merge-conflict magnet | **Accepted.** `GuardContext` optional in S2a (runtime fail-closed + shrinking-allowlist lint), required in new S2c (2 h). Re-estimated: S0a 9, S0b 6, S0c 4, S5c 7, S8a 6, S10 6. **Total ≈ 108 AI-h (ceiling 115), critical path 53 h + ≈ 10 h QA ≈ 63 h wall-clock** with four workers. | §2.5, §8 |
| N8 | LOW | Hand edits reverted every tick with no escape | **Accepted.** `agentop flow guarantee off <rule>` (owner-only), named in every revert / loop-guard / WARN text; turning a rule off raises its own WARN. | §2.7 |
| N9 | LOW | `classification_required` can stall honest work forever | **Accepted.** Leader/custodian `flow classify` declaration naming the repository and commit (never the category), re-classified by the server, logged and counted; workers cannot declare. | §3.2, S1b |

No r2 finding was rejected.

## S0d — hardening after the live security QA of S0a + S0b (13/11, `leader/qa/qa-eg-seguranca.md`, REPROVADO)

Binding design for slice S0d. It amends §2.3, §2.3.1, §2.6, §2.6.1 and §2.7; anything not named here is unchanged.

### S0d.1 (F1) The `ownerProof` mode is a sealed record, and reads fail closed

- **The record.** `<vault dir>/delivery-owner-mode.json` = `{ v: 1, kid, mode, atMs, mac }`, `mac =
  HMAC-SHA256(HKDF-SHA256(DEK, salt = kid, info = "agentistics/delivery-owner-mode/v1"), kid ∖0 mode ∖0 atMs)`
  — the `unlock-window.json` pattern. It is written ONLY by `setOwnerProofMode`, i.e. right after
  `requireDeliveryOwner` proved the owner with the vault open. `preferences.json`'s `delivery.ownerProof` stays as a
  display mirror for older readers and is never trusted to mean `legacy`.
- **Reading** is the pure `resolveOwnerMode({ record, prefs, latch })`:
  - `required` when ANY source says `required`, when the record exists but is unreadable or its MAC does not verify,
    or when the record vanished while this process had seen one (the latch);
  - `legacy` only when the record says `legacy` AND its MAC verifies under the open vault, or when there has never been
    a record (no file, no latch) and the preference does not say `required` — so a machine that never chose `required`
    behaves exactly as before;
  - a `legacy` record that cannot be verified right now (vault locked, or a CLI process that is a vault client) reads
    `required`. Cost, accepted: an owner who once chose `required` and went back to `legacy` is asked for the vault
    proof until the vault is unlocked.
- **Latch.** The process keeps the last effective mode; only `setOwnerProofMode` moves it to `legacy`. Editing,
  dropping or garbling any file while the server runs therefore changes nothing.
- **Health.** WARN `delivery-owner-mode-tampered` naming the reason (`unreadable` / `forged` / `replayed` / `vanished` /
  `disagree`), alongside the existing `delivery-owner-unproven` (English, like every other health item). The same
  state is read by `GET /api/deliveries/integrity` and the MCP `agentistics_vault_status` (`delivery` block).
- **Stated limit.** Every file a same-uid process can read it can also delete. Deleting the record AND the preference
  AND restarting the server reads as "never chosen" (`legacy`, with its permanent WARN). Only a secret can stop a
  rollback, and the vault's secret is not available while it is locked; a restart is visible (it kills the fleet).

### S0d.2 (F2) `guards.json` and `guarantees.json` are MACed; tampering fails closed

- **Key.** `<dataDir>/guard-integrity.key` (0600, not a `.json`): 32 random bytes plus the list of documents ever
  sealed with it, created on the first sealed write. It is excluded from backups by the existing `.key` secret rule
  (guards/guarantees are not backed up either). Each document carries `integrity: { v: 1, mac }`, `mac =
  HMAC-SHA256(key, "<document name>" ∖0 canonical-JSON(document without integrity))`, so one file cannot be swapped for
  the other.
- **Verdicts** (pure `checkIntegrity`): `ok`; `fresh` (no key, no document); `tampered` with a reason —
  `unsealed` (no/garbled `integrity`), `forged` (MAC mismatch), `missing` (key says the document was sealed, it is gone),
  `key-missing` (a document exists, the key does not). S0b never shipped, so there is no unsealed legacy file to migrate:
  an unsealed file IS tampering.
- **guards.json tampered** → `GuardsUnreadable` (every guarded write refused, nothing replaces the bytes; the
  existing fail-closed path) + WARN `guards-tampered: <reason>`.
- **guarantees.json tampered** → the rules come from the authenticated mirror in `guards.json` (`rules`, written in
  the same guards-locked section as every guarantee move); with no authenticated mirror every rule reads `on` —
  the guard binds rather than disappear. Never `off` for a tampered file. WARN `guarantees-tampered: <reason>`. An
  owner move (`setState`, owner check first) re-seals from the effective state; that is the repair.
- **"Rule was shadow/on and vanished"** is the `missing` verdict; deleting the key too is `key-missing` while either
  document remains.
- **Stated limit.** A same-uid process that reads `guard-integrity.key` can forge a MAC. This closes the §1.1
  `*.json`-edit capability and every deletion/edit that does not also read a key file; moving the key under the
  machine key (`vault/machine-secrets.ts`, silent OS wrapper) is a follow-up, not S0d.
- **N1 (re-QA, deletion never reads fresh).** A sealed witness in its own directory (`<dataDir>/guard-seal/witness.json`,
  0600, MAC'd with the same key) repeats which documents were sealed, a sealed sibling with no key proves a key existed,
  and the running process latches every generation it verified — any of the three makes an absent document `missing` /
  `key-missing` (rules from the mirror or all `on`, WARN), and a key with no witness is `witness-missing`; only deleting
  documents, key AND witness and then restarting reads a fresh machine (stated limit).
- **N2 (re-QA, rollback).** Every sealed write bumps the document's generation, sealed inside its MAC (`integrity.gen`,
  `mac` over `"<name>"∖0"g<gen>"∖0…`) and recorded in the witness, so an older sealed copy (generation below the witness
  or below what this process saw) is `rolled-back` — fail closed and WARNed exactly like any other tamper; rolling back
  the witness too is caught only by the process that saw the newer state (stated limit).
- **N3 (re-QA, reserved names outside `actor`).** A claim's `by` and an upload's `author` naming `owner`/`you`/`dono` are
  the real principal (the proven owner keeps the name, a proven session is recorded as itself; with no proof the claim is
  403 `reserved_actor` and the upload's author is `unattributed`); `flow:*` is always refused.
- **W1 (integration QA, cold rollback).** The key file also records the highest generation sealed per document,
  written last on every sealed write, so copying back an older documents + witness set and restarting reads
  `rolled-back` (WARN, guards refuse writes). Stated limit: restoring the key file too from the same old copy (four
  files) reverts every anchor and reads as the older state, and a same-uid process that reads the key still forges a
  MAC; a vault-held counter would close it (needs the vault at boot, follow-up). `rolled-back` guards have no owner
  repair path yet (as with any tampered guards file).
- **W3 (integration QA, comments and threads).** In required mode a reserved author (`owner`/`you`/`dono`) on a new
  comment, thread open or thread send is the proven principal, a proven session is recorded as itself, no proof is
  `unattributed`, `flow:*` is refused; legacy mode keeps the text as sent (no change for users who never turned
  required on).

### S0d.3 (F3) The `/api/tasks*` principal screen runs on every write

Every non-GET/HEAD/OPTIONS request under `/api/tasks` is screened whatever its `content-type` (or none): the body is
read as text and parsed as JSON; a non-empty body that is not JSON is refused 415 `json_required` (EN/PT) — the
handlers parse JSON regardless of the header, so a lying header was the bypass.

### S0d.4 (F4) `file-lock` never steals a live lock

The lock directory holds an `owner` file `{ pid, host, token }` written before the lock counts as held, and the holder
refreshes the directory's mtime every `STALE_MS / 3` (heartbeat, unref'd timer). A blocked acquirer steals only when
the lock is older than `STALE_MS` AND its owner is not alive (same host and `kill(pid, 0)` says ESRCH, or no readable
owner after `2 × STALE_MS`). `release` removes the directory only when the `owner` token is its own. `withGuardLocks`
inherits this; a holder paused past 15 s is no longer joined by a second writer.

### S0d.5 (F5) Every MCP task write carries the proof, DELETE included

`withTaskWriteProof` covers bodiless writes: a `DELETE` under `/api/tasks*` sends the proof as a JSON body; the
server reads a DELETE body like any other write (§S0d.3). Tests drive EVERY MCP task-write tool through `apiSend` and
assert `session` in the payload (kills mutants M1 "proof removed from apiSend", M2 "task_claim with session: null",
M10 "task_delete without proof").

### S0d.6 (F6) A comment with `role: owner` needs the owner principal

Creating a comment with `owner: true`, and editing or removing a comment whose `role` is `owner`, resolves the REST
principal exactly as `/api/deliveries` does (grant → session → legacy browser → unattributed) with scope
`{ pieceKey: <task ref or comment id>, move: comment:create | comment:edit | comment:remove }`. Not the owner → 403
`owner_proof_required` (required) / `so_o_dono` (legacy); the web retries through `postWithOwnerProof`, so the owner
gets the vault dialog in `required` and nothing changes for `legacy`. Ordinary comments are untouched.

### S0d.7 (F7) Refusal words

`so_o_dono`, `so_o_lider`, `reserved_actor`, `grant_scope`, `owner_proof_local_only`, `guard_busy`, `lock_order`,
`json_required`, `unverified_sender` get EN + PT sentences on the web; the server's `owner-proof-local-only` (vault)
and the delivery route's `owner_proof_local_only` are both mapped (the delivery route normalises `-` to `_`).

Out of scope, recorded: the crash-recovery tick that consumes `planRecovery` (S2b).
