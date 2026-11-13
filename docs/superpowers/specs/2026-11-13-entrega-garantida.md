# ENTREGA.GARANTIDA — server-enforced delivery rules the model cannot skip

Date: 2026-11-13. Status: specification, no runtime change in this document.
Tracking: Agentask `t-e1dea7cd6f` / `s-1961340554`. Baseline: `origin/main` @ `53f9c7898` (v2.210.1).

## 1. Why, and what "cannot skip" means here

The owner, 2026-11-13 ~03:20Z: deliveries should be made "guaranteeing quality, traceability,
deterministic flows, delivery forecasts … and none of that is being met". The board at that moment
proved it: 27 cards in *Revisão do líder*, 20 in *Sem líder*, and 157 of 191 in-review pieces with no
publish forecast. The 2026-11-13 evidence pass (`leader/qa/evidencia-entregas.md`) found that most
of those cards were already published, or were branches nobody merged, or had never produced any
proof that the thing works.

None of that was missing *machinery*. The delivery state machine (`delivery/machine.ts`), its gates
(`delivery/gates.ts`), the minute tick (`delivery/service.ts`, `delivery/ciclo.ts`), squash detection
(`sessions/release-squash.ts`), tag inference (`sessions/release-tags.ts`), the forecast estimator
(`sessions/task-live.ts`) and the calendar (`packages/core/src/deliveryCalendar.ts`) all exist. What
is missing is that **every rule has a side door**, and an assistant under pressure takes it:

| Rule the flow already states | The side door that empties it |
|---|---|
| QA before review, with findings | A `handback` moves the subtask `in_progress → in_review` directly (`statusAfterHandback`, `session-message.ts` `handbackSubtask`), and `patchSubtask`/`markTask` accept `in_review` from anyone. Neither consults the delivery record. Most of the 27 cards entered review this way. |
| `ci → publicado` on release evidence | Needs GitHub (`gh` release run + tag). A squash-merged legacy piece has no record and no version, so it sits in review after shipping (2.209.3 / 2.210.x showed 0 pieces). Nothing checks that the *installed* binary really carries the change. |
| A leader reviews | "Sem líder" is a presentation stage (`task-live-view.ts` `leaderForTask`) with no consequence and no clock. A piece whose leader died stays there forever. |
| Every open piece has a forecast | `resolvePieceForecast` returns `none: beyond-range` for every piece past its stage boundary. On a board where most pieces are overdue, that is most pieces. |

"Cannot skip" in this spec has a precise meaning:

1. Each rule lives in **one pure decision function** and is enforced at the **one write door** every
   surface reaches (REST, MCP, CLI, web drag, handback auto-move, engine flows, the tick).
2. A state that should be impossible but appears anyway (a hand edit of `tasks.json`, an older binary
   writing the book, a door added later that forgot the check) is **detected by the minute tick and
   reverted with a comment** — the rule is re-established from evidence, not from trust.
3. Each rule has an **anti-bypass test** (rule e) that attacks every door and asserts the refusal,
   plus one that forges the impossible state and asserts the tick reverts it.

What this spec does **not** claim: that a screenshot is truthful, or that a probe covers everything a
change does. Evidence is checked for *shape, freshness and binding*, deterministically; truth is still
the job of a QA session of a different model (the existing `qa-modelo` gate) and of the owner. Stated
again in §9.

### Threat model

The adversary is an assistant (worker or leader) that wants a piece to *look* further along than it is
— to clear its queue, to finish a turn, to satisfy a prompt. It can call every MCP tool, every CLI
verb and every REST route its session can reach, in any order, with any payload. It can write files in
its worktree and attach them. It cannot (and this spec does not defend against it doing so) read the
host's session-identity key and forge another session's proof, or edit `~/.agentistics` by hand
*between two ticks and then undo it* — but rule 2 above means a hand edit that *stays* is reverted.

## 2. Shared pieces

### 2.1 Cutover instant

`deliveries.json` gains `guaranteedSince: ISO` — written once, by the first build that ships slice S0,
under the store lock, never moved. Every rule below binds transitions **after** this instant. Pieces
already in review/merge/ci at cutover are not reverted silently; they are handled by the one-time
migration of §8 (S10). Reason: the 27 + 20 cards are mostly published work; reverting them would
destroy the evidence the owner is asking for.

### 2.2 The piece

A *piece* is what the Live draws: a subtask that is not a group member, or a task with no subtasks
(`boardReviewTargets`, `review-board.ts`). Group members inherit their group's rules (they carry no
session and no evidence of their own — same reason `done_needs_session` skips them). Every rule
addresses a piece by `<taskId>/<subtaskId>` or `<taskId>`.

A piece with no delivery record is adopted on first contact by any rule (`newDelivery` +
`adoptPhase`, unchanged): legacy pieces stop being a separate world.

### 2.3 Status events carry their authorization

Every allowed door that moves a piece into `in_review`, `pr_merge`, `ci` or `done` writes its
`TaskEvent` (`kind: 'status'`) with a new field `guard: { rule: 'a'|'b'|'c', ref: string }` — the
evidence id, release id or custody id that authorized it. The tick's reconciler (§3.6) treats a
status in those columns **without** a matching guarded event after `guaranteedSince` as an
unauthorized write and reverts it. This is what turns "every door checks" into "a door that forgot to
check is caught within a minute".

### 2.4 Where things live (all public repo, none frozen)

