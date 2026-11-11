import { describe, expect, test } from 'bun:test'
import {
  buildForecastCohorts, estimateEta, resolvePieceForecast, prepareForecastHistory, type Sample, type StageTypical,
} from './task-live'
import type { TaskDetail } from './task-report'

const H = 3600_000
const NOW = Date.parse('2026-11-09T10:00:00Z')
const samples = (hours: number[], harness = 'codex'): Sample[] => hours.map((h, i) => ({
  key: `${harness}-p${i}`, harness, model: 'sol', taskType: 'feature', endpoint: 'publication',
  startedAtMs: NOW - (24 + h) * H, completedAtMs: NOW - 24 * H, durationMs: h * H,
}))
const forecast = (extra: Partial<Parameters<typeof resolvePieceForecast>[0]> = {}) => resolvePieceForecast({
  nowMs: NOW, startedAtMs: null, stage: 'queue', sinceMs: null, origin: null,
  harness: 'codex', model: 'sol', taskType: 'feature', samples: [], typicals: {}, ...extra,
})

describe('Rule 5 publication forecast', () => {
  test('a leader with no stage history is anchored to its stage ceiling, not now', () => {
    const since = NOW - H
    const input = { stage: 'leader' as const, startedAtMs: since, sinceMs: since, typicals: {} }
    const first = forecast(input).publishEta
    expect(first).toMatchObject({ kind: 'estimate', source: 'stages', confidence: 'low', atMs: since + 6 * 24 * H })
    expect(forecast({ ...input, nowMs: NOW + H }).publishEta).toMatchObject({ kind: 'estimate', atMs: since + 6 * 24 * H, source: 'stages' })
    expect(forecast({ ...input, nowMs: since + 3 * 24 * H }).publishEta).toMatchObject({ kind: 'none', reason: 'beyond-range' })
  })

  test('a queue piece stuck past its ceiling never gets a publish time in the past', () => {
    const stuck = forecast({ stage: 'queue', sinceMs: NOW - 30 * 24 * H, typicals: {} })
    expect(stuck.publishEta.kind).toBe('none')
    expect(stuck.stageEta.kind).toBe('none')
    const since = NOW - H
    const fresh = forecast({ stage: 'queue', sinceMs: since, typicals: {} })
    expect(fresh.publishEta.kind).toBe('estimate')
    if (fresh.publishEta.kind === 'estimate') expect(fresh.publishEta.atMs).toBeGreaterThan(NOW)
    const later = forecast({ stage: 'queue', sinceMs: since, typicals: {}, nowMs: NOW + H })
    expect(later.publishEta).toMatchObject({ kind: 'estimate', atMs: fresh.publishEta.kind === 'estimate' ? fresh.publishEta.atMs : -1 })
  })

  test('worked example: four similar published pieces give 12:00–14:00, center 13:00', () => {
    const f = forecast({ stage: 'running', startedAtMs: NOW - H, samples: samples([3, 4, 4, 5]) })
    expect(f.publishEta).toMatchObject({ kind: 'estimate', atMs: NOW + 3 * H,
      earliestAtMs: NOW + 2 * H, latestAtMs: NOW + 4 * H, confidence: 'medium',
      basis: { scope: 'type-harness-model', endpoint: 'publication', n: 4, statistic: 'median' } })
  })
  test('worked example: general mean gives 11:00–22:00 if started now, low, n=3', () => {
    expect(forecast({ samples: samples([2, 4, 6], 'claude') }).publishEta).toMatchObject({
      kind: 'estimate', source: 'general', atMs: NOW + 4 * H, earliestAtMs: NOW + H,
      latestAtMs: NOW + 12 * H, confidence: 'low', n: 3,
      assumption: 'if-started-now', queueTimeUnknown: true,
      basis: { scope: 'general', statistic: 'mean', endpoint: 'publication' },
    })
  })
  test('bootstrap has n=0 and its own versioned source', () => {
    expect(forecast().publishEta).toMatchObject({ kind: 'estimate', source: 'bootstrap',
      atMs: NOW + 4 * H, earliestAtMs: NOW + H, latestAtMs: NOW + 12 * H,
      n: 0, confidence: 'low', methodVersion: 'registration-forecast-v1', basis: { scope: 'bootstrap' } })
  })
  test('overrun keeps a future interval after the median', () => {
    expect(forecast({ stage: 'running', startedAtMs: NOW - 4.5 * H,
      samples: samples([3, 4, 4, 5]) }).publishEta).toMatchObject({ kind: 'estimate',
      overrun: true, earliestAtMs: NOW + H / 4, latestAtMs: NOW + H / 2, atMs: NOW + H / 4 })
  })
  test('revised-overrun after restart reuses a persisted bucket anchor without poll drift', () => {
    const input = { stage: 'running' as const, startedAtMs: NOW - 6 * H, samples: samples([3, 4, 4, 5]) }
    const first = forecast(input).publishEta
    expect(first.kind).toBe('estimate')
    if (first.kind !== 'estimate') return
    const persisted = JSON.parse(JSON.stringify({ anchorAtMs: first.overrunAnchorAtMs }))
    const restarted = forecast({ ...input, nowMs: NOW + H / 6, overrunAnchorAtMs: persisted.anchorAtMs }).publishEta
    expect(restarted).toMatchObject({ kind: 'estimate', source: 'revised-overrun',
      atMs: first.atMs, earliestAtMs: first.earliestAtMs, latestAtMs: first.latestAtMs,
      overrunAnchorAtMs: first.overrunAnchorAtMs })
    const next = forecast({ ...input, nowMs: NOW + H, overrunAnchorAtMs: persisted.anchorAtMs }).publishEta
    expect(next.kind === 'estimate' && next.overrunAnchorAtMs).toBe(first.overrunAnchorAtMs! + H)
  })
  test('blocked work is conditional after resumption and keeps its reason', () => {
    expect(forecast({ stage: 'blocked', startedAtMs: NOW - 100 * H, blockReason: 'dependency' }).publishEta)
      .toMatchObject({ kind: 'estimate', conditional: 'blocked', blockReason: 'dependency',
        assumption: 'after-resumption', earliestAtMs: NOW + H, latestAtMs: NOW + 12 * H })
  })
  test('queued work uses a known future hold, bounded below by now', () => {
    expect(forecast({ scheduledAtMs: NOW + 2 * H }).publishEta).toMatchObject({ kind: 'estimate',
      earliestAtMs: NOW + 3 * H, latestAtMs: NOW + 14 * H, assumption: 'scheduled-start', queueTimeUnknown: false })
    expect(forecast({ scheduledAtMs: NOW - H }).publishEta).toMatchObject({ earliestAtMs: NOW + H })
  })
  test('complete stage composition is preferred and sums widened intervals', () => {
    const typical: StageTypical = { medianMs: H, p25Ms: H, p75Ms: H, n: 8 }
    const f = forecast({ stage: 'running', startedAtMs: NOW - H / 2, sinceMs: NOW - H / 2,
      typicals: { running: typical, qa: typical, leader: typical, merge: typical, ci: typical } })
    expect(f.publishEta).toMatchObject({ kind: 'estimate', source: 'stages', atMs: NOW + 4.5 * H,
      earliestAtMs: NOW + 3.25 * H, latestAtMs: NOW + 5.75 * H, confidence: 'high', n: 8 })
    expect(f.eta).toMatchObject({ kind: 'estimate', atMs: NOW + 4.5 * H })
  })
  test('one unknown stage falls back once to a whole-piece estimate', () => {
    expect(forecast({ stage: 'qa', startedAtMs: NOW - H, sinceMs: NOW - H / 2,
      typicals: { qa: { medianMs: H, p75Ms: H, n: 4 } } }).publishEta)
      .toMatchObject({ source: 'bootstrap', atMs: NOW + 3 * H })
  })
  test('work spans stay separate from publication and always use low-confidence widening', () => {
    const work = samples([1, 1, 1, 1]).map(s => ({ ...s, endpoint: 'work-span' as const }))
    const c = buildForecastCohorts([...work, ...samples([2, 4, 6], 'claude')], NOW)
    expect(forecast({ cohorts: c }).publishEta).toMatchObject({ source: 'general', basis: { endpoint: 'publication', n: 3 } })
    expect(forecast({ samples: work }).publishEta).toMatchObject({ confidence: 'low', source: 'general',
      earliestAtMs: NOW + H / 4, latestAtMs: NOW + 3 * H, basis: { endpoint: 'work-span' } })
  })
  test('cohorts bound valid terminal pieces by date/count and diagnose exclusions', () => {
    const valid = Array.from({ length: 510 }, (_, i) => ({ ...samples([4])[0]!, key: `v${i}`, completedAtMs: NOW - i * H }))
    const invalid = [
      { ...valid[0]!, key: 'old', completedAtMs: NOW - 91 * 24 * H },
      { ...valid[0]!, key: 'abandoned', abandoned: true },
      { ...valid[0]!, key: 'recovered', recovered: true },
      { ...valid[0]!, key: 'rollup', rollup: true },
      { ...valid[0]!, key: 'invalid', durationMs: Infinity },
    ]
    // Give all entries real, ordered start times after changing their completion stamp.
    const c = buildForecastCohorts([...valid, ...invalid].map(s => ({ ...s, startedAtMs: s.completedAtMs! - s.durationMs })), NOW)
    expect(c.sampleCount).toBe(500)
    expect(c.exclusions).toMatchObject({ outsideWindow: 1, abandoned: 1, recovered: 1, rollup: 1, invalid: 1, capped: 10 })
  })
  test('indexed lookup agrees with direct estimation and terminal pieces remain final', () => {
    const xs = samples([3, 4, 4, 5])
    const input = { nowMs: NOW, startedAtMs: NOW - H, harness: 'codex', model: 'sol', taskType: 'feature' }
    expect(estimateEta({ ...input, samples: xs })).toEqual(estimateEta({ ...input, cohorts: buildForecastCohorts(xs, NOW) }))
    expect(forecast({ stage: 'published' }).publishEta).toEqual({ kind: 'none', reason: 'final' })
  })
  test('cohort relaxation skips missing type/model and needs three samples at each level', () => {
    const xs = samples([3, 4, 5]).map((s, i) => ({ ...s, model: `model-${i}` }))
    expect(forecast({ samples: xs }).publishEta).toMatchObject({ basis: { scope: 'type-harness', n: 3 } })
    expect(forecast({ samples: xs, taskType: null }).publishEta).toMatchObject({ basis: { scope: 'harness', n: 3 } })
    expect(forecast({ samples: xs.slice(0, 2) }).publishEta).toMatchObject({ source: 'bootstrap', n: 0 })
  })
  test('real published endpoints include review waits; sessions and parents do not multiply samples', () => {
    const iso = (n: number) => new Date(n).toISOString()
    const d = {
      task: { id: 't', type: 'feature', status: 'done' }, comments: [],
      subtasks: [
        { id: 'g', isGroup: true, status: 'done' },
        { id: 'leaf', parentGroupId: 'g', status: 'done' },
      ],
      sessions: ['g', 'leaf', 'leaf'].map((subtaskId, i) => ({
        id: `s${i}`, subtaskId, harness: 'codex', model: 'sol', createdAt: iso(NOW - 6 * H), endedAt: iso(NOW - 4 * H),
      })),
      subtaskRollups: ['g', 'leaf'].map(id => ({ id, times: {
        source: 'sessions', startedAt: iso(NOW - 6 * H), completedAt: iso(NOW - 4 * H), durationMs: 2 * H,
      } })),
    } as unknown as TaskDetail
    const h = prepareForecastHistory({ details: [d], events: [], nowMs: NOW,
      deliveries: new Map(['g', 'leaf'].map(id => [id, { phase: 'publicado', publishedAt: iso(NOW - H) }])) })
    expect(h.cohorts.sampleCount).toBe(1)
    expect(h.cohorts.exclusions.rollup).toBe(1)
    expect(h.cohorts.samples[0]).toMatchObject({ endpoint: 'publication', durationMs: 5 * H })
  })
})
