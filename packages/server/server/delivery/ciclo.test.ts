import { describe, expect, test } from 'bun:test'
import { MERGE_POLL_MAX_MS, REVIEW_NUDGE_EVERY_MS, REVIEW_NUDGE_FIRST_MS, mergeScanDue, planReviewNudges, reconcileLine, waitingOnLeader } from './ciclo'
import { newDelivery, type DeliveryRecord, type Phase } from './machine'
import { pickMergedPr } from './gates'

const t0 = Date.parse('2026-11-07T00:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
function piece(phase: Phase, extra: Partial<DeliveryRecord> = {}): DeliveryRecord {
  const r = newDelivery({ subtaskId: 's1', taskId: 't1', at: iso(t0), phase })
  return Object.assign(r, extra)
}

describe('waitingOnLeader', () => {
  test('revisao_lider always waits on the leader; pr_merge/ci only with a REFUSED gate in this phase/revision', () => {
    expect(waitingOnLeader(piece('revisao_lider'))).toBe(true)
    expect(waitingOnLeader(piece('pr_merge'))).toBe(false)
    expect(waitingOnLeader(piece('ci', { tickNote: { at: iso(t0), phase: 'ci', revision: 1, reason: 'tag does not exist yet' } }))).toBe(false)
    expect(waitingOnLeader(piece('ci', { tickNote: { at: iso(t0), phase: 'ci', revision: 1, reason: 'release.yml failed', failed: true } }))).toBe(true)
    // A note from an older revision says nothing about now.
    expect(waitingOnLeader(piece('ci', { tickNote: { at: iso(t0), phase: 'ci', revision: 0, reason: 'x', failed: true } }))).toBe(false)
    expect(waitingOnLeader(piece('revisao_lider', { dequeued: { at: iso(t0), actor: 'l', reason: 'x' } }))).toBe(false)
    expect(waitingOnLeader(piece('executando'))).toBe(false)
  })
})

describe('planReviewNudges — 30 min, then every 2 h, max 3', () => {
  test('nothing before 30 min; the first at 30 min', () => {
    expect(planReviewNudges([piece('revisao_lider')], t0 + REVIEW_NUDGE_FIRST_MS - 1)).toEqual([])
    const due = planReviewNudges([piece('revisao_lider')], t0 + REVIEW_NUDGE_FIRST_MS)
    expect(due).toHaveLength(1)
    expect(due[0]).toMatchObject({ subtaskId: 's1', sent: 0 })
  })
  test('the second waits 2 h after the first; the fourth never comes', () => {
    const sent1 = piece('revisao_lider', { reviewNudge: { phase: 'revisao_lider', revision: 1, sent: 1, lastAt: iso(t0 + REVIEW_NUDGE_FIRST_MS) } })
    expect(planReviewNudges([sent1], t0 + REVIEW_NUDGE_FIRST_MS + REVIEW_NUDGE_EVERY_MS - 1)).toEqual([])
    expect(planReviewNudges([sent1], t0 + REVIEW_NUDGE_FIRST_MS + REVIEW_NUDGE_EVERY_MS)).toHaveLength(1)
    const sent3 = piece('revisao_lider', { reviewNudge: { phase: 'revisao_lider', revision: 1, sent: 3, lastAt: iso(t0) } })
    expect(planReviewNudges([sent3], t0 + 100 * 3600_000)).toEqual([])
  })
  test('a reminder of an OLDER phase/revision does not count — a new wait starts over', () => {
    const old = piece('revisao_lider', { revision: 3, reviewNudge: { phase: 'revisao_lider', revision: 1, sent: 3, lastAt: iso(t0) } })
    expect(planReviewNudges([old], t0 + REVIEW_NUDGE_FIRST_MS)).toHaveLength(1)
  })
  test('a leader action restarts the clock', () => {
    const touched = piece('revisao_lider', { leaderTouchedAt: iso(t0 + 20 * 60_000) })
    expect(planReviewNudges([touched], t0 + REVIEW_NUDGE_FIRST_MS)).toEqual([])
    expect(planReviewNudges([touched], t0 + 20 * 60_000 + REVIEW_NUDGE_FIRST_MS)).toHaveLength(1)
  })
  test('a failed attempt (nobody to reach) waits 30 min, never retries every minute', () => {
    const tried = piece('revisao_lider', { reviewNudge: { phase: 'revisao_lider', revision: 1, sent: 0, lastAttemptAt: iso(t0 + REVIEW_NUDGE_FIRST_MS) } })
    expect(planReviewNudges([tried], t0 + REVIEW_NUDGE_FIRST_MS + 60_000)).toEqual([])
    expect(planReviewNudges([tried], t0 + 2 * REVIEW_NUDGE_FIRST_MS)).toHaveLength(1)
  })
  test('a red release the leader was already told about counts as the first reminder', () => {
    const red = piece('ci', { releaseFailNotice: { at: iso(t0), reason: 'failed' }, tickNote: { at: iso(t0), phase: 'ci', revision: 1, reason: 'release.yml failed', failed: true } })
    expect(planReviewNudges([red], t0 + REVIEW_NUDGE_FIRST_MS)).toEqual([])
    expect(planReviewNudges([red], t0 + REVIEW_NUDGE_EVERY_MS)[0]).toMatchObject({ sent: 1 })
  })
  test('the reminder carries the tick reason', () => {
    const r = piece('revisao_lider', { tickNote: { at: iso(t0), phase: 'revisao_lider', revision: 1, reason: 'no merged PR proven' } })
    expect(planReviewNudges([r], t0 + REVIEW_NUDGE_FIRST_MS)[0]!.reason).toBe('no merged PR proven')
  })
})

describe('mergeScanDue — back-off', () => {
  test('first look-up at once; later a tenth of the time in the phase, 1..10 min', () => {
    expect(mergeScanDue(piece('revisao_lider'), t0)).toBe(true)
    const noted = (atMs: number) => piece('revisao_lider', { tickNote: { at: iso(atMs), phase: 'revisao_lider', revision: 1, reason: 'none' } })
    expect(mergeScanDue(noted(t0), t0 + 59_000)).toBe(false)
    expect(mergeScanDue(noted(t0), t0 + 60_000)).toBe(true)
    const late = t0 + 10 * 3600_000
    expect(mergeScanDue(noted(late), late + MERGE_POLL_MAX_MS - 1)).toBe(false)
    expect(mergeScanDue(noted(late), late + MERGE_POLL_MAX_MS)).toBe(true)
    expect(mergeScanDue(piece('ci'), t0)).toBe(false)
    expect(mergeScanDue(piece('executando'), t0)).toBe(false)
  })
})

describe('pickMergedPr', () => {
  const pr = (number: number, state: string, head?: string) => ({ number, state, ...(head ? { headRefOid: head } : {}), ...(state === 'MERGED' ? { mergeSha: `m${number}` } : {}) })
  test('one merged PR is the answer; an open/closed one is not', () => {
    expect(pickMergedPr([pr(7, 'MERGED')], [])).toMatchObject({ ok: true, pr: { number: 7 } })
    const none = pickMergedPr([pr(7, 'OPEN'), pr(8, 'CLOSED')], [])
    expect(none.ok).toBe(false)
    expect(!none.ok && none.reason).toContain('#7 (OPEN)')
    expect(pickMergedPr([], []).ok).toBe(false)
  })
  test('two merged PRs are ambiguous unless exactly one comes from the approved sha', () => {
    const two = pickMergedPr([pr(7, 'MERGED', 'a'), pr(9, 'MERGED', 'b')], [])
    expect(!two.ok && two.reason).toContain('ambiguous')
    expect(pickMergedPr([pr(7, 'MERGED', 'a'), pr(9, 'MERGED', 'b')], ['b'])).toMatchObject({ ok: true, pr: { number: 9 } })
  })
})

test('reconcileLine says what moved and what stays, with the reason', () => {
  expect(reconcileLine({ subtaskId: 's1', taskId: 't', from: 'revisao_lider', to: 'publicado', pr: 7, mergeSha: 'abcdef0123', tag: 'v2.201.1', applied: true })).toBe('s1\trevisao_lider → publicado ✔\tPR #7 abcdef012 v2.201.1')
  expect(reconcileLine({ subtaskId: 's2', taskId: 't', from: 'revisao_lider', reason: 'no merged PR proven' })).toBe('s2\trevisao_lider (fica)\tno merged PR proven')
})
