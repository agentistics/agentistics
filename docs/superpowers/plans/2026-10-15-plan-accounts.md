# PLAN.ACCOUNTS — implementation plan

Spec: `docs/superpowers/specs/2026-10-15-plan-accounts.md` (read §1–§10 before any slice; section
numbers below refer to it). Task `t-084a489bf7`. Implementer: Codex `gpt-6.1-sol`, one slice per
session, one worktree per slice based on `origin/dev`, commit locally, no push. QA by a different
model; the leader runs the suites.

Every slice:
- reads CLAUDE.md "Concurrent work", "plan limits" (docs/plan-limits.md) and the spec sections named;
- keeps the slice-1 boundary: probes return whitelisted strings only, nothing logged;
- treats ALL harnesses through tables keyed by `HarnessId` (`Record<HarnessId, …>`), never an
  `if (harness === 'claude')` chain outside a table, never a hardcoded harness array
  (`harnessRegistry.lint.test.ts`);
- adds tests beside the changed module; `bun test <files>` + `bunx tsc --noEmit -p .` green;
- writes the "done" line into the slice's own commit message body.

## Dependency graph

```
A0 (D6 renewal)   A1 (D7 idle live)   B2 (registry v2)   B3 (billing core)
      │                  │                 │   │   │            │
      ▼                  │                 │   │   └──► D2 (multi-root readers)
B1 (core per-account) ───┼─────────────────┤   │
      │                  ▼                 │   └──────► D1 (account roots + login)  [flag]
      └────────────► C1 (attribution + switch) ◄──┘                 │
                         │                                          │
                         ▼                                          │
                    C2 (payload/MCP per account) ──► C3 (Billing UI)│
                         │                                          │
                         └──────────────► D3 (spawn by account) ◄───┘   [flag]
                                                 │
                                                 ▼
                                          D4 (web add-account + picker)  [flag]
                                                 │
                                                 ▼
                                          E1 (visibility test + e2e QA)
```

**Parallel wave 1** (no shared files): A0, A1, B2, B3.
**Wave 2**: B1 (after A0), D2 (after B2), D1 (after B2).
**Wave 3**: C1 (after A1, B1, B2). **Wave 4**: C2. **Wave 5**: C3 ∥ D3. **Wave 6**: D4. **Wave 7**: E1.
A slice touching `core/planLimits.ts` (A0, B1) or `server/plan-limits.ts` (A1, C1, C2) never runs
alongside another slice on the same file.

---

## A0 — renewed windows project their next period (bug D6) · parallel

Files: `packages/core/src/planLimits.ts`, `packages/core/src/planLimits.test.ts`,
`packages/web/src/components/PlanLimitMeter.tsx` (show "estimated reset" when `projected`).

1. Add `PlanLimitWindow.projected?: true` and pure `effectiveWindow(w, nowMs): PlanLimitWindow`
   (spec §8): renewed → `usedPct 0`, `resetsAt += k·PLAN_WINDOW_MS[kind]` (smallest k with
   `resetsAt > nowMs`), `projected: true`; otherwise `w` unchanged.
2. `planBudget`, `planPace`, `forecastWindow`, `bindingPct` read windows through it.
3. `planPace`: drop history readings whose `updatedAt` is before the latest renewal of the week
   window (`effectiveWindow(...).resetsAt - length`).
4. Budget row gains `weekResetProjected?: true`.

Tests: stale record, `resetsAt` 1 day past → `daysToWeekReset` in (5.9, 6.1),
`sustainablePctPerHour` ≈ 100/144, `dailyBudgetPct` < 20, status `ok`; 15 days past → k = 3;
not renewed → identical output to today (snapshot of an existing fixture); burn across a renewal
uses only post-renewal readings.
Done: no row can report `sustainablePctPerHour > 100/0.5·0.99` from a renewed window; existing
tests unchanged.

## A1 — only working sessions burn (bug D7) · parallel

Files: `packages/server/server/plan-limits.ts` (`sampleLivePlanSessions`),
`packages/server/server/index.ts` (`/api/plan-limits` handler), `packages/server/server/plan-limits.test.ts`.

