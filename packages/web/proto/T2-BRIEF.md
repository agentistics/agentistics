# UI.SESSION-TABS T2 — implement session tabs (option C) + "leaders only" (option 1) — Sonnet

Task t-2c112d2d89. Base: branch `feat/session-tabs-proto` (origin/main v2.137.1 + T1 prototype). New branch `feat/session-tabs`.
Prototype to copy from: `packages/web/proto/SessionTabsProto.tsx` + `proto/sessionTabsModel.ts`
(run: `WEB_PORT=4863x agentop run --rm --name tabs -- bunx vite --port 4863x --strictPort` in packages/web, open
`/proto/session-tabs.html?opt=C` and `?view=leaders&lo=1`). Prints: `~/.agentistics/leader/shots/session-tabs-t1/`.
Delete `packages/web/proto/` in the final commit.

## Part 1 — session tabs (flag `sessionTabs`, default OFF)
Flag: add `sessionTabsStore` to `src/lib/appFlags.ts` (same `createSharedPref` shape, `prefKey: 'sessionTabs'`,
fallback false) + register `sessionTabs` in `user-ui-prefs.ts` `USER_UI_PREF_REGISTRY` (`ui.` slot) + a Settings
→ Preferences `RowSwitch` "Abas de sessões (experimental)". Flag off = byte-identical UI.

Model — `src/lib/sessionTabs.ts` (pure, from `proto/sessionTabsModel.ts`, with tests `sessionTabs.test.ts`):
`stripOrder(open,pins)`, `openTab(open,id,active,pins,max=12)`, `closeTab(order,id,active,pins)`, plus
`pruneTabs(open, knownIds)` (drop ids no fleet row resolves; ENDED rows stay — like `resolvePinnedRows`).
Store: `src/lib/sessionTabsStore.ts`, a `useSyncExternalStore` over localStorage key `agentistics-session-tabs`
(per BROWSER, try/catch every read/write, corrupt = `[]`). Pane-scope it like `panelSlots` (`lib/paneScope.ts`):
main pane keeps the bare key, split pane `…:split`.
PINS: never a second store — read/write `lib/pinnedSessions.ts` (`usePinnedSessions`/toggle via `planPinToggle`,
MAX_PINNED 10; refusal message on `limit` the same one the aside shows). Pinned = leads the strip, pin glyph, no ×.

Wiring: in `pages/SessionsPage.tsx`, every time the route's `sessionId` changes call `openTab` (navigation IS
"open a tab"; works from aside, rail, `#` mention, reopen — a reopen REPLACES the old id in place: use the
`reopenedSessionRoute` hand-off, never leave the retired id as a dead tab). Clicking a tab = `navigate` to that
session (same path the aside uses). Closing the active tab navigates to the neighbour from `closeTab`, or
`/sessions` when none.

Component — `src/components/sessions/SessionTabStrip.tsx`, rendered as its own row at the top of the
conversation panel (inside the panel border, above the chat — option C), desktop AND mobile:
- reuse: `.tabscroll` + `tabStripEdgeFade`/`tabStripFadeMask` (copy the `attachTabStrip` ref-callback pattern
  from `SessionsPage.tsx` ~line 1600, including its scrollIntoView-on-active — the prototype misses this at 390),
  `STATE_COLOR` (`lib/sessionCardStyle.ts`), `.ag-hint-pulse` (working), `.ag-mic-pulse` ring (waiting-approval),
  `needsAttention` (`components/nav/AttentionDot.tsx`), `useSessionRole` + a crown for leaders (title without the
  `[ LÍDER ] - ` prefix), `SessionRowMenu` + `rowMenu.ts` entries for right-click/long-press (add "Fixar/Desafixar",
  "Fechar", "Fechar outras", "Fechar à direita"), `reorderByDrag`/`setDragPayload` (`lib/dragReorder.ts`) for
  drag-reorder (pins reorder via `planPinMoveTo`).
- status mark (`TabStatus` in the prototype): working = green pulsing dot; waiting = orange dot; waiting-approval =
  orange dot + ring; exited/closed = hollow grey; lost = hollow red. Always with `aria-label`/`title` = `stateLabel`
  (never colour alone). Pill border goes orange-tinted for needs-you.
- close: × (visible on active/hover desktop; always on mobile, 28px inside a 44px pill), middle-click, `Ctrl/Cmd+W`
  is NOT taken (browser); keyboard `Ctrl+Alt+→/←` next/prev tab, `Ctrl+Alt+1..9` jump — add to `lib/panelShortcuts.ts`.
- overflow: the "N ⌄" button at the strip's end opens the list menu (all tabs with state + pin), with
  "Fechar outras / Fechar encerradas / Fechar todas" — reuse `SessionRowMenu`-style popover (portalled, `popoverStyle`).
- mobile 390: same strip, pills 44px tall, horizontal scroll with fade, active scrolled into view; no hidden mode.
- the header (`App.tsx` `sessionTopBar`, title + Ausente + stateLabel·cwd) stays UNCHANGED.
- split view: each `PaneFrame` gets its own strip (pane-scoped store).

## Part 2 — "Só líderes" in the aside (option 1)
`components/nav/SessionsAside.tsx` summary line (~line 1290, `summaryParts`): add a PERSISTED part `N líderes`
(crown icon, purple `--accent-purple` when on, × when on), shown only when ≥1 leader exists. Persist as
`leadersOnly: boolean` in `AsideGroupPrefs` (`lib/sessionsAsidePrefs.ts`, default false, parse-tolerant) — NOT in
the transient `summaryFilter` state. Filter = `getSessionRole(identityKey) === 'leader'` applied where
`applySummaryFilter` runs (and to the pinned band? NO — pins stay, same rule as activeOnly). Folders: hide a
user group with no visible member, keep the tree (Projeto › Líderes) — use the existing empty-group logic used
for search. Banner under the verbs row: "Mostrando só líderes · N sessões ocultas · mostrar todas" (role=status).
Count it in `arrangeChangedCount`? No — it is a filter: add it to the filter count badge instead
(`activeFilterCount.ts`). Option 2 (toggle in `SessionsGroupMenu` "Mostrar") was rejected: it hides the state
behind a menu.

## Tests / done
- `sessionTabs.test.ts` (open/close/neighbour/cap/pins never dropped/reopen replacement), store test (corrupt
  storage), `sessionsAsidePrefs` parse test for `leadersOnly`, a leaders filter test (folder kept, empty folder
  hidden, pinned untouched).
- flag OFF: no strip, aside unchanged except the leaders part (that one is not flagged — confirm with leader).
- Playwright on a THROWAWAY (`agentop run --rm`, never 47291/47292) with ≥8 fake sessions: desktop 1440 +
  390, dark + light; `scrollWidth <= innerWidth` at 390; prints to `~/.agentistics/leader/shots/session-tabs-t2/`
  compared side by side with the T1 prints.
- `bunx tsc --noEmit` + affected tests green; commit locally (Conventional Commits, Portuguese), push the branch,
  no PR; handback to the side leader with prints.
