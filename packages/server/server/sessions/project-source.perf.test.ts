/**
 * PERF GUARD — the wizard's project search must never wait for the filesystem walk.
 *
 * 07/10: a whole-disk scan root (`/mnt/c`) was walked synchronously inside `GET /api/fleet/new`
 * and froze the app. The index is built in the BACKGROUND (`startBackgroundIndex`); a call answers
 * from what is already known and says `indexing: true`. This builds a big fake tree (5 "disks" x
 * 1500 nested directories) as scan roots and fails if any call takes long enough to mean it waited.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PREFERENCES_FILE } from '../preferences'
import { findProjects, forgetProjects } from './project-source'

const BUDGET_MS = 300
const DISKS = 5
const DIRS_PER_DISK = 1500

let base = ''
let fakeHome = ''
const realHome = process.env.HOME
let prefsBefore: string | null = null

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'perf-fleet-new-'))
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
  try { prefsBefore = await Bun.file(PREFERENCES_FILE).text() } catch { prefsBefore = null }
  await writeFile(PREFERENCES_FILE, JSON.stringify({ scanRoots: roots }))
  process.env.HOME = fakeHome
  forgetProjects()
}, 30_000)

afterAll(async () => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome
  if (prefsBefore === null) await rm(PREFERENCES_FILE, { force: true }); else await writeFile(PREFERENCES_FILE, prefsBefore)
  forgetProjects()
  await rm(base, { recursive: true, force: true })
})

describe('findProjects (behind GET /api/fleet/new) never awaits the filesystem walk', () => {
  test('a cold call answers fast and says the index is still building', async () => {
    const t0 = performance.now()
    const cold = await findProjects('', fakeHome)
    const ms = performance.now() - t0
    expect(ms).toBeLessThan(BUDGET_MS)
    expect(cold.indexing).toBe(true)
  })

  test('every call while the walk runs stays under budget', async () => {
    for (let i = 0; i < 8; i++) {
      const t0 = performance.now()
      await findProjects(i % 2 ? 'c1' : '', fakeHome)
      expect(performance.now() - t0).toBeLessThan(BUDGET_MS)
    }
  })

  test('the background walk does finish, and later calls see its result', async () => {
    const deadline = Date.now() + 15_000
    let res = await findProjects('c1499', fakeHome)
    while (res.indexing && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50))
      res = await findProjects('c1499', fakeHome)
    }
    expect(res.indexing).toBe(false)
  }, 20_000)
})
