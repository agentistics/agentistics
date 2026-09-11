import { test, expect } from 'bun:test'
import { lastActivityMs, isLive, LIVE_THRESHOLD_MIN, liveEmptyNotice } from './sessionLive'
import type { LiveUnavailableReason, SessionMeta } from '@agentistics/core'

function base(over: Partial<SessionMeta>): SessionMeta {
  return {
    session_id: 's', project_path: '/p', start_time: '2026-07-07T10:00:00Z',
    duration_minutes: 0, user_message_count: 0, assistant_message_count: 0,
    tool_counts: {}, tool_output_tokens: {}, agent_file_reads: {}, languages: [],
    git_commits: 0, git_pushes: 0, input_tokens: 0, output_tokens: 0,
    first_prompt: '', user_interruptions: 0, user_response_times: [], tool_errors: 0,
    tool_error_categories: {}, uses_task_agent: false, uses_mcp: false,
    uses_web_search: false, uses_web_fetch: false, lines_added: 0, lines_removed: 0,
    files_modified: 0, message_hours: [], user_message_timestamps: [],
    harness: 'claude', ...over,
  }
}

test('lastActivityMs prefers end_time', () => {
  const s = base({ end_time: '2026-07-07T12:00:00Z', start_time: '2026-07-07T10:00:00Z' })
  expect(lastActivityMs(s)).toBe(Date.parse('2026-07-07T12:00:00Z'))
})

test('lastActivityMs falls back to last user timestamp then start', () => {
  const s = base({ end_time: undefined, user_message_timestamps: ['2026-07-07T10:30:00Z', '2026-07-07T11:00:00Z'] })
  expect(lastActivityMs(s)).toBe(Date.parse('2026-07-07T11:00:00Z'))
  const s2 = base({ end_time: undefined, user_message_timestamps: [] })
  expect(lastActivityMs(s2)).toBe(Date.parse('2026-07-07T10:00:00Z'))
})

test('isLive true within threshold, false outside', () => {
  const now = Date.parse('2026-07-07T12:00:00Z')
  const liveS = base({ end_time: '2026-07-07T11:55:00Z' })
  const deadS = base({ end_time: '2026-07-07T11:30:00Z' })
  expect(isLive(liveS, now, LIVE_THRESHOLD_MIN)).toBe(true)
  expect(isLive(deadS, now, LIVE_THRESHOLD_MIN)).toBe(false)
})

// --- what an empty "Open now" is allowed to claim ------------------------------------------------

const ALL_REASONS: LiveUnavailableReason[] =
  ['unsupported-platform', 'no-proc', 'no-ps', 'container-isolated', 'permission-denied', 'capability-off']

test('a non-empty panel says nothing', () => {
  expect(liveEmptyNotice({ count: 1, lang: 'en' })).toBeNull()
  expect(liveEmptyNotice({ count: 3, lang: 'pt', unavailable: 'no-proc' })).toBeNull()
})

test('an empty panel with detection working says only that nothing is open', () => {
  const en = liveEmptyNotice({ count: 0, lang: 'en' })
  expect(en).toEqual({ title: 'No sessions open right now.', detail: '' })
  expect(liveEmptyNotice({ count: 0, lang: 'pt' })?.detail).toBe('')
})

test('every impossible configuration explains itself in both languages, and none is a bare zero', () => {
  let checked = 0
  for (const reason of ALL_REASONS) {
    const en = liveEmptyNotice({ count: 0, lang: 'en', unavailable: reason })
    const pt = liveEmptyNotice({ count: 0, lang: 'pt', unavailable: reason })
    expect(en).not.toBeNull()
    expect(pt).not.toBeNull()
    // It must never read as "nobody is working" — that is the whole point of the branch.
    expect(en!.title).not.toBe('No sessions open right now.')
    expect(en!.detail.length).toBeGreaterThan(30)
    expect(pt!.detail.length).toBeGreaterThan(30)
    // Genuinely translated, not the English string twice.
    expect(pt!.detail).not.toBe(en!.detail)
    expect(pt!.title).not.toBe(en!.title)
    checked++
  }
  // Guards the loop: a reason added to the union without copy must fail here, not pass silently.
  expect(checked).toBe(ALL_REASONS.length)
  expect(checked).toBe(6)
})

test('a central explains the member channel instead of its own host', () => {
  // Its own /proc is irrelevant there, so the reason must not leak into the sentence.
  const en = liveEmptyNotice({ count: 0, lang: 'en', central: true, unavailable: 'container-isolated' })
  expect(en!.title).toContain('No machine is reporting')
  expect(en!.detail).toContain('does not share')
  expect(en!.detail).not.toContain('pid: host')
  const pt = liveEmptyNotice({ count: 0, lang: 'pt', central: true })
  expect(pt!.detail).toContain('não compartilha')
})
