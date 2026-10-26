import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseAntigravityModels } from '@agentistics/core'
import { createHarnessAccounts, __setHarnessAccountsForTest } from './harness-accounts'
import { resetHarnessSpawnability } from './sessions/harness-spawnable'
import { planLimitsTool } from '../../mcp/plan-limits-tool'
import { __resetPlanLimitsForTest, __setLiveTranscriptPathForTest, __setManagedLookupForTest, ingestPlanLimits, planLimitsPayload } from './plan-limits'
import { appendPoint, pointOf, type HistoryPoint } from './plan-history'

const fixture = JSON.parse(readFileSync(join(import.meta.dir, '../../core/src/__fixtures__/agy-fetch-models.json'), 'utf8'))
const NOW = Date.parse('2026-10-28T12:00:00Z')
let dir = ''
let savedPath: string | undefined
let savedHome: string | undefined
beforeEach(() => {
  __resetPlanLimitsForTest()
  resetHarnessSpawnability()
  __setManagedLookupForTest(async () => [])
  __setLiveTranscriptPathForTest(async () => null)
  dir = mkdtempSync(join(tmpdir(), 'pl-test-'))
  savedPath = process.env.PATH
  savedHome = process.env.HOME
  process.env.PATH = dir
  process.env.HOME = dir
  for (const bin of ['claude', 'codex', 'agy']) {
    writeFileSync(join(dir, bin), '#!/bin/sh\nexit 0\n')
    chmodSync(join(dir, bin), 0o755)
  }
  __setHarnessAccountsForTest(createHarnessAccounts({ file: join(dir, 'accounts.json'), probe: async () => ({ key: 'default', label: 'Conta padrão' }) }))
})
afterEach(() => {
  process.env.PATH = savedPath
  process.env.HOME = savedHome
  resetHarnessSpawnability()
  __setManagedLookupForTest(null)
  __setLiveTranscriptPathForTest(null)
  if (dir.includes('pl-test-')) rmSync(dir, { recursive: true, force: true })
})

const agyRecord = () => {
  const l = parseAntigravityModels(fixture, NOW)!
  return l
}

test('an agy record is ONE row, tightest group on top, one ScopeBudget per group', async () => {
  expect(await ingestPlanLimits(agyRecord())).toBe(true)
  const body = await planLimitsPayload(undefined, NOW + 1000)
  const rows = body.budgets.filter(b => b.harness === 'antigravity')
  expect(rows).toHaveLength(1)
  const row = rows[0]!
  expect(row.scope).toBe('google')
  expect(row.weekPct).toBeCloseTo(4, 0)
  expect(row.scopes?.map(s => s.scope.id).sort()).toEqual(['anthropic+openai', 'google'])
  const claudeGpt = row.scopes!.find(s => s.scope.id === 'anthropic+openai')!
  expect(claudeGpt.weekPct).toBe(0)
  expect(row.scopes!.find(s => s.scope.id === 'google')!.weekPct).toBeCloseTo(4, 0)
  expect(row.weekPct).toBeGreaterThanOrEqual(claudeGpt.weekPct)
})

test('claude/codex rows carry no scope fields', async () => {
  await ingestPlanLimits({
    harness: 'claude', account: 'default', plan: 'Max',
    windows: [{ kind: 'week', usedPct: 10, resetsAt: NOW + 86_400_000 }], updatedAt: NOW, source: 'claude-stream',
  })
  const row = (await planLimitsPayload(undefined, NOW + 1000)).budgets.find(b => b.harness === 'claude')!
  expect('scopes' in row).toBe(false)
  expect('scope' in row).toBe(false)
})

test('MCP passes scopes through and routes qa authored by claude to the Gemini group', async () => {
  await ingestPlanLimits(agyRecord())
  const body = await planLimitsPayload(undefined, NOW + 1000)
  const out = planLimitsTool({ kind: 'qa', authorHarness: 'claude' }, body as never) as { budgets: { scopes?: unknown[] }[]; recommendation?: { harness: string | null; scope?: string } }
  expect(out.budgets.find((b: any) => b.harness === 'antigravity')?.scopes).toHaveLength(2)
  if (out.recommendation?.harness === 'antigravity') expect(out.recommendation.scope).toBe('google')
})

test('history: a scoped point keeps the tightest group flat and each group under scopes', () => {
  const p = pointOf(agyRecord())
  expect(p.weekPct).toBeCloseTo(4, 0)
  expect(Object.keys(p.scopes!).sort()).toEqual(['anthropic+openai', 'google'])
  expect(p.scopes!['anthropic+openai']!.weekPct).toBe(0)
})

test('history: an unscoped point has no scopes key; a legacy point without scopes still appends', () => {
  const p = pointOf({ harness: 'claude', account: 'default', windows: [{ kind: 'week', usedPct: 5, resetsAt: NOW }], updatedAt: NOW, source: 'claude-stream' })
  expect('scopes' in p).toBe(false)
  const legacy: HistoryPoint = { at: NOW - 600_000, weekPct: 1, fiveHourPct: null }
  expect(appendPoint([legacy], pointOf(agyRecord()))).toHaveLength(2)
})

test('history: points in one bucket merge per scope', () => {
  const a: HistoryPoint = { at: NOW, weekPct: 4, fiveHourPct: null, scopes: { google: { weekPct: 4 } } }
  const b: HistoryPoint = { at: NOW + 1000, weekPct: 4, fiveHourPct: null, scopes: { 'anthropic+openai': { weekPct: 0 } } }
  expect(appendPoint([a], b).at(-1)!.scopes).toEqual({ google: { weekPct: 4 }, 'anthropic+openai': { weekPct: 0 } })
})
