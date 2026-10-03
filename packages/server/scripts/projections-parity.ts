#!/usr/bin/env bun
/**
 * projections-parity — the surface-level parity check (P3 / A4.4, A4.6) on REAL data: every figure a
 * surface shows, computed by its legacy path (`/api/data`, `buildApiResponse`) and by its projected
 * path (`/api/runtime/metrics`, the same query in-process), compared row by row.
 *
 *   bun packages/server/scripts/projections-parity.ts \
 *     --data-dir <COPY of the data dir> --projections <COPY of projections.db> [--surface mcp|tui|all] \
 *     [--journal <COPY of journal.db>] [--legacy-cache <file.json>] [--json <report.json>]
 *
 * `--journal` first catches the store up on that journal (a projection whose version changed is
 * rebuilt there, exactly as the server would at start), so the check runs the projections as shipped.
 *
 * READ-ONLY by construction: it refuses the live data dir and any path inside it. Building the legacy
 * answer writes its caches into `--data-dir`, and opening a store may create its tables — so both must
 * be copies (`VACUUM INTO` for the databases). Transcripts are only read.
 *
 * Beside the verdict it ATTRIBUTES the differences, session by session (Claude, joined on the
 * conversation id): sessions the journal does not hold, subagent spend, and pricing.
 */
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}

const dataDir = arg('data-dir')
const projectionsPath = arg('projections')
const surface = arg('surface') ?? 'all'
if (!dataDir || !projectionsPath) {
  console.error('usage: projections-parity --data-dir <copy> --projections <copy of projections.db> [--surface mcp|tui|all]')
  process.exit(2)
}
const live = resolve(homedir(), '.agentistics')
const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p))
const journalPath = arg('journal')
for (const p of [dataDir, projectionsPath, ...(journalPath ? [journalPath] : [])]) {
  const r = real(p)
  if (r === live || r.startsWith(`${live}/`)) {
    console.error(`refused: ${p} is the live data dir — run on copies (VACUUM INTO for the databases)`)
    process.exit(2)
  }
}

process.env.AGENTISTICS_DIR = resolve(dataDir)
process.env.AGENTISTICS_PROJECTIONS = '1'

const { buildApiResponse } = await import('../server/data')
const { openProjectionStore } = await import('../server/projections/store')
const { createProjectionReader } = await import('../server/projections/reader')
const { STORED_PROJECTIONS } = await import('../server/projections/catalog')
const { parseMetricsQuery, runMetricsQuery } = await import('../server/runtime-metrics-query')
const { calcCost } = await import('@agentistics/core')
const legacyMcp = await import('../../mcp/legacy-analytics')
const projectedMcp = await import('../../mcp/projected-analytics')
const parity = await import('../../mcp/surface-parity')
const tuiFigures = await import('../../tui/src/projected-figures')

type Report = import('../../mcp/surface-parity').ParityReport

// ── the two inputs ──────────────────────────────────────────────────────────────────────────────
const cachePath = arg('legacy-cache')
let data: any
if (cachePath && existsSync(cachePath)) data = await Bun.file(cachePath).json()
else {
  const t0 = performance.now()
  data = await buildApiResponse()
  console.error(`legacy /api/data built in ${Math.round(performance.now() - t0)} ms`)
  if (cachePath) await Bun.write(cachePath, JSON.stringify(data))
}
const store = await openProjectionStore({ path: resolve(projectionsPath), projections: STORED_PROJECTIONS })
if (journalPath) {
  const { openJournal } = await import('../server/journal/journal')
  const { catchUpProjections } = await import('../server/projections/catch-up')
  const journal = await openJournal({ path: resolve(journalPath) })
  const t0 = performance.now()
  const r = await catchUpProjections({ journal, store, env: process.env })
  console.error(`catch-up on the journal copy: ${r.state}, ${r.eventsRead} events, ${Math.round(performance.now() - t0)} ms; ${r.projections.map(p => `${p.name} ${p.mode}`).join(', ')}`)
  await journal.close?.()
}
const reader = createProjectionReader(store)
const query: import('../../mcp/projected-analytics').MetricsQueryFn = async (p) => {
  const parsed = parseMetricsQuery(p)
  if (!parsed.ok) return { ok: false, status: 400, error: JSON.stringify(parsed) }
  return { ok: true, body: await runMetricsQuery(reader, parsed.query) }
}

