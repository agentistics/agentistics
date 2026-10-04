import { describe, it, expect } from 'bun:test'
import {
  memoryBudget, parseMeminfo, ASSUMED_SESSION_BYTES, RED_WITHIN, SWAP_ALARM_FRACTION,
} from './memory-budget'

const GB = 1024 * 1024 * 1024
const MB = 1024 * 1024

const sample = (over: Partial<ReturnType<typeof base>> = {}) => ({ ...base(), ...over })
const base = () => ({ total: 16 * GB, available: 10 * GB, swapTotal: 4 * GB, swapUsed: 0 })

describe('parseMeminfo', () => {
  it('reads the real shape of /proc/meminfo', () => {
    // Verbatim from this machine on 2026-08-15.
    const s = parseMeminfo([
      'MemTotal:       16127932 kB',
      'MemFree:         6000536 kB',
      'MemAvailable:   10217372 kB',
      'Buffers:          444092 kB',
      'SwapTotal:       4194304 kB',
      'SwapFree:        3576832 kB',
    ].join('\n'))
    expect(s).not.toBeNull()
    expect(s!.available).toBe(10217372 * 1024)
    expect(s!.swapUsed).toBe((4194304 - 3576832) * 1024)
  })

  it('takes MemAvailable, never MemFree', () => {
    // Measured at one moment here: free 5.7 GB against available 9.7 GB. Reading MemFree would
    // declare a machine with 4 GB of headroom nearly out, and every later warning becomes noise.
    const s = parseMeminfo('MemTotal: 16127932 kB\nMemFree: 6000536 kB\nMemAvailable: 10217372 kB')
    expect(s!.available).not.toBe(6000536 * 1024)
  })

  it('returns null rather than a gauge built on a zero', () => {
    expect(parseMeminfo('')).toBeNull()
    expect(parseMeminfo('MemTotal: 16127932 kB')).toBeNull()   // no MemAvailable
    expect(parseMeminfo('nonsense')).toBeNull()
  })

  it('treats a machine with no swap as having none, not as having failed', () => {
    const s = parseMeminfo('MemTotal: 100 kB\nMemAvailable: 50 kB')
    expect(s).not.toBeNull()
    expect(s!.swapTotal).toBe(0)
    expect(s!.swapUsed).toBe(0)
  })
})

describe('memoryBudget — how loaded the machine is', () => {
  it('reports RAM and SWAP as one pool', () => {
    // Two readings are wanted and neither implies the other: `used/max` answers "can I open
    // another one", this answers "how close is this box to the edge". Two of seventeen is
    // comfortable; two of seventeen while swapping is not.
    const half = memoryBudget({
      sample: { total: 8 * GB, available: 4 * GB, swapTotal: 0, swapUsed: 0 },
      sessionBytes: 0, sessions: 0,
    })
    expect(half.percent).toBe(50)
  })

  it('counts swap as USED, so a full swap cannot hide behind free RAM', () => {
    // The freeze this exists for: 3.6 GB of free RAM at 97% swap. Reading RAM alone called that
    // machine healthy at the moment it stopped responding.
    const swapping = memoryBudget({
      sample: { total: 16 * GB, available: 3.6 * GB, swapTotal: 4 * GB, swapUsed: 3.9 * GB },
      sessionBytes: 0, sessions: 0,
    })
    const ramOnly = Math.round((1 - 3.6 / 16) * 100)
    expect(swapping.percent).toBeGreaterThan(ramOnly)
  })

  it('is bounded, and answers 0 for a machine it could not measure', () => {
    const none = memoryBudget({
      sample: { total: 0, available: 0, swapTotal: 0, swapUsed: 0 }, sessionBytes: 0, sessions: 0,
    })
    expect(none.percent).toBe(0)
    const over = memoryBudget({
      sample: { total: 1 * GB, available: 0, swapTotal: 0, swapUsed: 0 }, sessionBytes: 0, sessions: 0,
    })
    expect(over.percent).toBeLessThanOrEqual(100)
  })
})

describe('memoryBudget', () => {
  it('measures the cost from what is running, rather than assuming', () => {
    const b = memoryBudget({ sample: sample(), sessionBytes: 1200 * MB, sessions: 4 })
    expect(b.cost.basis).toBe('measured')
    expect(b.cost.bytes).toBe(300 * MB)
  })

  it('falls back to the declared default and SAYS it is assumed', () => {
    const b = memoryBudget({ sample: sample(), sessionBytes: 0, sessions: 0 })
    expect(b.cost).toEqual({ bytes: ASSUMED_SESSION_BYTES, basis: 'assumed' })
  })

  it('counts what the sessions already hold as part of the room', () => {
    // Otherwise the total shrinks as you use the machine correctly: four sessions running would
    // report a smaller ceiling than the same machine with none.
    const withNone = memoryBudget({ sample: sample(), sessionBytes: 0, sessions: 0, assumedBytes: 250 * MB }).max
    const withFour = memoryBudget({
      sample: sample({ available: 10 * GB - 1000 * MB }),
      sessionBytes: 1000 * MB,
      sessions: 4,
      assumedBytes: 250 * MB,
    }).max
    expect(withFour).toBe(withNone)
  })

  it('turns red by DISTANCE, not by percentage', () => {
    // Three left of thirty is comfortable; three left of fourteen is the last warning. A fraction
    // makes those the same number, and what gets spent is one session at a time.
    const tight = memoryBudget({
      sample: sample({ available: 2 * GB + 3 * 250 * MB }),
      sessionBytes: 11 * 250 * MB, sessions: 11, assumedBytes: 250 * MB,
    })
    expect(tight.left).toBe(RED_WITHIN)
    expect(tight.red).toBe(true)
    expect(tight.alarm).toBe('sessions')

    const roomy = memoryBudget({
      sample: sample({ available: 2 * GB + 10 * 250 * MB }),
      sessionBytes: 4 * 250 * MB, sessions: 4, assumedBytes: 250 * MB,
    })
    expect(roomy.left).toBeGreaterThan(RED_WITHIN)
    expect(roomy.red).toBe(false)
    expect(roomy.alarm).toBeUndefined()
  })

  it('alarms on SWAP even when the RAM figure looks fine', () => {
    // The freeze this exists to prevent: RAM read 3.6 GB free while swap sat at 97%, and it is the
    // swap thrash that stops the machine responding. A RAM-only budget said everything was fine at
    // the exact moment the laptop locked up.
    const b = memoryBudget({
      sample: sample({ available: 8 * GB, swapUsed: 4 * GB * SWAP_ALARM_FRACTION }),
      sessionBytes: 250 * MB, sessions: 1,
    })
    expect(b.left).toBeGreaterThan(RED_WITHIN)  // by sessions alone this is comfortable
    expect(b.red).toBe(true)
    expect(b.alarm).toBe('swap')                // …and the reason is named, because the action differs
  })

  it('never reports a ceiling below what is already running', () => {
    // An over-committed machine is a real state, and reporting `max: 2` while four are up would be
    // a number nobody can act on. It says 4 of 4, none left.
    const b = memoryBudget({
      sample: sample({ available: 0 }), sessionBytes: 4 * GB, sessions: 4,
    })
    expect(b.max).toBeGreaterThanOrEqual(4)
    expect(b.left).toBe(0)
    expect(b.red).toBe(true)
  })
})
