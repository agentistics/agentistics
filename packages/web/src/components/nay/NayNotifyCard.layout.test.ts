/**
 * The Nay notification card's LAYOUT contract (owner bug 2026-10-02: a long title + a 2-line message
 * made the card scroll as a whole — header clipped away, the countdown bar drawn across the buttons).
 *
 * The component has no DOM test harness in this repo, so the rule is held over its source, the way
 * `zLayers.test.ts` holds the z-index table: the card itself must never be the scroller; one inner
 * region scrolls; header and actions are `flexShrink: 0`; and the countdown bar lives in the
 * non-scrolling shell. Re-verified against a real browser in the fix's before/after screenshots.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dir, 'NayNotifyCard.tsx'), 'utf8')
const between = (a: string, b: string) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)))

test('the card is a flex column and is NOT the scroll container (the max-height the follow loop sets must not scroll it)', () => {
  const card = between("position: 'fixed', zIndex: NAY_NOTIFY_CARD_Z", 'showTail &&')
  expect(card).toContain("display: 'flex', flexDirection: 'column'")
  expect(card).not.toMatch(/overflowY|overflow:/)
})

test('a non-scrolling shell clips to the rounded edge, and the countdown bar is INSIDE it (pinned, never scrolled)', () => {
  const shell = src.indexOf('data-nay-shell')
  const bar = src.indexOf("height: 3, overflow: 'hidden'")
  const body = src.indexOf('data-nay-body')
  expect(shell).toBeGreaterThan(0)
  expect(bar).toBeGreaterThan(shell)
  expect(bar).toBeLessThan(body)
  expect(src.slice(shell, shell + 400)).toContain("overflow: 'hidden'")
  expect(src.slice(shell, shell + 400)).not.toContain('overflowY')
})

test('only the message body (and the drawer) scroll; header and actions never shrink away', () => {
  expect(src.match(/overflowY: 'auto'/g)).toHaveLength(2) // body + drawer, nothing else
  expect(between('data-nay-body', 'data-say')).toContain("overflowY: 'auto'")
  expect(src.slice(src.indexOf('data-nay-actions'), src.indexOf('data-nay-actions') + 140)).toContain('flexShrink: 0')
  expect(src.slice(src.indexOf("data-rise style={{ display: 'flex', alignItems: 'center', gap: 8"), src.indexOf('minimalistLogo'))).toContain('flexShrink: 0')
})

test('the tail stays OUTSIDE the clipping shell (it sits past the card edge)', () => {
  expect(src.indexOf('showTail &&')).toBeLessThan(src.indexOf('data-nay-shell'))
})
