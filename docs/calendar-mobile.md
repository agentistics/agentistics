# Delivery calendar on phones

Below the app's 768px breakpoint, `/tasks/calendar` opens an hour grid for one BRT day. The header opens the month picker and view menu (Day, 3 days, Week, Month, Schedule, Agenda). The seven-day strip selects a date; a horizontal swipe changes its week. A horizontal swipe over the hour grid changes the selected day. Vertical gestures scroll the grid.

Filters open in the app's bottom sheet. The sheet reuses the existing task, stage, version, harness, priority and confirmation controls. The URL stores `calDay`, `calView`, and `calFilters`, preserving unrelated query parameters. Invalid filter values fall back to the defaults.

Timed versions appear in the hour grid, alongside pieces and account renewals. Versions without an estimate appear in the all-day band on today, together with task deadlines. This keeps the version context visible without a second row of release cards taking space above the grid. The band shows three entries, then an expansion button; it can also collapse. Its expanded content scrolls within a bounded height.

Each piece's membership and interval come from core's `pieceSpan`, the same range the API filters by day. Pieces with only one known instant occupy a minimum touch target at that instant; the display does not invent an ETA. Overlapping events share columns within each connected group. Empty days retain hour lines. The calendar uses the existing page-fit registration to omit the page footer, and the phone frame allows the grid to shrink to available space. The duplicate floating chat button is hidden while this view is mounted; chat remains available in the app's bottom navigation. The filter sheet uses the app's focus and Escape handling and safe-area padding.

Schedule reserves additional scrollable space after the time axis and below its last row so labels remain reachable. Desktop keeps its existing layout.

## Validation

Pure tests cover horizontal gesture thresholds, vertical gesture rejection, date boundaries and interval packing. DOM tests cover empty grids, week columns, card counts, detail selection, month-to-day navigation, filter-sheet visibility and Schedule's label reserve. Browser layout, safe-area behavior, visual parity at 360/390/1280px, and first-load performance require independent Chromium and WebKit QA.
