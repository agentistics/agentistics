import { describe, expect, test } from 'bun:test'
import { activateMobileSessions, MOBILE_AREA_SLOTS, MOBILE_SESSIONS_HOME_EVENT, mobileAreaSlot, scrollMobileSessionsToTop } from './mobileAreaTabs'
import { slotAt } from './bottomNavDrag'

describe('option A destinations', () => {
  test('five equal drag slots map to Agentask, Usage, Sessions, Metrics and More', () => {
    expect(MOBILE_AREA_SLOTS).toEqual(['tasks', 'usage', 'sessions', 'metrics', 'more'])
    const width = 356
    for (let i = 0; i < 5; i++) {
      expect(MOBILE_AREA_SLOTS[slotAt((i + 0.5) * width / 5, width, 5)]).toBe(MOBILE_AREA_SLOTS[i])
    }
  })

  test('subpages select their area; all other destinations select More', () => {
    for (const [pathname, slot] of [
      ['/tasks', 0], ['/tasks/activity', 0], ['/usage/history', 1], ['/sessions/abc', 2],
      ['/leadership/checkins', 2], ['/', 3], ['/costs', 3], ['/tools', 3],
      ['/repositories', 4], ['/vault', 4], ['/settings/preferences', 4], ['/unknown', 4],
    ] as const) expect(mobileAreaSlot(pathname)).toBe(slot)
  })
})

describe('Sessions / Home activation', () => {
  test('on the list, Home scrolls to top without navigating or resetting list state', () => {
    for (const path of ['/sessions', '/sessions/']) {
      const navigated: string[] = []
      let scrolled = 0
      activateMobileSessions(path, to => navigated.push(to), () => { scrolled++ })
      expect(navigated).toEqual([])
      expect(scrolled).toBe(1)
    }
  })

  test('an open session, a leadership page or another area returns to the session list', () => {
    for (const path of ['/sessions/abc', '/sessions/abc/terminal', '/leadership', '/usage', '/sessions-report']) {
      const navigated: string[] = []
      let scrolled = 0
      activateMobileSessions(path, to => navigated.push(to), () => { scrolled++ })
      expect(navigated).toEqual(['/sessions'])
      expect(scrolled).toBe(0)
    }
  })
})

describe('Início on /sessions', () => {
  test('asks the page to leave the fleet-summary tab, so the tap always lands on the list', () => {
    let heard = 0
    const target = new EventTarget()
    const w = globalThis as unknown as { window?: unknown; document?: unknown }
    const oldWindow = w.window, oldDoc = w.document
    w.window = Object.assign(target, { scrollTo: () => {} })
    w.document = { querySelectorAll: () => [] }
    try {
      target.addEventListener(MOBILE_SESSIONS_HOME_EVENT, () => { heard++ })
      activateMobileSessions('/sessions', () => {}, scrollMobileSessionsToTop)
      expect(heard).toBe(1)
    } finally { w.window = oldWindow; w.document = oldDoc }
  })
})
