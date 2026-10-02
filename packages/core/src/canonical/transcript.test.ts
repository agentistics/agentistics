import { describe, expect, test } from 'bun:test'
import { transcriptAvailability } from './transcript'
import { transcriptSentence } from '../transcriptSentence'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0)

const base = { resolved: false, live: false, nowMs: NOW }

describe('transcriptAvailability', () => {
  test('a resolved, readable transcript is present', () => {
    expect(transcriptAvailability({ ...base, harness: 'claude', resolved: true })).toEqual({ state: 'present', reason: 'resolved' })
  })

  test('a resolved transcript that fails to read is unreadable, never empty', () => {
    expect(transcriptAvailability({ ...base, harness: 'claude', resolved: true, readFailed: true }).state).toBe('unreadable')
  })

  test('a running session with no file yet is not-yet-written, whatever its age', () => {
    expect(transcriptAvailability({ ...base, harness: 'claude', live: true, lastActivityMs: NOW - 90 * DAY }).state).toBe('not-yet-written')
  })

  test('claude past its retention is expired, and says when', () => {
    const last = NOW - 45 * DAY
    const a = transcriptAvailability({ ...base, harness: 'claude', lastActivityMs: last })
    expect(a).toEqual({
      state: 'expired', reason: 'past-retention',
      expiredAt: new Date(last + 30 * DAY).toISOString(), retentionDays: 30,
    })
  })

  test('the user’s own cleanupPeriodDays wins over the default', () => {
    const a = transcriptAvailability({ ...base, harness: 'claude', lastActivityMs: NOW - 10 * DAY, retentionDays: 7 })
    expect(a.state).toBe('expired')
    expect(a.retentionDays).toBe(7)
  })

  test('claude inside its retention is NOT expired — the period cannot be the reason', () => {
    expect(transcriptAvailability({ ...base, harness: 'claude', lastActivityMs: NOW - 5 * DAY }).state).toBe('deleted')
  })

  test('claude with no known last activity makes no claim of expiry', () => {
    expect(transcriptAvailability({ ...base, harness: 'claude' }).state).toBe('deleted')
  })

  test('a harness with no established retention rule is never expired, however old', () => {
    for (const harness of ['codex', 'gemini', 'copilot', 'antigravity', 'kimi', 'opencode']) {
      expect(transcriptAvailability({ ...base, harness, lastActivityMs: NOW - 400 * DAY }).state).toBe('deleted')
    }
  })

  test('an unknown harness id is deleted, not a throw', () => {
    expect(transcriptAvailability({ ...base, harness: '', lastActivityMs: NOW - 400 * DAY }).state).toBe('deleted')
  })
})

describe('transcriptSentence', () => {
  const expired = transcriptAvailability({ ...base, harness: 'claude', lastActivityMs: NOW - 45 * DAY })

  test('names the harness, the period and both dates', () => {
    const en = transcriptSentence(expired, 'en', 'claude', NOW - 45 * DAY)!
    expect(en).toContain('Claude Code deletes transcripts 30 days after the last activity')
    expect(en).toContain('removed around')
    const pt = transcriptSentence(expired, 'pt', 'claude', NOW - 45 * DAY)!
    expect(pt).toContain('Esta conversa expirou')
    expect(pt).toContain('30 dias')
  })

  test('deleted says no known rule explains it, and does not claim expiry', () => {
    const s = transcriptSentence({ state: 'deleted', reason: 'no-file-found' }, 'en', 'codex')!
    expect(s).toContain('no known expiry rule')
    expect(s).not.toContain('expired')
  })

  test('present and not-yet-written need no sentence', () => {
    expect(transcriptSentence({ state: 'present', reason: 'resolved' }, 'pt', 'claude')).toBeNull()
    expect(transcriptSentence({ state: 'not-yet-written', reason: 'live-no-file-yet' }, 'pt', 'claude')).toBeNull()
  })
})
