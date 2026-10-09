/**
 * scripts/perf/engine-map/budgets.ts — PURE: the 09 §8 budgets read off an ENGINE.MAP bench result.
 *
 * `bench.ts` writes one JSON (`rows[]` per N sessions × C clients condition, plus `soak`); this turns it
 * into a list of verdicts against the `engineMap` section of `scripts/perf/budgets.json`:
 *
 *   level 'warn'  — an exceeded budget is reported (annotation + summary) and the job stays green;
 *   level 'fail'  — an exceeded budget fails the job. Phase 4 flips the levels, not this code.
 *
 * A metric the plan did not measure is `skipped` — never `ok`. (`quick` has no N=50 row and no soak; a
 * budget reported as passed over a condition nobody ran is the confident zero this repo refuses.)
 */

export interface BenchRow {
  n: number; c: number
  cpuSelf: number; cpuChildren: number
  tmuxPerMin: number
  fleetKB: number
  sendEchoP95?: number; answerLagP95?: number
  switchFirstP95?: number
  perHarness?: Record<string, { linked: boolean; ack: string; sendAck: number | null; echo: number | null; shown: number | null; idle: number | null; chatGetMs: number | null; chatKB: number | null }>
}
export interface BenchResult { label?: string; rows: BenchRow[]; soak?: { slopeMBh: number } | null }

export type Level = 'warn' | 'fail'
export interface BudgetDef {
  /** What the number is, in the words of 09 §8. */
  label: string
  max: number
  /**
   * Noise allowance as a fraction of `max` (default `DEFAULT_TOLERANCE`): a measured value fails only
   * above `max × (1 + tolerance)`. The budget stays the number 09 §8 states; the tolerance is what a
   * shared 2-core CI runner needs so a good build is not failed by one slow tick. A value between
   * `max` and the ceiling is reported `near` (annotation, job stays green).
   */
  tolerance?: number
  level: Level
  unit: string
  /** Where the value comes from — documentation for the table, not logic. */
  from?: string
  /** For `tmuxPerMinN50`: the smallest fleet the budget is stated for. */
  minN?: number
}
export type Budgets = Record<string, BudgetDef>

export type Verdict = 'ok' | 'near' | 'over' | 'skipped'

/** 10 %: documented in README.md § Budgets. */
export const DEFAULT_TOLERANCE = 0.1
export interface BudgetResult { key: string; label: string; unit: string; max: number; level: Level; value: number | null; verdict: Verdict; note?: string; ceiling: number }

const fin = (x: number | undefined | null): x is number => typeof x === 'number' && Number.isFinite(x)
const round1 = (x: number) => Math.round(x * 10) / 10

/** The fleet size the budgets 09 §8 states "N=10" for. */
export const BUDGET_FLEET = 10

/** The row of one condition. With several rows for the same n/c (never, today) the last one wins. */
export function rowOf(rows: BenchRow[], n: number, c: number): BenchRow | undefined {
  let found: BenchRow | undefined
  for (const r of rows) if (r.n === n && r.c === c) found = r
  return found
}

/** The measured value of each budget key, `null` when this run did not measure it. */
export function measure(result: BenchResult): Record<string, { value: number | null; note?: string }> {
  const rows = result.rows ?? []
  const out: Record<string, { value: number | null; note?: string }> = {}
  const cpu = (r: BenchRow | undefined) => r && fin(r.cpuSelf) && fin(r.cpuChildren) ? r.cpuSelf + r.cpuChildren : null

  // Probes run on the conditions with at least one client; the busiest one carries the p95s.
  const probed = rows.filter(r => r.n >= BUDGET_FLEET && r.c > 0 && fin(r.sendEchoP95))
  const probeRow = probed.sort((a, b) => b.c - a.c)[0] ?? rows.filter(r => r.c > 0 && fin(r.sendEchoP95)).sort((a, b) => b.n - a.n || b.c - a.c)[0]
  const nOf = (r?: BenchRow) => r ? ` (N=${r.n}, C=${r.c})` : ''
  out.switchFirstP95Ms = { value: fin(probeRow?.switchFirstP95) ? probeRow!.switchFirstP95! : null, note: nOf(probeRow) }
  out.sendToEchoP95Ms = { value: fin(probeRow?.sendEchoP95) ? probeRow!.sendEchoP95! : null, note: nOf(probeRow) }
  out.writeToShownP95Ms = { value: fin(probeRow?.answerLagP95) ? probeRow!.answerLagP95! : null, note: nOf(probeRow) }

  const idle = cpu(rowOf(rows, BUDGET_FLEET, 0))
  out.idleCpuPct = { value: idle === null ? null : round1(idle), note: ` (N=${BUDGET_FLEET}, C=0)` }

  // Per client: the CPU the clients added, divided by how many there were, at the same fleet size.
  // Compare against the busiest condition measured; C=0 is the baseline.
  const base = cpu(rowOf(rows, BUDGET_FLEET, 0))
  const loaded = rows.filter(r => r.n === BUDGET_FLEET && r.c > 0).sort((a, b) => b.c - a.c)[0]
  const loadedCpu = cpu(loaded)
  out.perClientCpuPct = base !== null && loaded && loadedCpu !== null
    ? { value: round1(Math.max(0, loadedCpu - base) / loaded.c), note: ` (Δ C=0 → C=${loaded.c} at N=${BUDGET_FLEET})` }
    : { value: null }

  // tmux/min is stated for N=50 with one client; a smaller fleet is shown in the table but is not that claim.
  const big = rows.filter(r => r.c === 1).sort((a, b) => b.n - a.n)[0]
  out.tmuxPerMinN50 = big && big.n >= 50
    ? { value: big.tmuxPerMin, note: ` (N=${big.n}, C=1)` }
    : { value: null, note: big ? ` (this plan reached N=${big.n}, the budget is stated for N=50)` : '' }

  // The first /api/fleet payload — the largest median over the conditions (grows with the fleet).
  const kbs = rows.map(r => r.fleetKB).filter(fin)
  out.fleetFirstFrameKB = { value: kbs.length ? round1(Math.max(...kbs)) : null }

  out.soakSlopeMBh = fin(result.soak?.slopeMBh) ? { value: result.soak!.slopeMBh } : { value: null, note: ' (no soak in this plan)' }
  return out
}

