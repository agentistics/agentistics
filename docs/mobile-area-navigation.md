# Mobile area navigation

On phones, the bottom navigation shows the current area and page from `lib/appAreas.ts` and a round
Sessions shortcut. The shortcut displays an attention badge only for a measured positive count. The
bar follows the existing shell rule: it hides while a session is open. The header continues to host
the magnifier.

The place pill opens the same `AreaTree` used by the desktop sidebar, in its sheet variant. Area rows
are at least 46px and subpages 44px. Selecting a destination closes the sheet, including selecting the
current page. The tree keeps the registry's Settings entries and filters them by the viewer's visible
settings sections. Global action tiles and the existing account actions follow the tree.

`BottomSheet` owns the scrim, Escape handling, focus containment and return, scroll region, and bottom
safe inset. The navigation sheet and `FiltersSheet` share that frame. Filters still update immediately;
the footer offers Done and conditionally Clear. `MobilePillBar` supplies the floating styling and drag
gesture for both its original tabs and the place layout. The legacy `MobileBottomNav` stays unmounted
until the final area-navigation cleanup.

Mobile shell header controls and list/overview tabs have 44px minimum targets. Header rows can wrap
when optional status controls are present.
