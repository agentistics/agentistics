import { describe, expect, test } from 'bun:test'
import { ANTIGA_AFTER_MS, RECONCILE_SCOPE_MS, antigaComment, inReconcileScope, isAntiga } from './antigas'

const NOW = Date.parse('2026-11-08T12:00:00Z')
const H = 3600_000

describe('antigas classification', () => {
  test('a record-less piece untouched for over 24 h with nobody alive is antiga', () => {
    expect(isAntiga({ hasRecord: false, live: false, updatedMs: NOW - 25 * H, nowMs: NOW })).toBe(true)
  })
  test('a recent piece stays in review (≤ 24 h)', () => {
    expect(isAntiga({ hasRecord: false, live: false, updatedMs: NOW - ANTIGA_AFTER_MS, nowMs: NOW })).toBe(false)
    expect(isAntiga({ hasRecord: false, live: false, updatedMs: NOW - 2 * H, nowMs: NOW })).toBe(false)
  })
  test('a live session or a delivery record keeps it in review whatever its age', () => {
    expect(isAntiga({ hasRecord: false, live: true, updatedMs: NOW - 900 * H, nowMs: NOW })).toBe(false)
    expect(isAntiga({ hasRecord: true, live: false, updatedMs: NOW - 900 * H, nowMs: NOW })).toBe(false)
  })
  test('an unknown age is never old', () => {
    expect(isAntiga({ hasRecord: false, live: false, updatedMs: null, nowMs: NOW })).toBe(false)
  })
})

describe('reconcile scope', () => {
  const base = { hasRecord: false, live: false, nowMs: NOW, mentioned: false }
  test('a record, a release-PR mention or a touch within 30 days is in scope; older and unmentioned is not', () => {
    expect(inReconcileScope({ ...base, hasRecord: true, updatedMs: NOW - 400 * 24 * H })).toBe(true)
    expect(inReconcileScope({ ...base, mentioned: true, updatedMs: NOW - 400 * 24 * H })).toBe(true)
    expect(inReconcileScope({ ...base, updatedMs: NOW - RECONCILE_SCOPE_MS + H })).toBe(true)
    expect(inReconcileScope({ ...base, updatedMs: NOW - RECONCILE_SCOPE_MS - H })).toBe(false)
  })
})

describe('antiga comments', () => {
  test('publish names the version only when given; archive keeps the reason', () => {
    expect(antigaComment('publish', { version: '2.203.0' })).toContain('v2.203.0')
    expect(antigaComment('publish', {})).not.toContain('na v')
    expect(antigaComment('archive', { reason: 'obsolete' })).toContain('obsolete')
  })
})
