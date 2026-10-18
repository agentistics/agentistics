import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENTS_DEADLINE_MS, __setHarnessAgentsReaderForTest, readHarnessAgents } from './harness-agents-io'

/** A short deadline for the hang cases; production's is `AGENTS_DEADLINE_MS`. */
const DEADLINE = 300

const pathBefore = process.env.PATH
let dir = ''

/** Put a fake `claude` first on PATH, so the real CLI is never reached. */
function fakeClaude(script: string): void {
  dir = mkdtempSync(join(tmpdir(), 'agents-io-'))
  writeFileSync(join(dir, 'claude'), `#!/bin/sh\n${script}\n`)
  chmodSync(join(dir, 'claude'), 0o755)
  process.env.PATH = `${dir}:${pathBefore ?? ''}`
}

afterEach(() => {
  process.env.PATH = pathBefore
  __setHarnessAgentsReaderForTest(null)
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe('readHarnessAgents', () => {
  test('parses what the CLI prints', async () => {
    fakeClaude(`echo '[{"sessionId":"abc","pid":42,"name":"MAIN"}]'`)
    expect(await readHarnessAgents()).toEqual([expect.objectContaining({ sessionId: 'abc', pid: 42, name: 'MAIN' })])
  })

  test('a failing CLI is "nothing", never a throw', async () => {
    fakeClaude('echo boom >&2; exit 3')
    expect(await readHarnessAgents()).toEqual([])
  })

  test('production waits longer than the slowest answer measured (~5.1 s)', () => {
    expect(AGENTS_DEADLINE_MS).toBeGreaterThan(5_100)
  })

  test('a CLI that hangs is abandoned at the deadline, without blocking the event loop', async () => {
    fakeClaude('sleep 30')
    let ticks = 0
    const tick = setInterval(() => { ticks++ }, 20)
    const t0 = performance.now()
    const out = await readHarnessAgents(DEADLINE)
    clearInterval(tick)
    const took = performance.now() - t0
    expect(out).toEqual([])
    expect(took).toBeGreaterThanOrEqual(DEADLINE - 20)
    expect(took).toBeLessThan(DEADLINE + 1_500)
    // A spawnSync would have frozen the loop for the whole wait: the timer could not have fired.
    expect(ticks).toBeGreaterThan(3)
  })

  test('a late CLI is killed with everything it forked, and nothing holds the pipe', async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'agents-io-pid-')), 'grandchild')
    // The grandchild inherits stdout: killing only the CLI would leave it holding the pipe open.
    fakeClaude(`sleep 30 & echo $! > ${pidFile}; wait`)
    const t0 = performance.now()
    expect(await readHarnessAgents(DEADLINE)).toEqual([])
    expect(performance.now() - t0).toBeLessThan(DEADLINE + 1_500)
    await Bun.sleep(100)
    const grandchild = Number((await Bun.file(pidFile).text()).trim())
    let alive = true
    try { process.kill(grandchild, 0) } catch { alive = false }
    expect(alive).toBe(false)
  })

  test('the test seam replaces the CLI entirely', async () => {
    fakeClaude('exit 1')
    __setHarnessAgentsReaderForTest(async () => [{ sessionId: 'seam' }])
    expect(await readHarnessAgents()).toEqual([{ sessionId: 'seam' }])
  })
})
