import { describe, expect, test } from 'bun:test'
import { activeHarnesses, makePayload, shouldSendToday, shouldSendTelemetry, ensureTelemetryId, sendTelemetry } from './telemetry'
import type { SessionMeta } from '@agentistics/core'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('anonymous telemetry', () => {
  const session = (harness: string, at: string): SessionMeta => ({
    session_id: `${harness}-${at}`,
    project_path: '/repo',
    start_time: at,
    user_message_timestamps: [at],
    harness,
  } as SessionMeta)

  test('reports harnesses with activity in the last seven days only', () => {
    const now = Date.parse('2026-10-07T12:00:00.000Z')
    expect(activeHarnesses([
      session('claude', '2026-10-06T12:00:00.000Z'),
      session('codex', '2026-09-29T12:00:00.000Z'),
    ], now)).toEqual(['claude'])
    expect(activeHarnesses([], now)).toEqual([])
  })

  test('persists one random install id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentistics-telemetry-'))
    const path = join(dir, 'telemetry.json')
    const first = await ensureTelemetryId(path)
    const second = await ensureTelemetryId(path)
    expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(second).toEqual(first)
    expect(JSON.parse(await readFile(path, 'utf8')).id).toBe(first.id)
  })
  test('uses a once-per-UTC-day gate', () => {
    expect(shouldSendToday(undefined, '2026-10-06')).toBe(true)
    expect(shouldSendToday('2026-10-06', '2026-10-06')).toBe(false)
    expect(shouldSendToday('2026-10-05', '2026-10-06')).toBe(true)
  })
  test('only allows compiled binaries with a durable data directory', () => {
    const base = { isCompiled: true, env: {}, dataDir: '/home/user/.agentistics', tmpDir: '/tmp' }
    expect(shouldSendTelemetry(base)).toBe(true)
    for (const input of [
      { isCompiled: false },
      { env: { AGENTISTICS_TELEMETRY: '0' } },
      { env: { DO_NOT_TRACK: '1' } },
      { env: { CI: '1' } },
      { env: { NODE_ENV: 'test' } },
      { env: { AGENTISTICS_THROWAWAY: '1' } },
      { dataDir: '/tmp/agentistics-preview' },
    ]) expect(shouldSendTelemetry({ ...base, ...input })).toBe(false)
    expect(shouldSendTelemetry({ ...base, dataDir: '/tmpx/agentistics' })).toBe(true)
  })
  test('payload contains exactly the public fields', () => {
    expect(makePayload({ id: 'x', version: '2.110.0', os: 'linux', arch: 'x64', harnesses: ['codex', 'codex', 'claude'] })).toEqual({ id: 'x', version: '2.110.0', os: 'linux', arch: 'x64', harnesses: ['claude', 'codex'] })
  })
  test('opt-out and environment disable before network', async () => {
    const fetchFn = (async () => { throw new Error('must not call') }) as unknown as typeof fetch
    expect(await sendTelemetry({ enabled: false, fetchFn })).toBe(false)
    expect(await sendTelemetry({ env: { AGENTISTICS_TELEMETRY: '0' }, fetchFn })).toBe(false)
  })
})