| Concern | Module (S/ = `packages/server/server/`) |
|---|---|
| Evidence model + validators (pure) | **new** `S/delivery/evidence.ts` |
| Evidence storage | **new** `evidence` array on `DeliveryRecord`; bytes stay in `task-files/` |
| In-review gate at the status doors | `S/sessions/task-web.ts` `markTask` / `patchSubtask`; `S/sessions/session-message.ts` `handbackSubtask` |
| Flow edge | `S/delivery/machine.ts` `EDGES['qa>revisao_lider']` + new gate `evidencia` in `GATES` |
| Release manifest + install ledger | **new** `S/delivery/releases.ts` (pure) + `S/delivery/release-store.ts` (IO, `<dataDir>/releases.json`, `<dataDir>/installs.jsonl`) |
| Post-release verifier | **new** `S/delivery/verify.ts` (pure plan) + `S/delivery/verify-host.ts` (in-process probes) |
| Orphan custody | **new** `S/delivery/custody.ts` (pure) + tick in `service.ts` |
| Forecast invariant | `S/sessions/task-live.ts` `resolvePieceForecast` / `estimateStages`; `packages/core/src/deliveryCalendar.ts` |
| Reconciler for unauthorized states | `service.ts` tick, new step `guardSweep` |

## 3. Rule (a) — a piece enters review only with evidence attached

### 3.1 What counts as evidence (deterministic)

An **evidence item** is attached to a piece and recorded on its delivery record:

```ts
interface EvidenceItem {
  id: string                    // ev-<12 hex>
  kind: 'screenshot' | 'api-capture' | 'test-log' | 'report' | 'probe'
  fileId?: string               // TaskFile id (screenshot, api-capture, test-log, report-as-file)
  repoRef?: { repo: string; sha: string; path: string }   // report committed to a repository
  sha256?: string               // of the bytes, computed by the server, never the caller
  revision: number              // delivery revision at attach time
  headSha?: string              // the piece's verified HEAD at attach time (record.headSha), if any
  width?: number                // screenshots: read from the image header by the server
  probe?: Probe                 // kind 'probe' only — see §4.4
  by: string                    // the verified session id (session-identity proof) or 'you'
  at: string
}
```

Each kind has a **validator over bytes**, run by the server at attach time (pure, `evidence.ts`):

| Kind | Valid when (all must hold) |
|---|---|
| `screenshot` | Magic bytes are PNG/JPEG/WebP; decoded header width × height ≥ 320 × 200; size ≥ 4 KB; width recorded. |
| `api-capture` | UTF-8 text ≤ 1 MB containing a request line (`GET|POST|… /path`), a status line or `"status": <int>`, and a non-empty body after it. The server-side helper `agentop evidence capture <url>` (run inside the worker's own `agentop run` throwaway) produces exactly this shape. |
| `test-log` | Text containing a test runner summary with **zero failures and at least one pass** — `bun test`'s `N pass` / `0 fail` lines, or the `agentop run` footer `exit 0`. A log with `fail` > 0 is refused, not attached. |
| `report` | Either a TaskFile of markdown ≥ 300 bytes containing a line matching `^(Verdict|Veredito|Result|Resultado)\s*:` — or a `repoRef` whose `sha:path` exists (`git cat-file -e` in a clone `release-repos.ts` knows) **and** whose `sha` is reachable from a remote branch (`git branch -r --contains`), so an unpushed local file is not evidence. |
| `probe` | A well-formed `Probe` (§4.4). Not proof by itself; required for rule (b). |

Three binding rules make evidence non-reusable and current:

- **Fresh**: `item.at` is after the piece's last entry into `executando` or `ajuste` (from
  `record.history`). Evidence from before an adjustment does not prove the adjusted work.
- **Bound**: when the record has a `headSha` (the `salvo` gate ran), the item's `headSha` must equal
  it at the moment of the move. A new push after the evidence makes it stale (`evidence_stale`).
- **Unique**: the same `sha256` may back evidence on at most one piece. Re-attaching one screenshot to
  three pieces is refused (`evidence_reused`, naming the other piece).

### 3.2 Which evidence a piece needs — by what it changed, not by what it says

`requiredEvidence(piece)` (pure) reads the **diff of the piece's verified HEAD against its merge-base
with the release line** (`git diff --name-only`), computed once by the `salvo` gate and stored as
`record.touched: { web: boolean; server: boolean; docsOnly: boolean; none: boolean }`:

