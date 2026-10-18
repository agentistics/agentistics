import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('./BillingSettings.tsx', import.meta.url), 'utf8')

describe('BillingSettings wiring', () => {
  test('one list and one editor: the old blocks are gone', () => {
    expect(src).toContain('<BillingAccountList')
    for (const gone of ['AccountsSection', 'BillingAccountsView', 'FirstDetectionNotice', 'Troquei de plano']) expect(src).not.toContain(gone)
    expect((src.match(/<Drawer\b/g) ?? []).length).toBe(1)
  })
  test('a row writes the timeline it prices on', () => {
    expect(src).toContain('withScopePeriods(cur, scope, next)')
  })
  test('an account that still needs a plan is tracked until its write is stored', () => {
    expect(src).toContain("billingNotices.mark(tracked, 'saving')")
    expect(src).toContain('if (accountsLoaded) billingNotices.prune(')
    expect(src).toContain('if (b) setAccountsLoaded(true)')
  })
  test('the drawer closes only on a stored save, and the error is placed once', () => {
    expect(src).toContain('saveThenClose(() => writePeriods(')
    expect(src).toContain('saveErrorPlace(saveError, noticeState, draft !== null)')
  })
  test('dates use the app calendar (dd/mm/aaaa), not the browser-locale native input', () => {
    expect(src).toContain('<DatePicker')
    expect(src).not.toContain('type="date"')
  })
})
