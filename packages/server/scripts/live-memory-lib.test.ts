/**
 * live-memory-lib.test.ts — LIVE.4's measurement arithmetic (spec §6 C5 / Q6): the numbers the default-on gate
 * is judged on. Pure: samples in, verdict out.
 */
import { describe, expect, test } from 'bun:test'
import { GATE, parseProcStatus, parseProcStat, parseCsv, percentile, report, sampleToCsv, slopeMBPerHour, type Sample } from './live-memory-lib'

const MIN = 60_000
const mk = (n: number, f: (i: number) => number, t0 = Date.parse('2026-10-03T20:00:00.000Z')): Sample[] =>
  Array.from({ length: n }, (_, i) => ({ at: new Date(t0 + i * MIN).toISOString(), rssKb: f(i) * 1024, swapKb: 0, threads: 20, cpuTicks: i * 10, latencyMs: 8 }))

describe('procfs', () => {
  test('VmRSS, VmSwap and Threads off /proc/<pid>/status', () => {
    expect(parseProcStatus('Name:\tbun\nVmRSS:\t  250112 kB\nVmSwap:\t      64 kB\nThreads:\t21\n')).toEqual({ rssKb: 250112, swapKb: 64, threads: 21 })
    expect(parseProcStatus('Name:\tx\n')).toBeNull()
  })
  test('utime+stime off /proc/<pid>/stat, even with spaces and parens in the command name', () => {
    expect(parseProcStat('123 (bun (server) x) S 1 123 123 0 -1 4194560 100 0 0 0 55 45 0 0 20 0 21 0 1 1 1')).toBe(100)
  })
})

describe('statistics', () => {
  test('percentile is nearest-rank', () => { expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3); expect(percentile([1, 2, 3, 4, 5], 0.95)).toBe(5); expect(percentile([], 0.5)).toBeNull() })
  test('slope in MB/hour, least squares over time', () => {
    expect(slopeMBPerHour(mk(120, i => 300 + i * 0.5))).toBeCloseTo(30, 3)       // +0.5 MB/min
    expect(slopeMBPerHour(mk(120, () => 300))).toBeCloseTo(0, 6)
    expect(slopeMBPerHour(mk(1, () => 300))).toBeNull()
  })
  test('csv round trip', () => { const s = mk(3, i => 300 + i); expect(parseCsv(sampleToCsv(s))).toEqual(s) })
})

describe('the default-on gate (+150 MB, flat, < 1 GB, latency not worse)', () => {
  test('a flat 24 h run 80 MB over its baseline passes', () => {
    const base = mk(24 * 60, () => 300), run = mk(24 * 60, () => 380)
    const r = report(run, { baseline: base })
    expect(r.deltaMB).toBeCloseTo(80, 1)
    expect(r.verdict).toBe('pass')
    expect(r.checks.every(c => c.ok)).toBe(true)
  })
  test('+200 MB fails the delta check; a leak fails the slope check; a 1.2 GB peak fails the peak check', () => {
    const base = mk(24 * 60, () => 300)
    expect(report(mk(24 * 60, () => 500), { baseline: base }).checks.find(c => c.name === 'delta')!.ok).toBe(false)
    expect(report(mk(24 * 60, i => 300 + i * 0.1), { baseline: base }).checks.find(c => c.name === 'slope')!.ok).toBe(false)
    expect(report(mk(24 * 60, i => (i === 700 ? 1300 : 350)), { baseline: base }).checks.find(c => c.name === 'peak')!.ok).toBe(false)
  })
  test('the first hour is warm-up and is excluded from delta and slope (but not from the peak)', () => {
    const run = mk(24 * 60, i => (i < 60 ? 900 : 350))
    const r = report(run, { baseline: mk(24 * 60, () => 300) })
    expect(r.deltaMB).toBeCloseTo(50, 1)
    expect(r.peakMB).toBeCloseTo(900, 1)
  })
  test('without a baseline the verdict is "incomplete" — the gate is a DELTA and is not guessed', () => {
    const r = report(mk(24 * 60, () => 300), {})
    expect(r.verdict).toBe('incomplete')
    expect(r.deltaMB).toBeNull()
  })
  test('too short a run is incomplete too (the gate asks 24 h)', () => {
    expect(report(mk(120, () => 300), { baseline: mk(120, () => 300) }).verdict).toBe('incomplete')
  })
  test('latency: p95 not worse than the baseline\'s (a 10% / 5 ms tolerance for noise)', () => {
    const base = mk(24 * 60, () => 300).map(s => ({ ...s, latencyMs: 10 }))
    const slow = mk(24 * 60, () => 300).map(s => ({ ...s, latencyMs: 40 }))
    expect(report(slow, { baseline: base }).checks.find(c => c.name === 'latency')!.ok).toBe(false)
  })
  test('the thresholds are the owner\'s', () => { expect(GATE).toEqual({ deltaMB: 150, slopeMBPerHour: 5, peakMB: 1024, warmupMin: 60, minHours: 24 }) })
})

describe('the sampler finds the server by its command line (read-only)', () => {
  test('findServerPid matches `agentop server`, never itself or a bare `agentop`', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { findServerPid } = await import('./live-memory-measure')
    const root = mkdtempSync(join(tmpdir(), 'procfake-'))
    const put = (pid: string, argv: string[]) => { mkdirSync(join(root, pid)); writeFileSync(join(root, pid, 'cmdline'), argv.join('\0') + '\0') }
    put('11', ['/usr/bin/bash', '-c', 'x']); put('12', ['/home/u/.local/bin/agentop']); put('13', ['/home/u/.local/bin/agentop', 'server']); put('notapid', ['agentop', 'server'])
    expect(findServerPid(root)).toBe(13)
    rmSync(root, { recursive: true, force: true })
  })
})
