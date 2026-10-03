/**
 * engine-delegate.test.ts — the host's delegation members (engine-api 1.7, B6.2): consent is the
 * host's and DENIES by default; a start is filed or stopped; the handback is the last assistant turn.
 */
import { describe, expect, test } from 'bun:test'
import { createDelegateMembers, type DelegateDeps } from './engine-delegate'

function deps(over: Partial<DelegateDeps> = {}): DelegateDeps & { log: string[] } {
  const log: string[] = []
  return {
    log,
    startable: async () => ['claude', 'codex', 'gemini'],
    allowed: async () => ['claude', 'codex'],
    spawn: async b => { log.push(`spawn:${b.harness}:${b.model}`); return { ok: true, message: 'started', id: 'm-1' } },
    file: async (t, s, st) => { log.push(`file:${t}:${s}:${st ?? ''}`); return { ok: true } },
    kill: async id => { log.push(`kill:${id}`) },
    chat: async () => ({ turns: [{ role: 'user', text: 'do it' }, { role: 'assistant', text: 'first' }, { role: 'assistant', text: 'HANDBACK: done' }], live: false }),
    ...over,
  }
}
const req = { harness: 'claude' as const, cwd: '/w', prompt: 'brief', model: 'claude-sonnet-5-5', label: 'worker', requestedBy: 'native:ses_1' }

describe('delegation members', () => {
  test('the harnesses offered are installed AND allowed', async () => {
    expect(await createDelegateMembers(deps()).delegateHarnesses()).toEqual(['claude', 'codex'])
    expect(await createDelegateMembers(deps({ allowed: async () => [] })).delegateHarnesses()).toEqual([])
  })

  test('R2: a harness the person did not allow is refused before anything starts (default deny)', async () => {
    const d = deps({ allowed: async () => [] })
    const r = await createDelegateMembers(d).delegateSpawn(req)
    expect(r).toMatchObject({ ok: false, code: 'not_allowed' })
    expect(!r.ok && r.sentence).toContain('Delegation')
    expect(d.log).toEqual([])
  })

  test('allowed but not installed: unavailable', async () => {
    const r = await createDelegateMembers(deps()).delegateSpawn({ ...req, harness: 'codex' as const, model: 'm' })
    expect(r.ok).toBe(true)
    const r2 = await createDelegateMembers(deps({ startable: async () => ['codex'] })).delegateSpawn(req)
    expect(r2).toMatchObject({ ok: false, code: 'unavailable' })
  })

  test('R1: started and filed on the subtask; a failed filing stops the session and fails the start', async () => {
    const d = deps()
    expect(await createDelegateMembers(d).delegateSpawn({ ...req, taskId: 't-1', subtaskId: 's-1' })).toEqual({ ok: true, managedId: 'm-1' })
    expect(d.log).toEqual(['spawn:claude:claude-sonnet-5-5', 'file:t-1:m-1:s-1'])
    const bad = deps({ file: async () => ({ ok: false, reason: 'blocked' }) })
    const r = await createDelegateMembers(bad).delegateSpawn({ ...req, taskId: 't-1' })
    expect(r).toMatchObject({ ok: false, code: 'filing_failed' })
    expect(bad.log).toEqual(['spawn:claude:claude-sonnet-5-5', 'kill:m-1'])
  })

  test('the fleet\'s own refusals pass through (memory budget named)', async () => {
    const r = await createDelegateMembers(deps({ spawn: async () => ({ ok: false, message: 'Not enough memory.', code: 'memory_budget' }) })).delegateSpawn(req)
    expect(r).toEqual({ ok: false, code: 'memory_budget', sentence: 'Not enough memory.' })
  })

  test('the handback is the latest assistant turn; an unreadable chat is a reason', async () => {
    expect(await createDelegateMembers(deps()).lastReply('m-1')).toEqual({ ok: true, text: 'HANDBACK: done', live: false })
    expect(await createDelegateMembers(deps({ chat: async () => { throw new Error('x') } })).lastReply('m-1')).toEqual({ ok: false, reason: 'unreadable' })
  })
})
