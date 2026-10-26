import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  effectiveWindow, meterDiscontinuity, parseAntigravityModels, planBudget, planPace, planThresholdNotices,
  routeRecommendation, scopeForModel, scopeIds, scopedView, tightestScope, windowKey,
  type AccountBudget, type PlanLimits, type PlanLimitScope, type ScopeBudget,
} from './planLimits'

const fx = (n: string) => JSON.parse(readFileSync(join(import.meta.dir, '__fixtures__', n), 'utf8'))
const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Date.parse('2026-10-28T12:00:00Z')
const RESET = NOW + 4 * DAY

const gemini: PlanLimitScope = { id: 'google', label: 'Gemini models', models: ['gemini-3-pro-high', 'Gemini 3 Pro (High)'], providers: ['google'] }
const claudeGpt: PlanLimitScope = { id: 'anthropic+openai', label: 'Claude and GPT models', models: ['claude-sonnet-4-6', 'gpt-oss-120b'], providers: ['anthropic', 'openai'] }

const scoped = (g: number, c: number): PlanLimits => ({
  harness: 'antigravity', account: 'acc_1', sourcePlan: 'Google AI Plus', updatedAt: NOW, source: 'antigravity-quota-api',
  windows: ([
    { kind: 'week', usedPct: g, resetsAt: RESET, scope: gemini },
    { kind: 'week', usedPct: c, resetsAt: RESET + HOUR, scope: claudeGpt },
  ] as PlanLimits['windows']).sort((a, b) => b.usedPct - a.usedPct),
})

describe('scoped helpers', () => {
  test('windowKey: bare kind unscoped, kind:scope when scoped', () => {
    expect(windowKey({ kind: 'week' })).toBe('week')
    expect(windowKey({ kind: '5h' })).toBe('5h')
    expect(windowKey({ kind: 'week', scope: gemini })).toBe('week:google')
  })
  test('scopeIds, scopedView and scopeForModel', () => {
    const l = scoped(4, 0)
    expect(scopeIds(l).sort()).toEqual(['anthropic+openai', 'google'])
    expect(scopedView(l, 'google').windows.map(windowKey)).toEqual(['week:google'])
    expect(scopeForModel(l, 'GEMINI-3-PRO-HIGH')?.id).toBe('google')
    expect(scopeForModel(l, 'Gpt-OSS-120B')?.id).toBe('anthropic+openai')
    expect(scopeForModel(l, 'nope')).toBeUndefined()
  })
  test('tightestScope picks the fullest week, ties by earliest reset then id', () => {
    expect(tightestScope(scoped(96, 10), NOW)?.id).toBe('google')
    expect(tightestScope(scoped(4, 0), NOW)?.id).toBe('google')
    expect(tightestScope(scoped(10, 50), NOW)?.id).toBe('anthropic+openai')
    expect(tightestScope(scoped(20, 20), NOW)?.id).toBe('google')
  })
  test('the projected window of a renewed scoped window keeps its scope', () => {
    const w = effectiveWindow({ kind: 'week', usedPct: 50, resetsAt: NOW - HOUR, scope: gemini }, NOW)
    expect(w.projected).toBe(true)
    expect(w.scope).toBe(gemini)
  })
  test('an unscoped window projects with no scope key at all', () => {
    expect('scope' in effectiveWindow({ kind: 'week', usedPct: 50, resetsAt: NOW - HOUR }, NOW)).toBe(false)
  })
})

describe('budget and pace per group', () => {
  test('without a model: the tightest group (Gemini 96 % / Claude 10 %)', () => {
    const b = planBudget(scoped(96, 10), NOW)
    expect(b.scope).toBe('google')
    expect(b.weekPct).toBe(96)
    expect(b.status).toBe('hold')
  })
  test('a model picks its own group', () => {
    const b = planBudget(scoped(96, 10), NOW, { model: 'claude-sonnet-4-6' })
    expect(b.scope).toBe('anthropic+openai')
    expect(b.weekPct).toBe(10)
    expect(b.status).toBe('ok')
  })
  test('planPace is measured on the group view', () => {
    const p = planPace(scoped(96, 10), NOW, [], [], undefined, { model: 'claude-sonnet-4-6' })
    expect(p.pauseUntil).toBeUndefined()
    expect(planPace(scoped(96, 10), NOW).pauseUntil).toBe(RESET)
  })
  test('an unscoped record has no scope field', () => {
    const l: PlanLimits = { harness: 'claude', account: 'default', updatedAt: NOW, source: 'claude-stream', windows: [{ kind: 'week', usedPct: 10, resetsAt: RESET }] }
    expect('scope' in planBudget(l, NOW)).toBe(false)
  })
})

