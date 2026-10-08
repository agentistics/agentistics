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
