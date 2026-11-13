import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { HARD_STALE_MS, lockFile, mayStealLock, STALE_MS, withFileLock } from './file-lock'

async function tmp(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'agentop-lock-')), 'file.json')
}

test('a lock is held, and released', async () => {
  const f = await tmp()
  const held = await lockFile(f)
  expect(held.contended).toBe(false)
  await expect(stat(`${f}.lock`)).resolves.toBeDefined()
  await held.release()
  await expect(stat(`${f}.lock`)).rejects.toBeDefined()
})

test('an ABANDONED lock is cleared rather than waited on forever', async () => {
  // A process killed between acquire and release leaves the directory. Without expiry the next
  // start of agentop would hang on a lock nobody holds.
  const f = await tmp()
  await mkdir(`${f}.lock`)
  const old = Date.now() + STALE_MS + 1000
  const held = await lockFile(f, () => old)
  expect(held.contended).toBe(false)
  await held.release()
})

test('a contended lock PROCEEDS and says so, rather than failing the caller', async () => {
  // Refusing here would mean not recording a session that has already been spawned — a lost label
  // is a smaller harm than a live session with no record at all.
  const f = await tmp()
  const first = await lockFile(f)
  let t = Date.now()
  const second = await lockFile(f, () => (t += 3000))
  expect(second.contended).toBe(true)
  await first.release()
  await second.release()
})

test('the lock is released even when the work throws', async () => {
  const f = await tmp()
  await expect(withFileLock(f, async () => { throw new Error('boom') })).rejects.toThrow('boom')
  await expect(stat(`${f}.lock`)).rejects.toBeDefined()
})

test('two callers in one process still run one at a time', async () => {
  const f = await tmp()
  const order: string[] = []
  await Promise.all([
    withFileLock(f, async () => { order.push('a-in'); await Bun.sleep(30); order.push('a-out') }),
    withFileLock(f, async () => { order.push('b-in'); await Bun.sleep(1); order.push('b-out') }),
  ])
  // Whoever went first finished before the other started.
  expect(order[0]!.endsWith('-in')).toBe(true)
  expect(order[1]).toBe(`${order[0]!.slice(0, 1)}-out`)
})

test('the lock directory does not survive a release, so it cannot become stale garbage', async () => {
  const f = await tmp()
  await withFileLock(f, async () => undefined)
  await expect(stat(`${f}.lock`)).rejects.toBeDefined()
  await rm(f, { force: true })
})

// A FIRST-TIME MACHINE HAS NO PARENT DIRECTORY, and the non-recursive `mkdir` of the lock failed
// with ENOENT, which the old loop read as contention and retried forever with no sleep and no
// deadline — the hang behind 42 uploader tests on a CI runner with no ~/.agentistics, and behind a
// first push that never finished. See the module header's last rule.
test('a lock whose PARENT directory does not exist is taken, not spun on forever', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentop-lock-'))
  const f = join(root, 'not', 'there', 'yet', 'file.json')
  const started = Date.now()
  const held = await Promise.race([
    lockFile(f),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('lockFile never returned')), 2000)),
  ])
  expect(Date.now() - started).toBeLessThan(2000)
  expect(held.contended).toBe(false)
  await expect(stat(`${f}.lock`)).resolves.toBeDefined()
  await held.release()
  await rm(root, { recursive: true, force: true })
})

