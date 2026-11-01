# Engine surfaces, sockets and assets (engine-api 1.15, 1.17, 1.18)

In 1.18 a surface may use the shared `composer` placement. The host renders it as a generic icon
button beside the microphone; the required bilingual `label` remains its accessible name and tooltip.
The `icon` is one of `phone`, `phone-off`, `sparkles` or `panel`, mapped by the host. A `composer` surface MUST declare an `icon` (the button is icon-only); without one it is refused with `bad-icon`. An engine built against
1.18 is refused by an older host (the minor must not exceed the host's), so it never needs the older
placements as a fallback.

Also in 1.18, a surface declaration may carry two more optional fields, validated by `surfaceRefusals`
(`bad-layout`, `bad-frameless`):

- `layout?: 'full' | 'side' | 'inline'` is the layout the surface opens in (default `full`). `inline`
  is valid only for the `composer` placement: the host mounts the surface directly ABOVE the session
  composer, inside the session view, while the conversation and the composer (text and attachments)
  stay usable. The module context's `layout` reports it, and `setLayout('full' | 'side' | 'inline')`
  moves a live surface between the three. The host re-parents the same element, so the module is not
  remounted and keeps its DOM state. `setLayout('inline')` from a non-`composer` surface is ignored, and
  if the session view is not on screen an `inline` surface is drawn as `side` until it returns.
- `frameless?: boolean`: when `true` the host draws no padding, title bar or close button around the
  surface in `full` and `side`. The surface draws its own chrome and ends itself with `ctx.close()`
  (always present in the mount context; Esc still closes a `full` surface).

For the `composer` placement, while the surface is open (any layout) the host's button shows an active
state, in the same spot and size as the idle one: the label switches to `activeLabel`, the background is
filled, and clicking
it ENDS the surface when it declared `activeLabel`/`activeIcon`: its `onIndicatorEnd` handler runs (it ends
itself with `ctx.close()`), or, with none, the host removes it, indicator included. Without an active face
a click just takes it off screen (parked if kept alive). While a composer surface with an `activeLabel` is
mounted for a session, that session's composer hides the dictate button. A kept-alive composer surface that
left its session (floated, or parked by another surface) returns to the composer when the session view
returns. A floating surface opens card-sized (about 360×480), and the Nay button lists minimized surfaces
(resume / end / "Open Nay chat") instead of opening the chat straight away. Optional fields, validated as `bad-active`:
`activeIcon` (from the closed icon set, which now includes `phone-off`), `activeLabel` (`{ pt, en }`,
the accessible name while active, falling back to `label`) and `activeTone` (`'accent'` by default, or
`'danger'` for the destructive red).

### The `rail` placement and the `page` layout (1.18)

A `rail` surface is an entry in the app's navigation, beside the pages: an icon-only link (the `icon`
is REQUIRED, refused with `bad-icon` otherwise; the `label` is its accessible name and tooltip). It is
drawn in the desktop area rail and the area tree, and on a phone in the "More" sheet, like the other
pages. Opening it navigates to the surface's own route, `/x/<id>`, where the host mounts the surface
AS A PAGE in the main area, with no frame, padding, title bar or close button (`layout: 'page'`). The
entry is marked as the current page while the route is on screen.

`page` is valid only for `rail`, and `rail` accepts no other layout: `layout: 'page'` elsewhere, or any
other layout on a `rail` surface, is refused with `bad-layout`; `setLayout` ignores both. Leaving the
route ends the surface (it is unmounted), unless it is kept alive (below). An unknown id on the route
says the page is not available; a page whose surface ended itself (`ctx.close()`) offers to open it
again.

### Staying mounted off screen: `ctx.keepAlive` (1.18)

`ctx.keepAlive(true)` changes what taking the surface off screen means. Leaving its `rail` page, the
close button, Esc on a `full` frame and the active `composer` button no longer unmount it: the host
moves the SAME element, still mounted (no `unmount`, no second `mount`), into an off-screen holder in
the document, so media, sockets, timers and DOM state carry on. Its entry brings it back (navigating to
its route, or clicking its composer button, which stays active meanwhile), and so does the indicator
below; it comes back in the layout it had. `ctx.close()` always ends it. `ctx.keepAlive(false)` returns
to the normal behaviour, and while the surface is off screen it unmounts it at once.

