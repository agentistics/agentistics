import { describe, expect, test } from 'bun:test'
import { makePayload, shouldSendToday, ensureTelemetryId, sendTelemetry } from './telemetry'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('anonymous telemetry', () => {
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
  test('payload contains exactly the public fields', () => {
    expect(makePayload({ id: 'x', version: '2.110.0', os: 'linux', arch: 'x64', harnesses: ['codex', 'codex', 'claude'], mode: 'solo' })).toEqual({ id: 'x', version: '2.110.0', os: 'linux', arch: 'x64', harnesses: ['claude', 'codex'], mode: 'solo' })
  })
  test('opt-out and environment disable before network', async () => {
    const fetchFn = (async () => { throw new Error('must not call') }) as unknown as typeof fetch
    expect(await sendTelemetry({ enabled: false, fetchFn })).toBe(false)
    expect(await sendTelemetry({ env: { AGENTISTICS_TELEMETRY: '0' }, fetchFn })).toBe(false)
  })
})
