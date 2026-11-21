# The built-in browser

agentistics can give a session a browser to drive, show you what it is doing, and let you take the
wheel. It can also give you a browser of your own in the right-hand bar. Both are a Chromium started by
`agentop server` on the machine that runs it — nothing here is a service in the cloud.

Code: `packages/server/server/browser/` (host, CDP, screencast, padlock, routes), the tools in
`packages/mcp/browser-tools.ts`, the screens in `packages/web/src/components/browser/`, and the settings
in `packages/web/src/pages/settings/BrowserSettings.tsx` (pure sentences in `lib/browserSettings.ts`).

## Two kinds of browser

| | Session browser | Your own browser |
|---|---|---|
| Who drives | The model, through the `agentistics_browser_*` tools | You |
| Where you see it | A card in the session's chat (watch live, or full screen) | The browser panel in the right-hand bar |
| Padlock | Yes — locked by default | None — it is always yours |
| Tabs | up to 4 | up to 8 |
| Closes when | 10 min with no browser action and nobody watching, or the session ends | 20 min with nobody watching and no interaction |

The model's tools reach **only the browser of its own session** — the MCP proves which session is
calling, and your own browser is not a target of any tool. A session cannot open, read or unlock it.

## The padlock

A session's browser starts **locked**: the model drives, you watch. Unlock it to use the page yourself
(sign in, solve a CAPTCHA, type a password); the model's actions are then **held**, never run on a page
that changed under it. When you lock it again the model gets a normal result saying you used the browser
and that the page may have changed, so it takes a fresh snapshot before acting. If the hold runs out first
it is told you are still using it and can wait with `agentistics_browser_wait_unlock`.

- Only you can change the padlock. A request that carries a session's identity is refused, and unlocking
  needs your vault proof — a session that drops its environment still cannot unlock itself.
- What you type while unlocked goes straight to the page. It is never logged.

## Screen, floating and full screen

The card in the chat shows the page live **only while someone is looking** (card visible, tab visible).
Nobody looking means no frames and no CPU spent encoding. The card can float over the conversation or
go full screen; a card scrolled out of view shows the last frame, marked as paused.

## Limits

All numbers live in `browser-spec.ts` as named constants; **Settings → Browser** shows the live use.

- At most **3 browsers alive**: 2 for sessions + 1 of your own. A new one starts only with at least
  1.5 GB of memory available; when the cap is full, a session browser that is idle for over 2 minutes
  with nobody watching is closed to make room, otherwise the tool says to try again in a few minutes.
- Memory is watched every 10 s as **PSS** (RSS over-counts pages shared between tabs). Above **900 MB**
  a browser closes its oldest inactive tab; above **1.2 GB** it is stopped and the model/panel is told why.
  Without a readable `smaps_rollup` the watcher falls back to RSS with limits ×1.6 and says so.
  Where `systemd-run --user --scope` exists the browser is also started under `MemoryMax=1200M` with
  `MemorySwapMax=0`.
- The browser blocks `file:`, `chrome:`, `devtools:` and similar schemes, the agentistics ports and
  the debugging port, including through redirects and DNS answers.
- Chromium is never started at server boot — only on the first tool call or the first click on the
  browser icon — and is always stopped by its **saved PID**, never by name.

## Executable

The server uses, in order: `AGENTISTICS_BROWSER_BIN`; the Playwright headless shell in
`~/.cache/ms-playwright`; `chromium`/`chromium-browser` on the PATH; Chrome. Only the **binary** of Chrome
is used — with our own `--user-data-dir`, never your Chrome profile. Settings → Browser says which one
was found and how. With none found it says so in a sentence.

## Profiles

Each browser gets a throwaway profile folder under `~/.agentistics/browser/` (`sessions/<id>/`,
`personal/`), mode `0700`, deleted when the browser ends and swept at server boot when no live process
holds it. They are never backed up (`backup-plan.ts`, `runtime`). Your own browser remembers its **tab list**
(URLs and titles, `personal-tabs.json`) but never cookies: reopening the panel re-creates the tabs signed out.

**Settings → Browser → Delete profiles** removes every profile folder now (cookies and cache of browsers
already closed). It asks first, and is **refused while any browser is live** (the server answers 409
`browser_live`; the button is disabled with the reason). A session cannot call it, and the process-tree check
is only a hint (a same-user agent can escape it with `systemd-run --user`): the request must also carry the
owner's **single-use vault grant** (`X-Agentop-Owner-Grant`, class `browser-profiles`, minted by
`POST /api/vault/browser-profiles` after the same fresh Windows Hello / Touch ID / password proof as the padlock
unlock; ≤ 5 min, this page's session, loopback only). Without one the answer is 403 and nothing is deleted.

## Turning it off

**Settings → Browser** has the switch (`preferences.browserEnabled`). It is **on unless turned off** and can
only narrow the exposure profile (`capabilities.localShell`; `lan`/`public` keep it off). The server enforces
it before any route: with the switch off every `/api/browser/*` answers 403 `browser_disabled`.

## Per-harness support

The tools are the agentistics MCP, registered per harness like the other tools; a tool call is held at most
as long as the harness's own tool timeout allows, so the padlock hold is shortened per harness.

| Harness | Browser tools |
|---|---|
| Claude Code, Codex, Gemini CLI, Copilot CLI, Kimi, OpenCode | Yes, through the agentistics MCP |
| Antigravity | Registered, but it has a **browser of its own**; if the model uses that one it does not appear here |
| Hermes | Not yet — Hermes does not receive the agentistics browser tools |
| agentistics (native runtime) | Wired by the engine; not part of this document |

Claude in Chrome, the Claude app's built-in browser and computer-use are recognised (the card knows a
navigation happened) but are never streamed or unlocked by agentistics.