While it is off screen its composer button shows the idle face again (label, icon, no fill; marked
`data-parked`), because a click then brings it back rather than taking it away. Coming back moves focus
as the first mount did (into the frame, a `full` one being modal; onto the surface inline or on its
page), and `ctx.layout` keeps reporting the layout it had while parked. If the engine stops announcing
the surface (the announcement is re-read when the engine's capabilities change), it ends, parked or
not, and its indicator goes away.

Limitations: the off-screen holder has the viewport's size, out of sight, so a surface that measures
itself does not see a 1px box, but it is not laid out where it was. Moving the element in and out of
the holder detaches it from the document for an instant inside one synchronous commit: media elements,
sockets and timers carry on, but an `<iframe>` inside the surface RELOADS on every move (browsers reload
a frame whose element is re-inserted), so a kept-alive surface should not depend on iframe state.

Only one surface is ON SCREEN at a time. Opening another takes the visible one away: a kept-alive one
is parked, any other is ended. Each surface's context is bound to that surface, so a parked one never
moves the one on screen.

### The top-bar indicator: `ctx.setIndicator` (1.18)

`ctx.setIndicator(ind | null)` shows (or removes) a pill in the app's top bar, on every screen, for as
long as the surface is mounted (on screen or parked); unmounting removes it.

```ts
interface SurfaceIndicator {
  label: { pt: string; en: string }       // 1–40 characters each
  since?: number                          // epoch ms: the pill shows a live mm:ss elapsed timer
  tone?: 'accent' | 'danger'              // default accent
  icon?: SurfaceIcon                      // the same closed set
  endLabel?: { pt: string; en: string }   // 1–40 characters each: a secondary button
}
```

The pure `surfaceIndicatorRefusals(ind)` judges it (`bad-indicator`, `bad-label`, `bad-since`,
`bad-tone`, `bad-icon`, `bad-end-label`); a refused indicator makes `setIndicator` throw an Error naming
the reasons and leaves the previous one in place. Clicking the pill brings the surface back: a `rail`
page by navigating to its route, a session surface (`composer`, `session-header`, …) by opening the
session that owns it, in the layout it had. With `endLabel` the pill carries a secondary button that
calls the callback registered with `ctx.onIndicatorEnd(fn)` (which returns a function that removes it).
On a phone the pill is compact (icon and timer; the label stays its accessible name), sits in the top
bar, and never covers the bottom navigation. In the mobile Sessions workspace, indicators reserve a
wrapping row below its own header, so they cannot overlap the session title. The row disappears when
no mounted surface has an indicator.

### Opening a session: `ctx.openSession` (1.18, optional)

`ctx.openSession?.(sessionId)` navigates the app to `/sessions/<id>` with the app's own router (the same
navigation the indicator pill uses), without reloading the page, and returns `true`. It returns `false`,
doing nothing, when the id is not a short string (1 to 128 characters, no `/`, `\`, `?`, `#`, whitespace
or control characters) or the app cannot navigate. It is only navigation: a surface kept alive and parked
stays mounted. The member is optional, so call it as `ctx.openSession?.(id)` and treat `undefined` as
"not supported". The host does not check that the session exists; the app shows its usual not-found state.

### What kind of conversation: `ctx.sessionKind` (1.18, optional)

`ctx.sessionKind` is `'nay'` when `ctx.sessionId` names the app's own assistant conversation (which is not
a fleet row, so asking the fleet about it answers not-found) and `'session'` for any other session. The
host sets it where it opens a surface from a session's composer; it is absent elsewhere (no session) or on
a host that does not know, so read it as `ctx.sessionKind === 'nay'` and treat anything else as unknown.