| What the diff touches | Required at the move into review |
|---|---|
| `packages/web/**` or `packages/vscode/**` or `packages/tui/**` (a screen) | ≥ 1 `screenshot` with width ≥ 1000 **and** ≥ 1 with width ≤ 500 (the repo's mobile rule, CLAUDE.md "every screen delivers its mobile version"), + ≥ 1 `probe` |
| Server/CLI/MCP code, no screen | ≥ 1 `api-capture` **or** `test-log`, + ≥ 1 `probe` |
| Only `docs/**`, `*.md`, specs | ≥ 1 `report` |
| No commit at all (research, measurement, decision) | ≥ 1 `report` |

A piece may not *declare* its category; it is derived. A piece with no `salvo` run and no commit is
`none` (report). A piece whose author claims "docs only" while the diff touches code gets the code
requirement — that is the point.

### 3.3 The doors and their refusals

All of these call one function, `checkReviewEntry(record, book, nowMs)` → `{ ok: true, evidenceIds }
| { ok: false, code, missing[] }`:

| Door | Today | After |
|---|---|---|
| `markTask(ref, 'in_review')` (REST `POST /api/tasks/<ref>`, MCP `agentistics_task_status`, CLI `agentop task mark`, web drag) | Only `open_subtasks` | + `checkReviewEntry` for a task-level piece |
| `patchSubtask(id, { status: 'in_review' })` (REST, MCP `agentistics_task_subtask`, web) | Nothing | + `checkReviewEntry` |
| Handback auto-move (`handbackSubtask`) | Always moves | Moves only when `checkReviewEntry` passes. Otherwise the subtask stays `in_progress`, the handback comment is still recorded, and the **reply to the worker** carries the refusal sentence so it attaches evidence and re-sends. |
| Flow `qa → revisao_lider` (`agentop flow phase`, `agentistics_task_phase`) | `qa-modelo` gate + findings text | + gate `evidencia` (host-checked, same function) |
| Also gated, same function: `→ pr_merge`, `→ ci`, `→ done` from any door | — | A piece cannot skip review by jumping to a later column. |

Refusal (HTTP 422, code `evidence_required`), the sentence names exactly what is missing:

> EN: "This piece cannot move to review yet: it changed a screen, so it needs a desktop screenshot (≥ 1000 px wide), a mobile screenshot (≤ 500 px wide) and one post-release probe. Attached and current: none. Attach with `agentistics_task_evidence` or `agentop task evidence add`."
> PT: "Esta peça ainda não pode ir para revisão: ela mudou uma tela, então precisa de um print desktop (≥ 1000 px), um print mobile (≤ 500 px) e uma sonda pós-release. Anexadas e atuais: nenhuma. Anexe com `agentistics_task_evidence` ou `agentop task evidence add`."

Other codes: `evidence_stale` (HEAD moved after the evidence — names both shas), `evidence_reused`,
`evidence_invalid` (validator failed — names the rule, e.g. "test log reports 2 failures"),
`evidence_in_use` (deleting a TaskFile that backs evidence of an open piece: 409).

### 3.4 Surfaces

- **MCP** **new** `agentistics_task_evidence` `{ ref, action: 'add'|'list'|'remove', kind, fileId? | filePath? | repoRef? | probe? }`. `filePath` uploads from the worker's worktree (same size cap as task files, 8 MB). Description says what each piece type needs.
- **CLI** **new** `agentop task evidence add <ref> --kind screenshot --file shot.png`, `ls`, `rm`; **new** `agentop evidence capture <url> [--out f]` (writes the `api-capture` shape).
- **REST** `POST/GET/DELETE /api/tasks/<ref>/evidence` — rides the existing `/api/tasks` capability entry (`localShell`); matched before the generic `<ref>` route like `next`/`activity`.
- **UI** Live card and subtask row: an evidence chip (`📎 3 · desktop · mobile · probe`) and, on a piece in `in_progress` whose handback was held, "handback held: missing <x>" in the card's own words. Desktop and 390 px in the same slice.
- **Briefing**: the worker brief (`agentistics-context.ts`) gains one line: "Before your handback, attach evidence with agentistics_task_evidence; the server refuses review without it."

### 3.5 Anti-bypass test (rule a)

`delivery/evidence-guard.bypass.test.ts` (unit, pure) + `sessions/evidence-doors.e2e.test.ts` (real
store in a temp data dir, real routes through `handleRequest`). For a piece that changed a screen and
has no evidence, **every one of these must leave it out of review**:

1. MCP `agentistics_task_status {ref: taskPiece, status: 'in_review'}` → 422 `evidence_required`.
2. MCP `agentistics_task_subtask` edit `{status: 'in_review'}` → 422.
3. REST `POST /api/tasks/<ref>` with `status: in_review`, and the web drag payload → 422.
4. CLI `agentop task mark <ref> in_review` → exit 2 with the sentence.
5. Worker `agentistics_session_message kind=handback` → comment recorded, subtask still `in_progress`, reply names what is missing.
6. `agentop flow phase qa→revisao_lider` with verdict APROVADO → refused `portao` (`evidencia`).
7. Jump doors: `status: pr_merge`, `ci`, `done` directly → 422 (cannot skip review).
8. Forged evidence: a 1×1 PNG; a `.png` that is a renamed text file; a test log with `3 fail`; a report with no verdict line; a `repoRef` to an unpushed sha → each `evidence_invalid`.
9. Stale: attach valid evidence, push a new commit (`salvo` again) → move refused `evidence_stale`.
10. Reuse: attach the same screenshot bytes to a second piece → `evidence_reused`.
11. Delete the backing TaskFile while the piece is open → 409 `evidence_in_use`.
12. Category lie: a piece whose diff touches `packages/web` but attaches only a `report` → refused.
13. Only a desktop screenshot → refused naming the mobile one.
14. **Forged state**: write `status: 'in_review'` straight into `tasks.json` (no guarded event) → after one `tick()`, status is back to its previous value, comment `guard: unauthorized move into review reverted (no evidence)`, history entry, bell (informative).
15. Positive control: same piece with valid desktop + mobile screenshots + probe → every door above succeeds and writes `guard.rule = 'a'`.

### 3.6 The reconciler (`guardSweep`, shared by a/b/c)

Each tick, for pieces whose status changed after `guaranteedSince`: a piece in `in_review` / `pr_merge`
/ `ci` / `done` whose latest status event lacks `guard` (or names an evidence/release id that does not
exist on the record) is moved back to the status before that event, with a comment and a history
entry. Bounded: at most 20 reverts per tick; a piece reverted twice in 24 h is moved to `blocked`
(`externo: an unknown writer keeps moving this piece`) instead of looping. `done` set by the **owner**
from the browser (`actor === 'you'`, no session identity) is never reverted — the owner validating is
the one move that needs no evidence object.

## 4. Rule (b) — a release closes the cycle, verified on the installed binary

### 4.1 Outcome

When a version ships, **every piece in it** reaches `publicado` in one pass, and each is then
**verified against the binary actually installed on this machine**. A failed check reopens the piece.
This works with squash merges, and without GitHub, CI or tags.

### 4.2 Two facts the product does not record today

1. **Build identity.** `/api/version` returns `current` only. Add `build: { sha: string | null,
   builtAt: string }` written by `build:assets` into the generated slot (`git rev-parse HEAD` of the
   tree being built; `null` when built outside a checkout). Additive field.
2. **Install ledger.** `<dataDir>/installs.jsonl`: on every server boot, if the running
   `{version, build.sha}` differs from the ledger's last line, append `{version, buildSha, firstSeenAt,
   previousVersion}`. Append-only, 0600, capped at 500 lines. This is "what was really running here,
   and since when" — the one witness that exists without GitHub.

### 4.3 The release manifest

`<dataDir>/releases.json` (store-locked like `deliveries.json`), one entry per version:

```ts
interface ReleaseEntry {
  version: string                 // '2.211.0' or any label in local mode ('2026-11-13-a')
  mode: 'github' | 'local'
  pieces: string[]                // piece keys
  linkedBy: Record<string, 'declared' | 'target' | 'ancestry' | 'patch-id' | 'tag'>  // how each piece got in
  mergeSha?: string               // github mode, or the local main sha the build came from
  buildSha?: string               // from the install ledger once seen
  publishedAt?: string            // github: release run completion; local: install firstSeenAt
  verification?: { at: string; buildSha: string | null; results: ProbeResult[] }
}
```

**Which pieces belong to a version** — `linkPieces(version, candidates)`, pure, first match wins:

1. `declared` — named by `agentop flow release --version X --subtask …` (exists today, gains `--local`, which makes `--merge-sha` optional).
2. `target` — `record.versionTarget === X` and the piece is in `pr_merge`/`ci`.
3. `ancestry` — the piece's `mergeSha` (or `headSha`) is an ancestor of the version's `buildSha` / tag (`git merge-base --is-ancestor`).
4. `patch-id` — the piece's change is in the version's range by `squashPublishedIn` (`release-squash.ts`, unchanged) — this is what makes squash merges work.
5. `tag` — `firstTagContaining` from the sibling branch `fix/calendario-registro-real` (reused, not duplicated; S5 depends on it landing).

A piece in review/merge/ci that is linked to a published version and was not moved is exactly the
2.210.x bug; with this list it cannot stay behind.

**When a version counts as published** — `releasePublished(entry, ledger, gh)`:

- `github` mode: the existing `release` gate (tag exists AND its `release.yml` run is green).
- `local` mode, or `github` mode with gh unavailable: **the install ledger shows that version running
  on this machine**. The observed install *is* the publication, because that is the binary the person
  uses. `publishedAt` = `firstSeenAt`.

Either way, publication moves every linked piece `ci → publicado` (pieces still in review/merge are
first walked through `ci` with `linkedBy` as the detail — the same adoption `flow release` already
does), writes `guard.rule = 'b'` with the release version as `ref`, and stamps `publishedAt`.

### 4.4 Probes — how a piece says how to check it on the installed binary

A `probe` evidence item (required by rule a for any piece that changed code) is one of three closed,
**read-only** shapes:

```ts
type Probe =
  | { kind: 'http'; path: string /* must start /api/ */; expect: { status: number; pointer?: string /* JSON pointer */; equals?: unknown; matches?: string /* regex */ ; exists?: boolean } }
  | { kind: 'bundle'; literal: string /* ≥ 12 chars, must appear in the embedded web assets */ }
  | { kind: 'cli'; argv: string[] /* agentop verb from READONLY_CLI_VERBS */; expect: { exit: number; stdoutMatches?: string } }
