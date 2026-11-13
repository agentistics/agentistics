/**
 * Power check for the benchmark verdict (NOT part of the test suite).
 *
 * Part 1 — verdict rates per design (tasks × reps) for six scenarios that vary quality as well as cost/time:
 *   (a) candidate accepted 90% vs reference 70%, same cost
 *   (b) the same, candidate 1.25× dearer
 *   (c) the same, candidate 2× dearer
 *   (d) both arms 90% accepted, candidate 2× dearer and 2× slower
 *   (e) both arms 90% accepted, candidate 1.5× dearer
 *   (f) equal arms at 90% accepted (false-verdict rate)
 * Part 2 — what drives the width (12×3, scenarios d and f): the median width of the final interval and of each
 *   type's points interval, then the final width again leaving out one metric at a time.
 *
 *   bun run packages/server/scripts/benchmark-power.ts [experiments-per-cell=200] [resamples=400]
 *
 * Noise: the fixture values (per-run cost ±30%, task spread exp(±0.3)). ~/agentistics-workspace/leader/metodo/
 * analise.json holds only per-delivery medians/means (cost, active minutes), not within-task repetition noise,
 * so it cannot calibrate these and is NOT used.
 *
 * Reads nothing, writes nothing, spends nothing: pure simulation over @agentistics/core/benchmark.
 */
import { mulberry32, verdict, type Verdict, type VerdictSample } from '@agentistics/core/benchmark'
import { SCORE_TYPES, computeScore } from '../../core/src/benchmark/score'

const EXPERIMENTS = Number(process.argv[2] ?? 200)
const RESAMPLES = Number(process.argv[3] ?? 400)
const DESIGNS: [number, number][] = [[8, 2], [12, 3], [20, 2]]
const NOISE = 0.3, SPREAD = 0.3

interface Scenario { key: string; label: string; candAccept: number; refAccept: number; cost: number; time: number }
const SCENARIOS: Scenario[] = [
  { key: 'a', label: 'accepted 90 vs 70, same cost', candAccept: 0.9, refAccept: 0.7, cost: 1, time: 1 },
  { key: 'b', label: 'accepted 90 vs 70, cand 1.25x dearer', candAccept: 0.9, refAccept: 0.7, cost: 1.25, time: 1 },
  { key: 'c', label: 'accepted 90 vs 70, cand 2x dearer', candAccept: 0.9, refAccept: 0.7, cost: 2, time: 1 },
  { key: 'd', label: 'both 90, cand 2x dearer and 2x slower', candAccept: 0.9, refAccept: 0.9, cost: 2, time: 2 },
  { key: 'e', label: 'both 90, cand 1.5x dearer', candAccept: 0.9, refAccept: 0.9, cost: 1.5, time: 1 },
  { key: 'f', label: 'equal arms at 90 (false verdicts)', candAccept: 0.9, refAccept: 0.9, cost: 1, time: 1 },
]

function gen(tasks: number, reps: number, sc: Scenario, rng: () => number): VerdictSample[] {
  const factors = Array.from({ length: tasks }, () => Math.exp((rng() * 2 - 1) * SPREAD))
  const out: VerdictSample[] = []
  for (const [id, rate, cost, time] of [['cand', sc.candAccept, sc.cost, sc.time], ['ref', sc.refAccept, 1, 1]] as const) {
    for (let t = 0; t < tasks; t++) {
      for (let rep = 0; rep < reps; rep++) {
        const accepted = rng() < rate
        const jit = () => 1 + (rng() * 2 - 1) * NOISE
        out.push({
          taskId: `t${t}`, armId: id, rep, accepted,
          costUSD: cost * factors[t]! * jit(),
          wallMs: 60_000 * time * jit(),
          defects: accepted ? (rng() < 0.2 ? 1 : 0) : 1 + (rng() < 0.5 ? 1 : 0),
          severeDefects: accepted ? 0 : (rng() < 0.4 ? 1 : 0),
          humanInterventions: 0,
          harnesses: { h: { sessions: 1, withCost: 1 } },
        })
      }
    }
  }
  return out
}

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)]! : NaN }
const pct = (n: number) => `${((n / EXPERIMENTS) * 100).toFixed(0)}%`.padStart(4)

