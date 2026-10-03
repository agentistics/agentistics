/**
 * session-source.test.ts — LIVE.2's merge rule over EVERY combination of its inputs (spec §4 + C3),
 * not a sample, with the owner's Q3: a deleted or expired transcript shows metrics only.
 */
import { describe, expect, test } from 'bun:test'
import type { TranscriptAvailability, TranscriptState } from '@agentistics/core'
import { planSessionSource, type SessionSourceInput } from './session-source'

const STATES: TranscriptState[] = ['present', 'not-yet-written', 'expired', 'deleted', 'unreadable']
const REASON: Record<TranscriptState, TranscriptAvailability['reason']> = {
  present: 'resolved', 'not-yet-written': 'live-no-file-yet', expired: 'past-retention', deleted: 'no-file-found', unreadable: 'read-failed',
}
const bools = [false, true]

function* all(): Generator<SessionSourceInput> {
  for (const enginePresent of bools) for (const surfaceFlag of bools) for (const projectionReady of bools)
    for (const state of STATES) for (const projected of bools) for (const projectedAttention of [0, 2]) for (const legacyReadOk of bools) {
      if (!projected && projectedAttention > 0) continue // attention rows live in the conversation's row
      yield { enginePresent, surfaceFlag, projectionReady, projected, projectedAttention, transcript: { state, reason: REASON[state] }, legacyReadOk }
    }
}

describe('planSessionSource — the whole table', () => {
  test('anything off (no engine, flag off, projection not ready) is legacy, whatever else is true', () => {
    for (const i of all()) {
      if (i.enginePresent && i.surfaceFlag && i.projectionReady) continue
      expect(planSessionSource(i)).toEqual({ from: 'legacy' })
    }
  })

  test('on: a PRESENT transcript always wins — it may only gain the attention markers no transcript carries', () => {
    for (const i of all()) {
      if (!(i.enginePresent && i.surfaceFlag && i.projectionReady) || i.transcript.state !== 'present') continue
      const r = planSessionSource(i)
      if (i.legacyReadOk && i.projectedAttention > 0) expect(r).toEqual({ from: 'legacy+overlay', overlay: 'attention' })
      else expect(r).toEqual({ from: 'legacy' })
    }
  })

  test('on: not-yet-written and unreadable stay legacy (their own sentence; a failed read is not a gone transcript)', () => {
    for (const i of all()) {
      if (!(i.enginePresent && i.surfaceFlag && i.projectionReady)) continue
      if (i.transcript.state === 'not-yet-written' || i.transcript.state === 'unreadable') expect(planSessionSource(i)).toEqual({ from: 'legacy' })
    }
  })

  test('on: expired or deleted + the journal knows the conversation → METRICS ONLY; otherwise legacy (its sentence, unchanged)', () => {
    for (const i of all()) {
      if (!(i.enginePresent && i.surfaceFlag && i.projectionReady)) continue
      if (i.transcript.state !== 'expired' && i.transcript.state !== 'deleted') continue
      expect(planSessionSource(i)).toEqual(i.projected ? { from: 'metrics', transcript: i.transcript } : { from: 'legacy' })
    }
  })

  test('the rule never answers anything outside the three shapes, and "metrics" always names why', () => {
    let n = 0
    for (const i of all()) {
      n++
      const r = planSessionSource(i)
      expect(['legacy', 'legacy+overlay', 'metrics']).toContain(r.from)
      if (r.from === 'metrics') expect(r.transcript.state === 'expired' || r.transcript.state === 'deleted').toBe(true)
    }
    expect(n).toBe(8 * 5 * 3 * 2)
  })
})
