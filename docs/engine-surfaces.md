# Engine surfaces, sockets and assets (engine-api 1.15, 1.17)

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

`host.structuredSessions.get(id)` gives a surface a handle on the session it was opened from. It
returns `null` for every other id — unknown and somebody else's are indistinguishable — except a session
this engine started itself; there is no way to list sessions through it. The host decides which session a
surface belongs to from the WebSocket handshake it accepted for a declared, live session, never from the
engine's word alone.

The handle has three verbs and no others:

- `follow(max, on)` — the session's chat seam (a `window` of turns, then deltas);
- `send(text)` — adds a turn typed with an `[from agentistics · surface]` header, so the conversation
  never shows it as something the owner wrote. Refused while a request is open or on a session that is
  not structured;
- `cancel()` — cancels the turn in flight and nothing else.

A handle is invalidated when the surface unmounts (its sockets close) or the session ends, and a dead
handle stays dead; a surface mounted later gets a new one through `get`. A community build has no engine,
so none of this exists there.

## Versioning

Contract 1.17 (minor): `structuredSessions` is optional on the host; an engine that needs it refuses to
load on an older host. It follows 1.16 (flows).


Contract 1.15 (minor): everything above is optional. A 1.14 engine still loads; a 1.15 engine on an
older host is refused at load (unreserved prefix) and the host runs as a community build.
