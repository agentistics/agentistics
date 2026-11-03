import { describe, expect, test } from 'bun:test'
import { defaultProcessOpsDeps, processHostOps, type ProcessOpsDeps } from './process-ops'
import type { ReapResult } from '../sessions/session-reaper-io'

const result = (o: Partial<ReapResult> = {}): ReapResult => ({ atMs: 1, dryRun: false, processes: 2, freedBytes: 3 * 1048576, sessions: 1, stuck: 0, pids: [7, 8], found: [], ...o })
const deps = (o: Partial<ProcessOpsDeps> = {}): ProcessOpsDeps => ({
  collect: (async () => result()) as unknown as ProcessOpsDeps['collect'],
  stopOne: (async () => ({ stopped: [5], stuck: [], freedBytes: 1048576, found: [{ pid: 5, comm: 'claude', rssBytes: 1048576 }] })) as unknown as ProcessOpsDeps['stopOne'],
  endedAt: async () => 1000,
  alive: async () => false,
  mode: () => 'on',
  ...o,
})

describe('coletar-processos', () => {
  test('answers what it found, stopped and freed', async () => {
    const out = await processHostOps(deps())['coletar-processos']({}) as Record<string, unknown>
    expect(out).toMatchObject({ ok: true, stoppedCount: 2, freedMb: 3, summary: 'freed 3 MB from 2 leftover processes of closed sessions' })
  })
  test('passes dry-run through', async () => {
    let asked: unknown
    const collect = (async (o: unknown) => { asked = o; return result({ dryRun: true }) }) as unknown as ProcessOpsDeps['collect']
    await processHostOps(deps({ collect }))['coletar-processos']({ 'dry-run': true, graceMs: 0 })
    expect(asked).toEqual({ dryRun: true, graceMs: 0 })
  })
  test('a pass that could not judge is a refusal, not a confident zero', async () => {
    const collect = (async () => result({ processes: 0, pids: [], skippedWhy: 'backend could not be listed' })) as unknown as ProcessOpsDeps['collect']
    expect(await processHostOps(deps({ collect }))['coletar-processos']({})).toMatchObject({ refused: true })
  })
})

describe('AGENTISTICS_REAPER on the flow path', () => {
  test('0 refuses the collector and never calls it', async () => {
    let called = false
    const collect = (async () => { called = true; return result() }) as unknown as ProcessOpsDeps['collect']
    const out = await processHostOps(deps({ collect, mode: () => 'off' }))['coletar-processos']({})
    expect(out).toMatchObject({ refused: true, reason: 'coletor desligado por AGENTISTICS_REAPER=0' })
    expect(called).toBe(false)
  })
  test('dry forces dryRun, input cannot override to false', async () => {
    const asked: unknown[] = []
    const collect = (async (o: unknown) => { asked.push(o); return result({ dryRun: true }) }) as unknown as ProcessOpsDeps['collect']
    const ops = processHostOps(deps({ collect, mode: () => 'dry' }))
    await ops['coletar-processos']({})
    await ops['coletar-processos']({ dryRun: false })
    expect(asked).toEqual([{ dryRun: true }, { dryRun: true }])
  })
  test('on keeps the input in charge', async () => {
    let asked: unknown
    const collect = (async (o: unknown) => { asked = o; return result() }) as unknown as ProcessOpsDeps['collect']
    await processHostOps(deps({ collect }))['coletar-processos']({})
    expect(asked).toEqual({ dryRun: false })
  })
  test('default deps read the env per call', async () => {
    const d = defaultProcessOpsDeps()
    const prev = process.env.AGENTISTICS_REAPER
    try {
      process.env.AGENTISTICS_REAPER = '0'; expect(d.mode!()).toBe('off')
      process.env.AGENTISTICS_REAPER = 'dry'; expect(d.mode!()).toBe('dry')
    } finally { if (prev === undefined) delete process.env.AGENTISTICS_REAPER; else process.env.AGENTISTICS_REAPER = prev }
  })
  test('matar-arvore-sessao: 0 still closes, dry is dry', async () => {
    const asked: unknown[] = []
    const stopOne = (async (_i: string, o: unknown) => { asked.push(o); return { stopped: [], stuck: [], freedBytes: 0, found: [] } }) as unknown as ProcessOpsDeps['stopOne']
    await processHostOps(deps({ stopOne, mode: () => 'off' }))['matar-arvore-sessao']({ sessionId: 'x' })
    await processHostOps(deps({ stopOne, mode: () => 'dry' }))['matar-arvore-sessao']({ sessionId: 'x', dryRun: false })
    expect(asked).toEqual([{ endedMs: 1000, dryRun: false }, { endedMs: 1000, dryRun: true }])
  })
})

describe('matar-arvore-sessao', () => {
  test('stops an ended session\'s tree', async () => {
    expect(await processHostOps(deps())['matar-arvore-sessao']({ sessionId: 'x' })).toMatchObject({ ok: true, stoppedCount: 1, freedMb: 1 })
  })
  test('refuses a session that is not ended, or that still runs', async () => {
    expect(await processHostOps(deps({ endedAt: async () => null }))['matar-arvore-sessao']({ sessionId: 'x' })).toMatchObject({ refused: true })
    expect(await processHostOps(deps({ alive: async () => true }))['matar-arvore-sessao']({ sessionId: 'x' })).toMatchObject({ refused: true })
    expect(await processHostOps(deps({ alive: async () => null }))['matar-arvore-sessao']({ sessionId: 'x' })).toMatchObject({ refused: true })
    expect(await processHostOps(deps())['matar-arvore-sessao']({})).toMatchObject({ refused: true })
  })
})
