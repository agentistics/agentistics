/**
 * STRUCTURED.OWNER — a store COPIED to another data dir must never act on the original's relays.
 *
 * Incident: a throwaway server started on `cp -a ~/.agentistics`; the copy's `relay.pid` files named
 * live relays of the REAL server (same PID namespace), and its terminate()/reattach signalled them.
 * Each test runs a real relay (holding `sleep`) and copies its directory.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { durableStore, type DurableStore, type SavedSpawn } from './structured-durable'

const saved: SavedSpawn = { v: 1, harness: 'gemini', spawn: { cwd: '/tmp' } as SavedSpawn['spawn'], backend: { id: 'm-1', cwd: '/tmp' } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(f: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!f()) { if (Date.now() > end) throw new Error('timed out'); await sleep(25) }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

const tmps: string[] = []
const stores: DurableStore[] = []
afterEach(async () => {
  for (const s of stores.splice(0)) for (const id of s.alive()) await s.terminate(id, 4000)
  for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true })
}, 20_000)

async function original(): Promise<{ A: DurableStore; aRoot: string; bRoot: string; relayPid: number }> {
  const base = mkdtempSync(path.join(tmpdir(), 'owner-'))
  tmps.push(base)
  const aRoot = path.join(base, 'a', 'structured')
  const A = durableStore(aRoot)
  stores.push(A)
  A.create('m-1', saved).launch('sleep', ['300'], '/tmp')
  await until(() => A.isAlive('m-1'))
  const pid = JSON.parse(await Bun.file(path.join(A.dirOf('m-1'), 'relay.pid')).text()).relay as number
  const bRoot = path.join(base, 'b', 'structured')
  cpSync(aRoot, bRoot, { recursive: true, filter: src => !src.endsWith('relay.sock') }) // a socket cannot be copied
  return { A, aRoot, bRoot, relayPid: pid }
}

describe('a copied store is foreign', () => {
  test('the copy never signals, re-attaches or lists the original\'s relay; the original still does', async () => {
    const { A, bRoot, relayPid } = await original()
    const B = durableStore(bRoot)
    expect(B.isAlive('m-1')).toBe(false)
    expect(B.alive()).toEqual([])
    expect(B.dead()).toEqual(['m-1'])
    expect(B.replay('m-1')).toBeNull()
    expect(await B.terminate('m-1', 500)).toBe(true) // nothing of its own to end
    expect(alive(relayPid)).toBe(true)
    B.remove('m-1') // dropping the copied record only
    expect(existsSync(B.dirOf('m-1'))).toBe(false)
    expect(A.isAlive('m-1')).toBe(true)
    expect(A.replay('m-1')).not.toBeNull()
    expect(await A.terminate('m-1')).toBe(true)
    expect(alive(relayPid)).toBe(false)
  }, 30_000)

  test('a legacy record without an owner stamp: the original is still owned, the copy is still foreign', async () => {
    const { A, bRoot, relayPid } = await original()
    unlinkSync(path.join(A.dirOf('m-1'), 'owner.json'))
    const B = durableStore(bRoot)
    unlinkSync(path.join(B.dirOf('m-1'), 'owner.json'))
    // The upgrade path: the real server re-attaches what it started before the stamp existed.
    expect(A.isAlive('m-1')).toBe(true)
    expect(A.replay('m-1')).not.toBeNull()
    // The copy has no stamp to go by, but the live relay names ANOTHER directory.
    if (process.platform === 'linux') {
      expect(B.isAlive('m-1')).toBe(false)
      expect(await B.terminate('m-1', 500)).toBe(true)
      expect(alive(relayPid)).toBe(true)
    }
    expect(await A.terminate('m-1')).toBe(true)
    expect(alive(relayPid)).toBe(false)
  }, 30_000)

  test('a record whose relay is gone is dead for its owner (boot cleanup unchanged)', async () => {
    const { A, relayPid } = await original()
    expect(await A.terminate('m-1')).toBe(true)
    expect(alive(relayPid)).toBe(false)
    expect(A.dead()).toContain('m-1')
  }, 30_000)
})
