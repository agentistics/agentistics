import { describe, expect, test } from 'bun:test'
import { buildAwayDigestFromSources } from './away-digest'

const since = Date.parse('2026-01-01T00:00:00.000Z')
const now = since + 5 * 60 * 60 * 1000
const away = { on: true as const, since: new Date(since).toISOString(), until: null, authorised: [], note: '', maxWorkers: 6, topCaps: {} }

describe('away digest source projection', () => {
  test('filters the inclusive window, bounds lists, redacts secrets, and marks missing sources unavailable', () => {
    const inside = new Date(since + 1).toISOString()
    const outside = new Date(since - 1).toISOString()
    const digest = buildAwayDigestFromSources(away, now, {
      tasks: [{ id: 'task-1', title: 'Visible task', status: 'in_review' }],
      events: [
        { taskId: 'task-1', at: inside, kind: 'status', detail: 'token=do-not-leak' },
        { taskId: 'task-1', at: outside, kind: 'status', detail: 'outside' },
        ...Array.from({ length: 35 }, (_, i) => ({ taskId: `task-${i}`, at: inside, kind: 'status' })),
      ],
      sessions: [
        { id: 'inside', createdAt: inside, title: 'inside' },
        { id: 'outside', createdAt: outside, title: 'outside' },
        ...Array.from({ length: 35 }, (_, i) => ({ id: `s-${i}`, createdAt: inside })),
      ],
      notices: [{ ts: since + 1, meta: { text: 'notice' } }, { ts: since - 1, meta: { text: 'outside' } }],
    }) as any
    expect(digest.tasks.length).toBeLessThanOrEqual(30)
    expect(digest.sessions.length).toBeLessThanOrEqual(30)
    expect(digest.awayNotices).toHaveLength(1)
    expect(JSON.stringify(digest)).not.toContain('do-not-leak')
    expect(JSON.stringify(digest)).not.toContain('outside')
    expect(digest.version).toBe('unavailable')
    expect(digest.releases).toBe('unavailable')
    expect(digest.pending).toBe('unavailable')
  })

  test('redacts and bounds task titles before they reach the digest prompt', () => {
    const digest = buildAwayDigestFromSources(away, now, {
      tasks: [{ id: 'task-1', title: 'token=private-value ' + 'x'.repeat(2000), status: 'in_review' }],
      events: [{ taskId: 'task-1', at: new Date(since + 1).toISOString(), kind: 'status' }],
    }) as { tasks: { title: string }[] }
    expect(digest.tasks[0]!.title).toStartWith('token=[redacted]')
    expect(digest.tasks[0]!.title.length).toBe(500)
    expect(JSON.stringify(digest)).not.toContain('private-value')
  })

  test('keeps only cached releases published inside the digest window', () => {
    const digest = buildAwayDigestFromSources(away, now, {
      awayDigest: { since: away.since, lastBucket: 20 },
      releases: [
        { tag: 'v1.0.0', published_at: new Date(since + 1).toISOString() },
        { tag: 'v0.9.0', published_at: new Date(since - 1).toISOString() },
      ],
    })
    expect(digest.releases).toEqual([{ tag: 'v1.0.0', published_at: new Date(since + 1).toISOString() }])
  })
})
