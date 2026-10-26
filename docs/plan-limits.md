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
  spawn env. Choosing the default account explicitly removes its inherited isolation variable, so
  a worker running on another account cannot pass that login to the new session. Structured relays
  delete it from the child environment; tmux panes use `env -u` for that child only. The removal is
  saved for recovery and retained when continuing in a TUI. With no account selected, the legacy
  environment is preserved.
- An account runs where it is SIGNED IN: its root is read from the registry's bindings, never from
  `HarnessAccount.root` alone (a signed-out account reads `null` too, which is not the default
  login). Naming a signed-out account, or reopening a row recorded on one, is refused in words
  (**409 `account_signed_out`**) for the owner as well — it never runs under whatever login holds a
  root now.
- Antigravity's legacy `default` and `root:<hash>` records for the default root merge before
  identification. Its first confirmed identity keeps the surviving record's id and nickname.
  Only Antigravity treats `root:` records as unidentified placeholders: it minted those keys
  before it had an identity probe. Other harnesses keep `root:` records separate from a new login.
- No `account` → the router's pick for that harness (C2's agent-visible budgets, `pickAccount`), else
  the default root when its account is visible, else the oldest visible signed-in account (a
  secondary-only account included), else the owner keeps the default root and an agent is refused.
  The automatic pick is never an account that is off for agents. The cockpit wizard's own start goes
  through the same decision on the host (`hostSpawnAccount`) and stamps the account it chose.
- An agent is identified on every door: `/api/fleet/new`, `/api/fleet/nay` and `/api/fleet/act`
  (reopen) read the body's `session` proof server-side; the CLI reads `AGENTOP_MANAGED_ID` with the
  identity key; an engine DELEGATION is always an agent start.
- With the flag OFF nothing is chosen or stamped and argv/env stay byte-identical, but the
  hidden-account rule still holds: an agent is refused when the default root's login is off for
  agents. A RETIRED account still bound to the default root is that root's login (retiring keeps the
  binding and the on-disk login): an agent's default launch on it is refused, flag on and off; the
  owner may still launch there.
- A named account that is off for agents is refused **403 `account_unavailable`** only when the
  request carries a verified session identity (an agent asking: the body's `session` proof on HTTP,
  `AGENTOP_MANAGED_ID` with the identity key on the CLI). The owner may still choose it. An unknown
  id is **422 `unknown_account`**, a retired one **409 `account_retired`**, and naming any account
  with the flag off is refused in words (`accounts_disabled`).
