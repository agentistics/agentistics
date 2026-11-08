import { describe, expect, test } from 'bun:test'
import { harnessHasAccounts, judgePredispatch, judgeVaga, stagedAccount, topTierFull, type SessionFact, type SubtaskFact } from './gates'
import { checkTopTier, topTierMessage, topTierRefusal } from '../sessions/top-tier-gate'
import { hasEffortConcept } from '../sessions/live-runtime'

const sub = (staged: SubtaskFact['staged']): SubtaskFact => ({ id: 's', taskId: 't', title: 's', status: 'todo', groupMember: false, blockedBy: [], staged })
const worker = (harness: string, model: string, alive = true, role = 'worker'): SessionFact => ({ id: `${harness}-${model}-${Math.random()}`, harness, model, role, alive, cwd: '/r', worktree: true })

describe('FLUXO.AVISOS 4 — pre-dispatch asks only for what the harness uses', () => {
  test('a harness with an effort concept and accounts still needs both', () => {
    expect(hasEffortConcept('claude')).toBe(true)
    expect(harnessHasAccounts('claude')).toBe(true)
    const v = judgePredispatch(sub({ prompt: 'p', harness: 'claude', model: 'claude-opus-5-5' }))
    expect(v.ok).toBe(false)
    expect(v.missing).toEqual(['effort', 'account'])
  })
  test('a harness with no accounts is complete without one, and its account reads default', () => {
    expect(harnessHasAccounts('antigravity')).toBe(false)
    expect(stagedAccount({ harness: 'antigravity' })).toBe('default')
    expect(stagedAccount({ harness: 'claude' })).toBeUndefined()
    expect(stagedAccount({ harness: 'claude', account: ' acc_1 ' })).toBe('acc_1')
    const staged = { prompt: 'p', harness: 'antigravity', model: 'gemini-3.6-flash', effort: 'high' }
    expect(judgePredispatch(sub(staged)).ok).toBe(true)
  })
  test('a harness with no effort concept is complete without an effort', () => {
    const noEffort = ['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi', 'opencode'].find(h => !hasEffortConcept(h))
    if (!noEffort) return // every harness in this build declares one: nothing to relax
    const v = judgePredispatch(sub({ prompt: 'p', harness: noEffort, model: 'm', account: 'default' }))
    expect(v.missing ?? []).not.toContain('effort')
  })
  test('with no harness yet, the harness itself is missing — and the old complete set is still required', () => {
    const v = judgePredispatch(sub({ prompt: 'p' }))
    expect(v.missing).toEqual(['harness', 'model', 'effort', 'account'])
  })
  test('the slot gate reads the implied default account of a harness that has none', () => {
    const o = { sessions: [], memoryBytes: 8 * 1024 ** 3, topCap: 2 }
    const staged = sub({ prompt: 'p', harness: 'antigravity', model: 'gemini-3.6-flash' })
    const ok = judgeVaga(staged, { ...o, budgets: [{ harness: 'antigravity', account: 'default', fiveHourPct: 10, weekPct: 10, stale: false }] })
    expect(ok.ok).toBe(true)
    expect(ok.evidence?.account).toBe('default')
    const nobudget = judgeVaga(staged, { ...o, budgets: [] })
    expect(nobudget.ok).toBe(false)
    expect(nobudget.reason).toContain('antigravity:default')
  })
})

describe('FLUXO.AVISOS 5 — the top-tier cap binds every door', () => {
  const fleet = [worker('claude', 'claude-opus-5-5'), worker('claude', 'claude-opus-5-5'), worker('claude', 'claude-sonnet-5-5'), worker('claude', 'claude-opus-5-5', false), worker('claude', 'claude-opus-5-5', true, 'leader')]
  test('the shared rule: running top-tier WORKERS plus the new ones against the cap', () => {
    expect(topTierFull('claude', 'claude-opus-5-5', fleet, 2)).toEqual({ running: 2, cap: 2 })
    expect(topTierFull('claude', 'claude-opus-5-5', fleet, 3)).toBeNull()
    expect(topTierFull('claude', 'claude-opus-5-5', fleet, 3, 2)).toEqual({ running: 2, cap: 3 })
    expect(topTierFull('claude', 'claude-sonnet-5-5', fleet, 0)).toBeNull() // not top tier
    expect(topTierFull('codex', 'gpt-6.1-sol', fleet, 0)).toBeNull() // other provider has none running
  })
  test('the slot gate and the CLI gate agree', () => {
    const staged = sub({ prompt: 'p', harness: 'claude', model: 'claude-opus-5-5', effort: 'high', account: 'a' })
    const o = { sessions: fleet, budgets: [{ harness: 'claude', account: 'a', fiveHourPct: 10, weekPct: 10, stale: false }], memoryBytes: 8 * 1024 ** 3 }
    expect(judgeVaga(staged, { ...o, topCap: 2 }).ok).toBe(false)
    expect(judgeVaga(staged, { ...o, topCap: 3 }).ok).toBe(true)
  })
  test('a batch is judged together; a leader and a non-top model are never refused', () => {
    const cap = () => 3
    const r = (n: number, role?: string) => Array.from({ length: n }, () => ({ harness: 'claude', model: 'claude-opus-5-5', role }))
    expect(topTierRefusal(r(1), fleet, cap)).toBeNull()
    expect(topTierRefusal(r(2), fleet, cap)).toMatchObject({ harness: 'claude', running: 2, cap: 3, adding: 2 })
    expect(topTierRefusal(r(5, 'leader'), fleet, cap)).toBeNull()
    expect(topTierRefusal([{ harness: 'claude', model: 'claude-sonnet-5-5' }], fleet, () => 0)).toBeNull()
    expect(topTierRefusal([{ harness: 'claude' }], fleet, () => 0)).toBeNull() // model unknown: nothing to judge
  })
  test('checkTopTier refuses with a sentence, --force overrides it out loud, an unreadable fleet never blocks', async () => {
    const facts = { sessions: async () => fleet, topCap: async () => 2 }
    const errors: string[] = []
    const real = console.error
    console.error = (...a: unknown[]) => { errors.push(a.join(' ')) }
    try {
      const req = [{ harness: 'claude', model: 'claude-opus-5-5' }]
      expect(await checkTopTier(req, false, 'en', false, facts)).toBe(true)
      expect(errors[0]).toContain('top-tier worker cap is full (2 running, cap 2')
      expect(errors[0]).toContain('--force')
      errors.length = 0
      expect(await checkTopTier(req, true, 'en', false, facts)).toBe(false)
      expect(errors[0]).toContain('--force: the claude top-tier cap was overridden')
      expect(await checkTopTier(req, false, 'en', false, { sessions: async () => { throw new Error('fleet unreadable') }, topCap: async () => 2 })).toBe(false)
      expect(await checkTopTier([{ harness: 'claude', model: 'claude-sonnet-5-5' }], false, 'en', false, facts)).toBe(false)
    } finally { console.error = real }
    expect(topTierMessage({ harness: 'claude', model: 'm', running: 2, cap: 2, adding: 1 }, 'pt')).toContain('teto')
  })
})
