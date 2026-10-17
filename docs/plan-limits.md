# Account availability and plan limits

Settings → Billing lists detected harness accounts and their availability to agents. Switching an
account off keeps its login and owner-visible meters intact. Agent budgets, free slot totals,
per-harness slots, live session summaries, and routing recommendations exclude that account while
it is unavailable; other available accounts of the same harness remain usable. The owner API includes the excluded budgets in
`hiddenFromAgents`; the MCP plan-limits tool does not expose that list.

`GET /api/accounts` discovers current accounts for enabled adapters and lists known accounts.
`PATCH /api/accounts/:harness/:key` accepts `{ "available": false }` (or `true`); keys must be URL
encoded. Both routes use the billing detection capability and auth gates and are unavailable on a
team central. The local data directory stores the non-secret registry in `accounts.json`.

Identity probes cache for 60 seconds and fall back to `default` after errors or a two-second timeout.
An unknown identity inherits the most recently confirmed account's availability, including after
restart. Failed probes do not replace that persisted identity; detecting it again preserves its
availability setting. Availability checks include live-session harnesses even when they have no meter.
Claude uses auth status (organization ID, otherwise email), Codex uses only `account_id` from its
native auth file, and Copilot uses host plus login. Other harnesses use the default account.
Copilot's config reader accepts full-line `//` comments without changing slashes inside JSON strings.
The local auth/config documents are parsed in-process and discarded at the reader boundary; only
whitelisted identity strings are returned or persisted, and the documents are never logged.
Availability persists for each detected identity.

## One row per account (C2)

Meters are keyed by account id (`acc_…`); a meter recorded before accounts existed is `default`
until the confirmed login of the default root migrates it (at load, and again when a binding is
confirmed later). `GET /api/plan-limits` answers:

- `budgets[]` — one row per agent-visible account, with `account` and `accountLabel` (the nickname,
  or `"<Harness> #n"` by first-seen order among visible, non-retired accounts; an address is never
  a label, so a nickname containing `@` falls back to the numbered form). Unmigrated `default`
  meters use the harness name without a number.
- `limits[]` — owner surfaces: every account, with the owner-only login `label`.
- `registered[]` — a Billing plan for an account that has reported no window yet, per account.
- `freeSlotsByHarness` — the sum over the harness's visible accounts that are not on hold;
  `freeSlotsByAccount` carries the parts.
- `hiddenFromAgents` — the rows of accounts switched off (owner API only).

The MCP tool forwards `budgets`, `freeSlotsByAccount` and the recommendation `account` /
`accountLabel`; never `limits`, owner labels or `hiddenFromAgents`. The check-in report has one
line per visible account.

When a harness has several accounts with room, the router takes the one whose week resets first
(its quota is lost soonest), then the one with the most room (`pickAccount`). An account without
a weekly window sorts after accounts with a reported weekly reset; ties still use room.

Live sessions use the managed session’s immutable account id, then the account bound to the
transcript's configuration root (the longest matching root wins). Without either, they use the
harness's bound default account or its only visible account. This applies to every harness and
keeps legacy and external sessions on a migrated single account's measured burn. The managed
registry is read once per sample. Burn is distributed by token deltas within `(harness, account)`
only, so percentages from separate quotas are never added. Sessions attributed to a hidden or
retired account appear only in the owner's `hiddenFromAgents` rows; those accounts do not suppress
unrelated external sessions. Sessions still unresolved remain in the live summary and affect no
account's slots.

## Spawning on an account (D3, experimental `multi-account`)

With `AGENTISTICS_MULTI_ACCOUNT=1`, every door that starts a session picks the harness ACCOUNT it
runs on, through one pure decision (`sessions/spawn-account.ts`): `POST /api/fleet/new` (`account`
in the body), `agentop session start --account <acc_…>`, `agentop session batch` (`--account` is a
positional default for the `--session`s that follow) and every reopen.

- The account's root reaches the pane as its harness's one isolation variable (`ISOLATION_ENV`:
  `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME`, `GEMINI_CLI_HOME`, `KIMI_CODE_HOME`) through the
  spawn env, never the command line. The default root adds nothing: with the flag off, or on a
  single-account machine, argv and env are byte for byte what they were.
- No `account` → the router's pick for that harness (C2's agent-visible budgets, `pickAccount`), else
  the default root when its account is visible, else the oldest visible account. The automatic pick
  is never an account that is off for agents.
- A named account that is off for agents is refused **403 `account_unavailable`** only when the
  request carries a verified session identity (an agent asking: the body's `session` proof on HTTP,
  `AGENTOP_MANAGED_ID` with the identity key on the CLI). The owner may still choose it. An unknown
  id is **422 `unknown_account`**, a retired one **409 `account_retired`**, and naming any account
  with the flag off is refused in words (`accounts_disabled`).
- `ManagedSession.accountId` is stamped at spawn and is immutable: reopen, attach, restart and the
  takeover of a running conversation inherit it and run in that root (the transcript exists only
  there). A row whose account was retired reopens refused in words — checked BEFORE any holder
  process is ended. A row with no `accountId` reopens in the default root, as before.
- The boot MCP re-registration in claude/copilot roots runs `mcp remove` before `mcp add` (add refuses
  an existing name), so a stale entry in a root is repaired.
- Antigravity and opencode have no isolation variable: an account root is refused for them in words
  (`account-unsupported`).
