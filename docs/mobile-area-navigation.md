# Mobile area navigation

On phones, option A uses one dark floating pill with five equal slots: Agentask, Usage, Sessions,
Metrics and More. The indicator follows the finger across the shared track; releasing activates the
slot under it. Sessions always has an orange disc and bold label. The pill stays dark in both themes,
and count badges use the shared `SOLID_COUNT` styling only for measured positive values. Reduced
motion disables springs and icon lift/scale, including when the preference changes while the app is
open. The bar hides while a session is open. The header continues to host the magnifier.

Throughout the Sessions area, the centre reads Home with a house icon. Activating it from a session
or a leadership page returns to `/sessions`; on the list it scrolls the actual list/overview pane to
top without navigating or resetting filters. The action supports open-session routes, though the
shell hides the bar while a conversation is open. Other subpages select their parent area's slot;
Repositories, Vault and Settings select More. Direct tabs go to each area's first page.

More opens the same `AreaTree` used by the desktop sidebar, in its sheet variant. Area rows
are at least 46px and subpages 44px. Selecting a destination closes the sheet, including selecting the
current page. The tree keeps the registry's Settings entries and filters them by the viewer's visible
settings sections. Below a divider, global actions reuse the area-row geometry: Hardware opens its
overlay; Theme and Language show their current values on the right and keep the sheet open when
changed. The existing account actions follow them. There are no Live or manual data-refresh actions.

An installable update from `/api/version` adds Update app first in that lower group, and in the desktop
header. This entry persists through dismissing or snoozing the popup and reopens the existing
`renderUpdatePrompt` flow. It disappears when the version answer becomes current; it never creates
a separate install path.

`useData` keeps server push/patch subscriptions. Its fallback asks every 10 seconds while a fleet row
is working and every 60 seconds while idle, avoiding full reads when the revision stream is healthy.
Hidden tabs pause fallback reads and load retries. Focus or visibility return requests fresh data
immediately, while respecting the update finale's existing deferral of heavy payloads. Legacy
`liveUpdates` and `updateInterval` values are ignored. The retired `/settings/live` URL redirects to
Preferences.

Leaders, Check-ins, Hand-offs and Away mode are subpages of Sessions, retaining their `/leadership`
URLs. The central Home tab returns these document pages to the session list.
The shared tree has one Sessions area, with combined session-attention and check-in warning counts.

`BottomSheet` owns the scrim, Escape handling, focus containment and return, scroll region, and bottom
safe inset. The navigation sheet and `FiltersSheet` share that frame. Filters still update immediately;
the footer offers Done and conditionally Clear, which is the sheet's only clear action
(`FiltersBar hideClearAll`). Chip remove buttons project a 44px target and the date range row is 44px
on a phone. The sheet's page search is a 44px field with no keyboard-shortcut hint. `MobilePillBar` supplies the floating styling and drag
gesture for the five destinations, using `bottomNavDrag.ts` for equal-slot geometry.

Mobile shell header controls, the collapsed stats strip and list/overview tabs have 44px minimum targets. Header rows can wrap
when optional status controls are present.