1. `sampleLivePlanSessions(sessions, liveIds, nowMs, burnByHarness, working?: ReadonlySet<string>)`:
   a session is kept only if `working.has(id)` or its token total grew since a previous sample
   taken ≤ 10 min ago. Kept sessions share burn by token delta; a kept session with zero delta
   (working, nothing billed yet) gets 0. Never `burn / group.length`.
2. Handler: build `working` from the session hub snapshot (`processSessionHub()` peek in
   `sessions/session-hub.ts`; rows with `state === 'working'`, mapped to conversation/session ids
   the same way `liveSessionIds` are) — a peek, never `read()`.
3. `planSlots`: sessions with `burnPctPerHour === 0` do not enter the per-session average.

Tests: 3 idle sessions + burn 2 %/h → `[]`; 1 working + 2 idle → one session with the whole burn;
two working with deltas 3:1 → 75/25 split; a session first seen this sample → excluded until a
second sample.
Done: `GET /api/plan-limits` on a machine whose fleet is all `waiting` reports `liveSessions: []`.

## B2 — account registry v2 · parallel

Files: `packages/server/server/harness-accounts.ts`, `harness-accounts.test.ts`,
`packages/server/server/accounts-web.ts` (unchanged routes, new fields in the body).

1. Types per spec §3 (`HarnessAccount` with `id`, `nickname?`, `root`, `retired?`;
   `AccountsFile` v2 with `bindings`, `segments`).
2. `readAccounts()` migrates v1 arrays (id minted `acc_` + 12 hex from `crypto.randomBytes`;
   newest confirmed per harness → `bindings['<harness>:']`). Idempotent: reading v2 twice is equal.
3. Writes wrap the existing `serial` in `withFileLock(file)` (`sessions/file-lock.ts`).
4. `IDENTITY_PROBES: Record<HarnessId, ((root: string | null) => Promise<AccountIdentity>) | null>`
   replacing the `if` chain + `hasIdentityProbe`; claude key `orgId:email` (spec Q1); claude probe
   gets `CLAUDE_CONFIG_DIR` in `env` when `root` is set; codex/copilot read `<root>/…`.
   gemini/kimi/antigravity: `null` → key `root:<sha256(realpath(root ?? defaultRoot))[0,12]>`.
   `ISOLATION_ENV: Record<HarnessId, string | null>` (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
   `COPILOT_HOME`, `GEMINI_CLI_HOME`, `KIMI_CODE_HOME`, antigravity `null`) exported for D1/D3.
5. API: `current(harness, root?)`, `byId(id)`, `bind(root, identity)` (adopt by `(harness,key)`,
   returns `{account, previous?}` when the binding changed), `setNickname`, `startSegment(id, ms)`,
   `forceProbe(harness, root)`. `PATCH /api/accounts/:harness/:key` keeps working; add
   `PATCH /api/accounts/:id` `{available?, nickname?}`.
6. `label`/email never in `console.*`; grep test over the module source.

Tests: v1→v2 migration fixture; two roots same harness → two accounts; same key in a second root
adopts the id and keeps `available:false`; failed probe keeps binding (slice-1 behaviour); two
concurrent `current()` from two store instances on one file → no lost account (lock).
Done: existing slice-1 tests pass unchanged; registry holds N accounts per harness.

## B3 — billing per account (core only) · parallel

Files: `packages/core/src/billing.ts`, `packages/core/src/billing.test.ts`.

1. `BillingSettings.accountProfiles?: Record<string, BillingTimeline>`; parse/validate it in the
   existing `parseBillingSettings` path (same period rules; overlap refused within one timeline).
2. `computePlanCost` / `monthlyCommitment` take an optional `accounts: {id, harness}[]`; per harness
   C = Σ accounts' own timelines + the harness default timeline ONCE if any account (or none) lacks
   its own. `coveredDayKeys` = union. Without `accounts`, output is byte-identical to today.
3. `registeredPlanLabel(billing, harness, now, accountId?)` (prefers the account timeline).