- `ManagedSession.accountId` is stamped at spawn and is immutable: reopen, attach, restart and the
  takeover of a running conversation inherit it and run in that account, never another. A row whose
  account was retired reopens refused in words — checked BEFORE any holder process is ended. An
  AGENT reopening a row whose account is now off for agents is refused in words; the owner may still
  reopen it. A row with no `accountId` reopens in the default root, as before (an agent under the
  default root's rule). The group reopen ("reopen what fell", `/api/fleet/act` `reopenFell`) carries
  the verified caller to every row's spawn. A resume with no row to replace — an external process's
  conversation, a closed one — takes the account of the NEWEST registry row of that conversation (as
  the CLI takeover does), so a signed-out recorded account refuses before the holder is ended; a
  conversation agentop never ran keeps the default root.
- An account refusal keeps its code through every host result (reopen, group reopen, external
  continuation, Nay, the host's final recheck), and `/api/fleet/act`, `/new` and `/nay` answer it
  with its status (403 / 409 / 422).
- The boot MCP re-registration in claude/copilot roots runs `mcp remove` before `mcp add` (add refuses
  an existing name), so a stale entry in a root is repaired.
- Antigravity and opencode have no isolation variable: an account root is refused for them in words
  (`account-unsupported`).

## Switching the open session from Plan usage

The sidebar footer's Plan usage popover and the Plan usage modal identify the session currently
open in the Sessions workspace and its account, using the same account names as the usage list.
With another account available, “Switch the open session's account” opens the existing account
switch dialog. Without a target, the session line stays visible with the existing unavailable
reason. Outside an open session, both surfaces omit this section entirely.

The shell supplies the selected session; no separate selection store exists. A completed switch
follows the reopened session, replacing its tab when needed and keeping the other split pane.
Tab reaches both actions in the footer popover; clicking Switch closes that popover first.
Escape dismisses the account dialog before any underlying Plan usage modal.

## Usage area

The Usage area reads the same plan-limit store as the composer and Nay. `/usage` shows one card
per account (including registered accounts awaiting a reading), ordered by the surface harness
registry and account label. Accounts excluded from agent routing remain visible to the owner.
Capacity without a measured rate is described as unmeasured; it does not become a zero.
Harnesses without subscription plans have registration links to Settings → Billing. The native
runtime uses provider billing rather than subscription plans and is excluded from that list.

`/usage/plan` accepts a positive number of hours, defaulting to four, and uses the shared
`planSessions` helper for sustainable parallel capacity and pause times. Hours are planning metadata,
not an input to capacity arithmetic. `/usage/limits` renders
the same `NayLimitsTab` as the usage modal. `/usage/history` shows account readings for the weekly
and five-hour windows. History is persisted by `plan-history.ts` in `plan-history.json`: one point
per 5-minute bucket (the newest reading wins), 14 days, at most 4032 points per account, each point
carrying its windows' reset ids so Real breaks where a window renewed. A new meter segment drops the
account's series. The raw in-memory readings still feed the pace maths; these pages add no polling loop.

Expected usage is a straight line from zero at the current window's start to 100% at renewal.
Actual percentages retain their measured values on the same percentage scale, without independent
normalization. Without a renewal time, no expected line is invented. Agora compares the current
weekly window; history retains older observed readings, with the expected line limited to the
current known window.

### Usage math and policy

Usage is BETA; the shared beta chip appears in the area tree, rail tooltip, mobile sheet and page
titles. The detailed formula/verdict audit is [usage-math-audit.md](usage-math-audit.md).

The shared exhaustion forecast uses average consumption up to the last observation: percent divided
by elapsed time from window start to that reading (at least one minute). Its estimated exhaustion
instant is anchored to that reading's `updatedAt`, so clock ticks alone do not move it. It does not
use recent measured burn. No usage means no warning; 100% or more is exhausted. Remaining quota is
clamped at zero; over 100% shows an explicit over-limit state and retains the reported percentage.
Pending registered accounts carry the same friendly `accountLabel` as measured accounts, never a
raw account id or owner login. A telling account label remains visible in Limits even for one account.

Recent weekly pace uses same-account, same-renewal observations from the last six hours, after the
current account segment starts. Burn is the nonnegative percentage delta divided by elapsed hours
(at least one minute). Without two observations it falls back to the sustainable rate as policy,
not a measurement. Sustainable rate is remaining weekly quota divided by remaining hours (at least
half an hour); projected periods cap it at 198%/h. A positive live per-session measurement can
still establish measured capacity. A flat zero burn cannot establish per-session capacity.

Recent burn/sustainable ratios below 0.8 are under pace, above 1.2 over pace; both boundaries belong
to on pace, allowing only floating-point noise. Positive burn against zero quota is over pace.
Budget hold starts at 85% of 5h or 95% of week. A week at 80%, or one forecast to run out early,
is tight. The page combines these fields: hold first, tight/recent over next, otherwise on/under.
The area warning count uses that same decision. MCP exposes budget and pace as separate fields.

`tight` is a warning, not a routing hold. Registered, available accounts with that status remain
eligible for every work kind; only `hold` crosses a quota stop threshold. Thus a tight account
whose recent burn is under pace can still receive workers at its measured cadence. QA continues
to exclude the author's harness. If no route exists because plans are unregistered, unavailable,
yielded or excluded for QA, the router says no eligible plan, rather than claiming they are held.
“All plans on hold” is reserved for actual hold rows and names the earliest account pause time.

A low absolute percentage can still carry the tight warning early in a window. For example,
4% weekly usage with 6.85 days left means only 3.6 hours have elapsed out of 168: the linear expected
usage is 2.14%. At that window-average rate the remaining 96% lasts 86.4 hours, shorter than the
164.4 hours to renewal. The warning is therefore tight, independently of the 5h percentage and of
recent burn. Recent burn can simultaneously be under pace; that account remains routable. At the
same 4% with 6.5 days left, the average forecast lasts through renewal and the budget is ok.

Plan shows the server's suggested parallel cadence, including availability overrides, rather than
recalculating it in the browser. The requested hours record the intended interval; recommendation
remains sustainable through renewal, independent of that duration. Suggested cadence is 0 for
hold/recent over, otherwise a 1–8 heuristic from recent/sustainable rates. It differs from free
slots, which subtract measured live burn and divide remaining rate by average per-session burn.
The running count includes attributed positive-burn sessions, not all open fleet sessions.

Daily budget is nonnegative remaining weekly quota divided by days remaining (at least half a day).
Hold pause time is the weekly reset when weekly quota binds, otherwise the 5h reset. An over-pace
pause solves for when remaining quota can sustain the measured burn through renewal, capped at
the next 5h reset as a recheck time. The page headline uses the latest future account pause; MCP's
aggregate uses the earliest recheck. Account cards retain their own pause times and future days.

History retains at most 32 observations per account within seven days of the latest sample, in
memory only. Durations use absolute milliseconds (week=168h); dates use the browser's time zone.
Meters tick on the client clock, whereas budget snapshots refresh through the existing SSE store.
The audit records the stale-snapshot, planning-horizon and projection limitations explicitly.

### Usage area presentation

Usage › Now and Plan use the same measured-capacity test (`freeSlotsMeasured` and a finite,
positive burn rate). When the last live session leaves the fleet, Plan retains the server's
`suggestedParallel` recommendation. Unknown capacity is described as unmeasured.

Now omits the recent burn/ideal pair because the account status also considers the weekly
budget; equal recent rates can coexist with an over-budget week. Its weekly expected tile and
status remain visible. Current account readings and historical samples have separate lifetimes:
the charts describe the persisted history, rather than implying no current
reading exists. Limits show the update age per account, from that account's `updatedAt`, without
a competing modal-wide age.

## Adding a login in Billing (experimental `multi-account`)

Settings → Billing → **Add account** opens a link/code dialog. The owner opens the link in their
own browser; the server never opens a browser. Claude Code and Gemini ask for the authorization
code shown by the page. Codex, Copilot and Kimi display a device code and wait for authorization.
Kimi's link already includes its code. The dialog shows the assistant, identity and reported plan
only after the existing root probe binds the account. A successful CLI exit alone does not bind it.
Antigravity and opencode still cannot isolate a second account.

| Assistant | Login command | Transport |
| --- | --- | --- |
| Claude Code | `claude auth login --claudeai` | Hidden PTY; paste code |
| Gemini CLI | `NO_BROWSER=true gemini` | Hidden PTY; paste code |
| Codex | `codex login --device-auth` | Pipes; device code |
| Copilot | `copilot login --device-code` | Pipes; device code |
| Kimi | `kimi login` | Pipes; device code |

These processes are private login helpers, never managed sessions, sidebar entries or fleet rows.
PTY helpers use agentop's existing **utility tmux socket**, separate from the user's tmux and the
fleet socket. The child receives its account isolation variable and a restricted runtime PATH
without `xdg-open` or other browser launchers; display variables and inherited access tokens are
absent. Gemini gets a private settings copy selecting its personal OAuth method, so its first-run
method picker cannot block the link; the default settings file is never edited.

Copilot must save its login through the system keychain. If it asks to save a token in plain text,
or reports that the token could not be saved, the helper refuses and the dialog explains why.
It never answers yes to that prompt.

`POST /api/accounts/roots` waits for a parsed link and returns
`{ok, pendingId, root, kind: 'paste' | 'device', url, code?, expiresAt}`. The `code` here is only a
public device code (including Codex's 4+5 format). Claude's OSC hyperlinks are stripped before
validating the authorization URL against the host/path allowlist, including
`claude.com/cai/oauth/authorize`. `POST /api/accounts/roots/:pendingId/code` accepts `{code}` for a paste login
and returns only `{ok: true}`. Pasted authorization codes go directly to the private PTY's stdin,
never to shell arguments, logs, audit records or files. Responses contain fixed refusal sentences,
never raw CLI output or transport errors. The same local-shell capability, CSRF and authentication
gates protect both routes.

`GET /api/accounts/roots` includes the active helper's link metadata. After a rejected pasted
code, `login.error: 'invalid_code'` restores the paste field with a localized explanation; the
helper selects the latest allowlisted URL when the CLI regenerates it. Raw post-input pane output
is inspected transiently and never buffered across reads; only public metadata, prompt/error
counts and a pane digest are retained. Bound rows include the
reported label and plan. The dialog can resume a pending helper from Billing. Cancel, closing the
dialog or leaving Settings calls the existing `DELETE` route to stop the helper and remove its
pending root. Cancellation racing a completed bind preserves the newly added account. Existing
account deletion still requires the exact root path to remove credentials. The dialog closes
immediately on Cancel, reports cleanup errors on the Billing page, and remains mounted when the
viewport crosses 768px. While it is open, its pending card shows only status. URLs wrap across the
full dialog width, and 44px control minimums apply only on mobile. Root lifecycle audit records
are dispatched without awaiting the audit sink; delivery failures produce a fixed operational log
without CLI output or pasted codes.

A helper has 30 seconds to produce its link and a maximum lifetime of 15 minutes; a shorter
reported device expiry (or Gemini's five-minute prompt window) takes precedence. Timeout and
refusal stop the helper and remove its unbound directory. A failed row with a fixed reason remains
in memory for up to 15 minutes so the open dialog can explain what happened. Link metadata and
failure rows are not persisted; confirmed account bindings keep the existing durable registry.
