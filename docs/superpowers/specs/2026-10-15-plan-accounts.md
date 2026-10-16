# PLAN.ACCOUNTS — several accounts per harness in the plan limits

Status: design, 2026-10-15. Task `t-084a489bf7` (Agentask, urgent, core). Implementation plan:
`docs/superpowers/plans/2026-10-15-plan-accounts.md`.

Owner requirements this answers (task comments `c-6e1d7d53f2`, `c-3ec7dcf61c`, approval
`c-41b3edced7`, priority `c-94cc3d52e4`):

1. A new login is **registered automatically** by the account's own id. The plan comes from the
   harness when it reports one; otherwise the owner picks it **once**, from a notice in Billing.
2. A known account **resumes** its plan, its usage history, its limits and its pauses.
3. **Several accounts logged in at the same time**, one config directory per account. The account
   is chosen per session (by the owner, or by the router); two sessions may run in parallel on
   different accounts; **a live session stays on its account**.
4. **Hard rule**: registered ≠ authorised. Every account has an "available to agents" switch.
   Switched off, it stays logged in and visible to the owner, and is **invisible** to the LLMs,
   the router, `plan_limits`, recommendations and every automatic spawn. Tested on every surface.
5. **All harnesses equal.** No harness is "first"; where a harness cannot do something, the
   product says so in a sentence, per harness, from a table.

Slice 1 (v2.135.0, `harness-accounts.ts`, `accounts-web.ts`, the Billing switch) already detects
the CURRENT login of claude/codex/copilot and stores availability in `accounts.json`. This design
builds on it; nothing there is redone.

---

## 1. What is wrong today (measured in the code, origin/main d1317152)

| # | Defect | Where |
|---|---|---|
| D1 | Every meter is stored under `account: 'default'`; a login change overwrites the previous account's numbers (the new one arrives at 0 %, the hold lifts). | `core/planLimits.ts` `parseClaudeRateLimitEvent`, `parseCodexRateLimits` |
| D2 | Burn mixes the two accounts for ~6 h: the negative delta is clamped to 0 and the pace falls to `under`, so the router dispatches MORE work right after a switch. | `planPace` (`readings` filter by `harness:account`, both `default`) |
| D3 | Threshold notices go mute when the new account's `resetsAt` is earlier than the old one ("an older record: ignore"). | `planThresholdNotices` |
| D4 | Availability is applied PER HARNESS through the current login (`agentVisiblePlans` hides a whole harness), so with two accounts the switch cannot hide one and keep the other. | `core/planLimits.ts` `agentVisiblePlans` |
| D5 | Billing has one timeline per harness; two subscriptions paid at once cannot be expressed (overlap is refused). | `core/billing.ts` `BillingProfiles` |
| D6 | **weekResetsAt stuck on a past reset**: once `now ≥ resetsAt`, `currentUsedPct` is 0, `daysToWeekReset` is clamped to 0, `hoursToReset` to 0.5, so `sustainablePctPerHour = 100/0.5 = 200 %/h`, `dailyBudgetPct` = 200 and the pace/slots computed from it are nonsense until a new record arrives — which for an idle harness may be days. | `planBudget`, `planPace` |
| D7 | **Idle sessions counted as live**: `liveSessionIds` is every assistant process `/proc` sees (a session sitting at its prompt included), and `sampleLivePlanSessions` divides the harness burn EQUALLY among them when no token moved (`burn / group.length`). Idle sessions then consume slots and `freeSlots` reads 0 on a quiet machine. | `server/plan-limits.ts` `sampleLivePlanSessions`, `index.ts` `/api/plan-limits` |
| D8 | Only the default config home of each harness is read: a session run with `CLAUDE_CONFIG_DIR=/x` writes its transcript under `/x/projects`, which no adapter reads — the second account's work would be missing from every metric. | `server/config.ts` roots, every adapter |

---

## 2. Concepts and vocabulary

- **Account** — one login of one harness. Identified by `(harness, key)`; carries a stable
  agentistics id `acc_<12 hex>` used everywhere else (sessions, billing, meters, URLs). The id
  never changes even if the label, plan or root changes.
- **Account key** (`key`) — the provider's own non-secret identity, per harness (§3). It is the
  thing that decides "is this the same account".
- **Config root** (`root`) — the directory the harness keeps its login and state in. The
  **default root** is the harness's normal home (`~/.claude`, `~/.codex`, …). An **account root**
  is a directory agentistics created for an additional account:
  `~/.agentistics/accounts/<harness>/<accountId>/` (0700). One root holds exactly one login at a
  time; a root's account can change only by a login inside it (§5).