Tests: two accounts with overlapping subscriptions → C is the sum; one with own timeline + one
inheriting → default counted once; no `accounts` arg → every existing test unchanged; overlap
inside one account timeline still refused.
Done: plan arithmetic for N accounts lives only in `billing.ts`.

## B1 — core per-account primitives · after A0

Files: `packages/core/src/planLimits.ts`, `planLimits.test.ts`, `packages/core/src/index.ts` (exports).

1. `PlanLimits.account` doc: the account id (`acc_…`), `'default'` only as legacy.
2. Replace `agentVisiblePlans(plans, currentAccounts)` with
   `agentVisible<T extends {harness; account}>(rows, accounts: {id; available; retired?}[])` —
   filters by ACCOUNT id; a row whose account is unknown to the registry is kept only if its account
   is `'default'` and the harness has no hidden current account (legacy path).
3. `planPace(l, now, history, live, segmentStart?)`: readings before `segmentStart` ignored.
4. `harnessAggregate(rows)`: per harness, visible non-held accounts → `{freeSlots: Σ, status:
   'hold' iff every account hold, best paceStatus}`.
5. `routeRecommendation` works on aggregates and returns `account` (most room: lowest
   `max(fiveHourPct, weekPct)`, ties → newest) and per-account `alternatives` entries
   `{harness, account}` (keep `alternatives: HarnessId[]` for compatibility, add
   `accountAlternatives`).
6. `planThresholdNotices`: key `${harness}:${account}:${kind}` (already), plus
   `resetNoticesFor(state, harness, account)`.
7. Pure `meterDiscontinuity(prev, next): boolean` per spec §5 (resetsAt Δ > 1 h, old not renewed,
   usedPct drop ≥ 15).

Tests: hidden account of a harness with two accounts → other account still routed; both hidden →
harness absent; aggregate sums slots; route picks account with most room; discontinuity truth
table (each of the three conditions false alone → false).
Done: no core function decides visibility by harness.

## D2 — read every root · after B2 (parallel with D1, C1)

Files: `packages/server/server/config.ts` (`harnessRoots`), `adapters/{claude,codex,gemini,copilot,kimi}.ts`
(directory constants → per-root lists), `packages/core/src/types.ts` (`SessionMeta.account?`),
adapter tests with a two-root fixture.

1. `harnessRoots(harness)`: default root + non-retired registry roots, memo 5 s, read via
   `harness-accounts` `readAccounts` (no probe).
2. Each adapter walks every root and stamps `account` with the root's binding (absent for the
   default root without binding). Claude `stats-cache.json`: default root only (spec §4 D8).
3. Antigravity: unchanged (single root).

Tests: per adapter, a second root's session appears with `account`; default-root sessions keep
their ids; claude stats-cache total unchanged by a second root.
Done: a session run with `CLAUDE_CONFIG_DIR=<root>` appears in `/api/data`.

## D1 — account roots + login flow (server) · after B2 · flag `multi-account`

Files: `packages/core/src/experimental.ts` (row `multi-account`, env `AGENTISTICS_MULTI_ACCOUNT`,
absent = off), new `packages/server/server/account-roots.ts` (+ test),
`accounts-web.ts` (`POST /api/accounts/roots {harness}`, `DELETE /api/accounts/roots/:id`),
`mcp-launch.ts` (register per root), `backup/backup-plan.ts` (rows for `accounts/`), `audit.ts` events.

1. `ROOT_SHARED: Record<HarnessId, string[] | null>` per spec §4 (antigravity `null`).
   `createRoot(harness)`: 0700 dir, symlinks from the default root for listed names that exist,
   returns `{pendingId, root, env}`. Refuses when `ISOLATION_ENV[h]` is null or flag off.
2. `LOGIN_START: Record<HarnessId, {argv: string[]} | null>` read from each CLI's `--help`
   (claude bare + `/login` typed; `codex login`; `copilot login`; `gemini`; `kimi login`).
   Route spawns a managed session with the root env (existing `spawnManaged`) and returns its id.
3. Poller: while a pending root exists, `forceProbe` every 60 s; a confirmed identity → `bind`.
4. Delete: refused (409 `root_in_use`) while a managed session with that `accountId` runs;
   marks `retired`; removes the dir only with `{confirm: <root path>}` in the body.
