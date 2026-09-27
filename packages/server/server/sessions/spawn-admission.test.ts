import { describe, it, expect } from 'bun:test'
import { memoryBudget, ASSUMED_SESSION_BYTES, type MemorySample } from './memory-budget'
import {
  admitSpawn, admissionMessage, admissionOverrideNote, admissionRefusal, admissionRefusalBody,
  admissionUnmeasuredNote, type SpawnBudget,
} from './spawn-admission'

const GB = 1024 * 1024 * 1024
const MB = 1024 * 1024

/**
 * Every budget here is a REAL `memoryBudget(...)` output built from a `MemorySample`, never a
 * hand-rolled `MemoryBudget` — so these tests pin the composition of the two modules, and a change
 * to the budget arithmetic that moves an admission decision fails here too.
 */
function measure(sample: MemorySample, sessions: number, perSession: number): SpawnBudget {
  return { sample, budget: memoryBudget({ sample, sessionBytes: sessions * perSession, sessions }) }
}
const noSwap = { total: 16 * GB, swapTotal: 4 * GB, swapUsed: 0 }

// room = available + running - 2 GB reserved; max = floor(room / cost); left = max - running.
/** 2 running at 250 MB, room 1750 MB -> max 7, left 5. */
const FIVE_LEFT = measure({ ...noSwap, available: 3298 * MB }, 2, 250 * MB)
/** 2 running at 250 MB, room 1250 MB -> max 5, left 3. */
const THREE_LEFT = measure({ ...noSwap, available: 2798 * MB }, 2, 250 * MB)
/** 4 running at 500 MB, room 52 MB -> computed max 0, floored to the 4 running, left 0. */
const OVERCOMMITTED = measure({ ...noSwap, available: 100 * MB }, 4, 500 * MB)
/** Plenty of RAM (left 32) while swap is 97.5% full — the freeze this feature exists for. */
const SWAPPING = measure({ total: 16 * GB, available: 10 * GB, swapTotal: 4 * GB, swapUsed: 3.9 * GB }, 0, 0)
/** Nothing running: the cost is the assumed fallback. room 8 GB / 250 MB -> 32. */
const EMPTY = measure({ ...noSwap, available: 10 * GB }, 0, 0)

describe('the fixtures are what the table claims', () => {
  it('pins the budgets they are built from', () => {
    expect([FIVE_LEFT.budget.max, FIVE_LEFT.budget.left]).toEqual([7, 5])
    expect([THREE_LEFT.budget.max, THREE_LEFT.budget.left]).toEqual([5, 3])
    expect([OVERCOMMITTED.budget.used, OVERCOMMITTED.budget.max, OVERCOMMITTED.budget.left]).toEqual([4, 4, 0])
    expect(SWAPPING.budget.alarm).toBe('swap')
    expect(SWAPPING.budget.left).toBeGreaterThan(0)
    expect(EMPTY.budget.cost).toEqual({ bytes: ASSUMED_SESSION_BYTES, basis: 'assumed' })
  })
})

describe('admitSpawn — the table', () => {
  const cases: Array<{
    name: string
    input: SpawnBudget | null
    requested: number
    force?: boolean
    expect: { admit: boolean; unmeasured?: boolean; overridden?: boolean; reason?: 'swap' | 'no-room'; fits?: number }
  }> = [
    { name: 'unmeasured machine admits, flagged', input: null, requested: 1, expect: { admit: true, unmeasured: true, overridden: false } },
    { name: 'unmeasured + force is still just unmeasured', input: null, requested: 9, force: true, expect: { admit: true, unmeasured: true, overridden: false } },
    { name: 'room: 1 asked, 5 left', input: FIVE_LEFT, requested: 1, expect: { admit: true, unmeasured: false, overridden: false, fits: 5 } },
    { name: 'exact fit: 5 asked, 5 left', input: FIVE_LEFT, requested: 5, expect: { admit: true, unmeasured: false, overridden: false, fits: 5 } },
    { name: 'no room: 6 asked, 5 left', input: FIVE_LEFT, requested: 6, expect: { admit: false, reason: 'no-room', fits: 5 } },
    { name: 'batch of 5 with 3 left is refused whole, fits 3', input: THREE_LEFT, requested: 5, expect: { admit: false, reason: 'no-room', fits: 3 } },
    { name: 'over-committed machine refuses even one, fits 0', input: OVERCOMMITTED, requested: 1, expect: { admit: false, reason: 'no-room', fits: 0 } },
    { name: 'swap alarm refuses though RAM has room', input: SWAPPING, requested: 1, expect: { admit: false, reason: 'swap', fits: 0 } },
    { name: 'swap alarm + force admits, overridden', input: SWAPPING, requested: 1, force: true, expect: { admit: true, unmeasured: false, overridden: true, reason: 'swap', fits: 0 } },
    { name: 'no room + force admits, overridden', input: THREE_LEFT, requested: 5, force: true, expect: { admit: true, unmeasured: false, overridden: true, reason: 'no-room', fits: 3 } },
    { name: 'force on a machine with room changes nothing', input: FIVE_LEFT, requested: 1, force: true, expect: { admit: true, unmeasured: false, overridden: false, fits: 5 } },
  ]

  for (const c of cases) {
    it(c.name, () => {
      const a = admitSpawn(c.input, c.requested, { force: c.force })
      expect(a.admit).toBe(c.expect.admit)
      expect(a.requested).toBe(c.requested)
      if (a.admit) {
        expect(a.unmeasured).toBe(c.expect.unmeasured!)
        expect(a.overridden).toBe(c.expect.overridden!)
      }
      const r = admissionRefusal(a)
      if (c.expect.reason) {
        expect(r).not.toBeNull()
        expect(r!.reason).toBe(c.expect.reason)
        expect(r!.fits).toBe(c.expect.fits!)
        expect(r!.requested).toBe(c.requested)
      } else {
        expect(r).toBeNull()
        if (a.admit && !a.unmeasured && !a.overridden) expect(a.fits).toBe(c.expect.fits!)
      }
    })
  }

  it('a refusal carries the raw figures a sentence must name', () => {
    const a = admitSpawn(SWAPPING, 1)
    expect(a.admit).toBe(false)
    const r = admissionRefusal(a)!
    expect(r).toEqual({
      reason: 'swap', requested: 1, fits: 0,
      availableBytes: 10 * GB, swapUsedBytes: 3.9 * GB, swapTotalBytes: 4 * GB,
      costBytes: ASSUMED_SESSION_BYTES, costBasis: 'assumed', used: 0, max: 32,
    })
    // JSON-safe: survives a round trip unchanged.
    expect(JSON.parse(JSON.stringify(r))).toEqual(r)
  })

  it('carries the measured cost basis when sessions are running', () => {
    const r = admissionRefusal(admitSpawn(THREE_LEFT, 5))!
    expect(r.costBasis).toBe('measured')
    expect(r.costBytes).toBe(250 * MB)
  })

  it('carries the assumed cost basis when nothing runs', () => {
    const tight = measure({ ...noSwap, available: 2048 * MB + 500 * MB }, 0, 0)   // room 500 MB -> 2
    const r = admissionRefusal(admitSpawn(tight, 3))!
    expect(r.costBasis).toBe('assumed')
    expect(r.fits).toBe(2)
  })

  it('refuses a request that is not a positive integer, loudly', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => admitSpawn(FIVE_LEFT, bad)).toThrow(RangeError)
      expect(() => admitSpawn(null, bad)).toThrow(RangeError)
    }
  })
})

