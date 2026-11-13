import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'guards-lock-order-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const N = 40
const worker = join(import.meta.dir, 'guards-lock-order.worker.ts')
const spawn = (role: 'board' | 'tick') => Bun.spawn([process.execPath, 'run', worker, dir, role, String(N)], { stdout: 'pipe', stderr: 'pipe' })
const count = (n: string) => Number(readFileSync(join(dir, n), 'utf8'))

describe('two processes, a board-raising write and a tick, in a loop (spec §2.6.1)', () => {
  test('no deadlock, no overlap inside the shared critical section, no lost or unguarded write', async () => {
    const board = spawn('board'); const tick = spawn('tick')
    const timeout = new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 60_000))
    const res = await Promise.race([Promise.all([board.exited, tick.exited]), timeout])
    if (res === 'timeout') { board.kill(); tick.kill(); throw new Error('deadlock: workers did not finish in 60 s') }
    expect(res).toEqual([0, 0])
    expect(existsSync(join(dir, 'overlap.log'))).toBe(false)
    // every iteration of every worker bumped its counters while holding the locks: nothing lost
    expect(count('tasks.count')).toBe(N)
    expect(count('deliveries.count')).toBe(2 * N)
    expect(count('guards.count')).toBe(2 * N)
  }, 90_000)

  test('the board role truly takes the three locks in order (a worker run alone completes and leaves no lock behind)', async () => {
    const p = spawn('board')
    expect(await p.exited).toBe(0)
    for (const f of ['tasks', 'deliveries', 'guards']) expect(existsSync(join(dir, `${f}.json.lock`))).toBe(false)
  }, 60_000)
})
