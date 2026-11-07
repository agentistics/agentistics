import { describe, expect, test } from 'bun:test'
import { parseVmStat } from './cli-run'

// A healthy 16 GB Mac as `vm_stat` prints it: few FREE pages, a lot of inactive/speculative/purgeable ones.
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               11853.
Pages active:                            382733.
Pages inactive:                          369520.
Pages speculative:                        20610.
Pages throttled:                              0.
Pages wired down:                        112094.
Pages purgeable:                          15210.
"Translation faults":                 1953838020.
`

describe('M8 — macOS available memory is not os.freemem()', () => {
  test('free + inactive + speculative + purgeable pages, times the stated page size', () => {
    const bytes = parseVmStat(VM_STAT)!
    expect(bytes).toBe((11853 + 369520 + 20610 + 15210) * 16384)
    // The old reading (free pages only) would have said 0.18 GB and refused every start; available is ~6.4 GB.
    expect(11853 * 16384).toBeLessThan(3 * 1024 ** 3)
    expect(bytes).toBeGreaterThan(3 * 1024 ** 3)
  })
  test('unreadable output is unmeasured, never a number', () => {
    expect(parseVmStat('')).toBeNull()
    expect(parseVmStat('Pages free: 5.')).toBeNull()
  })
})
