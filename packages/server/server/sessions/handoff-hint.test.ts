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

  it('reminds every +50k after the previous hint, not at an absolute size', () => {
    expect(planHandoffHints([row({ hintedLevel: 1, hintedTokens: 150_000 })])).toHaveLength(0)
    expect(planHandoffHints([row({ contextTokens: 199_000, hintedLevel: 1, hintedTokens: 150_000 })])).toHaveLength(0)
    expect(planHandoffHints([row({ contextTokens: 200_000, hintedLevel: 1, hintedTokens: 150_000 })])[0]?.level).toBe(2)
    // Triggered by the 35% rule well below 150k: level 2 is +50k from THAT crossing.
    const low = { contextTokens: 120_000, contextWindow: 300_000 }
    expect(planHandoffHints([row({ ...low, hintedLevel: 1, hintedTokens: 120_000 })])).toHaveLength(0)
    expect(planHandoffHints([row({ ...low, contextTokens: 170_000, hintedLevel: 1, hintedTokens: 120_000 })])[0]?.level).toBe(2)
    // And it keeps reminding.
    expect(planHandoffHints([row({ contextTokens: 300_000, hintedLevel: 2, hintedTokens: 250_000 })])[0]?.level).toBe(3)
    expect(planHandoffHints([row({ contextTokens: 299_000, hintedLevel: 2, hintedTokens: 250_000 })])).toHaveLength(0)
  })

  it('never hints a non-leader', () => {
    expect(planHandoffHints([row({ title: 'worker' })])).toHaveLength(0)
    expect(planHandoffHints([row({ title: 'worker', leader: true })])).toHaveLength(1)
  })

  const store = () => {
    const st = { level: 0, tokens: undefined as number | undefined }
    const texts: string[] = []
    return {
      st, texts,
      deps: (ok = true, delay = 0) => ({
        rows: async () => [row()],
        prompt: async (_id: string, text: string) => { if (delay) await new Promise(r => setTimeout(r, delay)); texts.push(text); return { ok } },
        hinted: async () => ({ level: st.level, ...(st.tokens !== undefined ? { tokens: st.tokens } : {}) }),
        markHinted: async (_id: string, level: number, tokens: number | undefined) => { st.level = level; st.tokens = tokens; return true },
      }),
    }
  }

  it('delivers once and persists level and size', async () => {
    const s = store()
    expect(await sendHandoffHints(s.deps())).toBe(1)
    expect(await sendHandoffHints(s.deps())).toBe(0)
    expect(s.st).toEqual({ level: 1, tokens: 150_000 })
    expect(s.texts[0]).toContain('[from agentistics · question]')
    expect(s.texts[0]).toContain('150k tokens (38% da janela)')
    expect(handoffHintText({ id: 'x', level: 1, tokens: 150_000, fraction: 0.375 })).toContain('handoff:true')
  })

  it('concurrent runs deliver one level once, and a failed send is retried', async () => {
    const s = store()
    const counts = await Promise.all([sendHandoffHints(s.deps(true, 20)), sendHandoffHints(s.deps(true, 20))])
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1)
    expect(s.texts).toHaveLength(1)
    const f = store()
    expect(await sendHandoffHints(f.deps(false))).toBe(0)
    expect(f.st.level).toBe(0)
    expect(await sendHandoffHints(f.deps(true))).toBe(1)
  })

  it('a row the caller already knows needs no hint is not read fresh (PERF.IDLE)', async () => {
    let reads = 0
    const deps = {
      rows: async () => [
        { id: 'worker', title: 'worker', contextTokens: 900_000, contextWindow: 1_000_000 },
        { id: 'lead', title: '[ LEADER ] x', contextTokens: 10_000, contextWindow: 1_000_000 },
        { id: 'done', title: '[ LEADER ] y', contextTokens: 160_000, contextWindow: 1_000_000, hintedLevel: 1, hintedTokens: 150_000 },
      ],
      prompt: async () => ({ ok: true }),
      hinted: async () => { reads++; return { level: 0 } },
      markHinted: async () => true,
    }
    expect(await sendHandoffHints(deps)).toBe(0)
    expect(reads).toBe(0)
  })
})

describe("hand-off hint while away", () => {
  it('appends the away sentence when given', () => {
    const t = handoffHintText({ id: 'x', level: 1, tokens: 150_000, fraction: 0.375 }, ' O dono está fora (modo ausente) até avisar que voltou: registre isso no handoff para o sucessor.')
    expect(t).toContain('handoff:true). O dono está fora')
  })
  it('sendHandoffHints passes the away note through', async () => {
    const sent: string[] = []
    await sendHandoffHints({
      rows: async () => [{ id: 'L', title: '[ LEADER ] - x', contextTokens: 160_000 }],
      prompt: async (_id, text) => { sent.push(text); return { ok: true } },
      hinted: async () => ({ level: 0 }),
      markHinted: async () => true,
      awayNote: async () => ' AWAY-NOTE',
    })
    expect(sent[0]).toEndWith(' AWAY-NOTE')
  })
})
