/**
 * Power check for the benchmark verdict (NOT part of the test suite).
 *
 * For each design (tasks × reps) and each TRUE cost-per-accepted ratio (candidate ÷ reference), simulate
 * seeded experiments and report how often each verdict comes out. Equal acceptance rate in both arms,
 * so the cost ratio is the whole difference. Two scenarios:
 *   cost-only   — only cost differs (time, quality, reliability equal)
 *   cost+time   — the dearer arm is also proportionally slower (a team is dearer AND slower)
 *
 *   bun run packages/server/scripts/benchmark-power.ts [experiments-per-cell=300] [resamples=500]
 *
 * Reads nothing, writes nothing, spends nothing: pure simulation over @agentistics/core/benchmark.
 */
import { makeSamples, mulberry32, verdict, type Verdict } from '@agentistics/core/benchmark'

const EXPERIMENTS = Number(process.argv[2] ?? 300)
const RESAMPLES = Number(process.argv[3] ?? 500)
const DESIGNS: [number, number][] = [[8, 2], [8, 3], [12, 2], [12, 3], [20, 2]]
const RATIOS = [1.0, 1.25, 1.5, 2.0]
const ACCEPT = 0.7

type Tally = Record<Verdict, number>

function cell(tasks: number, reps: number, ratio: number, withTime: boolean, seed: number): Tally {
  const rng = mulberry32(seed)
  const t: Tally = { pays: 0, does_not_pay: 0, tie: 0, insufficient: 0 }
  for (let e = 0; e < EXPERIMENTS; e++) {
    const samples = makeSamples({
      tasks, reps, seed: Math.floor(rng() * 1e9), taskSpread: 0.3,
      arms: [
        { id: 'cand', cost: ratio, acceptRate: ACCEPT, noise: 0.3, wallMs: 60_000 * (withTime ? ratio : 1) },
        { id: 'ref', cost: 1, acceptRate: ACCEPT, noise: 0.3, wallMs: 60_000 },
      ],
    })
    // random (not evenly spread) acceptance with the same true rate
    for (const s of samples) s.accepted = rng() < ACCEPT
    t[verdict({ samples, candidate: 'cand', reference: 'ref', size: 'M', seed: e + 1, resamples: RESAMPLES }).verdict]++
  }
  return t
}

const pct = (n: number) => `${((n / EXPERIMENTS) * 100).toFixed(0)}%`.padStart(4)

console.log(`# Power check — ${EXPERIMENTS} experiments per cell, ${RESAMPLES} resamples, acceptance ${ACCEPT * 100}% in both arms`)
console.log('Verdict shown as: pays / does_not_pay / tie / insufficient. True ratio = candidate cost per accepted ÷ reference (>1: candidate dearer).\n')
for (const withTime of [false, true]) {
  console.log(`## ${withTime ? 'cost + time scale together' : 'cost only'}`)
  console.log(`| tasks×reps | ${RATIOS.map(r => `ratio ${r.toFixed(2)}`).join(' | ')} |`)
  console.log(`|---|${RATIOS.map(() => '---').join('|')}|`)
  for (const [tasks, reps] of DESIGNS) {
    const cols = RATIOS.map((r, i) => {
      const t = cell(tasks, reps, r, withTime, 1000 * tasks + 10 * reps + i)
      return `${pct(t.pays)} / ${pct(t.does_not_pay)} / ${pct(t.tie)} / ${pct(t.insufficient)}`
    })
    console.log(`| ${tasks}×${reps} | ${cols.join(' | ')} |`)
  }
  console.log()
}
