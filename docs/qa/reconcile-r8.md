# CICLO.RECONCILE-2 r8 implementation evidence

Issue: https://github.com/agentistics/agentistics/issues/1364 (P1, In progress).
Baseline: `3d34ce735`, branch `fix/ciclo-reconcile-2`. Commit pending.

## Replay and its limits

Command (no port, no real-store apply):

```text
TMPDIR=/dev/shm/reconcile-2-r8 agentop heavy -- bun packages/server/scripts/reconcile-r8-evidence.ts /home/mithrandir/agentistics-workspace/leader/qa/evidence/qa-reconcile-2-r7
```

The script reads the named QA copies, mutates parsed objects only and never calls git, gh or a server.
The r7 rows below are captured HTTP payloads; r8 rows are an in-memory replay, not a new HTTP/browser measurement.
The clock is fixed at `2026-11-09T01:19:31.980Z`. Process liveness comes from the captured Live session ids;
registry rows are the copied fixture's rows. Empty PR lists reproduce the captured run's zero PR matches;
no tag proofs are supplied. Actual publication can therefore be higher when independent QA supplies real tag evidence.
Existing `done_needs_session` checks use the board's `subtaskHasSession` / `rowsOfTask` helpers.

| Input / action | Antiga | Dry Antiga | Queue | Running | Leader review | Completed without release proof | Published | All |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| r7 captured before | 171 | 149 | 10 | 1 | 240 | 0 | 11 | 262 |
| r7 captured after | 0 | — | 10 | 1 | 107 | 0 | 139 | 257 |
| r8 replay before | 189 | 189 | 2 | 0 | 253 | 495 | 8 | 758 |
| r8 after Complete | 33 | 33 | 2 | 0 | 97 | 651 | 8 | 758 |
| r8 after explicitly Archive remaining | 0 | 0 | 2 | 0 | 64 | 651 | 8 | 725 |

QA, Adjust, Merge and CI counts are zero in every row. The script checks equality of the actual screen,
dry-run and action id sets, not just their sizes. It checks a second dry run has no remaining old pieces.
All 189 completion attempts address exactly those ids: 156 complete; 33 correctly refuse completion because
no conversation is filed. Archive is an explicit, separate action for those 33, never an automatic fallback
in the product. They remain in the book as abandoned and intentionally leave the Live. No completed card
leaves All or appears queued. The higher r8 All count exposes historical completed work without inventing
release dates: `completed` has no publication time window; it is not counted in Published or Active.

The earlier exploratory replay treated `closeLegacy` as always succeeding (189 completed). That was an
assumption, not evidence of the session gate. The table above supersedes it and preserves that gate.

## Causes and changes

1. `delivery/antigas.ts:43` is the shared predicate used by Live (`sessions/task-live.ts:706`), reconcile
   (`delivery/service.ts:1448`) and the click (`delivery/service.ts:1613`). It includes effective review
   status, open children, records, live sessions, handback age and known proof. The old-review payload
   is no longer truncated before the dialog can act on it. A stored queue record still excludes a
   piece from the legacy predicate even when its stale phase is ignored for rendering.
2. `delivery/service.ts:1457` treats no repository as normal non-code work, before the GitHub-budget
   check. `delivery/antigas.ts:45` no longer lets a no-repos cache entry suppress the age rule.
   `sessions/task-web.ts:152` carries the reason of an incomplete lookup to the Live. No-repos cannot
   borrow a matching SHA from a different checkout to claim publication (`sessions/task-live.ts:689`,
   `sessions/task-live.ts:701`). GH failures and exhausted budgets remain unverified and are retried.
