# APP.AREAS T6–T8: round 4 corrections

Implementation against the live round 4 report at HEAD `ebde35450`.

- **P2 Home:** `StatCard` always places its label above its controls, using one shared header rule. Sub-lines wrap in every card; the former `subNoWrap` option is removed, including catalog examples.
- **P3a Usage:** descriptive `StatTile` values retain a readable 14px font and wrap. Detailed plan windows reserve a forecast line even when no warning applies, keeping Session/Week/update positions consistent between account cards.
- **P3b Plan:** the shared `FieldInput` supports a visible and accessible unit suffix. Help copy has an explicit 20px bottom gap. Invalid hours have a red `role=alert`, retain the account cards and replace dependent results with N/A. Cards also show observed running sessions and weekly renewal context, with N/A for unavailable readings.
- **P3c Limits:** the same `PlanUsageCard` → `WindowRow` → `warnForecast` path already supplies Agora, Limits and Nay; no forecast-policy change is warranted. `forecastWindow` suppresses exhaustion once projected exhaustion reaches or passes renewal, so navigating later can legitimately remove the line. Added coverage immediately before/after this boundary. Manage plans uses the shared inline `RecordCardAction`, with a physical minimum 44×44px box.
- **P3d Leaders:** remove repeated localized role prefixes from card titles, use singular/plural status text in both languages, and label child counts as active children. Exited children are excluded; stale fleet counts show N/A.
- **P3e Leadership settings:** embedded defaults omit their redundant inner heading; check-in labels use the secondary text color. Away authorization phrases start in lowercase when joined into a sentence.
- **P3f Nay:** all controls inside the mobile dock share a physical 44px minimum, including settings, close, change and nested session controls. Existing projected hit boxes are contained within those physical targets. Shared `SessionFacts` wraps title, task, harness and model on every stacked surface; the launch summary also wraps.
- **P3g Actions:** use the shared inline action beside the title, eliminating the repeated full-width footer. Harness/model have an explicit middle-dot separator; long model text wraps.
- **P3h Activity:** Portuguese handback wording now says “Enviou trabalho para revisão.”

Regression coverage was added or updated in `StatCard.test.tsx`, `SessionFacts.test.tsx`, `NayDock.layout.test.ts`, `usageCards.test.tsx`, `leadership.test.tsx`, `ActionsPage.test.tsx` and `taskActivity.test.tsx`. These include pt/en and the existing desktop/390px fixture paths where applicable.

Per the worker brief, no dependency installation, tests, servers, commits or pushes were run. Live layout and the added tests still require the integration leader's independent validation. The history/overview chart buffer limitation reported by QA is unchanged: this brief requests fixes for the P2/P3 findings, and no live readings were fabricated.
