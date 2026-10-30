import { afterEach, describe, expect, test } from 'bun:test'
import { getPendingSessionsSnapshot, markSessionPending, reconcilePendingSessionsNow, resetPendingSessionsForTest } from './pendingSessionStore'
import { PENDING_SESSION_WAIT_MS } from './pendingSession'

afterEach(() => resetPendingSessionsForTest())

describe('the "Starting…" placeholder never outlives its row (OPENCODE.CORREÇÕES)', () => {
  test('a spawn that returns AFTER its row already landed resolves at once, with no further poll', () => {
    // opencode's ACP start took ~25 s: the fleet carried the row before the POST answered, and nothing changed afterwards.
    reconcilePendingSessionsNow(new Set(['7dc6c27eb1']))
    markSessionPending({ id: '7dc6c27eb1', harness: 'opencode', label: 'Teste' })
    // Other suites share this module-level store in one process: look only at this test's own entry.
    expect(getPendingSessionsSnapshot().pending.map(p => p.id)).not.toContain('7dc6c27eb1')
    expect(getPendingSessionsSnapshot().failed.map(p => p.id)).not.toContain('7dc6c27eb1')
  })

  test('a row that never comes is reported as failed by the clock, even on a quiet fleet', async () => {
    reconcilePendingSessionsNow(new Set(['other']))
    const orig = Date.now
    try {
      markSessionPending({ id: 'never', label: 'X' })
      expect(getPendingSessionsSnapshot().pending.map(p => p.id)).toContain('never')
      const t0 = orig()
      Date.now = () => t0 + PENDING_SESSION_WAIT_MS + 100
      await new Promise(r => setTimeout(r, PENDING_SESSION_WAIT_MS + 120))
    } finally { Date.now = orig }
    expect(getPendingSessionsSnapshot().failed.map(p => p.id)).toContain('never')
  }, PENDING_SESSION_WAIT_MS + 5000)
})
