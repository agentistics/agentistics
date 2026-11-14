import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lockFile } from '../sessions/file-lock'
import { GUARD_LOCK_ORDER, GuardBusy, GuardLockOrderError, withGuardLocks, type GuardLockPaths } from './guard-locks'

let dir: string
let paths: GuardLockPaths
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guard-locks-'))
  paths = { tasks: join(dir, 'tasks.json'), deliveries: join(dir, 'deliveries.json'), guards: join(dir, 'guards.json') }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const lockDirs = () => readdirSync(dir).filter(n => n.endsWith('.lock'))

describe('the global order is tasks → deliveries → guards', () => {
  test('the order constant is exactly that', () => { expect([...GUARD_LOCK_ORDER]).toEqual(['tasks', 'deliveries', 'guards']) })

  test('acquires in order and holds all of them while fn runs, releases all after', async () => {
    let during: string[] = []
    await withGuardLocks(['tasks', 'deliveries', 'guards'], async () => { during = lockDirs() }, { paths })
    expect(during.sort()).toEqual(['deliveries.json.lock', 'guards.json.lock', 'tasks.json.lock'])
    expect(lockDirs()).toEqual([])
  })
  test('a subset in order is fine (deliveries + guards skips tasks)', async () => {
    let during: string[] = []
    await withGuardLocks(['deliveries', 'guards'], async () => { during = lockDirs() }, { paths })
    expect(during.sort()).toEqual(['deliveries.json.lock', 'guards.json.lock'])
  })
  test('a request out of order is a programming error, thrown before any lock is taken', async () => {
    await expect(withGuardLocks(['guards', 'tasks'], async () => 1, { paths })).rejects.toBeInstanceOf(GuardLockOrderError)
    await expect(withGuardLocks(['tasks', 'tasks'], async () => 1, { paths })).rejects.toBeInstanceOf(GuardLockOrderError)
    expect(lockDirs()).toEqual([])
  })
  test('never acquires an earlier lock while holding a later one: a nested call is refused', async () => {
    await withGuardLocks(['deliveries'], async () => {
      await expect(withGuardLocks(['tasks'], async () => 1, { paths })).rejects.toBeInstanceOf(GuardLockOrderError)
      await expect(withGuardLocks(['deliveries'], async () => 1, { paths })).rejects.toBeInstanceOf(GuardLockOrderError)
      // a LATER lock is the legal extension
      expect(await withGuardLocks(['guards'], async () => 'ok', { paths })).toBe('ok')
    }, { paths })
  })
  test('alreadyHeld: the board hook inside task-store.write() holds tasks already — it is not re-taken (the lock is not reentrant)', async () => {
    const outer = await lockFile(paths.tasks)
    let during: string[] = []
    await withGuardLocks(['tasks', 'deliveries', 'guards'], async () => { during = lockDirs() }, { paths, alreadyHeld: ['tasks'] })
    expect(during).toContain('deliveries.json.lock')
    expect(existsSync(`${paths.tasks}.lock`)).toBe(true) // still the outer's
    await outer.release()
  })
  test('alreadyHeld may only be a prefix-compatible claim: claiming deliveries held while asking for tasks is an order error', async () => {
    await expect(withGuardLocks(['tasks', 'deliveries'], async () => 1, { paths, alreadyHeld: ['deliveries'] })).rejects.toBeInstanceOf(GuardLockOrderError)
  })
})

describe('timeout fails closed (§2.6.1)', () => {
  test('a contended lock → guard_busy 409, fn NEVER runs, everything already taken is released', async () => {
    const blocker = await lockFile(paths.guards)
    let ran = false
    const err = await withGuardLocks(['tasks', 'deliveries', 'guards'], async () => { ran = true }, { paths, waitMs: 120 }).catch(e => e)
    expect(err).toBeInstanceOf(GuardBusy)
    expect(err).toMatchObject({ code: 'guard_busy', status: 409 })
    expect(String(err.message)).toContain('retry')
    expect(ran).toBe(false)
    expect(lockDirs()).toEqual(['guards.json.lock']) // only the blocker's
    await blocker.release()
    expect(await withGuardLocks(['tasks', 'deliveries', 'guards'], async () => 'later', { paths })).toBe('later')
  })
  test('the default wait is 5 s', async () => {
    const { GUARD_WAIT_MS } = await import('./guard-locks')
    expect(GUARD_WAIT_MS).toBe(5000)
  })
  test('fn throwing releases every lock and rethrows', async () => {
    await expect(withGuardLocks(['tasks', 'deliveries', 'guards'], async () => { throw new Error('inner') }, { paths })).rejects.toThrow('inner')
    expect(lockDirs()).toEqual([])
  })
  test('tick/sweep mode: busy is reported as a skip result, not an exception', async () => {
    const blocker = await lockFile(paths.deliveries)
    const r = await withGuardLocks(['deliveries', 'guards'], async () => 'ran', { paths, waitMs: 80, onBusy: 'skip' })
    expect(r).toEqual({ skipped: 'guard_busy' })
    await blocker.release()
  })
})

describe('the lint: locks are taken only through withGuardLocks', () => {
  const SERVER = join(import.meta.dir, '..')
  const walk = (d: string, out: string[] = []): string[] => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) && !/\.fixture\.ts$/.test(e.name)) out.push(p)
    }
    return out
  }
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  test('no module takes the guards.json lock outside guard-locks.ts', () => {
    const offenders = walk(SERVER).filter(f => !f.endsWith('delivery/guard-locks.ts'))
      .filter(f => { const s = strip(readFileSync(f, 'utf8')); return /(withFileLock|lockFile)\s*\([^)]*guards/.test(s) })
    expect(offenders).toEqual([])
  })
  test('guards-store.ts and activation.ts never lock by themselves (the caller holds the set)', () => {
    for (const n of ['guards-store.ts', 'activation.ts']) {
      expect(strip(readFileSync(join(SERVER, 'delivery', n), 'utf8'))).not.toMatch(/withFileLock|lockFile/)
    }
  })
  test('the only modules that lock tasks.json / deliveries.json files directly are the two stores + guard-locks', () => {
    const lockers = walk(SERVER).filter(f => /\b(withFileLock|lockFile)\b/.test(strip(readFileSync(f, 'utf8')))).map(f => f.slice(SERVER.length + 1)).sort()
    const allowed = new Set([
      'sessions/file-lock.ts', 'delivery/guard-locks.ts', 'delivery/store.ts', 'sessions/task-store.ts',
      // pre-existing, unrelated files
      'plan-limits.ts', 'plan-history.ts', 'harness-accounts.ts', 'server-restart-io.ts', 'sessions/auto-switch-io.ts',
      'flows/owner-ledger.ts', 'sessions/session-roles.ts', 'sessions/registry.ts',
    ])
    expect(lockers.filter(f => !allowed.has(f))).toEqual([])
  })
})
