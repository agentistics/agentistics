/**
 * POST /api/resources/kill through the REAL route handler: a fake orphan agentop (a copy of `sh`
 * named `agentop`, trapping SIGTERM) is found by the real /proc inventory and really ended; a pid
 * the inventory does not hold is refused 403.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { copyFileSync, readFileSync, mkdtempSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleResources } from './routes'
import { readProcTable } from './proc-read'

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
  // Warm the shared process-table memo BEFORE the child exists, as an earlier test file in the same
  // `bun test` process does in CI: the kill must still find a pid born after that read.
  readProcTable()
  child = Bun.spawn([fake, '-c', 'trap "" TERM; while :; do sleep 0.2; done'], { stdout: 'ignore', stderr: 'ignore' })
  // Wait on the condition (the exec happened, so /proc names it `agentop`), not on a fixed sleep.
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try { if (readFileSync(`/proc/${child.pid}/comm`, 'utf8').trim() === 'agentop') break } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 20))
  }
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
    // A plain `sleep` this test owns, never `process.ppid`: under `agentop heavy` / `agentop run`
    // (the pre-commit hook, a throwaway) the parent IS an agentop process in the inventory, so the
    // route really killed it — the run died with "ended on request (SIGKILL)" or read 200. The
    // bystander also drops the env markers the inventory classifies by (a child inheriting
    // AGENTISTICS_HEAVY_JOB is a heavy job, AGENTISTICS_HELPER_ID a helper).
    const env = { ...process.env } as Record<string, string | undefined>
    delete env.AGENTISTICS_HEAVY_JOB; delete env.AGENTISTICS_HELPER_ID
    const bystander = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore', env: env as Record<string, string> })
    try {
      const res = await post(bystander.pid)
      expect(res!.status).toBe(403)
      expect(() => process.kill(bystander.pid, 0)).not.toThrow()
    } finally { bystander.kill('SIGKILL') }
  }, 20_000)
})