describe('rendering', () => {
  it('no-room names RAM, swap, the cost and how many fit — en', () => {
    const msg = admissionMessage(admissionRefusal(admitSpawn(THREE_LEFT, 5))!, 'en')
    expect(msg).toContain('5 sessions')
    expect(msg).toContain('only 3 fit')
    expect(msg).toContain('2.7 GB of RAM available')
    expect(msg).toContain('0.0 GB / 4.0 GB')
    expect(msg).toContain('250 MB (measured over the 2 running)')
    expect(msg).toContain('at most 3')
    expect(msg).toContain('--force')
  })

  it('no-room — pt, with a decimal comma', () => {
    const msg = admissionMessage(admissionRefusal(admitSpawn(THREE_LEFT, 5))!, 'pt')
    expect(msg).toContain('5 sessões')
    expect(msg).toContain('só cabem 3')
    expect(msg).toContain('2,7 GB de RAM')
    expect(msg).toContain('0,0 GB / 4,0 GB')
    expect(msg).toContain('250 MB (medido sobre 2 em execução)')
    expect(msg).toContain('--force')
  })

  it('swap names the swap percentage and says RAM looked fine — en and pt', () => {
    const r = admissionRefusal(admitSpawn(SWAPPING, 1))!
    const en = admissionMessage(r, 'en')
    expect(en).toContain('98% full')
    expect(en).toContain('3.9 GB / 4.0 GB')
    expect(en).toContain('10.0 GB of RAM available')
    expect(en).toContain('assumed')
    expect(en).toContain('Wait for swap to drain')
    const pt = admissionMessage(r, 'pt')
    expect(pt).toContain('98% cheio')
    expect(pt).toContain('3,9 GB / 4,0 GB')
    expect(pt).toContain('estimado')
    expect(pt).toContain('Espere o swap esvaziar')
  })

  it('a single session on an over-committed machine says none fit', () => {
    const r = admissionRefusal(admitSpawn(OVERCOMMITTED, 1))!
    expect(admissionMessage(r, 'en')).toContain('another session: none fit')
    expect(admissionMessage(r, 'pt')).toContain('mais uma sessão: não cabe nenhuma')
  })

  it('an override says it overrode, and only then', () => {
    const forced = admitSpawn(SWAPPING, 1, { force: true })
    expect(admissionOverrideNote(forced, 'en')).toStartWith('Started anyway, overriding the memory check:')
    expect(admissionOverrideNote(forced, 'pt')).toStartWith('Iniciada mesmo assim')
    expect(admissionOverrideNote(admitSpawn(FIVE_LEFT, 1), 'en')).toBeNull()
    expect(admissionOverrideNote(admitSpawn(null, 1), 'en')).toBeNull()
    expect(admissionOverrideNote(admitSpawn(THREE_LEFT, 5), 'en')).toBeNull()   // refused, not overridden
  })

  it('the unmeasured note says the check did not run', () => {
    expect(admissionUnmeasuredNote('en')).toContain('could not be checked')
    expect(admissionUnmeasuredNote('pt')).toContain('não pôde ser verificada')
  })

  it('the 409 body carries the code, the numbers and the sentence', () => {
    const r = admissionRefusal(admitSpawn(THREE_LEFT, 5))!
    const body = admissionRefusalBody(r, 'en')
    expect(body.code).toBe('memory_budget')
    expect(body.refusal).toEqual(r)
    expect(body.message).toBe(admissionMessage(r, 'en'))
  })
})