```

- `http` is GET only, dispatched **in-process** through the server's own `handleRequest` with an
  internal identity (never a network socket — so it never binds or touches a port, and it works on the
  installed server without any worker reaching 47291).
- `bundle` reads `embeddedDist` — proves the shipped UI code contains the change (the screen itself
  cannot be screenshotted by the server; the bundle can be read).
- `cli` runs the **installed** `agentop` binary (`process.execPath` of the server) with an allowlisted
  read-only verb (`--version`, `flow status`, `session ls --json`, `task ls --json`, `hooks status`).
- Validation at attach time: the shape, the allowlist, `path` under `/api/`, regex compiles, literal
  length. A probe that *passes against the currently installed (old) binary* at attach time is refused
  as `probe_not_discriminating` — it would pass whether or not the change ships. (Run in-process
  against the running server at attach time; cheap.)

### 4.5 The post-release check

`verify-host.ts`, run by the **installed server itself**:

- **When**: on the first boot whose ledger line is new (a new version or build is running), 60 s after
  boot (let the first build settle); and on demand by `agentop flow verify [--version X]`.
- **Which pieces**: every piece in every release entry with `version` > previous ledger version and
  ≤ current (`compareVersions`); a skipped intermediate version (2.210.0 → 2.212.0) verifies 2.211.x's
  pieces too. In local mode, every entry whose `buildSha` is an ancestor of the running build.
- **Checks, per piece**, all must pass:
  1. `/api/version` (in-process) `current` equals or exceeds the piece's version, and `build.sha` (when
     known on both sides) contains the piece's merge (`ancestry`) — the binary is the one we think it is;
  2. each `probe` of the piece passes (timeout 5 s each, 3 attempts 10 s apart for `http`).
- **Pass** → record `verification: { verdict: 'pass', … }`; the Live card reads **Publicado ·
  verificado em vX**. The board subtask stays `in_review`/`done`-eligible for the owner's validation
  (owner validation is unchanged and never automated).
- **Fail** → **reopen**: new edge `publicado > ajuste` in `EDGES` (actor `flow:verificacao`, needs a
  failing `ProbeResult`), revision + 1, `versionTarget = 'next'`, board status `ajuste`, a comment with
  the probe, expected vs got, the installed version and build sha, and a wake to the custodian leader
  (rule c). No owner ping in autonomous mode.
- **Loop guard**: a piece reopened by verification twice for the same probe goes to `bloqueado`
  (`externo`) rather than a third round.
- **Legacy pieces** (published before cutover, no probe): checked by step 1 only and labelled
  "verificado: versão" — weaker, and said so on the card.

### 4.6 Surfaces

- CLI: `agentop flow release --version X [--local] [--merge-sha S] --subtask …` (extended),
  **new** `agentop flow verify [--version X] [--json]`, **new** `agentop flow installs` (prints the ledger).
- MCP: `agentistics_task_phase` gains action `release` (exists per calendario report) with `local: true`;
  **new** read field `verification` on `agentistics_delivery_calendar` / `agentistics_live_delivery` pieces.
- UI: version strip on the Calendar shows `publicada · instalada aqui em <time> · N/M verificadas`;
  Live card chips `verificado` / `verificação falhou → reaberta`.
- REST: `GET /api/deliveries/releases`, `POST /api/deliveries/verify` (localShell).

### 4.7 Anti-bypass test (rule b)

`delivery/release-cycle.bypass.test.ts` (pure, fixture git repos built at test time with
`gitTestEnv()`) + `delivery/verify-host.e2e.test.ts` (in-process server in a temp data dir):

1. **Squash**: worker commit A on a branch; main gets squash commit S (different sha, same diff); tag
   `v9.9.9` on S → the piece is linked by `patch-id` and published; `git tag --contains A` is empty and
   must not matter.
2. **No GitHub, no tags, no CI**: plain repo, no remote; `flow release --local --version L --subtask P`;
   simulate boot with ledger line `{version: L}` → P published, `publishedAt == firstSeenAt`.
3. **Forgotten piece**: P1 declared, P2 in `ci` with `versionTarget = X` not declared → both published.
4. **Skipped version**: ledger 2.210.0 → 2.212.0; pieces of 2.211.0 are verified on that boot.
5. **Failing probe**: probe `http /api/x pointer /feature equals true`, installed server answers
   `false` → piece back in `ajuste`, board `ajuste`, comment with expected/got, `versionTarget: next`.
6. **Non-discriminating probe**: a probe that already passes on the old binary → refused at attach.
7. **Write probe**: `http` with a non-`/api/` path, or a `cli` verb outside the allowlist (`session kill`) → refused at attach.
8. **Cheat publish**: `agentistics_task_status {status: done}` / `patchSubtask {status: 'done'}` by a
   session on a piece with no release entry → refused (`release_required`, gated like §3.3 row 5);
   forged `done` in `tasks.json` by a session actor → `guardSweep` reverts.
9. **Cheat verification**: a caller POSTs a `verification: pass` field → ignored (read-only, like the
   `mergeSha` the machine already ignores); only `verify-host` writes it.
10. **Loop guard**: same probe fails on two consecutive builds → `bloqueado/externo`, not a third reopen.
11. **Build mismatch**: ledger says 2.211.0 but `build.sha` does not contain the piece's merge → fail
    with "installed build does not contain this change".

## 5. Rule (c) — an orphan piece returns to the project leader's queue

### 5.1 Definitions

- **Live leader of a task**: a fleet row with stored role `leader`, filed on the task (or holding its
  custody, below), alive (`isLiveState`), **and active**: its conversation wrote something, or it made
  a board action (an event whose actor is its session id), within `N` hours. Alive-but-silent for 3
  days is not a leader for this rule — that is the stuck card the owner saw.
- **Orphan**: a piece in `leader` / `merge` / `ci` stage, or in `running`/`qa` with no live session at
  all, whose task has had no live leader for more than `N` hours. `N` defaults to **4 h**
  (`preferences.delivery.orphanAfterHours`, machine preference, 1–48). The "since" is the newest of:
  the leader rows' `lastSeenMs` (the 60 s heartbeat already written to the registry) and their last
  board action. No new presence store.
- **Project** of a piece: `normalizeGitRemote` of `Task.repo`, else of the git remote of the piece's
  sessions (`repo-facts.ts`), else the task's sidebar folder. **Project leader**: the live leader
  (definition above, any task) whose cwd's repository is that project; ties → most recent activity,
  then smaller id.

### 5.2 What happens (`custody.ts`, pure plan; tick performs)

1. At `N` h the piece gets `record.custody = { sessionId, since, via: 'project-leader', project }`.
   **Custody is not filing**: a conversation belongs to exactly one task (`conversationOwners`), and
   filing the project leader on the orphan's task would *move* the leader away from its own task. The
   Live's `leaderForTask` and the tick's `liveLeader` accept a live custodian as the task's leader.
2. The custodian gets one message (the existing `tellLeader` path, kind `question`-shaped, from
   `flow custody`): piece, stage, how long, the last handback, the evidence present, and the three
   moves available (review it, send to ajuste, defer). Reminders follow `ciclo.ts`'s nudge cadence.
3. **No live leader in the project**: the piece enters the project's **leader queue**
   (`record.custody = { sessionId: null, since, via: 'queue', project }`). The next leader that becomes
   live in that project receives the whole queue in its SessionStart context and in
   `agentistics_checkin_report`, and custody is assigned to it on that tick. The Live shows **"Na fila
   do líder de <project> · há 6 h"**, never "Sem líder" past `N`.
4. A custodian that itself goes inactive past `N` loses custody; the piece goes to the next project
   leader or back to the queue. Custody ends when a leader filed on the task is live again (it wins
   back, recorded) or the piece reaches `publicado`.
5. Everything is recorded: history entry, comment on the piece, `guard.rule = 'c'` on any status move
   the custodian makes.

`displayStage: 'no-leader'` remains valid only for `0 < age ≤ N` — it is a short warning, not a column
that grows.

### 5.3 Surfaces

- Live: the "Sem líder" column becomes "Sem líder (< N h)"; a new band "Fila do líder do projeto"
  grouped by project with ages. Desktop + 390 px.
- MCP: **new** `custody` field on Live/calendar pieces; `agentistics_checkin_report` lists custody and
  queue items for the calling leader; **new** action `agentistics_task_phase { action: 'custody', take | release }` so a leader can take a queued piece explicitly.
- CLI: `agentop flow custody [--project P] [--json]`.

### 5.4 Anti-bypass test (rule c)

`delivery/custody.bypass.test.ts` (pure, clock injected) + `delivery/custody-tick.e2e.test.ts`:

1. Leader dies; at `N − 1 min` the piece is "Sem líder"; at `N + 1 min` it has custody of the live
   project leader, a message was sent, Live shows the custodian. Never "Sem líder" after `N`.
2. **Zombie leader**: row alive (`waiting`) but no transcript write and no board action for `N + 1 min`
   → counts as absent; custody assigned.
3. **Keep-alive cheat**: a leader posts an empty/no-op comment every hour to look active → only events
   *on that task* count, and a comment counts only if it is a board action on the piece (status, phase,
   evidence, review); a bare comment on an unrelated task does not refresh. (Assert the 1-hour pinger on
   another task does not keep the orphan's task "led".)
4. **Filing invariant**: after custody, `conversationOwners` still maps the custodian's conversation to
   its own task (no move).
5. **No leader in project** → queue; spawn a leader in that repo → on the next tick custody assigned and
   its SessionStart context lists the piece.
6. **Custodian dies** → re-assigned / back to queue; never stuck on a dead custodian.
7. **Original leader returns** → custody released to it, recorded.
8. **Cross-project**: a live leader in another repository never receives custody.
9. **Fleet unreadable** (`fleetRead: 'unknown'`) → no custody change at all (a failed read must not
   orphan everything — the existing `unknown ≠ absent` rule).

## 6. Rule (d) — every active piece has a forecast from measured history

### 6.1 What already exists and what is still wrong

`docs/superpowers/specs/2026-11-09-deterministic-registration.md` Rule 5 already designed the method
(cohort median → general mean → versioned bootstrap; p25/p75 ranges; confidence from n and spread;
overrun anchored hourly), and `estimateEta` implements most of it. The 157/191 gap is in the
**composition**, not the estimator:

- `resolvePieceForecast` returns `publishEta: none / beyond-range` whenever
  `stageOverdueSinceMs(...) !== null` — for queued pieces *and* for started ones — discarding the
  revised-overrun estimate `estimateEta` already computed (`total`).
- `estimateStages` returns `stageEta: none` for `no-history` / `beyond-range` / `not-started`, and the
  web renders that as "sem estimativa" (`liveCardModel.ts`, `liveDeliveryModel.ts`).
- Pieces the Live hides (record-only, idle, old reviews) reach the calendar with `none`.

### 6.2 The rule

**Invariant F**: for every piece that is not terminal (`published`, `completed`, `abandoned`), the
server projection carries `publishEta.kind === 'estimate'` **or** a typed `dueDate` on the piece itself.
`kind: 'none'` with reason `no-history | not-started | beyond-range` is **not representable** for an
active piece: the type narrows to `{ kind: 'none'; reason: 'final' }`.

- **Method** (unchanged from Rule 5, restated so it is testable): cohort = same task type + harness +
  model, then type + harness, then harness, each needing ≥ 3 samples of the *publication* endpoint;
  center = median, range = p25..p75 widened to ≥ 25 % of the median and ≥ 15 min half-width.
  Confidence: **high** n ≥ 8 and IQR/median < 0.6; **medium** n ≥ 4 and < 1.2; else **low**. Fallback:
  general mean (low), then bootstrap 4 h (1–12 h, n = 0, labelled). Samples: newest 500 valid terminal
  pieces in 90 days.
- **Overdue**: an overdue piece shows the `revised-overrun` estimate (`source: 'revised-overrun'`,
  `overrun: true`, low confidence), anchored hourly — never `none`. The card says "atrasada · nova
  previsão ~<date>".
- **Stage ETA** may still be absent for a stage with no history; the card then shows only the
  publication forecast, never the words "sem estimativa".
- **Typed due date wins**: the piece's own `dueDate` is the primary date shown and placed; the computed
  range stays visible as secondary ("prazo 14/11 · previsão ~16/11, atrasaria"). The parent task's
  `dueDate` is a mark, not the piece's date (aligned with `fix/calendario-registro-real` item 5).
- **Versions**: a planned version's date is the latest piece estimate (or due date) — with Invariant F,
  never `partial`/`none` while it has active pieces.
- **Read-only**: a forecast is never writable (`forecast_read_only`, 422, from Rule 5).

### 6.3 Where it is enforced

- `task-live.ts`: `resolvePieceForecast` returns `totalOnly(total)` (with `overrun`) instead of
  `none/beyond-range`; the queue branch uses `if-started-now` instead of `not-started`.
- `buildLive` / `buildCalendar`: after projection, `assertForecast(pieces)` (pure) collects violations
  into `diagnostics.forecastViolations` and the health check reports them as **WARN**
  (`delivery-forecast-missing`, naming keys) — a regression is visible on day one, not after the owner
  counts cards.
- Web: delete the "sem estimativa" branches for active pieces in `liveCardModel.ts`,
  `liveDeliveryModel.ts`, `ScheduleView.tsx`; a lint test greps for the literal outside `final`.

### 6.4 Anti-bypass test (rule d)

`sessions/forecast-invariant.bypass.test.ts` (pure) + an MCP/HTTP parity test:

1. Every stage × {no history, 1–2 samples, ≥ 3, ≥ 8} × {started, unstarted, blocked, overdue by 10×
   the median} → `publishEta.kind === 'estimate'` for all non-terminal stages.
2. A piece overdue in `leader` for 9 days (today's typical card) → estimate with `source:
   'revised-overrun'`; two calls an hour apart inside the same bucket → identical `atMs`.
3. Record-only, idle, old-review, group-member, no-model, no-session, no-harness pieces → estimate.
4. Typed `dueDate` on the piece → primary date = due date, computed range present, calendar places it
   on the BRT day; parent's due date alone does not override.
5. Write attempts: `PATCH` with `publishEta`/`eta`/`confidence` fields via REST, MCP, CLI → 422
   `forecast_read_only`.
6. Same piece through `/api/tasks/live`, `agentistics_live_delivery`, `agentistics_delivery_calendar`
   and `agentop flow calendario --json` → same `atMs`/range/source.
7. Lint: `"sem estimativa"`/`"no estimate"` appear in web only under a `final`/terminal branch.
8. Health: inject a piece whose projection returns `none` (test seam) → health WARN names it.

## 7. Rule (e) — one anti-bypass suite per rule

Already specified per rule (§3.5, §4.7, §5.4, §6.4). Common requirements:

- Each suite is named `*.bypass.test.ts` and is **not** in `scripts/slow-tests.txt`, so the pre-commit
  hook runs it whenever a guarded module changes (`affected-tests.ts` maps `delivery/**` and
  `sessions/task-web.ts` to these files).
- **Door inventory test** (`delivery/doors.lint.test.ts`): greps the server for every writer of a task
  or subtask `status` (`patchTask(`, `upsertSubtask(` with a `status`, `markTask(`, `patchSubtask(`)
  and fails unless the call site is in an allowlist that is known to go through `checkReviewEntry` /
  `releaseGuard` — so a **new door added next month** fails the build until it is guarded. Same shape
  as `tokens.lint.test.ts`.
- **Forged-state tests** for each rule (write the impossible state to disk, run one tick, assert the
  revert) — the guarantee does not depend on every door being right.
- Each slice's evidence step (§8) must attach its own evidence under rule (a) — the spec eats its own
  cooking from slice S2 onwards.

## 8. Implementation plan — slices a Sonnet can build

Order matters: S0–S2 stop the bleeding (review without evidence), S4–S6 close the cycle, S7 ends
"Sem líder", S8 ends "sem estimativa". Each slice is one PR to `dev`, one worktree, tests via
`agentop run --rm -- bun test <files>`, typecheck under the heavy lock. AI-hours = focused
implementation + tests + evidence for a Sonnet-class worker at high effort.

| # | Slice | Builds | Tests | Evidence step | AI-h |
|---|---|---|---|---|---|
| S0 | Cutover + shared types | `guaranteedSince` in `deliveries.json` (written once, under lock); `EvidenceItem`, `Probe`, `guard` on `TaskEvent`; `validRecord` keeps unknown fields verbatim (downgrade-safe) | store round-trip, older-build preserve, write-once | `store.test.ts` output attached as `test-log` | 2 |
| S1 | Evidence model + attach door | `delivery/evidence.ts` validators (image header reader, test-log parser, report rule, repoRef check), `requiredEvidence`, freshness/binding/uniqueness; `POST/GET/DELETE /api/tasks/<ref>/evidence`; MCP `agentistics_task_evidence`; CLI `agentop task evidence`, `agentop evidence capture`; `touched` computed by `salvo` | validator table (every row of §3.1 positive + negative), §3.5 cases 8–13 | API capture of attach + list; CLI transcript | 7 |
| S2 | Enforcement at every door + reconciler | `checkReviewEntry` in `markTask`, `patchSubtask`, `handbackSubtask` (held handback reply), gate `evidencia` on `qa>revisao_lider`, jump-door checks; `guard` stamped by allowed doors; `guardSweep` in the tick; `doors.lint.test.ts` | §3.5 cases 1–7, 14, 15; door lint | e2e log; a held handback reply captured | 6 |
| S3 | UI for evidence | Live card / subtask row evidence chip, "handback held" line, upload from the task view; worker brief line | component tests; 390 px overflow check | screenshots 1280 + 390 (rule a applies) | 4 |
| S4 | Build identity + install ledger | `build: { sha, builtAt }` in the engine-slot generator and `/api/version`; `installs.jsonl` append on boot; `agentop flow installs` | ledger append/idempotence/cap; version payload additive | `/api/version` capture from a throwaway build | 3 |
| S5 | Release manifest + linking | `releases.ts`/`release-store.ts`; `linkPieces` (declared/target/ancestry/patch-id/tag, reusing `release-squash.ts` and the sibling's `firstTagContaining`); local mode in `flow release --local`; publication by ledger; bulk `ci → publicado` with `guard.rule = 'b'` | §4.7 cases 1–4, 8 | `flow release --local` + `flow installs` transcript in a throwaway | 6 |
| S6 | Probes + post-release verifier + reopen | `Probe` validation incl. `probe_not_discriminating`; `verify-host.ts` (in-process GET, bundle read, allowlisted CLI); boot trigger + `agentop flow verify`; edge `publicado > ajuste`; loop guard; Live/Calendar chips | §4.7 cases 5–7, 9–11 | throwaway: install build N, then N+1 with one failing probe → piece reopened; screenshots of the chips | 7 |
| S7 | Orphan custody | `custody.ts` (leader activity, orphan clock, project resolution, queue); tick step; `leaderForTask` accepts custodian; check-in + SessionStart context; MCP/CLI custody verbs; Live band | §5.4 all | throwaway with a killed leader: before/after Live captures 1280 + 390 | 6 |
| S8 | Forecast invariant | `resolvePieceForecast`/`estimateStages` changes, narrowed type, `assertForecast` + health WARN, web branches removed + lint | §6.4 all | MCP + HTTP parity capture on a throwaway copy of a real store (delete its `structured/` first): count of active pieces with `none` = 0 | 4 |
| S9 | Cross-door e2e in a throwaway | One script per rule driving the real binary of the branch via `agentop run --rm --serve -- <branch server command>`: MCP + CLI + REST attempts, forged-state + tick | the four suites green on the compiled binary | the run logs + screenshots | 4 |
| S10 | Migration of today's board | One-time `agentop flow guarantee-migrate [--apply]` (dry-run default): pieces in review/merge/ci at cutover → linked & published by S5's linker where provable; otherwise listed as "needs evidence" with the triage verdict (`leader/qa/triagem-sem-lider.md`) as a comment; no silent revert | dry-run on a throwaway copy reproduces the 27/20 classification | migration report attached as `report` | 3 |

Total ≈ **52 AI-hours**. Parallelism: S1 → S2 → S3 is one chain; S4 → S5 → S6 another (S5 waits for
`fix/calendario-registro-real` to land); S7 and S8 are independent and can start with S0. Critical path
≈ S0 + S4 + S5 + S6 + S9 ≈ 22 h wall-clock with three workers.

Every slice: whatsNew pt+en entry only for user-visible slices (S3, S6, S7, S8), mobile branch in the
same change for S3/S6/S7, Darwin-safe IO (no `/proc` in new paths — leader activity uses the registry
heartbeat and transcript `stat`, which exist on both).

## 9. Risks and stated limits

1. **Evidence proves shape, not truth.** A model can attach a real screenshot of the wrong screen.
   Mitigations: freshness + HEAD binding + uniqueness + category by diff; truth stays with the
   cross-model QA gate (`qa-modelo`) and the owner. The spec does not claim more.
2. **False refusals stall honest workers.** A research piece misclassified as code, or a server change
   with no meaningful probe. Mitigation: category from the diff is conservative (docs-only is easy to
   satisfy), the refusal names the exact missing item and the tool to fix it, and a held handback still
   records the comment so no work is lost. Measure: count of `evidence_required` per day in the health
   panel during the first week.
3. **Probes can be weak.** `exists: true` on a field that existed before passes trivially — hence
   `probe_not_discriminating` at attach time. A probe cannot see a visual regression; screenshots
   cover that at review time, not post-release.
4. **Verification depends on the machine being upgraded.** Until the owner installs version X, its
   pieces are `publicado` (github mode) but `verification: pending`. The card says "aguardando
   instalação para verificar"; nothing reopens on pending. Pending > 7 days is a WARN, never a reopen.
5. **The installed server checks itself.** A broken build that cannot boot cannot verify — but then the
   ledger never records it and the previous version keeps running; the release stays unverified and
   visible. Upgrades from binaries older than S4 have no ledger history: the first S4 boot verifies only
   its own version's pieces.
6. **Reverting unauthorized moves can fight a legitimate writer we forgot** (an engine flow, an older
   binary on another machine sharing the store). Bounded by 20 reverts/tick and the twice-in-24h →
   `blocked/externo` rule; the door lint is the real fix.
7. **Custody needs a leader to exist.** On a machine with no leader at all the queue grows and is
   visible, but nobody acts — by design in autonomous mode nothing pings the owner. The band shows the
   age so the owner sees it on return.
8. **Forecast honesty.** Removing "sem estimativa" means low-confidence numbers are shown everywhere;
   the basis (`n`, scope, `revised-overrun`) must stay on the card or the number reads as a promise.
9. **Sibling work.** S5 reuses `firstTagContaining` from `fix/calendario-registro-real` (not yet
   pushed when this was written) and S8 overlaps its forecast changes (item 3) — rebase on it, never
   reimplement. `ce6f2622` (evidencia-entregas) produced the evidence vocabulary this spec formalises.
10. **Owner decisions this spec assumes** (recorded on the subtask, within the leader's authority):
    N = 4 h; local-mode publication = observed install; owner `done` from the browser needs no evidence
    object; legacy pieces are migrated, not reverted.
