import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emitIndexSnapshotForTest, findProjects, forgetProjects, newProjectParent, setHomeForTest } from './project-source'

// A REAL temporary HOME, wired through `findProjects` / `newProjectParent` (not pure units): the
// folder is created AFTER the first index, exactly as the owner's `~/upx-workspace` was.
const realTmp = realpathSync(tmpdir())
const home = mkdtempSync(join(realTmp, 'pastas-home-'))
const env = { TMPDIR: process.env.TMPDIR }
let clock = Date.now()
let dateSpy: ReturnType<typeof spyOn>

const mk = (rel: string) => mkdirSync(join(home, rel), { recursive: true })
const repo = (rel: string) => mk(`${rel}/.git`)
const advance = (ms: number) => { clock += ms }
const idle = async () => { for (let i = 0; i < 100; i++) { if (!(await findProjects('', home)).indexing) return; await new Promise(r => setTimeout(r, 20)) } }
const paths = async (q: string) => (await findProjects(q, home, 100, 'all')).rows.map(r => r.path)

beforeEach(async () => {
  setHomeForTest(home)
  // The temp tree is excluded from the wizard, so point "temporary" somewhere that is not above HOME.
  process.env.TMPDIR = '/nonexistent-tmp-for-test'
  forgetProjects()
  rmSync(home, { recursive: true, force: true })
  mk('')
  repo('code/alpha'); repo('code/beta'); mk('agentistics-workspace')
  dateSpy = spyOn(Date, 'now').mockImplementation(() => clock)
  advance(10_000)
  await findProjects('', home) // first index
  await idle()
})

afterEach(() => { dateSpy.mockRestore() })
afterAll(() => {
  setHomeForTest(null)
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  rmSync(home, { recursive: true, force: true })
})

describe('folders created outside agentop, through the real lookup', () => {
  test('a non-empty query that already matches something still finds the new folder', async () => {
    mk('upx-workspace')
    advance(2_000)
    const found = await paths('workspace')
    expect(found).toContain(join(home, 'agentistics-workspace'))
    expect(found).toContain(join(home, 'upx-workspace'))
  })

  test('what the shallow re-read found survives a disk-index tick and shows in the initial list', async () => {
    mk('upx-workspace')
    advance(2_000)
    expect(await paths('upx')).toContain(join(home, 'upx-workspace'))
    emitIndexSnapshotForTest()
    expect(await paths('')).toContain(join(home, 'upx-workspace'))
    advance(2_000)
    emitIndexSnapshotForTest()
    expect(await paths('')).toContain(join(home, 'upx-workspace'))
  })

  test('a disk-index tick does not renew the full-scan clock: the 60 s revalidation runs', async () => {
    mk('late-one')
    for (let i = 0; i < 40; i++) { advance(2_000); emitIndexSnapshotForTest() } // 80 s of ticks
    for (let i = 0; i < 100 && !(await paths('')).includes(join(home, 'late-one')); i++) await new Promise(r => setTimeout(r, 20))
    expect(await paths('')).toContain(join(home, 'late-one'))
  })

  test('a deleted folder leaves the index once a later full scan has run', async () => {
    mk('gone-soon')
    advance(2_000)
    expect(await paths('gone')).toContain(join(home, 'gone-soon'))
    rmSync(join(home, 'gone-soon'), { recursive: true })
    advance(65_000)
    await paths('')
    await idle()
    expect(await paths('')).not.toContain(join(home, 'gone-soon'))
  })

  test('newProjectParent sees repositories created after the first index', async () => {
    expect((await newProjectParent(false, home)).path).toBe(join(home, 'code'))
    repo('fresh/a'); repo('fresh/b'); repo('fresh/c')
    advance(2_000)
    expect((await newProjectParent(false, home)).path).toBe(join(home, 'fresh'))
  })
})
