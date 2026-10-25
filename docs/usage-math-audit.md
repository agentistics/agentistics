# Usage math audit

Audited 2026-10-25 against 2.151.0, issue #1146. Scope: `/usage`, `/usage/plan`,
`/usage/limits`, `/usage/history`, shared meters and the account budgets supplied by
`agentistics_plan_limits`. This is a source and regression-test audit, not validation of provider
telemetry accuracy or independent visual QA. Usage carries the existing Agentask BETA chip in
the desktop tree, collapsed tree/rail tooltip, mobile sheet and page titles, in PT/EN.

## Notation and sources

Timestamps are epoch milliseconds. `H = 3,600,000`, `D = 24H`, `L = 5H` or `7D`,
`R = resetsAt`, `U = usedPct`, `t = now`. Percentages are percentage points: Claude stream
utilization is multiplied by 100; Claude usage API and Codex already report 0–100. Overage remains
visible. “Agrees” means code agrees with documented policy, not that the policy predicts future
work perfectly. Previously undocumented policies are now explicit in [plan-limits.md](plan-limits.md).

Implementation sources:

- `packages/core/src/planLimits.ts`: windows, budget, forecast, pace, slots and routing.
- `packages/server/server/plan-limits.ts`: account attribution, histories, payload and overrides.
- `packages/mcp/plan-limits-tool.ts`: forwards visible rows and adds routing recommendations.
- `packages/web/src/lib/{planLimits,usagePlan,areaBadges}.ts`: store, formatting and UI status.
- `packages/web/src/pages/usage/*`, `components/PlanLimitMeter.tsx`, `components/ActivityChart.tsx`.

## Displayed values

| Value / surfaces | Formula in code | Formula / rule in docs | Verdict |
| --- | --- | --- | --- |
| Used %, Now/Limits rings and rows | `round(currentUsedPct(w,t))`; after `t>=R`, current use is 0 and detailed row displays `–` | Preserve actual %, distinguish renewal without a reading | Agrees. Text retains overage; geometry clamps [0,100]. |
| Remaining %, Now/Limits | `max(0,100-round(U))` before renewal | Remaining quota is nonnegative | Fixed: 125% previously displayed “−25% left”. |
| Renewal date and “in …”, Now/Limits | Local `fmtWhen(R,t)` plus `fmtSpan(R-t)` | Absolute timestamp and elapsed duration | Agrees; exact reset is already renewed. |
| Estimated reset after old reset | `R+(floor((t-R)/L)+1)L`, use=0, `projected:true` | Projection distinguished from observation | Agrees, including several missed windows. |
| “runs out ~HH:MM”, Now/Limits | `E=max(1 minute,t-(R-L))`; `at=t+(100-U)*E/U` | Average since window start, not recent measured burn | Agrees with policy caveat below. `U<=0`: lasts; `U>=100`: exhausted; renewed: no warning. `at>=R`: lasts. |
| Meter state / warning, Now/Limits | attention ≥75%, critical ≥95%; early forecast upgrades “room to spare” | Severity plus early exhaustion warning | Agrees; distinct from hold and recent pace thresholds. |
| Updated age, Now/Limits | age <1 minute →just now; else rounded duration; stale iff age >10 minutes | Each account's own update age | Agrees. Exactly ten minutes is not stale. |
| Week: expected %, Now | `clamp(100*(1-(weekResetsAt-t)/(7D)),0,100).toFixed(1)` | Straight 0→100 from start to renewal | Agrees. Requires known weekly meter and future budget reset. |
| Renews in, Now | `fmtSpan(weekResetsAt-t)` when positive | Weekly renewal interval | Agrees. Absent week →no weekly tile. Projected weekly reset is an estimate. |
| Parallel / recommended, Now | `liveSessions.length / suggestedParallel`, only with positive measured capacity | Authoritative server cadence | Agrees. Count includes attributed positive-burn sessions, not all open terminals. |
| Parallel, Plan | server `suggestedParallel`; hold →0, unknown capacity →unknown | Same recommendation as Now/MCP | Fixed: local `floor(sustainable/(account burn/live count))` could disagree or override an unavailable account's zero. |
| Hours input / interval, Plan | finite `Number(hours)>0`; default 4; helper does not vary cadence by hours | Sustainable cadence through renewal; requested interval displayed | Agrees with existing policy; limitation below. Blank/zero/negative/non-numeric edits show alert and N/A. |
| Running now / weekly renewal, Plan | measured session count; local reset if future | Same account's count and weekly reset | Agrees; unknown count and absent weekly renewal are N/A. |
| Pace pill, Now | hold if budget hold; over if tight OR recent over; else recent on/under | Combine budget severity with recent pace | Fixed: under previously became on. MCP can have `paceStatus:on` with `status:tight`; combined UI then warns. |
| Area count / headline | count rows with combined hold/over state | One shared page/nav predicate | Agrees. Under produces no warning; hold counted once. “All on pace” means no warning, including under. |
| Headline pause | latest future pause among warning rows, formatted with day | Conservative all-account pause; cards keep their own times | Fixed: a pause several days away previously showed HH:MM alone. MCP aggregate uses earliest recheck intentionally. |
| Pause tile / Plan availability | future time →local date/time; missing hold/over time →“No time set”; otherwise “No pause” | Do not invent a pause time | Agrees. Expired pause is not shown as future. |
| Expected charts, Now/History | `100*(sampleAt-(R-L))/L` inside known window; insert 0/100 endpoints; elsewhere null | Straight 0→100; absent reset →no expected line | Agrees for week and 5h. |
| Actual charts, Now/History | recorded week/5h % at timestamp; null stays missing; Now filters current week | Same percentage scale without normalization | Agrees. >100 preserved; keys include harness and account, duplicate nicknames disambiguated. |
| Chart axes / tooltips / window labels | epoch-ms X/local date-time, percent Y nominal 0–100 (Recharts expands overage), Week or 5 h by kind | Time versus percent, per window | Agrees. Earlier expected windows cannot be reconstructed from payload. |
| History scope | in-process samples, last 32 per account within seven days of latest reading | Recent in-memory history since server startup | Agrees with bounded retention now explicit; not a complete weekly archive. |
| Limits plan / pending rows | observed %/resets; absent record →waiting, no numeric zero | Missing data is unknown | Agrees. Availability/registration settings are not numeric usage observations. |

