import { afterEach, beforeAll, afterAll, describe, expect, test } from 'bun:test'
import { __setFleetHostForTest, __setHandoffRawForTest, runFleetAction } from './fleet-web'
import { addSession, removeSession } from './registry'

// Run inside agentop run --rm: the registry is that run's isolated one, never the owner's.
const filed: string[] = []
let savedUpdateCheck: string | undefined
beforeAll(() => { savedUpdateCheck = process.env.AGENTISTICS_NO_UPDATE_CHECK; process.env.AGENTISTICS_NO_UPDATE_CHECK = '1' })
afterAll(() => { if (savedUpdateCheck === undefined) delete process.env.AGENTISTICS_NO_UPDATE_CHECK; else process.env.AGENTISTICS_NO_UPDATE_CHECK = savedUpdateCheck })
afterEach(async () => {
  __setFleetHostForTest('en', null)
  __setFleetHostForTest('pt', null)
  __setHandoffRawForTest(null)
  for (const id of filed.splice(0)) await removeSession(id)
})

/** A leader with (or without) a successor, and a host that records the prompts it was asked to type. */
async function leader(o: { successor?: 'alive' | 'ended'; requested?: boolean }) {
  const tag = crypto.randomUUID().slice(0, 8)
  const id = `ho-${tag}`, succ = `ho-succ-${tag}`
  filed.push(id)
  const now = new Date().toISOString()
  await addSession({ id, harness: 'claude', cwd: process.cwd(), createdAt: now, label: '[ LEADER ] - Motor', leader: true,
    ...(o.requested ? { handoffRequestedAt: now } : {}), ...(o.successor ? { handoffTo: succ } : {}) } as never)
  if (o.successor) {
    filed.push(succ)
    await addSession({ id: succ, harness: 'claude', cwd: process.cwd(), createdAt: now, ...(o.successor === 'ended' ? { endedAt: now } : {}) } as never)
  }
  // The hub's view: both rows alive (a successor that ended is `closed`).
  __setHandoffRawForTest({ sessions: [{ id, status: 'running' }, ...(o.successor ? [{ id: succ, status: o.successor === 'ended' ? 'closed' : 'running' }] : [])] })
  const typed: string[] = []
  const host = { sessions: async () => ({ sessions: [] }), promptSession: async (_id: string, text: string) => { typed.push(text); return { ok: true } } } as never
  return { id, typed, host }
}

const ask = (lang: 'en' | 'pt', id: string, handoff?: true) => runFleetAction(lang, { action: 'prompt', id, text: 'Hand off leadership now', ...(handoff ? { handoff } : {}) } as never)

describe('a second hand-off request while one is alive (F5)', () => {
  for (const lang of ['en', 'pt'] as const) {
    test(`a handoff prompt is refused when the successor is alive, nothing is typed (${lang})`, async () => {
      const t = await leader({ successor: 'alive', requested: true })
      __setFleetHostForTest(lang, t.host)
      const out = await ask(lang, t.id, true)
      expect(out.ok).toBe(false)
      expect(out.message).toContain(lang === 'pt' ? 'passagem' : 'hand-off')
      expect(t.typed).toEqual([])
    })
  }

  test('asking again while the successor is NOT open yet (preparing) is allowed', async () => {
    const t = await leader({ requested: true })
    __setFleetHostForTest('en', t.host)
    expect((await ask('en', t.id, true)).ok).toBe(true)
    expect(t.typed.length).toBe(1)
  })

  test('a successor that already ended no longer blocks a new request', async () => {
    const t = await leader({ successor: 'ended', requested: true })
    __setFleetHostForTest('en', t.host)
    expect((await ask('en', t.id, true)).ok).toBe(true)
  })

  test('an ordinary prompt (no handoff flag) to a leader with a live successor is untouched', async () => {
    const t = await leader({ successor: 'alive', requested: true })
    __setFleetHostForTest('en', t.host)
    expect((await ask('en', t.id)).ok).toBe(true)
    expect(t.typed.length).toBe(1)
  })
})
