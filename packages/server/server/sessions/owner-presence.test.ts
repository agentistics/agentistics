import { describe, expect, test } from 'bun:test'
import { createOwnerPresence, PRESENCE_TTL_MS, validPresenceReport, WAIT_NOTICE_MS } from './owner-presence'
const rows = [{ id: 'a', conversationId: 'ca', title: 'A', waiting: false }, { id: 'b', title: 'B', waiting: true }]
const report = { client: 'tab', session: 'ca', visible: true, focused: true, interacted: true }
describe('owner presence without model calls', () => {
  test('canonical session, focus, hidden tabs, expiry and last interaction', () => {
    const p = createOwnerPresence()
    expect(p.report(report, rows, 100).presence).toMatchObject({ session: 'a', lastInteractionAt: 100 })
    expect(p.report({ ...report, interacted: false }, rows, 200).presence?.lastInteractionAt).toBe(100)
    expect(p.current(201 + PRESENCE_TTL_MS)).toBeUndefined()
    expect(p.report({ ...report, focused: false }, rows, 300).presence).toBeUndefined()
    expect(p.report({ ...report, visible: false }, rows, 400).presence).toBeUndefined()
    expect(p.report({ ...report, session: 'unknown' }, rows, 500).presence).toBeUndefined()
  })
  test('wait notice only after five minutes, once per episode, clears on open', () => {
    const p = createOwnerPresence()
    expect(p.report(report, rows, 0).notices).toEqual([])
    expect(p.report(report, rows, WAIT_NOTICE_MS - 1).notices).toEqual([])
    expect(p.report(report, rows, WAIT_NOTICE_MS).notices).toEqual([{ id: 'b:0', session: 'b', title: 'B' }])
    expect(p.report({ ...report, shown: ['b:0'] }, rows, WAIT_NOTICE_MS + 1).notices).toEqual([])
    expect(p.report({ ...report, session: 'b' }, rows, WAIT_NOTICE_MS + 2).cleared).toContain('b:0')
    expect(p.report(report, rows, WAIT_NOTICE_MS * 2).notices).toEqual([])
    p.report(report, rows.map(r => ({ ...r, waiting: false })), WAIT_NOTICE_MS * 2)
    p.report(report, rows, WAIT_NOTICE_MS * 3)
    expect(p.report(report, rows, WAIT_NOTICE_MS * 4).notices).toHaveLength(1)
  })
  test('opening before the deadline acknowledges that whole episode', () => {
    const p = createOwnerPresence()
    p.report({ ...report, session: 'b' }, rows, 0)
    expect(p.report(report, rows, WAIT_NOTICE_MS).notices).toEqual([])
  })
  test('hidden owner and another tab cannot consume a notice', () => {
    const p = createOwnerPresence()
    p.report(report, rows, 0)
    expect(p.report({ ...report, visible: false }, rows, WAIT_NOTICE_MS).notices).toEqual([])
    p.report(report, rows, WAIT_NOTICE_MS + 1)
    expect(p.report({ ...report, client: 'background', focused: false }, rows, WAIT_NOTICE_MS + 2).notices).toEqual([])
  })
  test('rejects malformed reports', () => {
    expect(validPresenceReport(report)).toBe(true)
    for (const r of [null, {}, { ...report, client: '' }, { ...report, visible: 'true' }, { ...report, session: 1 }]) expect(validPresenceReport(r)).toBe(false)
  })
})

test('opening elsewhere clears a notice when its original browser becomes active again', () => {
  const p = createOwnerPresence()
  p.report(report, rows, 0)
  expect(p.report(report, rows, WAIT_NOTICE_MS).notices).toHaveLength(1)
  p.report({ ...report, client: 'other', session: 'b' }, rows, WAIT_NOTICE_MS + 1)
  expect(p.report(report, rows, WAIT_NOTICE_MS + 2).cleared).toContain('b:0')
})

test('a notice is re-offered until the client acknowledges it as shown', () => {
  const p = createOwnerPresence()
  p.report(report, rows, 0)
  expect(p.report(report, rows, WAIT_NOTICE_MS).notices).toHaveLength(1)
  expect(p.report(report, rows, WAIT_NOTICE_MS + 1).notices).toHaveLength(1)
  expect(p.report({ ...report, shown: ['b:0'] }, rows, WAIT_NOTICE_MS + 2).notices).toEqual([])
  expect(p.report(report, rows, WAIT_NOTICE_MS + 3).notices).toEqual([])
})
test('lang and shown are validated', () => {
  expect(validPresenceReport({ ...report, lang: 'en', shown: ['x'] })).toBe(true)
  expect(validPresenceReport({ ...report, lang: 'fr' })).toBe(false)
  expect(validPresenceReport({ ...report, shown: [1] })).toBe(false)
})