// ENTREGA.GARANTIDA S0d.4 (QA F4, `s0b-stale.ts`): a holder past STALE_MS was joined by a second writer, and its
// release then deleted the second writer's lock. A LIVE lock is never stolen; release only removes its own.
describe('S0d.4 — a live lock is never stolen', () => {
  test('mayStealLock: young never; old only when the owner is gone, unknown, elsewhere — or past the hard ceiling', () => {
    const me = { pid: 42, host: 'h', token: 't' }
    const alive = () => true, dead = () => false
    expect(mayStealLock(STALE_MS, null, 'h', dead)).toBe(false)
    expect(mayStealLock(STALE_MS + 1, me, 'h', alive)).toBe(false) // the QA case: live holder past 15 s
    expect(mayStealLock(STALE_MS + 1, me, 'h', dead)).toBe(true)
    expect(mayStealLock(STALE_MS + 1, null, 'h', alive)).toBe(true) // crashed between mkdir and the owner write
    expect(mayStealLock(STALE_MS + 1, { ...me, host: 'other' }, 'h', alive)).toBe(true)
    expect(mayStealLock(HARD_STALE_MS + 1, me, 'h', alive)).toBe(true) // a recycled pid cannot wedge the lock forever
  })
  test('an OLD lock held by this (live) process is waited on, never taken: the second caller is contended', async () => {
    const f = await tmp()
    const first = await lockFile(f)
    const second = await lockFile(f, () => Date.now() + STALE_MS + 5000, 200)
    expect(second.contended).toBe(true)
    await first.release()
    await expect(stat(`${f}.lock`)).rejects.toBeDefined()
  })
  test('withGuardLocks fails CLOSED on such a lock (guard_busy), it never joins the holder', async () => {
    const f = await tmp()
    const { withGuardLocks, GuardBusy } = await import('../delivery/guard-locks')
    const dir = join(f, '..')
    const paths = { tasks: join(dir, 't.json'), deliveries: join(dir, 'd.json'), guards: join(dir, 'g.json') }
    const holder = await lockFile(paths.guards)
    let ran = false
    await expect(withGuardLocks(['guards'], async () => { ran = true }, { paths, waitMs: 200 })).rejects.toBeInstanceOf(GuardBusy)
    expect(ran).toBe(false)
    await holder.release()
  })
  test('the owner of an old lock is DEAD → it is taken over', async () => {
    const f = await tmp()
    await mkdir(`${f}.lock`)
    const child = Bun.spawn(['true']); await child.exited
    await writeFile(join(`${f}.lock`, 'owner'), JSON.stringify({ pid: child.pid, host: hostname(), token: 'dead' }))
    const held = await lockFile(f, () => Date.now() + STALE_MS + 1000)
    expect(held.contended).toBe(false)
    expect(JSON.parse(await readFile(join(`${f}.lock`, 'owner'), 'utf8')).token).not.toBe('dead')
    await held.release()
  })
  test('release never deletes a lock whose owner token is not its own', async () => {
    const f = await tmp()
    const held = await lockFile(f)
    await writeFile(join(`${f}.lock`, 'owner'), JSON.stringify({ pid: process.pid, host: hostname(), token: 'someone-else' }))
    await held.release()
    await expect(stat(`${f}.lock`)).resolves.toBeDefined()
    await rm(`${f}.lock`, { recursive: true, force: true })
  })
  test('the holder heartbeats: the lock directory\'s mtime moves while it is held', async () => {
    const f = await tmp()
    const held = await lockFile(f)
    const past = new Date(Date.now() - 60_000)
    await utimes(`${f}.lock`, past, past)
    // Poll until the heartbeat moves the mtime (no fixed sleep, no absolute-age threshold): deadline 3 × HEARTBEAT.
    const heartbeat = Math.floor(STALE_MS / 3)
    const deadline = Date.now() + 3 * heartbeat
    let moved = false
    while (Date.now() < deadline) {
      if ((await stat(`${f}.lock`)).mtimeMs > past.getTime() + 1000) { moved = true; break }
      await Bun.sleep(100)
    }
    expect(moved).toBe(true)
    await held.release()
  }, 3 * Math.floor(STALE_MS / 3) + 5000)
})

test('withFileLock runs the work when the parent directory does not exist yet', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentop-lock-'))
  const f = join(root, 'fresh', 'tasks.json')
  const out = await Promise.race([
    withFileLock(f, async () => 'ran'),
    new Promise<string>(resolve => setTimeout(() => resolve('hung'), 2000)),
  ])
  expect(out).toBe('ran')
  await rm(root, { recursive: true, force: true })
})