export function evaluate(result: BenchResult, budgets: Budgets): BudgetResult[] {
  const m = measure(result)
  return Object.entries(budgets).map(([key, def]) => {
    const got = m[key]
    const value = got?.value ?? null
    const ceiling = Math.round(def.max * (1 + (def.tolerance ?? DEFAULT_TOLERANCE)) * 1000) / 1000
    const verdict: Verdict = value === null ? 'skipped' : value <= def.max ? 'ok' : value <= ceiling ? 'near' : 'over'
    return { key, label: def.label, unit: def.unit, max: def.max, level: def.level, value, verdict, note: got?.note, ceiling }
  })
}

/** The exit code: 1 only when a budget at level `fail` is over. `warn` never fails the job. */
export function exitCode(results: BudgetResult[]): number {
  return results.some(r => r.verdict === 'over' && r.level === 'fail') ? 1 : 0
}

const ICON: Record<Verdict, string> = { ok: '✅', near: '🟡', over: '⚠️', skipped: '➖' }

/** A GitHub-flavoured markdown table for the job summary. */
export function renderBudgets(results: BudgetResult[]): string {
  const lines = ['| budget | measured | ceiling | level | |', '|---|---|---|---|---|']
  for (const r of results) {
    const mark = r.verdict === 'over' ? (r.level === 'fail' ? '❌' : ICON.over) : ICON[r.verdict]
    lines.push(`| ${r.label} | ${r.value === null ? 'not measured' : `${r.value} ${r.unit}`}${r.note ?? ''} | ≤ ${r.max} ${r.unit}${r.ceiling !== r.max ? ` (fails > ${r.ceiling})` : ''} | ${r.level} | ${mark} ${r.verdict} |`)
  }
  return lines.join('\n')
}

/** `::warning::` / `::error::` workflow commands — one line per exceeded budget. */
export function annotations(results: BudgetResult[]): string[] {
  return results.filter(r => r.verdict === 'over' || r.verdict === 'near').map(r =>
    r.verdict === 'near'
      ? `::warning title=ENGINE.MAP bench budget::${r.label}: ${r.value} ${r.unit} > ${r.max} ${r.unit}, inside the ${r.ceiling} ${r.unit} tolerance`
      : `::${r.level === 'fail' ? 'error' : 'warning'} title=ENGINE.MAP bench budget::${r.label}: ${r.value} ${r.unit} > ${r.ceiling} ${r.unit} (${r.level})`)
}

/** The six CLI harnesses the fleet is built from (bench.ts's `HARNESSES`; the native one has no CLI to fake). */
export const BENCH_HARNESSES = ['claude', 'codex', 'gemini', 'copilot', 'kimi', 'antigravity'] as const

export interface CoverageFinding { harness: string; problem: string }

/**
 * Equal compatibility, checked: the aggregate p95s above can look fine while one harness never answered
 * at all. Reads the last condition that probed each harness and names — per harness — what is missing:
 * not in the fleet, never echoed, never shown, or not linked to its conversation (an unlinked row draws
 * an empty chat). A WARNING list, not a budget: it says which harness, which a ceiling cannot.
 */
export function harnessCoverage(result: BenchResult, expected: readonly string[] = BENCH_HARNESSES): CoverageFinding[] {
  const last = [...(result.rows ?? [])].reverse().find(r => r.perHarness)
  if (!last?.perHarness) return expected.map(harness => ({ harness, problem: 'no per-harness probe ran in this plan' }))
  const out: CoverageFinding[] = []
  for (const h of expected) {
    const p = last.perHarness[h]
    if (!p) { out.push({ harness: h, problem: 'was not probed (no live session of this harness in the fleet)' }); continue }
    if (!p.linked) out.push({ harness: h, problem: 'session is not linked to its conversation (the chat view stays empty)' })
    if (!fin(p.echo)) out.push({ harness: h, problem: 'a sent prompt never echoed in the chat' })
    if (!fin(p.shown)) out.push({ harness: h, problem: 'the harness\'s answer never reached the chat' })
  }
  return out
}

export function renderCoverage(findings: CoverageFinding[]): string {
  if (findings.length === 0) return 'Every harness in the fleet was probed, linked, echoed and shown.'
  return ['| harness | finding |', '|---|---|', ...findings.map(f => `| ${f.harness} | ⚠️ ${f.problem} |`)].join('\n')
}

export function coverageAnnotations(findings: CoverageFinding[]): string[] {
  return findings.map(f => `::warning title=ENGINE.MAP bench harness::${f.harness}: ${f.problem}`)
}
