import { expect, test } from 'bun:test'
import { emptyToastQueue, enqueueToasts, removeToast, SUMMARY_ID } from './toastQueue'
import type { AppNotification } from './notifications'
const note = (id: number, type: AppNotification['type'] = 'info'): AppNotification => ({ id: String(id), type, title: `News ${id}`, ts: id, read: false })
test('one new notification keeps the normal toast', () => {
  const q = enqueueToasts(emptyToastQueue(), [note(1)], 100, false)
  expect(q.items.map(n => n.id)).toEqual(['1'])
  expect(q.summary).toBeNull()
})
test('20 updates in one response or separate renders become one summary', () => {
  const all = Array.from({ length: 20 }, (_, i) => note(i))
  const batch = enqueueToasts(emptyToastQueue(), all, 100, false)
  const streamed = all.reduce((q, n, i) => enqueueToasts(q, [n], 100 + i * 80, false), emptyToastQueue())
  for (const q of [batch, streamed]) { expect(q.items).toHaveLength(0); expect(q.summary?.ids).toHaveLength(20) }
})
test('overflow outside the burst window reserves one of three slots for summary', () => {
  let q = emptyToastQueue()
  for (let i = 0; i < 4; i++) q = enqueueToasts(q, [note(i)], i * 2100, false)
  expect(q.items).toHaveLength(2)
  expect(q.summary?.ids).toHaveLength(2)
})
test('hidden or away arrivals aggregate, including errors, and count unique news', () => {
  let q = enqueueToasts(emptyToastQueue(), [note(1), note(2, 'error')], 0, true)
  q = enqueueToasts(q, [note(1, 'warning')], 1, true)
  expect(q.items).toHaveLength(0)
  expect(q.summary).toEqual({ ids: ['2', '1'], away: true })
})
test('critical burst retains two error actions plus one summary, never four cards', () => {
  const q = enqueueToasts(emptyToastQueue(), Array.from({ length: 20 }, (_, i) => note(i, i < 5 ? 'error' : 'info')), 0, false)
  expect(q.items.map(n => n.type)).toEqual(['error', 'error'])
  expect(q.summary?.ids).toHaveLength(18)
  expect(removeToast(q, SUMMARY_ID).summary).toBeNull()
  expect(removeToast(q, '0').items.map(n => n.id)).toEqual(['1'])
})
