import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// No jsdom here: the wiring BillingSettings must keep is asserted over its source (the repo's pattern).
const src = readFileSync(new URL('./BillingSettings.tsx', import.meta.url), 'utf8')

describe('BillingSettings wiring (L1)', () => {
  test('a needPlan target is saved through saveTracked', () => {
    expect(src).toContain('target !== null && needPlan.some(a => a.id === target)')
    expect(src).toMatch(/tracked \? await saveTracked\(target, change\)/)
  })
  test('the drawer closes only on a stored save', () => {
    expect(src).toContain('saveThenClose(() => persist(')
  })
  test('the save error is placed once and stale failed notices are pruned', () => {
    expect(src).toContain("saveErrorPlace(saveError, noticeState, draft !== null)")
    expect(src).toContain("errPlace === 'drawer'")
    expect(src).toContain("errPlace === 'page'")
    expect(src).toContain('billingNotices.prune(')
  })
  test('failed notices are pruned only after the account list really loaded (never on the empty first render)', () => {
    expect(src).toContain('if (accountsLoaded) billingNotices.prune(')
    expect(src).toContain('if (b) setAccountsLoaded(true)')
  })
})
