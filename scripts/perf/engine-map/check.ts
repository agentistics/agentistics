/**
 * scripts/perf/engine-map/check.ts — the 09 §8 budgets over one bench result.
 *
 *   bun scripts/perf/engine-map/check.ts <bench-*.json> [--budgets scripts/perf/budgets.json]
 *
 * Prints the verdict table, emits `::warning::` annotations for an exceeded `warn` budget (and
 * `::error::` for a `fail` one), appends the table to $GITHUB_STEP_SUMMARY when set. Exit 1 only when a
 * budget at level `fail` is over — today every budget is `warn`, so this reports and stays green.
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { annotations, coverageAnnotations, evaluate, exitCode, harnessCoverage, renderBudgets, renderCoverage, type BenchResult, type Budgets } from './budgets.ts'

const argv = process.argv.slice(2)
const file = argv.find(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--budgets')
if (!file) { console.error('usage: check.ts <bench-*.json> [--budgets budgets.json]'); process.exit(2) }
const bi = argv.indexOf('--budgets')
const budgetsFile = bi >= 0 ? argv[bi + 1]! : join(import.meta.dir, '..', 'budgets.json')

const result = await Bun.file(file).json() as BenchResult
const all = await Bun.file(budgetsFile).json() as { engineMap?: Budgets }
if (!all.engineMap) { console.error(`no "engineMap" section in ${budgetsFile}`); process.exit(2) }

const results = evaluate(result, all.engineMap)
const table = renderBudgets(results)
const warned = results.filter(r => r.verdict === 'over').length
const skipped = results.filter(r => r.verdict === 'skipped').length
const coverage = harnessCoverage(result)
const md = `### ENGINE.MAP budgets (09 §8) — ${result.label ?? 'bench'}\n\n${table}\n\n${warned} over · ${skipped} not measured by this plan · ${results.length - warned - skipped} within budget.\n\n#### Per harness\n\n${renderCoverage(coverage)}\n`
console.log(md)
for (const a of [...annotations(results), ...coverageAnnotations(coverage)]) console.log(a)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`)
process.exit(exitCode(results))
