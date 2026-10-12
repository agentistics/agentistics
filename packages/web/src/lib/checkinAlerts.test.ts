import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

const mem = new Map<string, string>()
const original = (globalThis as { localStorage?: unknown }).localStorage
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v) },
  removeItem: (k: string) => { mem.delete(k) }, clear: () => mem.clear(), key: () => null, length: 0,
}

const { onCheckinState } = await import('./checkinAlerts')
const { readNayAlerts, resetNayNotifyStore } = await import('./nayNotifyStore')

const state = (needs: { subject: string; text: string; critical?: boolean }[]) => ({
  intervalMin: 30 as const, paused: null, checklist: [], session: 'conv-leader', lastRunAt: 1, nextRunAt: 2,
  last: { state: 'needs_you' as const, summary: 's', needs },
})
// Noon: outside the default quiet hours, so every new subject rings.
const noon = new Date(2026, 9, 12, 12, 0, 0).getTime()

describe('check-in alerts on the Nay card', () => {
  beforeEach(() => { mem.clear(); resetNayNotifyStore() })
  // Other suites in the same process read `localStorage`'s absence: put it back as it was.
  afterAll(() => { mem.clear(); resetNayNotifyStore(); (globalThis as { localStorage?: unknown }).localStorage = original })

  test('a newer round keeps the unread items of the card it replaces', () => {
    onCheckinState(state([{ subject: 'disk', text: 'Disco a 97%', critical: true }]) as never, noon)
    onCheckinState(state([{ subject: 'pr', text: 'PR pronto' }]) as never, noon + 60_000)
    const cards = readNayAlerts().filter(a => a.kind === 'checkin')
    expect(cards).toHaveLength(1)
    expect(cards[0]!.checkin!.items.map(i => i.subject).sort()).toEqual(['disk', 'pr'])
  })
})
