# Account availability and plan limits

Settings → Billing lists detected harness accounts and their availability to agents. Switching an
account off keeps its login and owner-visible meters intact. Agent budgets, free slot totals,
per-harness slots, live session summaries, and routing recommendations exclude that harness while
its current account is unavailable. The owner API includes the excluded budgets in
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
Availability persists for each detected identity. Plan meter account keys remain `default`.
This does not add multiple simultaneous logins or switch accounts.