3. The host previously selected raw group statuses while `buildTaskDetail` recomputed them from
   members. `delivery/review-board.ts:6` now uses the same `effectiveSubtasks` function. That function
   previously converted an EMPTY group to todo; `sessions/task-report.ts:547` now retains its own
   stored status. `sessions/task-live.ts:685` gives board completion without release evidence its
   own `completed` stage, visible in All, with no queue position or publication claim.
   Separately, `sessions/task-web.ts:870` intentionally freezes an existing deliveredAt; the old view
   then used it at `sessions/task-live.ts:714` to age a newly closed piece out of Published. The fix
   preserves the timestamp and shows the piece as completed instead. No fabricated fresh release date.
4. `delivery/host.ts:178` now includes task-level candidates. `delivery/host.ts:237` rechecks children
   before writing; task ids go through markTask rather than patchSubtask. `sessions/task-live.ts:494`
   keeps an open task container out of Leader review. `LiveAntigas.tsx:89` uses `subtaskId ?? taskId`
   for the list, count, requests and outcomes. Task-level handbacks are no longer discarded by the
   Live source's comment index (`sessions/task-web.ts:114`).
5. The r6→r7 arithmetic is exactly **134 + 42 + 1 − 6 = 171**. The script asserts it against the
   saved id sets. The 42 gained subtask cards are no-repos pieces suppressed by r6's populated cache
   but shown before r7 populated its cache: the defect in item 2. One other subtask,
   `s-127e2fbd02`, has its latest handback at `2026-11-01T23:48:32.472Z`: it is within seven days at
   r6's `2026-11-08T23:24:27.258Z`, but outside at r7's `2026-11-09T01:19:31.980Z`. That is the intended
   `DELIVERY_WAITS_MS` rule (`delivery/antigas.ts:49`), not a defect. Six task cards were excluded by
   r7's explicit task-level unchecked condition (removed at `sessions/task-live.ts:706`).

## All 21 discrepant ids

| Cause / r8 treatment | Ids |
| --- | --- |
| Empty groups formerly queued; keep own status, then Complete | s-97ca9d04b5, s-99ba211c97, s-e1e1a57b66, s-199631367f, s-350814828d, s-c2821803d0, s-882376dc74 |
| Empty groups formerly absent because unstaged todo was hidden; keep own status, then Complete | s-7bf170e3f8, s-1a8367250e, s-ada47c02d7, s-5e19ee4e78 |
| Groups with members; effective status is not review, so cleanup must not close them | s-3739fea2b7, s-b10057b137, s-72a5c72086, s-be0d04bcfd, s-7618a0c247, s-b523372de1, s-c767414572, s-dfa513c0f1, s-081a453723 |
| Existing deliveredAt from 2026-10-16; Complete remains visible rather than aging out of Published | s-3c7e645a58 |

The nine member-derived groups stay under their existing queue/running visibility rules and retain
their open members; the script prints each id. Their raw in_review flags were not proof of review work.
The alleged 14-item payload cutoff was 13 groups plus one piece with an old, frozen delivery date;
it was not a per-payload count limit. The recent delivery timestamps of the 128 visible cards said
nothing about the date of that absent piece.

## The seven task-level cards

| Task | Id | r8 action / destination in the copied seed |
| --- | --- | --- |
| Engine | t-e1dea7cd6f | Open children: container; children stay as the cards. A live direct worker is running; a leader remains in the leaders band. Never closed by old-card cleanup. |
| Cold start | t-d9e9fff3f6 | Antiga. Complete refuses: no filed session. Archive works through the same dialog. |
| HOTFIX accounts | t-f5326ee899 | Antiga. Complete refuses: no filed session. Archive works through the same dialog. |
| BILLING.SIMPLE | t-17ae7e85b0 | Antiga → Completed without release proof. |
| General QA | t-c60abcbcc1 | Antiga → Completed without release proof. |
| Nay feasibility | t-7a034cb88e | Antiga. Complete refuses: no filed session. Archive works through the same dialog. |
| Duck image | t-cfa3624847 | Antiga → Completed without release proof. |

## Validation