// The sessions the journal holds (Claude conversation ids): the second pass compares the legacy
// arithmetic over ONLY these, which separates "the journal lacks it" from "the two paths disagree".
const covered = new Set<string>()
for await (const f of reader.runFacts({})) covered.add(f.conversationId ?? f.sessionId)
for await (const f of reader.costFacts({})) covered.add(f.conversationId ?? f.sessionId)
const coveredData = {
  ...data,
  sessions: (data.sessions ?? []).filter((s: any) => covered.has(s.session_id)),
  harnesses: [...new Set((data.sessions ?? []).filter((s: any) => covered.has(s.session_id)).map((s: any) => s.harness ?? 'claude'))],
  statsCache: {},
}

// ── the surfaces ────────────────────────────────────────────────────────────────────────────────
const reports: Report[] = []
if (surface === 'mcp' || surface === 'all') {
  const F = parity.MCP_PARITY_FIELDS
  for (const [scope, d] of [['', data], [' (journal-covered)', coveredData]] as const) {
    for (const harness of [undefined, 'claude']) {
      const tag = `${harness ? `[${harness}]` : '[all]'}${scope}`
      reports.push(parity.compareObject(`mcp summary ${tag}`, legacyMcp.legacySummary(d, harness) as any, await projectedMcp.projectedSummary(query, harness) as any, F.agentistics_summary))
      reports.push(parity.compareRows(`mcp projects ${tag}`, legacyMcp.legacyProjects(d, harness) as any, await projectedMcp.projectedProjects(query, harness) as any, F.agentistics_projects.key, F.agentistics_projects.fields))
      reports.push(parity.compareRows(`mcp costs ${tag}`, legacyMcp.legacyCosts(d, harness) as any, await projectedMcp.projectedCosts(query, harness) as any, F.agentistics_costs.key, F.agentistics_costs.fields))
      reports.push(parity.compareRows(`mcp repos ${tag}`, legacyMcp.legacyRepos(d, harness) as any, await projectedMcp.projectedRepos(query, harness) as any, F.agentistics_repos.key, F.agentistics_repos.fields))
    }
    reports.push(parity.compareRows(`mcp harnesses${scope}`, legacyMcp.legacyHarnesses(d) as any, await projectedMcp.projectedHarnesses(query) as any, F.agentistics_harnesses.key, F.agentistics_harnesses.fields))
  }
}
if (surface === 'tui' || surface === 'all') {
  // The TUI's legacy Claude row is `statsCache` (whole history), so the covered pass, which has no
  // statsCache, reads Claude as 0 there: judge the covered TUI pass on projects and models only.
  const projected = await tuiFigures.projectedFigures(query)
  for (const [scope, d] of [['', data], [' (journal-covered)', coveredData]] as const) {
    const legacy = tuiFigures.legacyFigures(d)
    reports.push(parity.compareObject(`tui totals${scope}`, legacy.totals as any, projected.totals as any, ['sessions', 'tokens', 'costUSD']))
    reports.push(parity.compareRows(`tui harnesses${scope}`, legacy.harnesses as any, projected.harnesses as any, 'harness', ['sessions', 'tokens', 'costUSD']))
    reports.push(parity.compareRows(`tui projects${scope}`, legacy.projects as any, projected.projects as any, 'path', ['sessions', 'tokens', 'costUSD']))
    reports.push(parity.compareRows(`tui models${scope}`, legacy.models as any, projected.models as any, 'model', ['tokens', 'costUSD']))
  }
}

