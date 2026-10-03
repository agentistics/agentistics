import { describe, expect, test } from 'bun:test'
import { PROGRESS_SKEW_MS, advance, rawStep, type ServerProgress } from './upgradeSteps'

const T0 = 1_700_000_000_000
const p = (stage: ServerProgress['stage'], o: Partial<ServerProgress> = {}): ServerProgress => ({ stage, version: '2.31.0', at: T0 + 10, ...o })
const at = (progress: ServerProgress | null, o: { quietPolls?: number; arrived?: boolean } = {}) =>
  rawStep({ startedAt: T0, progress, quietPolls: o.quietPolls ?? 0, arrived: o.arrived ?? false })

describe('each real stage maps to its narrated step', () => {
  test('nothing written yet is the start of the download', () => expect(at(null).step).toBe('data'))
  test('checking and downloading are data', () => {
    expect(at(p('checking')).step).toBe('data')
    expect(at(p('downloading', { received: 0 })).step).toBe('data')
  })
  test('the download bar follows bytes when the total is known', () => {
    const half = at(p('downloading', { received: 50, total: 100 }))
    expect(half.download).toBe(0.5)
    const most = at(p('downloading', { received: 90, total: 100 }))
    expect(most.fraction).toBeGreaterThan(half.fraction)
    expect(at(p('downloading', { received: 50 })).download).toBeUndefined()
  })
  test('verifying and swapping are brain', () => {
    expect(at(p('verifying')).step).toBe('brain')
    expect(at(p('swapping')).step).toBe('brain')
  })
  test('restarting and done-without-arrival are wiring', () => {
    expect(at(p('restarting')).step).toBe('wiring')
    expect(at(p('done')).step).toBe('wiring')
  })
  test('the version answering the target is power', () => {
    expect(at(p('restarting'), { arrived: true })).toEqual({ step: 'power', fraction: 1, failed: false })
  })
  test('failed is reported', () => expect(at(p('failed')).failed).toBe(true))
})

describe('silence', () => {
  test('one dropped poll mid-download is a hiccup', () => {
    expect(at(p('downloading', { received: 5, total: 100 }), { quietPolls: 1 }).step).toBe('data')
  })
  test('two quiet polls are the restart', () => {
    expect(at(p('downloading', { received: 5, total: 100 }), { quietPolls: 2 }).step).toBe('wiring')
  })
  test('once the swap began, one quiet poll is the restart', () => {
    expect(at(p('swapping'), { quietPolls: 1 }).step).toBe('wiring')
  })
})

describe('a record from before the press', () => {
  test('a previous run is ignored', () => {
    expect(at(p('done', { at: T0 - PROGRESS_SKEW_MS - 1 })).step).toBe('data')
    expect(at(p('failed', { at: T0 - PROGRESS_SKEW_MS - 1 })).failed).toBe(false)
  })
  test('small clock skew still counts', () => expect(at(p('swapping', { at: T0 - 1000 })).step).toBe('brain'))
})

describe('never backwards', () => {
  test('a later step wins; an earlier one is ignored', () => {
    const wiring = at(p('restarting'))
    expect(advance(wiring, at(p('downloading', { received: 1, total: 100 }))).step).toBe('wiring')
    expect(advance(at(p('checking')), wiring).step).toBe('wiring')
  })
  test('inside a step the charge only grows', () => {
    const big = at(p('downloading', { received: 80, total: 100 }))
    const small = at(p('downloading', { received: 10, total: 100 }))
    expect(advance(big, small).fraction).toBe(big.fraction)
  })
  test('a failure always gets through', () => expect(advance(at(p('restarting')), at(p('failed'))).failed).toBe(true))
  test('the overall charge is monotone across the four steps', () => {
    const seq = [at(null), at(p('downloading', { received: 50, total: 100 })), at(p('verifying')), at(p('swapping')), at(p('restarting')), at(null, { arrived: true })]
    for (let i = 1; i < seq.length; i++) expect(seq[i]!.fraction).toBeGreaterThan(seq[i - 1]!.fraction)
  })
})