A host older than 1.18 refuses an engine built against 1.18 outright (the minor must not exceed the host's),
so none of these fields ever reaches it and there is no partial fallback; an engine that must also run
there ships a 1.17 surface instead.

An engine can serve its own routes, accept WebSockets and announce UI surfaces under one reserved
prefix, `/api/engine/x`. Nothing here is specific to any one feature: it is the generic door. A
community build (no engine) has no prefix, no button and no socket — the paths answer `404
engine-absent`.

## The prefix

`/api/engine/x` is in `RESERVED_PREFIXES` and in the host's capability table as `localShell`, so it
is reached only after the capability guard, the auth gate and the Host allowlist, like every other
reserved prefix. An engine route must declare exactly that capability or it is refused at load.

## WebSockets

A route may implement `upgrade(req, url, ctx) => EngineSocketHandlers | null`. The host calls it
only for a handshake that passed the guard, auth, Host and `wsInputOriginOk` (the same origin check
the session write socket uses); a bad origin never reaches the engine. The host owns:

- the **frame cap** (`ENGINE_SOCKET_LIMITS.maxFrameBytes`, 64 KiB; the engine may only ask for less) —
  a larger frame closes the socket with 1009;
- the **connection limits** (16 per route prefix, 4 per declared session) — beyond them the
  handshake answers `503 too_many_streams`;
- the **closing**: a connection that declares a `sessionId` is refused if that session does not
  exist and is closed (code 4001) when it ends; every socket is closed (1001) when the engine is
  disposed.

## Assets

The route serves its own static files. The host stamps the Content-Type of `.js`/`.mjs`/`.css`/
`.json`/images/fonts (with `nosniff`) and refuses `.wasm`: the page's CSP has no
`wasm-unsafe-eval`, and the CSP is not changed (no `unsafe-*`, no `blob:`, `frame-ancestors`
untouched).

## Surfaces

`manifest.surfaces` announces buttons the host draws:

| field | meaning |
|---|---|
| `id` | `[a-z][a-z0-9-]{0,39}`, unique |
| `placement` | `session-header`, `nay-dock`, `app-bar` (global, no session), `composer` or `rail` (1.18) |
| `label` | `{ pt, en }` text of the generic button |
| `module` | same-origin path under `/api/engine/x/`, ending `.js`/`.mjs` — anything else is refused at load |
| `experimental` | optional environment variable name; the surface is listed only while it is `1` |

`GET /api/engine` returns the surfaces the web may draw (experimental ones filtered by their flag);
a community build returns none. On click the web `import()`s the module and calls
`mount(el, { sessionId, lang, reducedMotion, layout, setLayout, close, keepAlive, setIndicator, onIndicatorEnd })` inside a frame the host
owns, at the app root: it keeps focus, closes on Esc while `full`, and has a close button. The surface
may flip the frame between `full` (modal) and `side` (docked panel) with `ctx.setLayout()` without
being unmounted, and it stays mounted while the person navigates; `unmount(el)` runs on every exit.

## Acting on the session (engine-api 1.17)

A surface reaches the session it was opened from through its own socket: `socket.structured()` returns a
handle on the session the handshake declared (the host accepted that socket only for a session that existed
and was live), bound to THAT socket. An id the engine supplies never selects the session, and the handle
exists only on a machine that serves `/api/engine/x` at all — a `localShell` route, refused on a central and
on any exposed profile.

`host.structuredSessions.get(id)` is the other door and it is narrower still: it resolves only a session this
engine started itself (`fleet.delegateSpawn`) and answers `null` for every other id, indistinguishably;
nothing here can enumerate sessions.

The handle has three verbs and no others, and every one is total (it never throws):

- `follow(max, on)` — the session's chat seam (a `window` of turns, then deltas);
- `send(text)` — adds a turn typed with an `[from agentistics · surface]` header, so the conversation
  never shows it as something the owner wrote. Refused for empty text, for text over 64 KiB, while a
  request is open, and on a session that is not structured;
- `cancel()` — cancels the turn in flight and nothing else.

A handle dies when its socket closes (another surface on the same session does not keep it alive) or the
session ends; it then releases its subscriptions and stays dead. A surface mounted later gets a new one,
so code that outlives a socket (a surface that reconnects) asks the current socket each time.
`live` reflects the socket and what the handle has seen; it learns of a session's end on the next use or
when the host closes the socket.

## Versioning

Contract 1.17 (minor): `structuredSessions` is optional on the host; an engine that needs it refuses to
load on an older host. It follows 1.16 (flows).


Contract 1.15 (minor): everything above is optional. A 1.14 engine still loads; a 1.15 engine on an
older host is refused at load (unreserved prefix) and the host runs as a community build.

## Floating windows and Nay sessions sections (engine-api 1.19)

`layout: 'float'` uses the same draggable, resizable window as detached sessions. Minimize keeps the
same mounted element running off screen and adds a live badge to the Nay button; clicking the button
restores the window. Closing follows `keepAlive`; `ctx.close()` always ends the surface.

A kept-alive `inline` or `side` surface automatically becomes `float` when its session leaves the
screen. It does not open an aside on the next screen. Set `floatOnLeave: false` to retain the previous
fallback behavior. Full-screen and rail-page surfaces keep their existing behavior.

`placement: 'nay-sessions'` adds a section labelled with the surface's localized `label` INSIDE the
Nay panel's Sessions tab, alongside Active, Groups and Ended in the existing segmented control. It
does not add a top-level Nay panel tab. Selecting the section loads the module there. Switching
sections or closing the panel keeps the mounted surface off screen. All new placements and layouts obey the existing manifest `experimental` flag:
when disabled, no tab, button, window or module request appears.

Turns submitted through the structured surface handle show the person's text as a user bubble with a
microphone chip. The transport header and any leading bracketed instruction paragraphs are removed
from the display. Peer reports continue to use the system-event renderer.
