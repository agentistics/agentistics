import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { requestUsagePage, subscribeUsagePage } from './usagePageRequests'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

describe('requestUsagePage', () => {
  test('notifies subscribers until they unsubscribe', () => {
    let n = 0
    const off = subscribeUsagePage(() => { n++ })
    requestUsagePage(); expect(n).toBe(1)
    off(); requestUsagePage(); expect(n).toBe(1)
  })
})

describe('the "Plan usage" modal is gone and every entry point goes to the Uso page', () => {
  test('the modal and its session switch no longer exist', () => {
    expect(existsSync(new URL('../components/PlanUsageModal.tsx', import.meta.url))).toBe(false)
    expect(existsSync(new URL('../components/PlanUsageSessionSwitch.tsx', import.meta.url))).toBe(false)
    expect(read('../App.tsx')).not.toContain('PlanUsageModal')
  })
  for (const f of ['../components/PlanUsageFootButton.tsx', '../pages/SessionsPage.tsx', '../components/nay/NayDock.tsx']) {
    test(f, () => { expect(read(f)).toContain('requestUsagePage') })
  }
  test('App navigates to /usage when asked', () => {
    const app = read('../App.tsx')
    expect(app).toContain('subscribeUsagePage')
    expect(app).toMatch(/subscribeUsagePage\(\(\) => navigate\('\/usage'\)\)/)
  })
})
