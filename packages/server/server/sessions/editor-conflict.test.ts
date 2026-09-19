import { describe, expect, test } from 'bun:test'
import { planFileWrite } from './editor-conflict'

describe('planFileWrite', () => {
  test('matching mtimes proceed', () => {
    expect(planFileWrite({ expectedMtimeMs: 100, diskMtimeMs: 100 })).toEqual({ ok: true })
  })
  test('a disk mtime newer than what the client last read is a conflict', () => {
    expect(planFileWrite({ expectedMtimeMs: 100, diskMtimeMs: 200 })).toEqual({
      ok: false, reason: 'conflict', diskMtimeMs: 200,
    })
  })
  test('this is the SAME rule regardless of direction — any mismatch is a conflict', () => {
    // A disk mtime OLDER than expected is just as much "not what I last read" as a newer one — the
    // file could have been reverted from a backup, or the clock could be wrong. The rule is never
    // "did it get newer", only "did it change from what I saw".
    expect(planFileWrite({ expectedMtimeMs: 200, diskMtimeMs: 100 })).toEqual({
      ok: false, reason: 'conflict', diskMtimeMs: 100,
    })
  })
})
