# Leader handoff settings and panel

Settings → Sessions has four handoff profiles: Economy (150,000 tokens), Balanced (250,000,
recommended default), Long (400,000), and Custom. The cut is an absolute current context size;
it is separate from cumulative tokens and the model's context window. Settings are stored under
`Preferences.handoffConfig` through the existing preferences API. Invalid stored values normalize
to the defaults. Custom cuts accept 1,000–10,000,000 tokens; the extra-context simulation accepts
0–100% of the model's reported context window, with 10% as the default.

The three visible warning levels can be switched independently: approaching at 80% of the cut,
handoff due at the cut, and overdue at cut +50,000. The header meter remains the context indicator
and uses green/yellow/orange/red. Only registered leaders with measured current context show it;
worker sessions retain their existing controls. The composer band appears only at due/overdue
when that warning is enabled. Closing the band folds it into the header meter; it returns after
10 minutes or another +50,000 tokens, whichever comes first. The panel offers the same reminder. Settings are the permanent
way to disable the visible warnings. These switches do not disable the existing message to the leader.

The desktop panel uses the shared confirmation modal; on phones it is a bottom sheet, and the
comparison table becomes cards. Only the panel body scrolls; Close, Remind and Hand off stay
visible in the footer, together with the confirmation message when requested. “Hand off now” opens the live panel and asks for confirmation.
Confirming sends a prompt to the current leader using the existing fleet prompt action. The leader
prepares the durable handoff and opens a successor through `agentop session --handoff` /
`handoff:true`, preserving the existing verification, inheritance, and relay behavior. The button
does not spawn a second, independent succession flow. Prompt delivery failures remain visible.

## Stable API contract

`GET /api/sessions/:id/handoff-panel` returns the `HandoffPanel` v1 contract exported from
`@agentistics/core` (`handoffConfig.ts`). The endpoint returns 404 for workers, closed/exited
sessions, and missing sessions. Responses use `Cache-Control: no-store`. The header, band and
panel share a single client subscription and a five-second poll per visible session; background
browser tabs do not poll. Settings changes refresh existing subscribers immediately.

The optional `extraPercent=0..100` query parameter overrides only the live simulation; it does not
persist settings or change the owner-selected cut. The panel applies the input on blur/Enter.

The response contains:

- Identity/version: `version: 1`, `sessionId`, `updatedAt` (server epoch milliseconds).
- Owner settings: normalized `config`, `cutTokens`, and `level` (`normal`, `near`, `due`, `overdue`).
- Context and spend: `contextTokens`, `contextWindow`, `spentUSD`, `replies`, `nextReplyUSD`,
  `successorReplyUSD`, `successorBaseTokens`, `handoffOverheadUSD`, `breakEvenReplies`. `replies`
  counts assistant calls, never the separate user-turn count.
- `projectionReplies: 20` and three `projections`: `continue`, `extra`, `handoff`. Each has
  `contextTokens`, `costUSD`, `fiveHourPct`, and `weekPct`.
- `quotaEstimated: true`, `workInFlight` (stable keys `main-response`, `background-work`), and
  `handoffPath` (the existing file when one is found).

Unknown measurements are **null**, never guessed zeros. Money is estimated API-equivalent USD,
using the known model's cache-read price, matching the existing `computeHandoffWhy` calculations.
The continue row estimates 20 replies at current context. The extra row estimates 20 replies at
current context + X% of the *reported context window*, not X% of the cut. The successor row
includes the existing one-off handoff overhead plus 20 replies at the existing successor base.
An unknown model price or context window leaves dependent cells null.

Quota percentages estimate **additional percentage points** of the account's 5-hour/week windows,
not the share of remaining allowance. The adapter observes the plan-limits meters and the same
account's fleet spend: positive utilization delta divided by positive spend delta, separately for
each window, multiplied by each projected cost. It requires unchanged account/session population
and reset boundaries, and recent samples (at most 30 minutes apart). Unknown account attribution,
missing measurements, renewal, unchanged utilization, or no observed spend leave quota cells null.
These estimates include other work in the account and are labeled estimates on screen.

## Engine boundary

`server/sessions/handoff-panel.ts` adapts the existing `computeHandoffWhy` model. The owner's cut
also overrides the existing hint threshold; the existing T*, successor-base, growth, overhead and
reminder formulas otherwise remain intact. The future measured-F/grace/complexity work can replace
the adapter's internals while keeping the v1 UI contract. Complexity modes and new engine math are
outside this screens batch.

Unit tests are in `core/src/handoffConfig.test.ts`, `server/sessions/handoff-panel.test.ts`, and
`web/src/components/sessions/HandoffWarning.test.tsx`, and `web/src/lib/handoffPanelState.test.ts`. The delivery owner runs tests/typechecking
and desktop/mobile light/dark visual QA in an isolated `agentop run --rm` environment before
accepting the change.
