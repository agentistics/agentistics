# Filter dropdown widths and adjacent controls

Issue: [#1405](https://github.com/agentistics/agentistics/issues/1405). Agentask: `s-757493f213`.

`Select` and `MultiPicker` size their open lists to intrinsic content, with the trigger width as a minimum and an 8px viewport margin on each side. A layout effect clamps the measured panel before paint. Option labels stay on one line; exceptionally long content scrolls inside the capped panel. The triggers retain the existing 32px desktop / 44px phone sizes.

The inline `FiltersBar` reserves the add-filter button's intrinsic width instead of allowing its wrapper to shrink underneath the painted button. It keeps the existing header compaction tiers and single row. Compact date and active-filter controls also receive 44px targets on phones. Navigation counts cannot shrink; the text label yields space before it can reach the separately reserved chevron.

## Author validation

Browser evidence is in `/home/mithrandir/agentistics-workspace/leader/qa/evidence/ui-dropdowns/`. Files use `before|after-browser-width-spot.png` names.

Chromium and WebKit were run through Playwright/Node in disposable `agentop run --rm` environments, with a Vite server started using `agentop run --rm --serve`. Heavy jobs used `agentop heavy` sequentially. The browser fixture mounted the real `CalendarFilters`, `FiltersBar`, `AreaTree`, `Select`, and `MultiPicker` components with deterministic data and the application's CSS. It exercised component layout; it did not load the production dashboard's data or authenticate against the owner's environment.

At 1280, 1440, and 390px:

- All five Calendar pickers opened within the viewport. Stage's desktop menu grew from 116px to 236px in Chromium and 200px in WebKit; labels such as “In development” and “Leader review” stayed on one line.
- Narrow triggers at the right edge opened wider lists with their right edge at or before `viewportWidth - 8`. A 390px Chromium Select capped its panel at 374px; long labels remained unwrapped and could scroll inside the panel.
- The home filter controls were checked with zero, one, and multiple active dimensions, including the compact 212px slot. Button rectangles did not intersect, and document width did not exceed viewport width. The warning/layout controls in this fixture were stand-ins for adjacent actions.
- Desktop and mobile screenshots include the sidebar in expanded and collapsed modes, using a three-digit count to stress the badge width.

Selection was also exercised: “Leader review” was checked and committed, and its active filter chip appeared in Chromium and WebKit at 1280 and 390px. At navigation widths of 200px and 132px, the measured badge stayed 12px before the chevron button with the group both expanded and folded. The collapsed icon rail retained its existing attention dot.

Targeted tests use `TZ=UTC agentop heavy agentop run --rm -- bun test <files>`:

- `packages/web/src/pages/settings/primitives.test.tsx`: 23 passing.
- `packages/web/src/components/FiltersBar.sheet.test.tsx`, `packages/web/src/components/nav/AreaTree.test.tsx`, `packages/web/src/components/calendar/calendar.dom.test.tsx`, and `packages/web/src/lib/headerFit.test.ts`: 54 passing together.

Run `primitives.test.tsx` separately: a combined invocation after the other fixtures encountered an existing global `window` restoration conflict; both isolated groups passed. No full suite or full TypeScript check was run. `git diff --check` is clean. Independent QA and the full dashboard integration check remain for the leader before release.
