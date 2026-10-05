/**
 * 2026-10-05, 2.104.0 → 2.104.1: the service came back and answered /api/version within a second,
 * yet `agentop upgrade` hung on "…still waiting for agentop-server to answer" and then recorded
 * `failed` (and the page said "the update did not finish"). The restart verdict required a pid
 * CHANGE read through lsof/ss; where neither can name the listener the pid is null and a healthy,
 * correctly-versioned server read as silent. These tests reproduce that false negative.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { awaitReplacement, type ServingObservation } from './service-manager'
import { pollRunningVersion, staleUpgradeState, type UpgradeFailure } from './upgrade'
import { progressForWire } from './upgrade-progress'
import { compressResponse } from './http-compress'

const fast = { timeoutMs: 400, intervalMs: 50, sleep: async () => {}, now: (() => { let t = 0; return () => (t += 100) })() }
const mk = () => ({ ...fast, now: (() => { let t = 0; return () => (t += 100) })() })

describe('awaitReplacement — a pid that cannot be read is not a server that is not there', () => {
  const before: ServingObservation = { pid: null, answering: false }

  test('REPRODUCTION: pid unobservable, server answering the NEW version -> replaced (was silent)', async () => {
    const observe = async (): Promise<ServingObservation> => ({ pid: null, answering: true, version: '2.104.1' })
    const v = await awaitReplacement(before, observe, { ...mk(), wantVersion: '2.104.1' })
    expect(v.kind).toBe('replaced')
  })

  test('the old behaviour stays when no version is wanted: unobservable pid is silent', async () => {
    const observe = async (): Promise<ServingObservation> => ({ pid: null, answering: true, version: '2.104.1' })
    expect((await awaitReplacement(before, observe, mk())).kind).toBe('silent')
  })

  test('a server answering the OLD version is not replaced', async () => {
    const observe = async (): Promise<ServingObservation> => ({ pid: null, answering: true, version: '2.104.0' })
    expect((await awaitReplacement(before, observe, { ...mk(), wantVersion: '2.104.1' })).kind).toBe('silent')
  })

  test('an answer that is not answering never counts, whatever version it last said', async () => {
    const observe = async (): Promise<ServingObservation> => ({ pid: null, answering: false, version: '2.104.1' })
    expect((await awaitReplacement(before, observe, { ...mk(), wantVersion: '2.104.1' })).kind).toBe('silent')
  })

  test('same pid as before but the new version answering is replaced too (pid reuse / in-place)', async () => {
    const observe = async (): Promise<ServingObservation> => ({ pid: 77, answering: true, version: '2.104.1' })
    const v = await awaitReplacement({ pid: 77, answering: true }, observe, { ...mk(), wantVersion: '2.104.1' })
    expect(v.kind).toBe('replaced')
  })

  test('a pid change still wins without any version (existing contract)', async () => {
    const observe = async (): Promise<ServingObservation> => ({ pid: 9, answering: true })
    expect((await awaitReplacement({ pid: 5, answering: true }, observe, mk())).kind).toBe('replaced')
  })
})

describe('pollRunningVersion reads a COMPRESSED /api/version', () => {
  let server: ReturnType<typeof Bun.serve>
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        // Padded past the compression threshold so the answer really goes out as br/gzip.
        const body = JSON.stringify({ current: '2.104.1', latest: '2.104.1', hasUpdate: false, pad: 'x'.repeat(4000) })
        return compressResponse(req, new Response(body, { headers: { 'Content-Type': 'application/json' } }))
      },
    })
  })
  afterAll(() => server.stop(true))

  test('a br/gzip answer decodes and matches the wanted version', async () => {
    const r = await pollRunningVersion(server.port!, '2.104.1', { timeoutMs: 2000, maxMs: 2000, intervalMs: 50 })
    expect(r).toEqual({ ok: true, observed: '2.104.1', state: 'matched' })
  })

  test('the answer really is compressed on the wire', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/version`, { headers: { 'Accept-Encoding': 'br, gzip' } })
    expect(res.headers.get('content-encoding')).toMatch(/br|gzip/)
    expect(((await res.json()) as { current: string }).current).toBe('2.104.1')
  })

  test('a different version is stale, not matched', async () => {
    const r = await pollRunningVersion(server.port!, '9.9.9', { timeoutMs: 300, maxMs: 300, intervalMs: 50 })
    expect(r.ok).toBe(false)
    expect(r.state).toBe('stale')
  })
})

describe('a failure recorded for the version the server RUNS is stale', () => {
  const failure: UpgradeFailure = { version: '2.104.1', failedAt: 1, attempts: 1, reason: 'restart failed' }
  const failed = { stage: 'failed' as const, version: '2.104.1', reason: 'x', at: Date.now() }

  test('staleUpgradeState clears the failure and rewrites the progress for the current version', () => {
    expect(staleUpgradeState(failure, failed, '2.104.1')).toEqual({ clearFailure: true, rewriteProgress: true })
  })
  test('a failure for ANOTHER version is left alone', () => {
    expect(staleUpgradeState(failure, failed, '2.104.0')).toEqual({ clearFailure: false, rewriteProgress: false })
    expect(staleUpgradeState(null, null, '2.104.1')).toEqual({ clearFailure: false, rewriteProgress: false })
  })
  test('the status wire never reports `failed` for the running version', () => {
    expect(progressForWire(failed, failed.at, '2.104.1')).toBeNull()
    expect(progressForWire(failed, failed.at, '2.104.0')?.stage).toBe('failed')
    expect(progressForWire(failed, failed.at)?.stage).toBe('failed')
  })
})
