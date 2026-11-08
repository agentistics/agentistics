import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeliveryStore } from '../delivery/store'
import { QUESTION_PROMOTE_MS, holdOwnerQuestion, questionsTick, resolveQuestion, type QuestionTurn } from './owner-questions'

const AT = '2026-11-08T01:40:00.000Z'
const t0 = Date.parse(AT)
const later = (ms: number) => new Date(t0 + ms).toISOString()

describe('resolveQuestion (pure)', () => {
  const q = { text: 'quando sai as coisas?', at: AT }
  test("the leader's reply after the question's own turn answers it", () => {
    const turns: QuestionTurn[] = [
      { role: 'user', text: 'quando sai as coisas?', at: later(2_000) },
      { role: 'assistant', text: '', at: later(3_000) }, // a tool-only step is not an answer
      { role: 'assistant', text: 'Sai na 2.203.0 hoje à noite, depois do QA.', at: later(60_000) },
    ]
    expect(resolveQuestion(q, turns, t0 + 120_000)).toEqual({ kind: 'answered', at: later(60_000), note: 'Sai na 2.203.0 hoje à noite, depois do QA.' })
  })
  test('no reply yet waits; unanswered past 30 min is promoted to a request', () => {
    const turns: QuestionTurn[] = [{ role: 'user', text: 'quando sai as coisas?', at: later(2_000) }]
    expect(resolveQuestion(q, turns, t0 + 60_000).kind).toBe('wait')
    expect(resolveQuestion(q, turns, t0 + QUESTION_PROMOTE_MS).kind).toBe('promote')
    expect(resolveQuestion(q, null, t0 + 60_000).kind).toBe('wait')
  })
  test('an older identical question (before this one was asked) does not count as its turn', () => {
    const turns: QuestionTurn[] = [
      { role: 'user', text: 'quando sai as coisas?', at: later(-3600_000) },
      { role: 'assistant', text: 'old answer', at: later(-3500_000) },
    ]
    expect(resolveQuestion(q, turns, t0 + 60_000).kind).toBe('wait')
  })
  test('a question typed in as a paste (wrapper prefix) is still found', () => {
    const turns: QuestionTurn[] = [{ role: 'user', text: '<pasted_content id="x">\nquando sai as coisas?', at: later(1_000) }, { role: 'assistant', text: 'hoje', at: later(9_000) }]
    expect(resolveQuestion(q, turns, t0 + 10_000).kind).toBe('answered')
  })
})

describe('questionsTick', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oq-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const base = { sessionId: 'lead', conversationId: 'conv-l', taskId: 't1', text: 'quando sai as coisas?', at: AT, channel: 'app' }

  test('answered: recorded with the reply, never promoted (no pedido, no piece, no reminder)', async () => {
    const store = createDeliveryStore(join(dir, 'd.json'))
    await holdOwnerQuestion(store, { ...base, id: 'q1' })
    await holdOwnerQuestion(store, { ...base, id: 'q1' }) // idempotent
    const promoted: string[] = []
    let now = t0 + 30_000
    const turns: QuestionTurn[] = [{ role: 'user', text: base.text, at: later(1_000) }]
    const deps = { store, now: () => now, turns: async () => turns, promote: async (q: { id: string }) => { promoted.push(q.id); return true } }
    expect(await questionsTick(deps)).toEqual([])
    turns.push({ role: 'assistant', text: 'Hoje às 20h.', at: later(20_000) })
    expect(await questionsTick(deps)).toEqual(['question-answered q1'])
    now = t0 + 2 * QUESTION_PROMOTE_MS
    expect(await questionsTick(deps)).toEqual([])
    expect(promoted).toEqual([])
    const q = (await store.read()).ownerQuestions!.q1!
    expect(q).toMatchObject({ state: 'answered', answer: { note: 'Hoje às 20h.' } })
  })

  test('unanswered after 30 min: promoted once to an ordinary request', async () => {
    const store = createDeliveryStore(join(dir, 'd.json'))
    await holdOwnerQuestion(store, { ...base, id: 'q2' })
    const promoted: string[] = []
    let now = t0 + QUESTION_PROMOTE_MS
    const deps = { store, now: () => now, turns: async () => [] as QuestionTurn[], promote: async (q: { id: string }) => { promoted.push(q.id); return true } }
    expect(await questionsTick(deps)).toEqual(['question-promoted q2'])
    now += 60_000
    expect(await questionsTick(deps)).toEqual([])
    expect(promoted).toEqual(['q2'])
    expect((await store.read()).ownerQuestions!.q2!.state).toBe('promoted')
  })

  test('resolved questions are dropped after a week', async () => {
    const store = createDeliveryStore(join(dir, 'd.json'))
    await holdOwnerQuestion(store, { ...base, id: 'q3' })
    await store.update(d => { d.ownerQuestions!.q3!.state = 'answered'; d.ownerQuestions!.q3!.answer = { at: AT, note: 'x' } })
    await questionsTick({ store, now: () => t0 + 8 * 24 * 3600_000, turns: async () => null, promote: async () => true })
    expect((await store.read()).ownerQuestions ?? {}).toEqual({})
  })
})
