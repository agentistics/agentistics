# CONTA.AGENDA — when, and how much, agents may use each account

Status: DESIGN (options for the leader's pick). Mockup and prints:
`agentistics-workspace/leader/shots/conta-agenda/` (`options.html`, 390 PT dark, 390 EN light, 1440 PT dark).

## The owner's ask

Per account, (a) windows when agents may use it — weekdays, "from hour X", date ranges
(21/02/2034–21/03/2034); outside them the account is off for agents ("only Thu from 15h, Fri and Sat",
"only Mondays", "Mon Tue Wed"); (b) a cap — the max % of the WEEKLY and/or 5 h window agents may
consume (today the Nayara Claude account was capped at 20 % of its week by hand, policed by leaders);
(c) at the edge, no new sessions on that account and running agent sessions get the existing account
switch to an allowed account, or a notice when none exists. The owner's own use is never blocked.

## What exists (mapped)

| Piece | Where | Reused for |
|---|---|---|
| Account registry `HarnessAccount.available` (the "off for agents" switch) | `server/harness-accounts.ts` (engine leader owns login/switch) | untouched; stays the master switch |
| Agent-visible budgets, routing, slots | `core/planLimits.ts` (`routeRecommendation`, `pickAccount`, `harnessAggregate`), `server/plan-limits.ts` (`planLimitsPayload`) | a blocked account becomes `status: hold`, `freeSlots: 0`, plus an `agenda` field |
| Spawn account decision, agent-only refusals | `server/sessions/spawn-account.ts` (`decideSpawnAccount`, `decideRecordedAccount`, `routerPicks`) | two new refusal codes |
| Switch picker with unavailable rows + reason | `server/sessions/account-switch.ts`, `web/lib/accountSwitch.ts`, `components/sessions/AccountSwitch.tsx` | two new `SwitchUnavailableReason`s |
| Accounts list + editor | `pages/settings/AccountRow.tsx` (`BillingAccountList`), `BillingSettings.tsx` → moving to Uso → Contas (`/usage/accounts`, feat/usage-area-cleanup) | new "Schedule" column + state Pill; editor section |
| Primitives | `primitives.tsx`: `RecordCard`, `Select`, `FieldInput`, `Toggle`, `TabSelect`, `dialogButtonStyle`; `Pill`; `PlanLimitBars` | the editor is built only from these |

## Options (editor)

- **A · Rule list — RECOMMENDED.** Each rule = weekday chips + optional "from/until" hour `Select`s +
  optional date range. Rules OR together; no rule = always. A summary sentence ("Thu from 15:00; Fri;
  Sat") is generated and reused verbatim by the list, the picker and refusals. 44 px targets at 390.
- **B · Weekly 7×24 hour grid** + separate date-range list + % slider. Best overview at 1440; unusable
  at 390 (11 px cells), and dates/hours become two concepts that cannot be combined.
- **C · Presets + one rule** (Always / Weekdays / Weekend / Pick days + one hour range + one range).
  Simplest, but cannot express the owner's own example (Thu from 15h but Fri/Sat all day).

Cap (all options): two `Select`s — Week: No cap / 5…100 %, 5 h window: No cap / 5…100 % — with the
current usage beside each.

## Model (same for every option)

- Stored in `preferences.accountAgenda[accountId]` (machine file — accounts belong to the machine):
  `{ rules: [{ days: number[], from?: 'HH:MM', until?: 'HH:MM', dates?: { from?, to? } }], cap?: { weekPct?, fiveHourPct? } }`.
- One pure rule in `@agentistics/core/accountAgenda.ts`:
  `agentAllowed(agenda, limits, now) → { allowed, reason?: 'outside_schedule' | 'over_cap_week' | 'over_cap_5h', until?, summary }`.
  Machine-local clock; dates inclusive. Every door calls it; nobody re-derives it.
- Cap compares the plan's `usedPct` (which includes the owner's manual use — it is what the meter
  measures). A stale or missing reading cannot prove the cap was hit → treated as under it and the row
  says "no reading" (stricter alternative: block on absence — leader's call).
- Bites in: `planLimitsPayload` (hold + 0 slots + `agenda`), `decideSpawnAccount`/`decideRecordedAccount`
  (`account_outside_schedule` / `account_over_cap`, 403, agents only), `account-switch.ts` (two new
  unavailable reasons, worded with when the account returns), and an edge watcher on the plan poll that
  offers the existing switch to the account's live agent sessions on the TRANSITION (or the "no allowed
  account; next opens Thu 15:00" notice). Running sessions are never killed.
- Unchanged: login/switch internals (engine leader), the owner's manual use.

## Open points for the leader

1. Option A vs B vs C (recommend A).
2. Missing/stale meter under a cap: allow (recommended) or block.
3. Cap measured on the plan's `usedPct` (recommended, owner's wording "counted from the window's start")
   vs. agent-only consumption (would need per-session attribution of the meter — not reliable today).
