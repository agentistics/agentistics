import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENTS_DEADLINE_MS, __setHarnessAgentsReaderForTest, readHarnessAgents } from './harness-agents-io'

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

  test('a CLI that hangs is abandoned at the deadline, without blocking the event loop', async () => {
    fakeClaude('sleep 30')
    let ticks = 0
    const tick = setInterval(() => { ticks++ }, 50)
    const t0 = performance.now()
    const out = await readHarnessAgents()
    clearInterval(tick)
    const took = performance.now() - t0
    expect(out).toEqual([])
    expect(took).toBeGreaterThanOrEqual(AGENTS_DEADLINE_MS - 50)
    expect(took).toBeLessThan(AGENTS_DEADLINE_MS + 1_500)
    // A spawnSync would have frozen the loop for the whole wait: the timer could not have fired.
    expect(ticks).toBeGreaterThan(5)
  })

  test('the test seam replaces the CLI entirely', async () => {
    fakeClaude('exit 1')
    __setHarnessAgentsReaderForTest(async () => [{ sessionId: 'seam' }])
    expect(await readHarnessAgents()).toEqual([{ sessionId: 'seam' }])
  })
})
