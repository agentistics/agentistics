import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __resetPlanLimitsForTest, ingestPlanLimits, latestCodexLimits, noteStructuredLine, planLimitsPayload,
  setPlanLimitsSink,
} from './plan-limits'

const fx = (n: string) => readFileSync(join(import.meta.dir, '../../core/src/__fixtures__', n), 'utf8').trim()
let dir = ''
beforeEach(() => { __resetPlanLimitsForTest(); dir = mkdtempSync(join(tmpdir(), 'pl-test-')) })
afterEach(() => { setPlanLimitsSink(null); if (dir.includes('pl-test-')) rmSync(dir, { recursive: true, force: true }) })

test('codex: the newest rate_limits line of a rollout tail', async () => {
  const p = join(dir, 'rollout-x.jsonl')
  const line = fx('plan-limits-codex.jsonl')
  writeFileSync(p, `{"type":"session_meta"}\n${line}\n{"type":"event_msg","payload":{"type":"agent_message"}}\n`)
  const l = await latestCodexLimits(p)
  expect(l?.harness).toBe('codex')
  expect(l?.windows).toHaveLength(2)
})

test('claude: a relayed stream line is stored; older records never replace newer', async () => {
  const rec = JSON.parse(fx('plan-limits-claude.jsonl')) as { t: number; l: string }
  let changed = 0
  setPlanLimitsSink({ changed: () => { changed++ }, notify: () => {} })
  noteStructuredLine(rec.l, rec.t)
  noteStructuredLine('{"type":"assistant"}', rec.t + 1)
  await new Promise(r => setTimeout(r, 10))
  const { limits } = await planLimitsPayload(undefined)
  expect(limits.map(l => l.harness)).toEqual(['claude'])
  expect(changed).toBe(1)
  const older = { ...limits[0]!, updatedAt: rec.t - 1000 }
  expect(await ingestPlanLimits(older)).toBe(false)
})

test('notices fire once per threshold, the 100% one names an alternative with room', async () => {
  const told: [number, string | null][] = []
  setPlanLimitsSink({ changed: () => {}, notify: (n, alt) => told.push([n.threshold, alt]) })
  const R = Date.now() + 3_600_000
  await ingestPlanLimits({ harness: 'codex', account: 'default', windows: [{ kind: '5h', usedPct: 10, resetsAt: R }], updatedAt: 1, source: 'codex-rollout' })
  const c = (pct: number, at: number) => ingestPlanLimits({ harness: 'claude', account: 'default', windows: [{ kind: '5h', usedPct: pct, resetsAt: R }], updatedAt: at, source: 'claude-stream' })
  await c(80, 2); await c(82, 3); await c(100, 4); await c(100, 5)
  expect(told).toEqual([[75, null], [100, 'codex']])
})