## Budget and pace producers

These fields feed the displayed values or MCP. Daily budget, rates and free slots are not separate
numeric tiles on the Usage pages.

| Field | Formula in code | Documented rule | Verdict |
| --- | --- | --- | --- |
| Days / daily budget | days=`max(0,(weekReset-t)/D)`; `max(0,100-weekPct)/max(days,0.5)` | Spread remaining weekly quota, half-day floor | Fixed negative daily budget on overage. |
| Sustainable `S`, %/h | `max(0,(100-weekPct)/max(0.5,remaining hours))`; projected cap 198 | Half-hour floor, projected below absolute 200 criterion | Agrees. No week →0.5h fallback, not a measured week. |
| Recent burn `B`, %/h | nonnegative weekly delta / `max(1/60,elapsed hours)` between first recent and last matching sample | Last six hours, same account/renewal, after account segment start | Fixed mismatched reset and future sample inclusion. One point falls back to S, explicitly unmeasured. |
| Recent `paceStatus` | B/S >1.2 →over; <0.8 →under; otherwise on | Inclusive [0.8,1.2] on band | Fixed decimal subtraction at boundaries (1e−12 tolerance). B>0/S=0 is over; zero/zero is on. |
| Budget status | hold if 5h≥85 OR week≥95; else tight if week≥80 OR weekly average runs out; else ok | Separate quota and pace policies | Agrees. Week hold wins when both windows bind. |
| Suggested parallel | hold/over →0; under →`clamp(max(2,ceil(S/max(B,S/2))),1,8)`; on →`clamp(ceil(max(B,S)/max(S,0.01)),1,8)` | Cadence heuristic bounded 1–8 unless paused | Agrees. Spawnability/yield overrides can zero it. Not a count of additional free slots. |
| Free slots | live mean burn P; `max(0,floor((S-sum(live burn))/P))`; absent live sessions use typical plan burn / measured count | Additional shared pool per account | Fixed decimal whole-slot loss (1.2/0.4). Measurement flag now requires observed interval or positive live measurement, not single-point fallback. |
| Pause until | hold →weekly reset at week≥95, else 5h reset at ≥85; over →`t+max(0,remaining hours-(100-weekPct)/B)*H`, capped at next 5h reset | Renewal hold or earlier over-pace recheck | Agrees. Recheck cap does not guarantee sustainable burn at that time. |
| Aggregate slots / pause | harness slots sum usable accounts; global free slots=max usable harness pools; pause=min account rechecks | Pick an available harness/account, not total interchangeable capacity | Agrees; headline's conservative latest pause has different scope. |