describe('routing with groups', () => {
  const sb = (scope: PlanLimitScope, weekPct: number, status: ScopeBudget['status']): ScopeBudget => ({
    scope, weekPct, weekResetsAt: RESET, daysToWeekReset: 4, dailyBudgetPct: 10, status,
    paceStatus: 'under', freeSlots: status === 'hold' ? 0 : 2, suggestedParallel: 2,
  })
  const agyRow = (g: ScopeBudget, c: ScopeBudget): AccountBudget => ({
    ...planBudget(scoped(96, 10), NOW), account: 'acc_1', plan: 'Google AI Plus', scopes: [g, c],
    // the top-level row is the tightest group
    status: 'hold', freeSlots: 0, suggestedParallel: 0,
  })

  test('a held group does not hold the other', () => {
    const r = routeRecommendation([agyRow(sb(gemini, 96, 'hold'), sb(claudeGpt, 10, 'ok'))], 'spec-impl')
    expect(r.harness).toBe('antigravity')
    expect(r.scope).toBe('anthropic+openai')
    expect(r.model).toBe('claude-sonnet-4-6')
  })
  test('every group held = no route', () => {
    const r = routeRecommendation([agyRow(sb(gemini, 96, 'hold'), sb(claudeGpt, 97, 'hold'))], 'spec-impl')
    expect(r.harness).toBeNull()
  })
  test('qa authored by claude never returns the anthropic scope', () => {
    const r = routeRecommendation([agyRow(sb(gemini, 10, 'ok'), sb(claudeGpt, 0, 'ok'))], 'qa', 'claude')
    expect(r.scope).toBe('google')
    const only = routeRecommendation([agyRow(sb(gemini, 96, 'hold'), sb(claudeGpt, 0, 'ok'))], 'qa', 'claude')
    expect(only.harness).toBeNull()
  })
  test('qa authored by codex excludes the openai group too', () => {
    const r = routeRecommendation([agyRow(sb(gemini, 96, 'hold'), sb(claudeGpt, 0, 'ok'))], 'qa', 'codex')
    expect(r.harness).toBeNull()
  })
  test('antigravity is not a lead/design route', () => {
    const r = routeRecommendation([agyRow(sb(gemini, 10, 'ok'), sb(claudeGpt, 0, 'ok'))], 'lead')
    expect(r.harness).toBe('antigravity') // only eligible harness: preference only orders, never excludes
    const withClaude = routeRecommendation([
      { ...planBudget({ harness: 'claude', account: 'default', updatedAt: NOW, source: 'claude-stream', windows: [{ kind: 'week', usedPct: 10, resetsAt: RESET }] }, NOW), plan: 'Max', account: 'a' },
      agyRow(sb(gemini, 10, 'ok'), sb(claudeGpt, 0, 'ok')),
    ], 'lead')
    expect(withClaude.harness).toBe('claude')
  })
})

describe('notices and discontinuity by windowKey', () => {
  test('unscoped notice keys are the historical strings', () => {
    const l: PlanLimits = { harness: 'claude', account: 'default', updatedAt: NOW, source: 'claude-stream', windows: [{ kind: 'week', usedPct: 80, resetsAt: RESET }, { kind: '5h', usedPct: 80, resetsAt: NOW + HOUR }] }
    expect(Object.keys(planThresholdNotices({}, l).state).sort()).toEqual(['claude:default:5h', 'claude:default:week'])
  })
  test('scoped windows notify separately and carry their scope', () => {
    const { notices, state } = planThresholdNotices({}, scoped(90, 80))
    expect(Object.keys(state).sort()).toEqual(['antigravity:acc_1:week:anthropic+openai', 'antigravity:acc_1:week:google'])
    expect(notices.map(n => [n.scope?.id, n.threshold]).sort()).toEqual([['anthropic+openai', 75], ['google', 85]])
    expect(notices.find(n => n.scope?.id === 'google')?.scope?.label).toBe('Gemini models')
  })
  test('meterDiscontinuity pairs windows by key, not by kind', () => {
    const prev = scoped(60, 5)
    // Gemini fell 60 -> 5 with a moved reset (login switch); the other group is steady.
    const next: PlanLimits = { ...prev, updatedAt: NOW + HOUR, windows: [
      { kind: 'week', usedPct: 5, resetsAt: RESET + 3 * HOUR, scope: gemini },
      { kind: 'week', usedPct: 5, resetsAt: RESET + HOUR, scope: claudeGpt },
    ] }
    expect(meterDiscontinuity(prev, next)).toBe(true)
    // Matching by kind alone would compare Gemini's new reading with the Claude/GPT group's and miss it.
    const steady = { ...next, windows: [{ ...next.windows[0]!, usedPct: 60, resetsAt: RESET }, next.windows[1]!] }
    expect(meterDiscontinuity(prev, steady)).toBe(false)
  })
})

