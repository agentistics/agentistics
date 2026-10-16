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

Live sessions use the managed session’s immutable account id, falling back to transcript account
metadata. Burn is distributed by token deltas within `(harness, account)` only, so percentages
from separate quotas are never added. Hidden account sessions appear only in the owner’s
`hiddenFromAgents` rows. If a harness has any hidden or retired account, sessions with unknown
accounts are excluded from agent-visible summaries and slots. Otherwise an unattributed session
can affect slots only when there is one unambiguous meter for it.
