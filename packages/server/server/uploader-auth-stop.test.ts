import { describe, expect, test } from 'bun:test'
import { AUTH_STOP_PROBE_MS, authStopFingerprint, authStopGate } from './uploader-auth-stop'

describe('authStopGate — a 401/403 stops the pushes for that connection', () => {
  const fp = authStopFingerprint('https://central.example', 'tok-1')

  test('not stopped → push', () => {
    expect(authStopGate(undefined, fp, 1_000)).toBe('push')
  })

  test('stopped, same config → skip, and probe at most once per window', () => {
    // 2026-10-03: a member pushed and logged `ingest returned 403; stopping push` every 2–5 s for
    // hours — every file change triggered another full ingest that was refused again.
    const stop = { fingerprint: fp, probedAtMs: 1_000 }
    expect(authStopGate(stop, fp, 1_000 + 5_000)).toBe('skip')
    expect(authStopGate(stop, fp, 1_000 + AUTH_STOP_PROBE_MS)).toBe('probe')
  })

  test('the connection CHANGED (endpoint or token) → the stop is lifted at once', () => {
    const stop = { fingerprint: fp, probedAtMs: 1_000 }
    expect(authStopGate(stop, authStopFingerprint('https://central.example', 'tok-2'), 1_001)).toBe('cleared')
    expect(authStopGate(stop, authStopFingerprint('https://other.example', 'tok-1'), 1_001)).toBe('cleared')
  })

  test('the fingerprint never carries the token itself', () => {
    expect(fp).not.toContain('tok-1')
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
  })
})
