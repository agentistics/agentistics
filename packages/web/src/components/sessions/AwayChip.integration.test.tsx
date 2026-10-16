import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { AWAY_OFF } from '@agentistics/core'
import { AwayChip, AwayDialogHost, awayMenuItems, currentAwayDialog, __resetAwayDialogForTest } from './AwayChip'
import { __setAwayForTest } from '../../lib/awayMode'

const count = (html: string, needle: string) => html.split(needle).length - 1
const g = globalThis as { window?: unknown }
const win = { innerWidth: 390, matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) }
beforeEach(() => { g.window = win })
afterEach(() => { delete g.window })
afterEach(() => { __setAwayForTest(null); __resetAwayDialogForTest() })

/** Everything the real screens mount at once for one session: top-bar chip, dedicated-terminal chip, mobile chip, ONE host. */
const screens = () => renderToStaticMarkup(<>
  <AwayChip id="s1" away pt={false} /><AwayChip id="s1" away pt={false} compact /><AwayChip id="s1" away pt={false} compact />
  <AwayDialogHost />
</>)

describe('away dialog — selecting the real ⋯ menu item', () => {
  test.each([false, true])('opens exactly ONE dialog with header + dedicated terminal + mobile mounted (pt=%s)', pt => {
    const [item] = awayMenuItems({ id: 's1', actionable: true, away: true }, pt, false)
    expect(renderToStaticMarkup(<AwayDialogHost />)).toBe('')
    item!.onSelect() // what SessionActions' row click calls
    expect(currentAwayDialog()?.id).toBe('s1')
    const html = screens()
    expect(count(html, 'role="dialog"')).toBe(1)
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-labelledby=')
  })
  test('the override moon shows wherever the chip is mounted (mobile header included)', () => {
    expect(count(screens(), 'session-away-chip')).toBe(3)
  })
  test('away undefined inherits: no moon, and the menu item reads OFF', () => {
    for (const global of [false, true]) {
      __setAwayForTest({ ...AWAY_OFF, on: global })
      expect(renderToStaticMarkup(<AwayChip id="s1" pt={false} />)).not.toContain('session-away-chip')
    }
    const [item] = awayMenuItems({ id: 's1', actionable: true }, false, false)
    expect(item!.on).toBe(false)
    item!.onSelect()
    expect(currentAwayDialog()?.away).toBe(false)
  })
})

describe('wiring', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
  test('the host is mounted once in App; the mobile conversation header carries the chip and the menu', () => {
    expect(count(read('../../App.tsx'), '<AwayDialogHost />')).toBe(1)
    const sp = read('../../pages/SessionsPage.tsx')
    expect(sp).not.toContain('<AwayDialogHost')
    expect(count(sp, '<AwayChip ')).toBeGreaterThanOrEqual(2)
    expect(sp).toContain('...awayMenuItems(selected, pt, awayGlobal.active)')
  })
  test('ConfirmModal is a real dialog', () => {
    const p = read('../../pages/settings/primitives.tsx')
    expect(p).toContain('role="dialog"'); expect(p).toContain('aria-modal="true"'); expect(p).toContain("e.key !== 'Tab'")
  })
})
