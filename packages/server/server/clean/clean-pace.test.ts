import { describe, expect, test } from 'bun:test'
import { batchPace, CLEAN_BATCH_PAUSE_MS, CLEAN_HOUR_MS, CLEAN_INTERVAL_MS, removalWait, waitForCleanHealth, type CleanHealth } from './clean-pace'
import { throttledRemove } from './throttled-remove'

describe('cleanup pacing', () => {
  test('tight, critical and readonly pause; ok resumes', async () => {
    for (const level of ['tight', 'critical', 'readonly'] as const) {
      let reads = 0
      const pauses: number[] = []
      await waitForCleanHealth({ health: async () => ({ level: reads++ === 0 ? level : 'ok', dirtyWriteback: 0 }), sleep: async ms => { pauses.push(ms) } })
      expect(pauses).toEqual([1000]); expect(reads).toBe(2)
    }
  })
  test('S10 waits above 1 GiB and drains below 512 MiB before resuming', () => {
    const h = (dirtyWriteback: number): CleanHealth => ({ level: 'ok', dirtyWriteback })
    expect(batchPace(h(1024 ** 3 + 1))).toMatchObject({ draining: true, waitMs: 1000 })
    expect(batchPace(h(700 * 1024 ** 2), true).waitMs).toBe(1000)
    expect(batchPace(h(512 * 1024 ** 2), true).waitMs).toBe(1000)
    expect(batchPace(h(512 * 1024 ** 2 - 1), true).waitMs).toBe(0)
  })
  test('one every two minutes, at most six per rolling hour, across invocations', () => {
    expect(removalWait(1, [])).toBe(0)
    expect(removalWait(1000, [0])).toBe(CLEAN_INTERVAL_MS - 1000)
    const starts = Array.from({ length: 6 }, (_, i) => i * CLEAN_INTERVAL_MS)
    expect(removalWait(6 * CLEAN_INTERVAL_MS, starts)).toBe(CLEAN_HOUR_MS - 6 * CLEAN_INTERVAL_MS)
    expect(removalWait(CLEAN_HOUR_MS, starts)).toBe(0)
  })
  test('50,000 entries per tree: sequential batches, 250ms pauses and injected mid-tree tight stops writes', async () => {
    let level: CleanHealth['level'] = 'ok'
    let erased = 0, active = 0, maxActive = 0, tightPauses = 0
    const batches: number[] = [], pauses: number[] = []
    for (let tree = 0; tree < 3; tree++) {
      const before = batches.length
      await throttledRemove(`/tmp/synthetic-${tree}`, {
        entries: async function* () { for (let i = 0; i < 50_000; i++) yield `/tmp/synthetic-${tree}/node_modules/${i}` },
        health: async () => ({ level, dirtyWriteback: 0 }),
        erase: async paths => { active++; maxActive = Math.max(maxActive, active); erased += paths.length; batches.push(paths.length); active--; if (batches.length === 1) level = 'tight' },
        sleep: async ms => {
          pauses.push(ms)
          if (ms === 1000) { expect(erased).toBe(2000); tightPauses++; level = 'ok' }
        },
      })
      expect(batches.length - before).toBeGreaterThanOrEqual(25)
    }
    expect(erased).toBe(150_000); expect(maxActive).toBe(1); expect(tightPauses).toBe(1)
    expect(pauses.filter(ms => ms === CLEAN_BATCH_PAUSE_MS)).toHaveLength(batches.length)
    expect(Math.max(...batches)).toBeLessThanOrEqual(2000)
  })
})
