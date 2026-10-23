import { expect, test } from 'bun:test'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { handleOwnerPresence, waitingSessions } from './owner-presence-web'

test('waiting episodes use explicit question/approval or needs-you evidence, never ordinary idle', () => {
  const rows = ['waiting-approval', 'waiting', 'working', 'exited', 'lost', 'closed'].map((state, i) => ({ id: String(i), conversationId: `c${i}`, title: `Session ${i}`, state })) as ControlSession[]
  const agendas = Object.fromEntries(rows.slice(1).map(r => [r.conversationId!, { last: { state: 'needs_you' }, lastRunAt: 100 }]))
  expect(waitingSessions(rows, agendas).map(r => r.waiting)).toEqual([true, true, false, false, false, false])
  expect(waitingSessions(rows, {}).map(r => r.waiting)).toEqual([true, false, false, false, false, false])
  expect(waitingSessions(rows, agendas)[1]?.since).toBe(100)
})
test('malformed presence requests are refused before any fleet or preference IO', async () => {
  for (const body of ['not json', '{}', '{"client":"x"}']) {
    const response = await handleOwnerPresence(new Request('http://local/api/fleet/owner-presence', { method: 'POST', body }))
    expect(response.status).toBe(400)
  }
})
