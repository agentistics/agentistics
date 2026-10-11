import { describe, expect, it } from 'bun:test'
import { handoffHintText, planHandoffHints, sendHandoffHints } from './handoff-hint'

const row = (extra: Record<string, unknown> = {}) => ({
  id: 'leader-1', title: '[ LEADER ] - engine', contextTokens: 150_000, contextWindow: 400_000, ...extra,
})

describe('LEADER.HANDOFF.HINT', () => {
  it('crosses on tokens or the context fraction', () => {
    expect(planHandoffHints([row()])).toHaveLength(1)
    expect(planHandoffHints([row({ contextTokens: 140_000, contextWindow: 410_000 })])).toHaveLength(0)
    expect(planHandoffHints([row({ contextTokens: 140_000, contextWindow: 300_000 })])).toHaveLength(1)
  })

  it('does not repeat a level and offers the second reminder after 50k', () => {
    expect(planHandoffHints([row({ hintedLevel: 1 })])).toHaveLength(0)
    const next = planHandoffHints([row({ contextTokens: 200_000, hintedLevel: 1 })])
    expect(next[0]?.level).toBe(2)
    expect(planHandoffHints([row({ contextTokens: 200_000, hintedLevel: 2 })])).toHaveLength(0)
  })

  it('never hints a non-leader', () => {
    expect(planHandoffHints([row({ title: 'worker' })])).toHaveLength(0)
    expect(planHandoffHints([row({ title: 'worker', leader: true })])).toHaveLength(1)
  })

  it('delivers once and persists the level', async () => {
    let stored = 0
    const texts: string[] = []
    const deps = {
      rows: async () => [row({ hintedLevel: stored })],
      prompt: async (_id: string, text: string) => { texts.push(text); return { ok: true } },
      hintedLevel: async () => stored,
      markHinted: async (_id: string, level: number) => { stored = level; return true },
    }
    expect(await sendHandoffHints(deps)).toBe(1)
    expect(await sendHandoffHints(deps)).toBe(0)
    expect(texts[0]).toContain('[from agentistics · question]')
    expect(texts[0]).toContain('150k tokens (38% da janela)')
    expect(handoffHintText({ id: 'x', level: 1, tokens: 150_000, fraction: 0.375 })).toContain('handoff:true')
  })
})