// ── attribution, session by session ─────────────────────────────────────────────────────────────
const tok = (t: any) => (t.input ?? 0) + (t.output ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0)
const proj = new Map<string, { main: number; sub: number; mainCost: number; models: Set<string> }>()
const harnessesInJournal = new Set<string>()
for await (const f of reader.costFacts({})) {
  harnessesInJournal.add(f.harness)
  const k = f.conversationId ?? f.sessionId
  const p = proj.get(k) ?? { main: 0, sub: 0, mainCost: 0, models: new Set<string>() }
  if (f.subagent) p.sub += tok(f.tokens)
  else { p.main += tok(f.tokens); p.mainCost += f.costUSD ?? 0; if (f.model) p.models.add(f.model) }
  proj.set(k, p)
}
const byHarness: Record<string, { legacy: number; inJournal: number }> = {}
let matched = 0, mainTokensEqual = 0, subagentSessions = 0, singleModel = 0, costEqualAt1h = 0, costEqualAsLegacy = 0
for (const s of data.sessions ?? []) {
  const h = s.harness ?? 'claude'
  const b = (byHarness[h] ??= { legacy: 0, inJournal: 0 })
  b.legacy++
  const p = proj.get(s.session_id)
  if (!p) continue
  b.inJournal++
  matched++
  const L = (s.input_tokens ?? 0) + (s.output_tokens ?? 0) + (s.cache_read_input_tokens ?? 0) + (s.cache_creation_input_tokens ?? 0)
  if (L === p.main) mainTokensEqual++
  if (p.sub > 0) subagentSessions++
  if (p.models.size !== 1) continue
  singleModel++
  const model = [...p.models][0]!
  const usage = { inputTokens: s.input_tokens ?? 0, outputTokens: s.output_tokens ?? 0, cacheReadInputTokens: s.cache_read_input_tokens ?? 0, cacheCreationInputTokens: s.cache_creation_input_tokens ?? 0, webSearchRequests: 0, costUSD: 0 }
  const split = s.cache_creation_1h_input_tokens !== undefined && s.cache_creation_5m_input_tokens !== undefined
    ? { cacheCreation1hInputTokens: s.cache_creation_1h_input_tokens, cacheCreation5mInputTokens: s.cache_creation_5m_input_tokens } : {}
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.005, a * 0.001)
  if (near(calcCost({ ...usage, ...split }, model), p.mainCost)) costEqualAt1h++
  if (near(calcCost(usage, model), p.mainCost)) costEqualAsLegacy++
}
const attribution = {
  harnessesInJournal: [...harnessesInJournal].sort(),
  sessionsByHarness: byHarness,
  joinedSessions: matched,
  mainAgentTokensEqual: mainTokensEqual,
  sessionsWithSubagentSpend: subagentSessions,
  singleModelSessions: singleModel,
  costEqualPricedWith1hCacheSplit: costEqualAt1h,
  costEqualPricedAsLegacy: costEqualAsLegacy,
}
const status = await reader.status()
store.close()

// ── output ──────────────────────────────────────────────────────────────────────────────────────
const verdict = reports.filter(r => !r.surface.includes('(journal-covered)')).every(r => r.equal) ? 'PASS' : 'FAIL'
for (const r of reports) {
  console.log(`${r.equal ? 'EQUAL' : 'DIFF '}  ${r.surface.padEnd(24)} rows ${r.rowsLegacy}→${r.rowsProjected}  matched ${r.matchedRows}  only-legacy ${r.onlyLegacy.length}  only-projected ${r.onlyProjected.length}  field diffs ${r.diffs.length}`)
  for (const d of r.diffs.slice(0, 4)) console.log(`         ${d.key} ${d.field}: ${JSON.stringify(d.legacy)} → ${JSON.stringify(d.projected)}`)
}
console.log('attribution', JSON.stringify(attribution, null, 2))
console.log('projections', JSON.stringify(status))
console.log(`verdict ${verdict}`)
const out = arg('json')
if (out) await Bun.write(join(out), JSON.stringify({ verdict, reports, attribution, status }, null, 2))
process.exit(0)