Logic regressions were run red first: five initial Live cases failed, and the service's no-repository
case failed. A further no-repos / borrowed-SHA regression failed before its guard was added.
All commands used `TMPDIR=/dev/shm/reconcile-2-r8 agentop heavy --`, one test file at a time, without ports.

| Test file | Passed | Skipped |
| --- | ---: | ---: |
| packages/core/src/liveBoard.test.ts | 8 | 0 |
| packages/server/server/delivery/antigas.test.ts | 10 | 0 |
| packages/server/server/delivery/service.test.ts | 182 | 1 existing |
| packages/server/server/sessions/task-live-reconcile-r8.test.ts | 8 | 0 |
| packages/server/server/sessions/task-live-stages.test.ts | 46 | 1 existing |
| packages/server/server/sessions/task-live.test.ts | 15 | 0 |
| packages/server/server/sessions/task-live-view.test.ts | 11 | 0 |
| packages/server/server/sessions/task-report.test.ts | 46 | 0 |
| packages/server/server/sessions/task-live-view.web-parity.test.ts | 10 | 0 |
| packages/web/src/components/tasks/LiveAntigas.r8.dom.test.tsx | 1 | 0 |
| packages/web/src/components/tasks/LiveDelivery.dom.test.tsx | 25 | 0 |
| packages/web/src/components/tasks/liveDeliveryModel.test.ts | 15 | 0 |
| packages/web/src/components/tasks/liveCardModel.test.ts | 65 | 0 |
| Total | 442 | 2 existing |

The 390px DOM test checks task/subtask count parity, confirmation copy, exact request ids, and removal
of successful outcomes. It is not a browser layout or screenshot measurement.
Full repository typecheck: `bun --bun tsc --noEmit --incremental --tsBuildInfoFile /dev/shm/reconcile-2-r8/typecheck-bun.tsbuildinfo`.
The default Node-backed tsc exhausted its 2GB heap; the Bun-backed invocation succeeds under the same
heavy-job wrapper. `git diff --check` passes.

Not verified: HTTP end-to-end writes, real GitHub/tag lookup, browser layout at desktop or 390px,
screenshots, MCP transport, live multi-client 409/Stop/Cancel behavior, production migration, release.
No install, server, real-store apply, commit, push or PR was run. Independent QA remains with the leader.

## Commit pending

The hook is `.husky/pre-commit` → `scripts/precommit.ts:59` → shared-core selection in
`scripts/affected-tests.ts:29`, which runs the whole suite. That includes port-binding tests such as
`packages/mcp/delivery-tools.test.ts:54` and `packages/mcp/queue-tools.test.ts:38`.
The r8 brief forbids those servers and explicitly forbids hook bypass. The worktree therefore remains
uncommitted for an authorized session to commit with the normal hook. No hook was disabled.

Changed files:

- docs/delivery-flow.md
- docs/qa/reconcile-r8.md
- packages/core/src/liveBoard.ts
- packages/mcp/agentistics-mcp.ts
- packages/server/scripts/reconcile-r8-evidence.ts
- packages/server/server/delivery/antigas.ts
- packages/server/server/delivery/host.ts
- packages/server/server/delivery/review-board.ts
- packages/server/server/delivery/service.ts
- packages/server/server/delivery/service.test.ts
- packages/server/server/sessions/task-live.ts
- packages/server/server/sessions/task-live.test.ts
- packages/server/server/sessions/task-live-stages.test.ts
- packages/server/server/sessions/task-live-reconcile-r8.test.ts
- packages/server/server/sessions/task-live-view.ts
- packages/server/server/sessions/task-report.ts
- packages/server/server/sessions/task-web.ts
- packages/web/src/components/tasks/LiveAntigas.tsx
- packages/web/src/components/tasks/LiveAntigas.r8.dom.test.tsx
- packages/web/src/components/tasks/LiveDelivery.dom.test.tsx
- packages/web/src/components/tasks/liveCardModel.ts
- packages/web/src/components/tasks/liveDeliveryModel.ts