5. Test greps `ROOT_SHARED` against `HARNESS_SECRETS` credential names → none linked.

Tests: create root links only allowlisted files; a credential-looking file in the default root is
never linked; agy refused in words; delete refused with a live session; flag off → 404.
Done: with the flag on, a root can be created, logged into via a session, and becomes an account.

## C1 — meter attribution + switch detection · after A1, B1, B2

Files: `packages/server/server/plan-limits.ts`, `plan-limits.test.ts`,
`sessions/structured-durable.ts` (pass the session's `accountId` to `noteStructuredLine`),
`sse.ts` (codex tap passes the root), `sessions/types.ts` (`ManagedSession.accountId?`, read only here).

1. `noteStructuredLine(line, atMs, accountId?)`, `noteCodexRollout(path)` resolves the root from the
   path prefix and the binding (or the linked managed session's `accountId`). Undeterminable →
   drop (spec §5). Parsers still emit `'default'`; the tap rewrites `account` before ingest.
2. `ingestPlanLimits`: if `meterDiscontinuity(held, l)` → `forceProbe`; different key → re-bind,
   store under the new account; same/unknown → `startSegment(account, l.updatedAt)`,
   `resetNoticesFor`, emit sink notification `plan.segment` (add code + pt/en text in
   `web/src/lib/notifications.ts`).
3. History map and notice state keyed by account id; `planPace` receives `segments[account]`.
4. Migration on load: `<h>:default` records re-keyed to the default root binding when confirmed.

Tests: switch via identity (two keys, one root) → two records, old untouched, notices independent;
discontinuity without probe → segment, burn restarts, no `under` dip, hold not released by a
foreign reading; an earlier `resetsAt` on a new account still notifies (D3); unattributable codex
rollout → dropped; migration of a `claude:default` file.
Done: D1–D3 of spec §1 each have a failing-before/passing-after test.

## C2 — plan_limits rows per account + MCP + check-in · after C1

Files: `plan-limits.ts` (`planLimitsPayload`), `index.ts` handler, `packages/mcp/plan-limits-tool.ts`
(+ test), `packages/server/server/checkin.ts` (+ test), `packages/web/src/lib/planLimits.ts`
(types), `docs/plan-limits.md`.

1. Payload per spec §6: `budgets[].account/accountLabel` (nickname or `"<Label> #n"`, never email),
   `limits[].account/label` (owner), `registered[]` per account, `freeSlotsByHarness` = Σ,
   `freeSlotsByAccount`, `hiddenFromAgents` per account, `recommendation` via B1 aggregate.
2. MCP: forwards `account`/`accountLabel`, `freeSlotsByAccount`, recommendation `account`; still
   never `hiddenFromAgents`, `limits`, or any `label`.
3. Check-in report: per-account lines, hidden accounts omitted.
4. Web store types updated; surfaces keep rendering (one row per account, labels via
   `HARNESS_LABELS` + `accountLabel`).

Tests: payload fixture (claude 2 accounts, codex 2 accounts, one off each) → off ones only in
`hiddenFromAgents`; MCP output contains no `@`; slots summed.
Done: `agentistics_plan_limits` returns one row per visible account.

## C3 — Billing UI per account + first-detection notice · after B3, C2 (parallel with D3)

Files: `packages/web/src/pages/settings/BillingSettings.tsx`, a new
`packages/web/src/pages/settings/AccountRow.tsx`, `server/preferences.ts` passthrough of
`accountProfiles`, i18n strings in the file's existing pt/en pattern.

1. One row per account (spec §6) using ONLY: `RowSwitch`, `Drawer`, `Select`, `RecordCard`,
   `ConfirmModal` (all `pages/settings/primitives.tsx`), `PlanLimitMeter`, the existing period
   editor for the account's timeline, a nickname text field (≥ 16px on mobile).
2. First-detection notice: account with no plan and no own timeline → banner in Billing with the
   catalog picker prefilled from `account.plan`; answering writes `accountProfiles[id]`.
3. Sentences per harness from a table: no meter ("this harness does not report its limits"), no
   identity ("does not report which account is logged in; use one folder per account"), agy single.
4. Mobile at 390px: rows as `RecordCard`, no horizontal scroll.

Tests: component test with 2 accounts/harness; switch PATCHes by id; notice disappears after a
pick; no email rendered where `nickname` exists only in agent-facing previews (none here — owner).
Done: two Claude accounts can each hold their own plan; cost-basis C reflects both.

## D3 — spawn by account · after C2, D1 · flag `multi-account`

Files: `sessions/spawn-spec.ts` (`planSpawn` env), `sessions/fleet-spawn.ts` (`FleetSpawnBody.account`),
`sessions/types.ts` + `registry.ts` (`ManagedSession.accountId`, immutable), reopen path
`sessions/reopen-target.ts`, `sessions/cli-session.ts` (`--account`), `session batch` auto-pick,
`sessions/session-identity.ts` caller check, tests beside each.

1. `planSpawn(req.account?: {harness, root})` → `env[ISOLATION_ENV[h]] = root`; default root adds
   nothing (byte-identical argv/env test).
2. `planFleetSpawn`: `account` id → registry lookup; refused `account_unavailable` (403) when the
   account is off/retired AND the request carries a verified session identity; refused
   `unknown_account` (422); absent → router `account` for that harness (C2) or default.
3. `ManagedSession.accountId` written at spawn; reopen/attach/restart spawn in the record's root;
   retired → refused in words.
4. `session batch`: each item without `account` takes the router's pick; never a hidden account.

Tests: env per harness; agent-identity spawn on a hidden account → 403; owner spawn → allowed;
reopen keeps the account; batch with one hidden account never picks it.
Done: two claude sessions run at once on two accounts; each stays on its account across reopen.

## D4 — web: add account + account picker · after D3 · flag `multi-account`

Files: `BillingSettings.tsx` / `AccountRow.tsx` ("Add account" per harness, opens the login session
in the Sessions workspace via the existing route), the new-session wizard
(`packages/web/src/components/sessions/` — reuse its existing `Select`), cockpit wizard
(`packages/tui/src/control/tabs/SessionWizard*`) account field.

1. "Add account" → `POST /api/accounts/roots` → navigate to the returned session; pending row shows
   "waiting for the login to finish".
2. Wizard: account `Select` only when the chosen harness has ≥ 2 visible accounts; default = router
   pick, labelled "(recommended)". Hidden accounts listed for the owner, marked "off for agents".
3. "Remove" (non-default root) → `ConfirmModal` naming the folder.

Tests: wizard hides the field with one account; picker sends `account`; remove refused with live
session shows the server sentence.
Done: the owner adds a second Claude account and starts a session on it without typing a command.

## E1 — visibility test + e2e QA · last

Files: new `packages/server/server/account-visibility.test.ts`, QA script under the leader's QA dir.

1. The hard-rule test (spec §7): fixture with two accounts of every metered harness and one of
   every other harness, one off per harness; asserts absence from `/api/plan-limits` agent fields,
   MCP tool, check-in, router, `session batch` pick, agent spawn (403). It enumerates consumers by
   grepping for `planLimitsPayload(` and `/api/plan-limits` and fails on an unlisted file.
2. E2E (throwaway `agentop run --rm`, isolated HOME and data dir, fake harness homes): flag OFF →
   single-account behaviour identical to v2.135.0 (snapshot of `/api/plan-limits` shape modulo the
   added fields); flag ON → add root, fake login identity, two parallel sessions, switch detection,
   hidden account invisible. QA run by a model other than the implementer; never against the owner's
   real `~/.claude`.
Done: QA report PASS; leader integrates.

---

## Estimates (AI hours, Codex sol)

A0 1 · A1 1.5 · B2 2 · B3 2 · B1 2 · D2 3 · D1 3 · C1 3 · C2 2 · C3 3 · D3 3 · D4 2.5 · E1 2.
Critical path A0→B1→C1→C2→D3→D4→E1 ≈ 15.5 h; with wave-1/2 parallelism the whole plan fits in
about two days of worker time, gated by QA and the release window.
