# Sessions workspace: split view, two sessions side by side

**Status:** approved 2026-09-29. The leader session relayed the decision on the owner's behalf.

## What the owner asked for

- **Up to TWO sessions side by side** in the Sessions workspace (desktop only). A phone keeps a single session.
- **Each side carries the FULL per-session layout.** Everything individual to that session stays
  visible:
  - its own header (title and state);
  - its own chat and composer;
  - its own artifacts rail (activity, agents, images, skills, git and the rest);
  - its own bottom band (Claude Code, Shell, Studio, PRs).
- **The two sides are independent.** The gap between them is a resize handle, as in the
  floating-panels design.

## Design

- **The URL.** The main session is the route's own `/sessions/:id`. The second one is
  `?split=<id>`, and its chat/terminal view is `?splitView=`. That means a reload, a bookmark or
  Back all keep the arrangement, and every existing `/sessions/:id` link means what it meant.
  `lib/splitRoute.ts` (pure) holds every decision about where a gesture lands:
  - `openInPane`: a pick from the list replaces the ACTIVE pane.
  - `openBeside`: the list row menu's "Abrir ao lado".
  - `closePane`: closing the main pane promotes the split session.
  - `replaceInPane`: a reopen follows its own pane only.
  - The two sides are never the same session.
- **The page.** The old `SessionsPage` body is now `SessionsPageBody`. It takes its session, its
  pane and the split route as props. The exported `SessionsPage`:
  - renders ONE body exactly as before when there is no split, or on a phone;
  - renders two `PaneFrame`s with a `PanelGap` between them when there is a split.
  - The main pane's share is a ratio (`lib/splitLayout.ts`, each side at least 420px), persisted
    per viewer.
- **Pane scope** (`lib/paneScope.ts`). Every store that assumed "the one open session" now keeps
  one state per pane. The main pane keeps the historical storage keys and DOM ids, so a browser that
  never splits sees no change. The stores:
  - `panelSlots` (rail/band occupancy);
  - `floatingPanels` (which session's windows each pane draws);
  - `artifactsStore` (records per session, and the focus request carries its pane);
  - the shell-band prefs;
  - the `ag-gap-*` DOM ids.
  - Hooks read the pane from context. An imperative call made outside React (a keyboard shortcut,
    a chat note's "open the Gallery", the Studio's search) uses the ACTIVE pane. Each `PaneFrame`
    marks itself active in the capture phase of its pointer and focus events.
- **Header.** While split, the App's session strip names no session, because it would read as the
  only one on screen. Each pane shows its own `SplitPaneHeader` instead:
  - title and state, and the delivery flag;
  - the metrics chip;
  - the chat/terminal switch and the verbs;
  - a "close this side" control.
  - The active pane is marked in orange.
- **One of each global thing:**
  - The unsaved-changes guard lives on the main pane and answers for both sessions' keys; the
    second pane's is `active={false}`.
  - The idle-sessions watch and modal live on the main pane only.
  - The hardware-pressure notification is sent from the main pane only.
  - Only the rightmost pane reports the right edge the App's Filtros tab anchors to.

## Known limits

- Closing the SPLIT pane with unsaved Studio edits in it is not asked about by the leave guard,
  because the path does not change. The Studio's own close path (`holdIfUnsaved`) still asks when
  its panel is closed directly.
- The dedicated terminal route (`/sessions/:id/terminal`) is the main pane's. Opening it from the
  split pane opens that session's terminal full screen, which leaves the split.
