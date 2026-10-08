/**
 * PERF GUARD — the wizard's project search must never wait for the filesystem walk.
 *
 * 07/10: a whole-disk scan root (`/mnt/c`) was walked synchronously inside `GET /api/fleet/new`
 * and froze the app. The index is built in the BACKGROUND (`startBackgroundIndex`); a call answers
 * from what is already known and says `indexing: true`. This builds a big fake tree (5 "disks" x
 * 1500 nested directories) as scan roots and fails if any call takes long enough to mean it waited.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import * as realPreferences from '../preferences'

// NEVER the real ~/.agentistics/preferences.json: an earlier version of this guard overwrote it
// for the run and restored it afterwards — a crash in between would have lost the person's
// settings, and two suites running at once raced on it. The scan roots come from an in-memory
// preferences module instead.
let fakeRoots: string[] = []
mock.module('../preferences', () => ({
  ...realPreferences,
  readPreferences: async () => ({ scanRoots: fakeRoots }),
}))
const { findProjects, forgetProjects } = await import('./project-source')

const BUDGET_MS = 300
const DISKS = 5
const DIRS_PER_DISK = 1500

let base = ''
let fakeHome = ''
const realHome = process.env.HOME

beforeAll(async () => {
  // Not under the OS temp dir: the index deliberately ignores temp folders.
  base = await mkdtemp(join(import.meta.dir, '.perf-fleet-new-'))
  fakeHome = join(base, 'home')
  await mkdir(fakeHome, { recursive: true })
  const roots: string[] = []
  for (let d = 0; d < DISKS; d++) {
    const root = join(base, `disk${d}`)
    roots.push(root)
    const makes: Promise<unknown>[] = []
    for (let i = 0; i < DIRS_PER_DISK; i++) {
      makes.push(mkdir(join(root, `a${i % 30}`, `b${i % 7}`, `c${i}`), { recursive: true }))
    }
    await Promise.all(makes)
  }
  fakeRoots = roots
  process.env.HOME = fakeHome
  forgetProjects()
}, 30_000)

afterAll(async () => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome
  forgetProjects()
  await rm(base, { recursive: true, force: true })
})

describe('findProjects (behind GET /api/fleet/new) never awaits the filesystem walk', () => {
  test('a cold call answers fast — still indexing, or already done with results, never waiting', async () => {
    const t0 = performance.now()
    const cold = await findProjects('', fakeHome, undefined, 'all')
    const ms = performance.now() - t0
    expect(ms).toBeLessThan(BUDGET_MS)
    // The resumable disk index can finish a small tree before the first answer; what must never
    // happen is the route WAITING for it. Either it says it is still building, or it is done.
    if (!cold.indexing) expect(Object.values(cold.totals).reduce((a, b) => a + b, 0)).toBeGreaterThan(0)
  })

  test('every call while the walk runs stays under budget', async () => {
    for (let i = 0; i < 8; i++) {
      const t0 = performance.now()
      await findProjects(i % 2 ? 'c1' : '', fakeHome, undefined, 'all')
      expect(performance.now() - t0).toBeLessThan(BUDGET_MS)
    }
  })

  test('the background walk does finish, and later calls see its result', async () => {
    const deadline = Date.now() + 15_000
    let res = await findProjects('c1499', fakeHome, undefined, 'all')
    while (res.indexing && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50))
      res = await findProjects('c1499', fakeHome, undefined, 'all')
    }
    expect(res.indexing).toBe(false)
  }, 20_000)
})
