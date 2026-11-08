/**
 * QA 2.202.0 (independent, live) — MED finding, documented as `test.failing` so the hook stays green.
 *
 * LIVE.ATALHO says: inside /sessions/<id> the top-bar group's Live row opens a LivePreview over the session,
 * a popover on desktop and a BOTTOM SHEET on a phone. On desktop it works. On a phone it cannot be reached:
 * the open-session bar is title-only (MOBILE.SESSION), `TopBarGroup` is rendered only in the LIST header
 * (`magnifierButton`, SessionsPage.tsx ~2252, used at ~3139), and the session drawer's `extra` rows
 * (~3090-3115) offer no Live entry. Measured in Chromium and WebKit at 390: `[data-topbar-group]` rendered=0
 * inside /sessions/<id>. So `LivePreview`'s phone branch is unreachable from a session.
 *
 * When the phone gets a way in (a Live row in the session drawer, or the group in the open-session bar),
 * this starts passing and must be flipped to `test`.
 */
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dir, 'SessionsPage.tsx'), 'utf8')

test.failing('phone: an open session offers the Live preview (group button in its bar or a Live row in its drawer)', () => {
  const groups = src.match(/<TopBarGroup\b/g)?.length ?? 0
  const drawerOffersLive = /LivePreview/.test(src)
  expect(groups >= 2 || drawerOffersLive).toBe(true)
})