- **Binding** — `root → accountId`, the account currently logged in a root, as last confirmed by
  a probe. Stored in the registry.
- **Segment** — an uninterrupted run of meter readings of one account. A suspected switch that
  cannot be confirmed starts a new segment: burn and notices never span two segments.

Rule: **storage is `harness:accountId`** for meters, history, notice state and billing. The
legacy literal `default` survives only as the migration source (§9).

---

## 3. ACCT.ID — the key, per harness

Every probe follows the slice-1 boundary: the document is parsed in-process, ONE whitelist of
fields leaves it, nothing is logged, and a test exercises the real read path.

| Harness | Isolation variable (native) | Key | Label (owner only) | Plan from the harness | Meter |
|---|---|---|---|---|---|
| claude | `CLAUDE_CONFIG_DIR` | `orgId + ':' + email` (fallback `email`, then `orgId`) | email | `subscriptionType` | `rate_limit_event` (stream) |
| codex | `CODEX_HOME` | `account_id`; API-key mode → `apikey` | `account_id` | `plan_type` (rollout) | rollout `rate_limits` |
| copilot | `COPILOT_HOME` | `host + ':' + login` | login | — | none |
| gemini | `GEMINI_CLI_HOME` | `root:<sha256(realpath(root))[0..12]>` | owner nickname | — | none |
| kimi | `KIMI_CODE_HOME` | `root:<hash>` | owner nickname | — | none |
| antigravity | **none** | `root:<hash>` of the default root only | owner nickname | — | none |

Decisions:

