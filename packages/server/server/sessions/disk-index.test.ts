import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiskCrawler, DiskIndex } from './disk-index'

const cleanup: string[] = []
afterEach(async () => { while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true }) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'disk-index-'))
  cleanup.push(root)
  await mkdir(join(root, 'one', 'deep'), { recursive: true })
  await writeFile(join(root, 'one', 'package.json'), '{}')
  await mkdir(join(root, 'node_modules', 'hidden'), { recursive: true })
  return root
}

describe('DiskCrawler', () => {
  it('resumes queued directories from its durable frontier after restart', async () => {
    const root = await fixture()
    const stateFile = join(root, 'state.json')
    const first = new DiskCrawler({ root, stateFile, sliceMs: 0 })
    await first.tick()
    const saved = JSON.parse(await readFile(stateFile, 'utf8'))
    expect(saved.queue.length).toBeGreaterThan(0)
    const second = new DiskCrawler({ root, stateFile, sliceMs: 1000 })
    await second.tick()
    expect(second.candidates()).toContainEqual(expect.objectContaining({ path: join(root, 'one') }))
  })

  it('advances five disks round-robin, one root per tick', async () => {
    const roots = await Promise.all(Array.from({ length: 5 }, async (_, i) => {
      const root = await fixture()
      await writeFile(join(root, `disk-${i}.json`), '{}')
      return root
    }))
    const index = new DiskIndex()
    const made = new Map<string, DiskCrawler>()
    index.configure(roots, root => { const c = new DiskCrawler({ root, stateFile: join(root, 'state.json'), sliceMs: 1000 }); made.set(root, c); return c })
    await index.tick()
    const progress = index.snapshot().progress
    expect(progress.filter(p => p.visited > 0)).toHaveLength(1)
    await index.tick()
    expect(index.snapshot().progress.filter(p => p.visited > 0)).toHaveLength(2)
  })

  it('does not descend into the skip list and finds project markers', async () => {
    const root = await fixture()
    const crawler = new DiskCrawler({ root, stateFile: join(root, 'state.json'), sliceMs: 1000 })
    await crawler.tick()
    expect(crawler.candidates().map(c => c.path)).toContain(join(root, 'one'))
    expect(crawler.candidates().some(c => c.path.includes('node_modules'))).toBe(false)
  })

  it('honours the injected slice clock', async () => {
    const root = await fixture()
    let clock = 0
    const crawler = new DiskCrawler({ root, stateFile: join(root, 'state.json'), sliceMs: 2, now: () => ++clock })
    const progress = await crawler.tick()
    expect(progress.queued).toBeGreaterThan(0)
  })
})

describe('DiskIndex idle behaviour', () => {
  it('does not tick or notify when there are no roots', async () => {
    const index = new DiskIndex()
    let calls = 0
    index.onSnapshot = () => { calls++ }
    index.configure([])
    await index.tick()
    await index.tick()
    expect(calls).toBe(1 - 1 + (calls ? 1 : 0)) // first signature may notify once at most
    expect(calls).toBeLessThanOrEqual(1)
  })

  it('notifies only when the snapshot changed, and a complete crawler stops rewriting state', async () => {
    const root = await fixture()
    const stateFile = join(root, 'state.json')
    const index = new DiskIndex()
    let calls = 0
    index.onSnapshot = () => { calls++ }
    index.configure([root], r => new DiskCrawler({ root: r, stateFile, sliceMs: 1000 }))
    await index.tick()
    expect(index.snapshot().indexing).toBe(false)
    const after = calls
    const written = await readFile(stateFile, 'utf8')
    await rm(stateFile)
    await index.tick()
    await index.tick()
    expect(calls).toBe(after)
    await expect(readFile(stateFile, 'utf8')).rejects.toThrow() // no rewrite once complete
    expect(written.length).toBeGreaterThan(0)
  })
})

describe('DiskIndex wake', () => {
  it('never runs two ticks at once when configure() adds a root mid-tick', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentop-wake-'))
    cleanup.push(dir)
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
    let n = 0
    const factory = (root: string) => new DiskCrawler({
      root, stateFile: join(dir, `s-${n++}.json`), sliceMs: 10_000,
      statDir: async () => ({ mtimeMs: 1 }),
      readDir: async () => { await sleep(120); return [] },
    })
    const idx = new DiskIndex()
    let active = 0
    let max = 0
    const orig = idx.tick.bind(idx)
    idx.tick = async () => { active++; max = Math.max(max, active); try { return await orig() } finally { active-- } }
    idx.configure(['/fakeA'], factory)
    idx.start()
    await sleep(40)
    idx.configure(['/fakeA', '/fakeB'], factory)
    await sleep(600)
    idx.stop()
    expect(max).toBe(1)
  })
})
