import { describe, expect, test } from 'bun:test'
import { EXPERIMENTAL_SENTENCE, nativeExperimentalOn, nativeGateRefusal } from './native-gate'

describe('the native harness and providers are experimental (owner, 2026-10-03)', () => {
  test('the flag the experimental preference writes decides; absent is off', () => {
    expect(nativeExperimentalOn({})).toBe(false)
    expect(nativeExperimentalOn({ AGENTISTICS_PROVIDER: '1' })).toBe(true)
    expect(nativeExperimentalOn({ AGENTISTICS_PROVIDER: '0' })).toBe(false)
  })
  test('off: the native and provider routes are a 403 "experimental" naming the command; others pass', () => {
    for (const p of ['/api/runtime/sessions', '/api/runtime/sessions/ses_x/messages', '/api/provider', '/api/provider/anthropic/models']) {
      expect(nativeGateRefusal(p, false)).toMatchObject({ status: 403, body: { error: 'experimental' } })
    }
    expect(nativeGateRefusal('/api/runtime/metrics', false)).toBeNull()
    expect(nativeGateRefusal('/api/providers-other', false)).toBeNull()
    expect(nativeGateRefusal('/api/ingest', false)).toBeNull()
    expect(nativeGateRefusal('/api/provider', true)).toBeNull()
    expect(EXPERIMENTAL_SENTENCE.en).toContain('agentop experimental enable')
    expect(EXPERIMENTAL_SENTENCE.pt).toContain('agentop experimental enable')
  })
})