- **Claude key includes the email.** `orgId` alone (the map's recommendation) collapses two seats
  of one Team/Enterprise org into one account, while their limits are per seat. `orgId:email` is
  unique per seat and still stable across subscription changes. Recorded as open question Q1.
- **A harness with no identity field is keyed by its ROOT**, never by `active`, project, model or
  any credential. Consequence, stated in the UI: for gemini/kimi/agy, logging another account
  into the SAME root is not detectable by key — §5's discontinuity rule is the only signal, and
  those harnesses have no meter, so a re-login there is invisible. The UI says: "this harness does
  not report which account is logged in; use one folder per account".
- **Antigravity is single-account in this design.** It has no native home variable; overriding
  `HOME` would also move git, ssh and every other tool's config for that process — refused. agy
  keeps one account (its default root) with the availability switch; the "Add account" action is
  absent for it with the sentence "Antigravity has no way to keep a second login apart yet." This
  is a finding, not a ranking: it is the same table every harness goes through.
- **Gemini and agy share `~/.gemini`.** `GEMINI_CLI_HOME` moves only the Gemini CLI; agy keeps
  reading `~/.gemini/antigravity-cli`. An account root for gemini is therefore safe for agy. A
  test pins that creating a gemini root never touches `~/.gemini/antigravity-cli`.
- **Probes run per root**: claude `claude auth status --json` with `CLAUDE_CONFIG_DIR=<root>`
  (2 s, SIGKILL, 64 KB, existing code); codex `<root>/auth.json`; copilot `<root>/config.json`.
  Cache 60 s per `(harness, root)`; a forced re-probe bypasses it (§5).

### Registry v2 (`~/.agentistics/accounts.json`, 0600)

```ts
interface HarnessAccount {           // server/harness-accounts.ts
  id: string                         // 'acc_' + 12 hex, minted once
  harness: HarnessId
  key: string                        // §3 table
  label: string                      // provider label (email/login/account_id) — owner surfaces only
  nickname?: string                  // owner-chosen, the ONLY text agents ever see besides `id`
  plan?: string                      // plan the harness reported
  available: boolean                 // slice 1
  root: string | null                // null = default root
  firstSeen: number
  lastSeen: number                   // advances only on a CONFIRMED probe
  retired?: boolean                  // root removed by the owner; history kept
}
interface AccountsFile { version: 2; accounts: HarnessAccount[]; bindings: Record<string /*root|''*/, string /*accountId*/> ; segments: Record<string /*accountId*/, number /*segment start ms*/> }
```

- v1 (a bare array) migrates on read: each entry gets an `id`, `root: null`; the newest
  confirmed entry per harness becomes the default root's binding. Idempotent.
- Writes go through `withFileLock` (`sessions/file-lock.ts`) — several agentop processes write
  this file (server, watcher, CLI). The in-process `serial` queue stays as the first layer.

---

## 4. Config roots — two accounts at the same time

**Creating an account root** (`POST /api/accounts/roots {harness}`, owner only, refused on a
harness whose isolation variable is `null`):

1. `mkdir -p ~/.agentistics/accounts/<harness>/<pendingId>` mode 0700.
2. **Share the non-credential configuration** with the default root by symlink, from a per-harness
   allowlist (`ROOT_SHARED`), so skills, settings, MCP and hooks behave the same in every account:
   claude `settings.json`, `skills/`, `agents/`, `commands/`, `CLAUDE.md`, `plugins/`;
   codex `config.toml`, `AGENTS.md`, `prompts/`; copilot `config` is NOT shared (it holds
   `loggedInUsers`), only `agents/`; gemini `settings.json`, `GEMINI.md`; kimi `config.toml` is
   NOT shared (may hold `api_key`), only `mcp.json`. **A file that can hold a credential is never
   linked or copied** — the allowlist is the table, and `account-roots.test.ts` greps the table for
   the credential file names of `backup-plan.ts`'s `HARNESS_SECRETS` and fails if one appears.
3. Register the agentistics MCP in the new root (the boot re-registration in `mcp-launch.ts`
   iterates every root).
4. Start a **login session** in the new root: a managed session of the harness with the root's
   env, opened in the Sessions workspace terminal, whose first screen is the harness's own login
   (`claude` → `/login`; `codex login`; `copilot login`; `gemini` (first run asks); `kimi login`).
   The person signs in in the browser the harness opens. Users are not technical: the Billing
   panel's "Add account" button does all of this; no command is shown.
5. When the login session ends (or every 60 s while it runs), the root is probed; the first
   confirmed identity mints or **adopts** the account: if `(harness, key)` already exists (the
   same account logged in elsewhere before) its id, plan, history, availability and pauses are
   resumed (requirement 2) and its `root` is set to this one. Unconfirmed → the root stays
   `pending` and the panel says "waiting for the login to finish".

**Removing a root**: owner only; refused while a live session runs in it; the account becomes
`retired` (history and billing kept, invisible to agents, not deleted). The directory is deleted
only after a confirmation that names it.

**Running**: `planSpawn` gains `account?: {harness, root}` and adds the root's isolation variable
to `plan.env` (`{CLAUDE_CONFIG_DIR: root}` etc.); the default root adds nothing, so a single-account
machine spawns byte-for-byte as today. tmux receives the env through the existing env channel
(never on the command line visible in `ps`; the existing `-e` concern applies only to secrets and
a path is not one).

**A live session stays on its account**: `ManagedSession.accountId` is written at spawn and is
immutable. Reopen/attach/restart resolve the account from the record and spawn in THAT root —
which is also forced by the data: the conversation's transcript exists only in that root. A row
whose account was retired reopens refused in words ("this conversation belongs to an account that
was removed").

### D8 — the readers must read every root

`config.ts` gains `harnessRoots(harness): {root, accountId|null}[]` (default + registry roots,
read from `accounts.json` with a 5 s memo). Every adapter's directory constant becomes a list
walked per root; `SessionMeta.account?: string` is stamped with the root's account id (absent for
the default root before any binding exists). Claude's `stats-cache.json` stays **default-root
only** as the cache: a secondary root's Claude history reaches the dashboard through the
per-session path (the consolidate store keeps it past the 30-day cleanup), exactly like a
non-Claude harness. Stated in `docs/plan-limits.md`.

---

## 5. ACCT.SWITCH — a login change opens a new budget

Two signals, in this order:

1. **Identity change** (claude, codex, copilot): a confirmed probe of a root returns a key
   different from its binding → the root is re-bound to the (new or adopted) account. Nothing is
   overwritten: the old account keeps its meters and history under its own id and is now simply
   "not logged in anywhere" (`root: null` only if it was this root's account; listed as
   "signed out" until it appears again).
2. **Meter discontinuity** (claude, codex — the harnesses that have a meter): an incoming reading
   for account A is suspicious when, against A's last reading of the same window kind,
   `resetsAt` differs by more than 1 h **and** the old window has not renewed **and** `usedPct`
   dropped by ≥ 15 points. Then:
   - force a re-probe of the reading's root (bypassing the 60 s cache);
   - probe confirms a different key → signal 1;
   - probe confirms the same key, or the harness cannot probe → **new segment** for A
     (`segments[A] = reading.updatedAt`): burn history before it is ignored, the notice state for
     `harness:A:*` is reset, and an owner notification `plan.segment` says "Claude's usage dropped
     sharply — counting from zero for this account" (no alert mixing, no silent hold release).

**Attribution of a reading** (the part that makes signals honest):

- claude stream tap: the line comes from a structured session's relay → that session's
  `ManagedSession.accountId`. A session started before this feature (no `accountId`) → the default
  root's binding.
- codex rollout tap: the rollout path is under `<root>/sessions/` → that root's binding at the
  rollout's first line time; if a managed session links the conversation, its `accountId` wins.
- A reading whose account cannot be determined is **dropped**, never stored under a guess (a meter
  under the wrong account is worse than a missing one: it lifts a hold).

**Notices** (`planThresholdNotices`): key `harness:accountId:kind`. The "older record: ignore"
branch stays, but now only within one account and one segment, so D3 cannot recur.

---

## 6. ACCT.BILLING — N accounts per harness, a plan per account

`BillingSettings` gains:

```ts
accountProfiles?: Record<string /*accountId*/, BillingTimeline>
```

- **The harness timeline (`profiles[h]`) stays** and means "the default for accounts of `h` that
  have no timeline of their own". On migration it is attached to nothing; the first account of a
  harness inherits it implicitly. So a one-account machine's arithmetic is unchanged.
- **Overlap** is refused within ONE account's timeline (existing `validatePeriod`), and allowed
  across accounts (two subscriptions at once is the point).
- **C (coverage) per harness = Σ over that harness's accounts of each account's C**, each account
  resolved to its own timeline or, failing that, the harness default — the default counted ONCE
  however many accounts inherit it. `computePlanCost` and `monthlyCommitment` change in exactly
  that one place (`billing.ts` is the only place plan arithmetic lives). `A` stays per harness.
  `coveredDayKeys` is the union over accounts.
- **First-detection notice**: a newly minted account whose harness reported no plan raises a
  Billing notice "New Claude account detected (a…@…). Which plan is it?" with the catalog picker
  prefilled from `subscriptionType`/`plan_type` when present. Answered once; dismissible (the
  account then prices as `unknown` = N/A, never 0).
- **Billing UI**: the accounts block from slice 1 becomes one row per account (label, nickname,
  plan, 5h/week meters via `PlanLimitMeter`, availability `RowSwitch`, "Edit plan" opening the
  existing period `Drawer`, "Remove" for a non-default root). Reused components only:
  `RowSwitch`, `Drawer`, `Select`, `PlanLimitMeter`, `ConfirmModal`, the existing period editor.
  Mobile: the rows collapse into `RecordCard` like every settings list.

### `plan_limits` — one row per account

`GET /api/plan-limits` `budgets[]` rows gain `account` (the id) and `accountLabel` (nickname, or
`"<Harness> #<n>"` by firstSeen order — **never the email**: the MCP hands this row to LLMs, and an
email is not an id field an agent needs). `limits[]` (owner surfaces) carries `account` and the
owner-only `label`. `registered[]` becomes per account. `freeSlotsByHarness` is the **sum** over the
harness's visible accounts; a new `freeSlotsByAccount` carries the parts. `hiddenFromAgents` lists
hidden ACCOUNTS (owner API only; the MCP never forwards it — slice 1 rule kept).

---

## 7. ACCT.PLAN — pace, holds and routing per account

- **Pace and budget are computed per account** (`planBudget`/`planPace` already take one
  `PlanLimits`; they now receive the account's own history and segment start).
- **Holds are per account**: 85 % on the 5h window, 95 % on the week (constants unchanged). A
  harness is on hold only when **every visible account** is.
- **Capacity is summed**: the harness row the router compares is the aggregate of its visible,
  non-held accounts (free slots summed, best pace). `routeRecommendation` keeps its preference
  table and returns the chosen harness **and** `account` = the account of that harness with the
  most room (lowest binding %, ties → most recently seen), plus `alternatives` that may name other
  accounts of the same harness.
- **Live sessions per account**: `LivePlanSession.account?` (from `ManagedSession.accountId` or
  `SessionMeta.account`); burn is distributed among sessions of the same ACCOUNT, not harness.
- **Spawn picks the account**: `POST /api/fleet/new`, `agentop session` and `session batch` accept
  `account` (id). Absent → the router's choice for that harness (or the default root when the
  harness has one account). The cockpit/web wizard shows an account `Select` only when the harness
  has ≥ 2 accounts.

### The hard rule, enforced at the server

An account with `available: false` (or `retired`):

- is absent from `budgets`, `freeSlots*`, `liveSessions`, `registered`, `recommendation`
  (including `alternatives`), the check-in report, and the MCP tool output;
- is **refused** as the `account` of any spawn whose request carries a verified session identity
  (an agent asking) — 403 `account_unavailable`, the same shape as `session_fanout`; the owner's
  own browser/CLI may still use it by explicit choice;
- is never chosen by the router or by `session batch`'s automatic pick;
- keeps its live sessions running and visible to the owner; their burn is counted only in
  `hiddenFromAgents`.

`account-visibility.test.ts` is the single test of this rule and covers EVERY surface listed
above with a fixture of two accounts of each metered harness, one off. A new surface that reads
plan limits must be added to it (the test enumerates the consumers by grepping imports of
`planLimitsPayload` and `/api/plan-limits`, and fails on an unlisted one).

---

## 8. The two plan_limits bugs, folded in

**D6 — a renewed window projects its next period.** New pure `effectiveWindow(w, nowMs)`: when
`nowMs ≥ w.resetsAt`, return `{kind, usedPct: 0, resetsAt: w.resetsAt + k·length, projected: true}`
with the smallest `k` that puts `resetsAt` in the future. `planBudget`, `planPace` and
`forecastWindow` read windows only through it. Burn readings older than the renewal are discarded
(a renewal is a segment boundary for burn, not for notices — notices already reset on `resetsAt`).
The row carries `projected: true` so a surface can say "estimated reset" rather than present a
computed time as reported. Pinned: a record 3 days stale with `resetsAt` 1 day in the past yields
`daysToWeekReset ≈ 6`, `sustainablePctPerHour = 100 / 144`, never 200.

**D7 — only working sessions burn.** `sampleLivePlanSessions` counts a session as live for slots
only when it is `working` in the fleet hub snapshot (`processSessionHub()` peek, the same source
`/api/hardware-resources` uses) **or** its tokens grew since the previous sample within the last
10 min. A session with no token delta gets `burnPctPerHour = 0` and is excluded from
`planSlots`' per-session average (it no longer receives `burn / group.length`). An external
`/proc`-only process with no fleet row counts only by token delta. Pinned: three idle `waiting`
sessions + measured burn 2 %/h → `liveSessions = []`, `freeSlots` from the plan burn alone.

---

## 9. Migration and compatibility

- `plan-limits.json` records under `<harness>:default` are re-keyed on first load to the default
  root's binding when one is confirmed; until then they stay readable under `default` (shown as the
  harness's "current account"). Notice state likewise.
- `accounts.json` v1 → v2 as in §3.
- `Preferences.billing` unchanged on disk until the owner edits an account plan.
- A machine with one account per harness sees no UI change except the account row it already has.
- Experimental flag `multi-account` (`AGENTISTICS_MULTI_ACCOUNT`, one row in `experimental.ts`,
  absent = OFF) gates the parts that change what runs: "Add account", account roots, the spawn
  `account` field and the account picker. Per-account storage, switch detection, per-account
  rows and the two bug fixes are not gated (they are correctness and are invisible with one
  account). E2E runs with the flag on and off.

## 10. Security

- Only whitelisted identity strings leave a probe; the email is an owner-surface field
  (`/api/accounts`, `limits[].label`) and never reaches an agent (MCP rows carry `account` id +
  `accountLabel`). Logs name accounts by id.
- Account roots are 0700, created under the data dir, never under a repo; their credential files
  belong to the harness — agentistics never reads, copies, seals or backs them up. `backup-plan.ts`
  gets a `secret` row for `accounts/*/*/**` credential files and a `runtime` row for the rest
  (a restored root without its login is useless, and its login must be re-done there).
- New routes (`/api/accounts/roots*`) ride `/api/accounts`'s existing capability-guard entry and
  auth; root creation and removal are owner actions that write an audit event.

## 11. Open questions for the owner (decided provisionally; nothing blocks)

- **Q1** Claude key = `orgId:email` (per seat) instead of `orgId` alone. Provisional: yes.
- **Q2** Agents see `"Claude #2"` / the nickname, never the email. Provisional: yes.
- **Q3** Antigravity stays single-account until it ships a home variable (no `HOME` override).
  Provisional: yes.
- **Q4** Secondary Claude roots do not feed `stats-cache` aggregates (per-session sums instead).
  Provisional: yes; revisit if a rented account's history beyond 30 days matters.
- **Q5** Shared config by symlink (skills, settings, MCP the same in every account) vs. a clean
  root per account. Provisional: shared.
- **Q6** When two accounts of one harness have room, the router picks the one with the most room;
  alternative policy "drain the account whose week resets first" (use it before it is lost) was
  considered and is a one-function change. Provisional: most room; recommend revisiting after a
  week of data.