describe('parseAntigravityModels', () => {
  const AT = Date.parse('2026-10-28T12:00:00Z')
  test('two groups, tightest first, ignored ids absent', () => {
    const l = parseAntigravityModels(fx('agy-fetch-models.json'), AT)!
    expect(l.harness).toBe('antigravity')
    expect(l.source).toBe('antigravity-quota-api')
    expect(l.account).toBe('default')
    expect(l.updatedAt).toBe(AT)
    expect(l.windows.map(w => [w.kind, w.scope!.id, w.usedPct])).toEqual([['week', 'google', 4], ['week', 'anthropic+openai', 0]])
    const [g, c] = l.windows
    expect(g!.resetsAt).toBe(Date.parse('2026-11-01T16:26:00Z'))
    expect(c!.resetsAt).toBe(Date.parse('2026-11-01T16:40:00Z'))
    expect(g!.scope!.label).toBe('Gemini models')
    expect(c!.scope!.label).toBe('Claude and GPT models')
    expect(g!.scope!.providers).toEqual(['google'])
    expect(c!.scope!.providers).toEqual(['anthropic', 'openai'])
    expect(c!.scope!.models).toEqual(['claude-sonnet-4-6', 'gpt-oss-120b', 'Claude Sonnet 4.6', 'GPT-OSS 120B'])
    expect(JSON.stringify(l)).not.toMatch(/chat_x|tab_x/)
    expect(scopeForModel(l, 'Gemini 3 Flash')?.id).toBe('google')
  })
  test('a group whose models carry a remainingFraction below the others takes the minimum', () => {
    const body = { models: {
      a: { modelProvider: 'MODEL_PROVIDER_GOOGLE', quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-01T16:26:00Z' } },
      b: { modelProvider: 'MODEL_PROVIDER_GOOGLE', quotaInfo: { remainingFraction: 0.7, resetTime: '2026-11-01T16:27:00Z' } },
    } }
    expect(parseAntigravityModels(body, AT)!.windows.map(w => w.usedPct)).toEqual([30])
  })
  test('R1: a group with a reset and remainingFraction OMITTED is not observed (never 0 % used)', () => {
    const l = parseAntigravityModels(fx('agy-fetch-models-missing-fraction.json'), AT)!
    expect(l.windows.map(w => w.scope!.id)).toEqual(['google'])
    expect(l.windows.some(w => w.scope!.id === 'anthropic+openai')).toBe(false)
  })
  test('a model with a null/absent resetTime is ignored', () => {
    const l = parseAntigravityModels(fx('agy-fetch-models-null-reset.json'), AT)!
    expect(l.windows.map(w => w.scope!.id)).toEqual(['anthropic+openai'])
  })
  test('a group renewing beyond a week is dropped, not mislabelled', () => {
    const l = parseAntigravityModels(fx('agy-fetch-models-far-reset.json'), AT)!
    expect(l.windows.map(w => w.scope!.id)).toEqual(['google'])
  })
  test('unknown shapes give null', () => {
    for (const b of [null, 'x', {}, { models: [] }, { models: { a: { modelProvider: 'MODEL_PROVIDER_GOOGLE' } } }]) {
      expect(parseAntigravityModels(b, AT)).toBeNull()
    }
    expect(parseAntigravityModels(fx('agy-fetch-models.json'), NaN)).toBeNull()
  })
  test('fixtures hold no email, token or real project id', () => {
    for (const n of ['agy-fetch-models.json', 'agy-fetch-models-missing-fraction.json', 'agy-fetch-models-null-reset.json', 'agy-fetch-models-far-reset.json']) {
      expect(readFileSync(join(import.meta.dir, '__fixtures__', n), 'utf8')).not.toMatch(/@|ya29|access_token|project/i)
    }
  })
})