function tally(tasks: number, reps: number, sc: Scenario, seed: number): Record<Verdict, number> {
  const rng = mulberry32(seed)
  const t: Record<Verdict, number> = { pays: 0, does_not_pay: 0, tie: 0, insufficient: 0 }
  for (let e = 0; e < EXPERIMENTS; e++) {
    const samples = gen(tasks, reps, sc, rng)
    t[verdict({ samples, candidate: 'cand', reference: 'ref', size: 'M', seed: e + 1, resamples: RESAMPLES }).verdict]++
  }
  return t
}

console.log(`# Power check — ${EXPERIMENTS} experiments per cell, ${RESAMPLES} resamples (default in production: 10000)`)
console.log(`Noise: cost ±${NOISE * 100}% per run, task spread exp(±${SPREAD}); wall time ±${NOISE * 100}%. Defects: accepted 20% one; rejected 1-2, severe 40%.`)
console.log('Cells: pays / does_not_pay / tie / insufficient.\n')
console.log('## Verdict rates')
console.log(`| scenario | ${DESIGNS.map(([t, r]) => `${t}×${r}`).join(' | ')} |`)
console.log(`|---|${DESIGNS.map(() => '---').join('|')}|`)
for (const sc of SCENARIOS) {
  const cols = DESIGNS.map(([tasks, reps], i) => {
    const t = tally(tasks, reps, sc, 7000 + 100 * tasks + 10 * reps + i + sc.key.charCodeAt(0))
    return `${pct(t.pays)} / ${pct(t.does_not_pay)} / ${pct(t.tie)} / ${pct(t.insufficient)}`
  })
  console.log(`| (${sc.key}) ${sc.label} | ${cols.join(' | ')} |`)
}

// ---------------------------------------------------------------------------------------------- width drivers
console.log('\n## What drives the width (12×3) — median width in points')
const EXCLUSIONS: [string, string[]][] = [
  ['none', []],
  ['- inconsistent-tasks', ['inconsistent-tasks']],
  ['- cost-spread', ['cost-spread']],
  ['- severe-defects-per-run', ['severe-defects-per-run']],
  ['- defects-per-run', ['defects-per-run']],
]
for (const key of ['d', 'f']) {
  const sc = SCENARIOS.find(s => s.key === key)!
  const rng = mulberry32(99_000 + key.charCodeAt(0))
  const widths: Record<string, number[]> = {}
  const push = (k: string, v: number | null | undefined) => { if (typeof v === 'number') (widths[k] ??= []).push(v) }
  for (let e = 0; e < EXPERIMENTS; e++) {
    const samples = gen(12, 3, sc, rng)
    for (const [name, exclude] of EXCLUSIONS) {
      const r = computeScore({ samples, candidate: 'cand', reference: 'ref', seed: e + 1, resamples: RESAMPLES, delta: 0.1, excludeMetrics: exclude })
      if (r.final.lo !== null && r.final.hi !== null) push(`final ${name}`, r.final.hi - r.final.lo)
      if (name === 'none') for (const t of SCORE_TYPES) push(`type ${t}`, r.types[t].hi !== null && r.types[t].lo !== null ? r.types[t].hi! - r.types[t].lo! : null)
    }
  }
  console.log(`\n### (${key}) ${sc.label}`)
  console.log('| interval | median width |')
  console.log('|---|---|')
  for (const t of SCORE_TYPES) console.log(`| ${t} points (max ${{ quality: 40, cost: 30, time: 20, reliability: 10 }[t]}) | ${median(widths[`type ${t}`] ?? []).toFixed(1)} |`)
  for (const [name] of EXCLUSIONS) console.log(`| final, ${name === 'none' ? 'all metrics' : name} | ${median(widths[`final ${name}`] ?? []).toFixed(1)} |`)
}
