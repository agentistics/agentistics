import { describe, expect, test } from 'bun:test'
import { buildAwayDigestFromSources } from './away-digest'

const since = Date.parse('2026-01-01T00:00:00.000Z')
const now = since + 5 * 60 * 60 * 1000
const away = { on: true as const, since: new Date(since).toISOString(), until: null, authorizations: [], note: '', workerCeiling: null, topModelCaps: {} }

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
})
