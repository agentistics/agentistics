/**
 * structured-relay-orphans.test.ts — a relay started under `bun test` dies with the RUNNER.
 *
 * 31/10 the OOM killer took the real agentop server down: its cgroup held 4600 tasks, almost all
 * relays, fake agents and relay workers left by test runs that had ended (or been interrupted) hours
 * or days before. A relay is detached ON PURPOSE (it outlives the server), so under a test nothing
 * ended it. `structured-relay.ts` now watches `AGENTISTICS_TEST_RUNNER_PID` (set by
 * `scripts/test-preload.ts`; never in production); this pins that a runner killed with no chance to
 * clean up still leaves nothing behind.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { testRunnerPid, TEST_RUNNER_PID_ENV } from './structured-relay'

const RUNNER = path.join(import.meta.dir, 'fixtures', 'runner-killed.ts')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Every live process that inherited `marker` (zombies excluded: they hold nothing). */
function carrying(marker: string): number[] {
  const out: number[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) continue
      if (readFileSync(`/proc/${name}/environ`, 'utf8').split('\0').includes(marker)) out.push(Number(name))
    } catch { /* gone, or not ours */ }
  }
  return out
}

const roots: string[] = []
const markers: string[] = []
afterEach(() => {
  // Whatever the assertions said, nothing of this test survives it.
  for (const m of markers.splice(0)) for (const pid of carrying(m)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

describe('testRunnerPid', () => {
  test('reads a plain pid and refuses everything else', () => {
    expect(testRunnerPid({ [TEST_RUNNER_PID_ENV]: '4242' })).toBe(4242)
    expect(testRunnerPid({})).toBeNull()
    for (const junk of ['', '0', '1', '-5', '12a', ' 12', '1e3', '99999999999999999999']) {
      expect(testRunnerPid({ [TEST_RUNNER_PID_ENV]: junk })).toBeNull()
    }
  })
})

describe.if(process.platform === 'linux')('a relay started under bun test', () => {
  test('dies with the runner: relay, child and worker are gone after a SIGKILL of the runner', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'relay-orphans-'))
    roots.push(root)
    const r = spawnSync(process.execPath, ['run', RUNNER, path.join(root, 'structured'), root], { encoding: 'utf8', timeout: 20_000 })
    expect(r.signal).toBe('SIGKILL') // it killed itself, as an OOM kill would
    const dir = r.stdout.trim()
    const { relay, child } = JSON.parse(readFileSync(path.join(dir, 'relay.pid'), 'utf8')) as { relay: number; child: number }
    const marker = `${TEST_RUNNER_PID_ENV}=${r.pid}`
    markers.push(marker)
    // The relay polls every 500 ms; then the ordinary TERM path ends the child's group and the
    // worker leaves on stdin EOF. The child is a plain `sleep` (see the fixture), so nothing but the
    // relay's watch can end it. Generous bound for a loaded machine.
    const until = Date.now() + 10_000
    while (Date.now() < until && carrying(marker).length > 0) await sleep(100)
    expect(carrying(marker)).toEqual([])
    for (const pid of [relay, child]) expect(() => process.kill(pid, 0)).toThrow()
  }, 30_000)
})
