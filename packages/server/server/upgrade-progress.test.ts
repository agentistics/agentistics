import { describe, expect, test } from 'bun:test'
import { PROGRESS_STALE_MS, parseUpgradeProgress, progressForWire, shouldWriteDownload } from './upgrade-progress'

const AT = 1_700_000_000_000

describe('parseUpgradeProgress', () => {
  test('a well-formed record round-trips', () => {
    const p = { stage: 'downloading' as const, version: '2.31.0', received: 10, total: 100, at: AT }
    expect(parseUpgradeProgress(JSON.stringify(p))).toEqual(p)
  })
  test('is total', () => {
    for (const raw of [null, '', '{', '[]', '{"stage":"warp","version":"1","at":1}', '{"stage":"done","at":1}', '{"stage":"done","version":"1","at":-1}'])
      expect(parseUpgradeProgress(raw)).toBeNull()
  })
  test('a reason survives only on failed, bounded', () => {
    expect(parseUpgradeProgress(JSON.stringify({ stage: 'done', version: '1', at: AT, reason: 'x' }))?.reason).toBeUndefined()
    expect(parseUpgradeProgress(JSON.stringify({ stage: 'failed', version: '1', at: AT, reason: 'x'.repeat(500) }))?.reason?.length).toBe(200)
  })
  test('a zero total is no total', () => {
    expect(parseUpgradeProgress(JSON.stringify({ stage: 'downloading', version: '1', at: AT, total: 0 }))?.total).toBeUndefined()
  })
})

describe('progressForWire', () => {
  const p = { stage: 'failed' as const, version: '2.31.0', reason: 'could not write /home/x/agentop.tmp', at: AT }
  test('drops the CLI reason, which can name local paths', () => {
    expect(progressForWire(p, AT + 1)).toEqual({ stage: 'failed', version: '2.31.0', at: AT })
  })
  test('a stale or future record is nothing running', () => {
    expect(progressForWire(p, AT + PROGRESS_STALE_MS + 1)).toBeNull()
    expect(progressForWire(p, AT - 120_000)).toBeNull()
    expect(progressForWire(null, AT)).toBeNull()
  })
})

describe('shouldWriteDownload', () => {
  test('first chunk, a quarter second, or two points of progress', () => {
    expect(shouldWriteDownload(null, 1, 100, AT)).toBe(true)
    expect(shouldWriteDownload({ received: 0, at: AT }, 1, 100, AT + 10)).toBe(false)
    expect(shouldWriteDownload({ received: 0, at: AT }, 2, 100, AT + 10)).toBe(true)
    expect(shouldWriteDownload({ received: 0, at: AT }, 1, undefined, AT + 250)).toBe(true)
    expect(shouldWriteDownload({ received: 0, at: AT }, 99, undefined, AT + 10)).toBe(false)
  })
})
