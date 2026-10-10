/**
 * POST /api/resources/kill through the REAL route handler: a fake orphan agentop (a copy of `sh`
 * named `agentop`, trapping SIGTERM) is found by the real /proc inventory and really ended; a pid
 * the inventory does not hold is refused 403.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleResources } from './routes'

let dir = ''
let child: ReturnType<typeof Bun.spawn> | null = null
const prevGov = process.env.AGENTISTICS_GOVERNOR

const post = (pid: unknown) => handleResources(
  new Request('http://x/api/resources/kill', { method: 'POST', body: JSON.stringify({ pid }) }),
  new URL('http://x/api/resources/kill'), {},
)

beforeAll(async () => {
  process.env.AGENTISTICS_GOVERNOR = '0' // the tick must not stop anything real
  dir = mkdtempSync(join(tmpdir(), 'res-kill-'))
  const fake = join(dir, 'agentop')
  copyFileSync('/bin/sh', fake); chmodSync(fake, 0o755)
  child = Bun.spawn([fake, '-c', 'trap "" TERM; while :; do sleep 0.2; done'], { stdout: 'ignore', stderr: 'ignore' })
  await new Promise(r => setTimeout(r, 400))
})
afterAll(() => {
  try { child?.kill('SIGKILL') } catch { /* gone */ }
  rmSync(dir, { recursive: true, force: true })
  if (prevGov === undefined) delete process.env.AGENTISTICS_GOVERNOR; else process.env.AGENTISTICS_GOVERNOR = prevGov
})

describe('POST /api/resources/kill', () => {
  test('a SIGTERM-ignoring fake orphan is really ended (ended:true)', async () => {
    const res = await post(child!.pid)
    expect(res!.status).toBe(200)
    const body = await res!.json() as { ended: boolean; signal: string }
    expect(body.ended).toBe(true)
    expect(body.signal).toBe('SIGKILL')
    await child!.exited
    expect(() => process.kill(child!.pid, 0)).toThrow()
  }, 20_000)

  test('a pid that is not in the inventory is refused 403', async () => {
    const res = await post(process.ppid > 1 ? process.ppid : 1)
    expect(res!.status).toBe(403)
  }, 20_000)
})
