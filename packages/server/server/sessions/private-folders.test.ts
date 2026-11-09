import { describe, expect, it } from 'bun:test'
import type { Dirent } from 'node:fs'
import { mkdir, mkdtemp, readdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isPrivateMacPath, scanDirectories } from './dir-scan'
import { DiskCrawler } from './disk-index'
import { listFolders } from '../fs-folders'

const HOME = '/Users/ana'
const PRIVATE = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Movies', 'Music', 'Public', 'Library']

function dirent(name: string): Dirent<string> {
  return { name, isDirectory: () => true, isFile: () => false } as unknown as Dirent<string>
}

/** A fake filesystem that records every read and stat. */
function fakeFs(tree: Record<string, string[]>) {
  const touched: string[] = []
  return {
    touched,
    readDir: async (dir: string) => { touched.push(dir); return (tree[dir] ?? []).map(dirent) },
    statDir: async (dir: string) => { touched.push(dir); return { mtimeMs: 1 } },
  }
}

const tree: Record<string, string[]> = {
  [HOME]: [...PRIVATE, 'code', 'Photos.photoslibrary'],
  [`${HOME}/code`]: ['app'],
  [`${HOME}/Desktop`]: ['secret'],
  [`${HOME}/Library`]: ['Mobile Documents'],
}

const underPrivate = (p: string) => PRIVATE.some(n => p === `${HOME}/${n}` || p.startsWith(`${HOME}/${n}/`)) || p.includes('.photoslibrary')

describe('isPrivateMacPath', () => {
  it('flags the macOS private folders and anything below them, only on darwin', () => {
    for (const n of PRIVATE) expect(isPrivateMacPath(`${HOME}/${n}`, HOME, 'darwin')).toBe(true)
    expect(isPrivateMacPath(`${HOME}/Library/Mobile Documents/x`, HOME, 'darwin')).toBe(true)
    expect(isPrivateMacPath(`${HOME}/code`, HOME, 'darwin')).toBe(false)
    expect(isPrivateMacPath(`${HOME}/Desktop`, HOME, 'linux')).toBe(false)
  })
  it('flags a photoslibrary on every platform', () => {
    expect(isPrivateMacPath('/home/a/Pics/Photos.photoslibrary/x', '/home/a', 'linux')).toBe(true)
  })
  it('keeps the rule from a whole-disk root', () => {
    expect(isPrivateMacPath('/Users/bob/Downloads', HOME, 'darwin')).toBe(true)
  })
})

describe('background walks never touch private folders', () => {
  it('scanDirectories skips them without a readdir', async () => {
    const fs = fakeFs(tree)
    const out = await scanDirectories(HOME, { depth: 4, home: HOME, platform: 'darwin', readDir: fs.readDir })
    expect(out.map(d => d.name)).toContain('code')
    expect(fs.touched.filter(underPrivate)).toEqual([])
  })
  it('scanDirectories from a whole-disk root keeps the rule', async () => {
    const fs = fakeFs({ '/': ['Users'], '/Users': ['ana'], ...tree })
    await scanDirectories('/', { depth: 4, home: HOME, platform: 'darwin', readDir: fs.readDir })
    expect(fs.touched.filter(underPrivate)).toEqual([])
  })
  it('the disk crawler neither stats nor lists them, even if a previous run queued one', async () => {
    const fs = fakeFs(tree)
    const crawler = new DiskCrawler({
      root: HOME, depth: 4, home: HOME, platform: 'darwin', stateFile: `/tmp/pf-${process.pid}-${Math.random()}.json`,
      readDir: fs.readDir, statDir: fs.statDir,
    })
    await crawler.load()
    ;(crawler as unknown as { state: { queue: unknown[] } }).state.queue.push({ path: `${HOME}/Desktop`, depth: 1 })
    await crawler.tick()
    expect(fs.touched.filter(underPrivate)).toEqual([])
    expect(fs.touched).toContain(`${HOME}/code`)
  })
  it('the folder picker lists a private folder without reading it, and reads it once opened', async () => {
    const H = await realpath(await mkdtemp(join(tmpdir(), 'pf-home-')))
    await mkdir(join(H, 'Desktop', 'secret'), { recursive: true })
    await mkdir(join(H, 'code', 'app'), { recursive: true })
    const reads: string[] = []
    const list = async (d: string) => {
      reads.push(d)
      return (await readdir(d, { withFileTypes: true })).map(e => ({ name: e.name, dir: e.isDirectory() }))
    }
    const home = await listFolders(H, { scanRoots: [], home: H, temporary: '/nonexistent-tmp', platform: 'darwin', list })
    expect(home.ok && home.folders.map(f => f.name)).toContain('Desktop')
    expect(reads.filter(r => r.startsWith(join(H, 'Desktop')))).toEqual([])
    reads.length = 0
    const opened = await listFolders(join(H, 'Desktop'), { scanRoots: [], home: H, temporary: '/nonexistent-tmp', platform: 'darwin', list })
    expect(reads).toContain(join(H, 'Desktop'))
    expect(opened.ok && opened.folders.map(f => f.name)).toContain('secret')
  })
})
