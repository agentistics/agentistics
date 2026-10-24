import { describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computeHandoffWhy, findHandoffFile, handoffHintText, handoffOverheadTokens, handoffTargetTokens, handoffThreshold,
  HANDOFF_HINT_RETRY_MS, hintCandidates, planHandoffHints, sendHandoffHints, successorBase,
} from './handoff-hint'

// The 16/10 numbers: F 100k (no samples → fallback), g ≈ 1.3k/call, a 1M window.
const row = (extra: Record<string, unknown> = {}) => ({
  id: 'leader-1', title: '[ LEADER ] - engine', contextTokens: 250_000, contextWindow: 1_000_000, ...extra,
})

describe('LEADER.HANDOFF.HINT', () => {
  it('HANDOFF.CALC: 153k does not trigger, ~250k does (F 100k, g ≈ 1.3k/call)', () => {
    // g measured: (153k − 60k) / 72 calls ≈ 1.3k.
    expect(planHandoffHints([row({ contextTokens: 153_000, calls: 72 })])).toHaveLength(0)
    expect(planHandoffHints([row({ contextTokens: 250_000, calls: 146 })])).toHaveLength(1)
    // A 200k window would floor at F + 100k = its whole window: capped at 80 % so it still fires.
    expect(handoffThreshold(100_000, 1_300, 153_000, 200_000)).toBe(160_000)
    expect(planHandoffHints([row({ contextTokens: 153_000, contextWindow: 200_000, calls: 72 })])).toHaveLength(0)
    expect(planHandoffHints([row({ contextTokens: 165_000, contextWindow: 200_000, calls: 90 })])).toHaveLength(1)
  })

  it('T* = F + sqrt(2·H·g) with H = cache write of F + ramp + 3 calls at the current size', () => {
    expect(handoffOverheadTokens(100_000, 153_000)).toBe(12.5 * 100_000 + 15 * 100_000 + 3 * 153_000)
    const t = handoffTargetTokens(100_000, 1_300, 153_000)
    expect(t).toBeCloseTo(100_000 + Math.sqrt(2 * 3_209_000 * 1_300), 0)
    expect(t).toBeGreaterThan(190_000)
    expect(t).toBeLessThan(195_000)
    // Never below max(F + 100k, 25 % of the window).
    expect(handoffThreshold(100_000, 1_300, 153_000, 1_000_000)).toBe(250_000)
    expect(handoffThreshold(100_000, 1_300, 153_000)).toBe(200_000)
    expect(handoffThreshold(100_000, 5_000, 153_000)).toBeCloseTo(handoffTargetTokens(100_000, 5_000, 153_000), 6)
  })

  it('F is the median of measured samples, 100k without any', () => {
    expect(successorBase([])).toEqual({ tokens: 100_000, samples: 0 })
    expect(successorBase([90_000, 110_000, 95_000])).toEqual({ tokens: 95_000, samples: 3 })
    expect(successorBase([90_000, 110_000])).toEqual({ tokens: 100_000, samples: 2 })
  })

  it('reminds every +50k after the previous hint, not at an absolute size', () => {
    expect(planHandoffHints([row({ hintedLevel: 1, hintedTokens: 250_000 })])).toHaveLength(0)
    expect(planHandoffHints([row({ contextTokens: 299_000, hintedLevel: 1, hintedTokens: 250_000 })])).toHaveLength(0)
    expect(planHandoffHints([row({ contextTokens: 300_000, hintedLevel: 1, hintedTokens: 250_000 })])[0]?.level).toBe(2)
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
    expect(s.st).toEqual({ level: 1, tokens: 250_000 })
    expect(s.texts[0]).toContain('[from agentistics · question]')
    expect(s.texts[0]).toContain('250k tokens (25% do limite)')
    expect(s.texts[0]).toContain('F ≈ 100k')
    expect(s.texts[0]).toContain('T* = F + √(2·H·g)')
    expect(s.texts[0]).toContain('por resposta')
    expect(handoffHintText({ id: 'x', level: 1, tokens: 150_000, fraction: 0.375 })).toContain('agentop session <harness> --handoff')
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

  it('only while idle and with no unanswered owner message (HANDOFF.RELAY)', async () => {
    expect(planHandoffHints([row({ activity: 'working' })])).toHaveLength(0)
    expect(planHandoffHints([row({ contextTokens: 900_000, activity: 'working' })])).toHaveLength(0)
    expect(planHandoffHints([row({ ownerWaiting: true })])).toHaveLength(0)
    const sent: string[] = []
    let level = 0
    const deps = (waiting: boolean) => ({
      rows: async () => [row()],
      prompt: async (_id: string, text: string) => { sent.push(text); return { ok: true } },
      hinted: async () => ({ level }),
      markHinted: async (_id: string, l: number) => { level = l; return true },
      ownerWaiting: async () => waiting,
    })
    expect(await sendHandoffHints(deps(true))).toBe(0)
    expect(level).toBe(0)
    expect(await sendHandoffHints(deps(false))).toBe(1)
  })

  it('an owner-waiting skip writes nothing, and a skipped or failed row waits out the retry (OPEN-PERF)', async () => {
    let writes = 0
    let level = 0
    let reads = 0
    let clock = 1_000
    const deferUntil = new Map<string, number>()
    const deps = (waiting: boolean, ok = true) => ({
      rows: async () => [row()],
      prompt: async () => ({ ok }),
      hinted: async () => { reads++; return { level } },
      markHinted: async (_id: string, l: number) => { writes++; level = l; return true },
      ownerWaiting: async () => waiting,
      deferUntil,
      now: () => clock,
    })
    // The owner is waiting: nothing is claimed, so nothing has to be put back.
    expect(await sendHandoffHints(deps(true))).toBe(0)
    expect(writes).toBe(0)
    // …and the next fleet build inside the retry window does not even read it again.
    const readsAfterSkip = reads
    clock += HANDOFF_HINT_RETRY_MS - 1
    expect(await sendHandoffHints(deps(false))).toBe(0)
    expect(reads).toBe(readsAfterSkip)
    // Past the window it is tried again; a failed send claims, puts back, and waits again.
    clock += 1
    expect(await sendHandoffHints(deps(false, false))).toBe(0)
    expect(writes).toBe(2)
    expect(level).toBe(0)
    expect(await sendHandoffHints(deps(false))).toBe(0)
    expect(writes).toBe(2)
    clock += HANDOFF_HINT_RETRY_MS
    expect(await sendHandoffHints(deps(false))).toBe(1)
    expect(level).toBe(1)
  })

  it('only a RUNNING session is a hint candidate — a finished leader cannot be prompted (OPEN-PERF)', () => {
    const views = [
      { id: 'live', status: 'running' }, { id: 'gone', status: 'exited' }, { id: 'lost', status: 'lost' },
      { id: 'ext', status: 'external' }, { id: 'closed', status: 'closed' }, { id: 'orphan', status: 'unregistered' },
    ] as const
    expect(hintCandidates(views).map(v => v.id)).toEqual(['live'])
  })

  it('break-even uses F and H, never the hand-off bytes alone', () => {
    const why = computeHandoffWhy({ ...row({ contextTokens: 153_000, calls: 72 }), model: 'claude-sonnet-5', turns: 10 }, {
      handoffPath: '/tmp/handoff.md', handoffBytes: 4_000,
    })
    expect(why.contextTokens).toBe(153_000)
    expect(why.successorBaseTokens).toBe(100_000)
    expect(why.overheadTokens).toBe(3_209_000)
    expect(why.gainPerCallTokens).toBe(53_000)
    expect(why.breakEvenTurns).toBe(Math.ceil(3_209_000 / 53_000))
    expect(why.breakEvenTurns).toBeGreaterThan(1)
    expect(why.successor).toEqual({ handoffPath: '/tmp/handoff.md' })
    expect(computeHandoffWhy({ id: 'x', title: 'x' })).not.toHaveProperty('avgCostPerTurnUSD')
  })

  it('an unpriced model omits the costs instead of showing zero', () => {
    const why = computeHandoffWhy({ ...row(), model: 'zzz-unknown', turns: 10, costUSD: 3 }, { handoffBytes: 4_000 })
    expect(why).not.toHaveProperty('costContinueUSD')
    expect(why).not.toHaveProperty('costSuccessorUSD')
    expect(why).not.toHaveProperty('gainPerCallUSD')
    expect(why.avgCostPerTurnUSD).toBeCloseTo(0.3)
  })

  it('finds the newest fixed handoff candidate, without recursing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'handoff-'))
    await mkdir(join(cwd, 'leader'))
    await mkdir(join(cwd, 'leader', 'deeper'))
    await writeFile(join(cwd, 'leader', 'HANDOFF.md'), 'old')
    await writeFile(join(cwd, 'leader', 'notes-HANDOFF.md'), 'newest')
    await writeFile(join(cwd, 'leader', 'deeper', 'HANDOFF.md'), 'ignored')
    const now = Date.now() / 1000
    await utimes(join(cwd, 'leader', 'HANDOFF.md'), now - 2, now - 2)
    await utimes(join(cwd, 'leader', 'notes-HANDOFF.md'), now, now)
    expect(await findHandoffFile(cwd)).toEqual({ path: join(cwd, 'leader', 'notes-HANDOFF.md'), bytes: 6 })
    expect(await findHandoffFile(await mkdtemp(join(tmpdir(), 'handoff-empty-')))).toBeUndefined()
    expect(await findHandoffFile(undefined)).toBeUndefined()
  })
})

describe("hand-off hint while away", () => {
  it('appends the away sentence when given', () => {
    const t = handoffHintText({ id: 'x', level: 1, tokens: 150_000, fraction: 0.375 }, ' O dono está fora (modo ausente) até avisar que voltou: registre isso no handoff para o sucessor.')
    expect(t).toContain('`. O dono está fora')
  })
  it('sendHandoffHints passes the away note through', async () => {
    const sent: string[] = []
    await sendHandoffHints({
      rows: async () => [{ id: 'L', title: '[ LEADER ] - x', contextTokens: 260_000 }],
      prompt: async (_id, text) => { sent.push(text); return { ok: true } },
      hinted: async () => ({ level: 0 }),
      markHinted: async () => true,
      awayNote: async () => ' AWAY-NOTE',
    })
    expect(sent[0]).toEndWith(' AWAY-NOTE')
  })
})
