/**
 * test-preload.ts — loaded by `bun test` before any test file (bunfig.toml `[test] preload`).
 *
 * Marks the run (`AGENTISTICS_TEST_RUNNER_PID`, inherited by every process a test starts) and, when
 * the run ends — normally, or by SIGINT/SIGTERM — ends whatever still carries the mark. A relay that
 * survives the runner being SIGKILLed or OOM-killed is handled by the relay itself, which watches the
 * same pid (`structured-relay.ts`). See `test-orphans.ts` for the scope and why it is that narrow.
 *
 * A leaked RELAY-FAMILY process fails the run: a test that starts a structured session must end it.
 */
import { afterAll } from 'bun:test'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { applySweep, planSweep, readProcs, RUNNER_ENV } from './test-orphans'

const ROOT = resolve(import.meta.dir, '..')
const RUNNER = process.pid
process.env[RUNNER_ENV] = String(RUNNER)

let swept = false
function sweep(): number {
  if (swept) return 0
  swept = true
  const plan = planSweep(readProcs(), RUNNER, [ROOT, tmpdir()])
  if (plan.kill.length === 0) return 0
  applySweep(plan)
  const short = (c: string) => c.split(ROOT).join('.').slice(0, 160)
  if (plan.relays.length > 0) {
    console.error(`\n[test-orphans] FAIL: ${plan.relays.length} structured relay process(es) outlived their test (killed now):`)
    for (const c of plan.relays) console.error(`  ${short(c)}`)
  }
  if (plan.others.length > 0) {
    console.error(`\n[test-orphans] ${plan.others.length} other process(es) outlived their test (killed now):`)
    for (const c of plan.others) console.error(`  ${short(c)}`)
  }
  return plan.relays.length
}

// A global `afterAll` (declared in the preload) runs ONCE, after the last file, and a throw there
// fails the run. `process.on('exit')` would read better and does not fire under `bun test` (1.3.14).
afterAll(() => {
  const leaked = sweep()
  if (leaked > 0) throw new Error(`[test-orphans] ${leaked} structured relay process(es) outlived their test — see the list above`)
})
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
  process.on(sig, () => { sweep(); process.exit(code) })
}
