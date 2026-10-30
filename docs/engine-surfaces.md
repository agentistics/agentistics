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
it closes the surface (as `ctx.close()` does). Optional fields, validated as `bad-active`:
`activeIcon` (from the closed icon set, which now includes `phone-off`), `activeLabel` (`{ pt, en }`,
the accessible name while active, falling back to `label`) and `activeTone` (`'accent'` by default, or
`'danger'` for the destructive red).

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
| `placement` | `session-header`, `nay-dock` or `app-bar` (global, no session) |
| `label` | `{ pt, en }` text of the generic button |
| `module` | same-origin path under `/api/engine/x/`, ending `.js`/`.mjs` — anything else is refused at load |
| `experimental` | optional environment variable name; the surface is listed only while it is `1` |

`GET /api/engine` returns the surfaces the web may draw (experimental ones filtered by their flag);
a community build returns none. On click the web `import()`s the module and calls
`mount(el, { sessionId, lang, reducedMotion, layout, setLayout, close })` inside a frame the host
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
