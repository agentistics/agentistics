import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { requestPlanUsageModal, subscribePlanUsageModal } from './planUsageModalRequests'

describe('requestPlanUsageModal', () => {
  test('notifies subscribers until they unsubscribe', () => {
    let n = 0
    const off = subscribePlanUsageModal(() => { n++ })
    requestPlanUsageModal(); expect(n).toBe(1)
    off(); requestPlanUsageModal(); expect(n).toBe(1)
  })
})

describe('every "open limits" entry point asks for the modal, not the Nay tab', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
  for (const f of ['../components/PlanUsageFootButton.tsx', '../pages/SessionsPage.tsx', '../components/nay/NayDock.tsx']) {
    test(f, () => {
      const s = read(f)
      expect(s).toContain('requestPlanUsageModal')
      expect(s).not.toMatch(/requestNayTab\('limits'\)/)
    })
  }
  test('App mounts the modal once, closing on esc/backdrop is in the modal', () => {
    expect(read('../App.tsx')).toContain('<PlanUsageModal')
    const m = read('../components/PlanUsageModal.tsx')
    expect(m).toContain("e.key === 'Escape'")
    expect(m).toContain('onClick={onClose}')
    expect(m).toContain('aria-modal="true"')
  })
})
