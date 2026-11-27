import { expect, test } from 'bun:test'
import type { SessionMeta } from '@agentistics/core'
import { repairDailyMessages } from './daily-messages-repair'

const day = (messages: number, input = 7) => ({
  input_tokens: input, output_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, messages, hours: { 10: messages },
})
const meta = (user: number, asst: number, daily?: SessionMeta['daily']) =>
  ({ session_id: 's', user_message_count: user, assistant_message_count: asst, daily } as unknown as SessionMeta)

test('an old record (days sum above lifetime) is apportioned to exactly the lifetime total', () => {
  const s = meta(3, 7, { '2026-11-03': day(9), '2026-11-01': day(3), '2026-11-02': day(3) })
  const r = repairDailyMessages(s)
  const sum = Object.values(r.daily!).reduce((a, d) => a + d.messages, 0)
  expect(sum).toBe(10)
  expect(r.daily!['2026-11-01']!.messages).toBe(2)
  expect(r.daily!['2026-11-02']!.messages).toBe(2)
  expect(r.daily!['2026-11-03']!.messages).toBe(6)
  // tokens and hours are measurements per line and are left alone
  expect(r.daily!['2026-11-03']!.input_tokens).toBe(7)
  expect(r.daily!['2026-11-03']!.hours).toEqual({ 10: 9 })
  // the stored object is not mutated
  expect(s.daily!['2026-11-03']!.messages).toBe(9)
})

test('a record already written by the fixed parser (sum <= lifetime) is returned untouched', () => {
  const s = meta(2, 3, { '2026-11-01': day(2), '2026-11-02': day(3) })
  expect(repairDailyMessages(s)).toBe(s)
  const short = meta(2, 3, { '2026-11-01': day(4) })
  expect(repairDailyMessages(short)).toBe(short)
  const none = meta(2, 3)
  expect(repairDailyMessages(none)).toBe(none)
})

test('the repair is idempotent', () => {
  const once = repairDailyMessages(meta(1, 4, { a: day(11), b: day(5), c: day(1) }))
  expect(repairDailyMessages(once)).toBe(once)
  expect(Object.values(once.daily!).reduce((a, d) => a + d.messages, 0)).toBe(5)
})