## Edge cases and policy questions

1. **Stale reading:** raw meters show age and distinguish renewal. Browser time ticks each minute,
   but budgets refresh on SSE/reconnect, not each tick. A disconnected page can temporarily retain
   old budget status/recommendation while raw meters say renewed. No extra polling or independent
   client recomputation was introduced. Resolving this needs a shared refresh policy.
2. **No measured rate / reset just occurred:** one point uses S as policy fallback; zero burn has
   no positive per-session cost, so Usage calls capacity unmeasured. MCP may still recommend fallback
   cadence. Newly projected windows carry zero usage and estimated renewal, not observed capacity.
3. **Window average versus recent burn:** exhaustion can warn while recent burn is zero, because
   earlier consumption was fast. It does not use measured recent burn. Whether to change this needs
   a policy decision: both shared meters and budget tight status currently use window average.
4. **Plan hours:** 1h, 4h and 168h give the same sustainable recommendation. No finite-horizon quota
   optimizer or reset simulation exists. The page explicitly explains that hours do not increase
   capacity. Making the input change the result needs a specified planning contract.
5. **Week versus 5h:** recent burn/capacity use the week; 5h supplies an 85% hold and recheck cap.
   No separate recent 5h sustainable rate exists. A missing weekly meter is not a measured week.
   Projected rolling windows may differ from providers that start a window on subsequent activity.
6. **Several accounts / missing account:** histories and measured sessions partition by harness and
   account; legacy unknown identity is not assigned arbitrarily among several logins. Owner Usage
   includes hidden accounts, MCP excludes them. Totals can differ legitimately. Stale aliases may
   yield to fresh same-login rows, zeroing cadence/slots. Unresolved fleet sessions affect no pool.
7. **Time zones / DST:** duration uses absolute ms: week=168h, 5h=5h. Labels use browser locale/time
   zone. Repeated DST hours can have identical HH:MM for different instants; short labels omit UTC
   offsets. Remote browser/server clock skew is not compensated. Future pause days now remain visible.
8. **History labels:** current weekly reset comes from budget (possibly projected); 5h uses the
   observed meter. History payload lacks older reset boundaries, so old readings retain actual
   percentages without reconstructed expected lines for each prior period. Last-32 retention may
   cover only minutes under frequent updates. “Since startup” is a lifetime boundary, not an archive.
9. **Precision / >100%:** percentages remain provider-rounded (parsers use one decimal), tile output
   may round to integer/one decimal, duration to nearest minute. Negative quota remainder is fixed;
   overage still triggers hold. Zero burn and zero remaining capacity produce finite policy values.

## Regression evidence and acceptance

`packages/core/src/planLimits.audit.test.ts` uses tables for forecasts, renewal boundaries, overage,
hold thresholds, 0.8/1.2 pace boundaries, zero quota, missing week, account/reset/segment isolation,
pause equations and decimal slots. Captured provider fixtures remain in `planLimits.test.ts` and
`planLimits.usage.test.ts`.

Web coverage: `usagePlan.test.ts` (server recommendation parity/account preservation),
`usageFormatting.audit.test.ts` (rounding/DST), `usageCards.test.tsx` (PT/EN, 390/1440, expected
week/5h series, overage, invalid input and unmeasured capacity), `areaBadges.test.ts` (shared count),
and `UsageBeta.dom.test.tsx` (Agentask chip style parity in tree/sheet, hover tooltip and titles).
Independent desktop/390px visual QA and owner validation remain release gates.
