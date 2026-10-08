import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { allowedRoots, isAllowedPath, listFolders } from './fs-folders'

// Real directories OUTSIDE the OS temp tree (it is a hidden folder by design) — under a throwaway cwd-free base.
const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'fsf-'))
const home = join(base, 'home'); const disk = join(base, 'disk'); const outside = join(base, 'outside')
for (const d of [join(home, '.config'), join(home, 'a', 'deep'), join(home, 'b'), join(home, 'node_modules'), disk, outside]) mkdirSync(d, { recursive: true })
writeFileSync(join(home, 'file.txt'), 'x')
symlinkSync(outside, join(home, 'link'))
const temporary = join(base, 'tmp-elsewhere')

describe('listFolders', () => {
  test('lists only directories, one level, with hasChildren', async () => {
    const r = await listFolders(home, { scanRoots: [], home, temporary })
    if (!r.ok) throw new Error('expected ok')
    const names = r.folders.map(f => f.name)
    expect(names).toContain('a'); expect(names).toContain('b')
    expect(names).not.toContain('file.txt')
    expect(names).not.toContain('deep')
    expect(r.folders.find(f => f.name === 'a')!.hasChildren).toBe(true)
    expect(r.folders.find(f => f.name === 'b')!.hasChildren).toBe(false)
  })
  test('skip list hides system folders', async () => {
    const r = await listFolders(home, { scanRoots: [], home, temporary })
    if (!r.ok) throw new Error()
    expect(r.folders.map(f => f.name)).not.toContain('node_modules')
    expect(r.folders.map(f => f.name)).not.toContain('.config')
  })
  test('outside the allowlist is forbidden; an enabled disk is allowed', async () => {
    expect(await listFolders(outside, { scanRoots: [], home, temporary })).toEqual({ ok: false, reason: 'forbidden' })
    expect((await listFolders(disk, { scanRoots: [disk], home, temporary })).ok).toBe(true)
    expect(await listFolders('/etc', { scanRoots: [], home, temporary })).toEqual({ ok: false, reason: 'forbidden' })
  })
  test('a symlink inside the home cannot lead out of it', async () => {
    expect(await listFolders(join(home, 'link'), { scanRoots: [], home, temporary })).toEqual({ ok: false, reason: 'forbidden' })
  })
  test('traversal is resolved before the check', async () => {
    expect(await listFolders(join(home, '..', 'outside'), { scanRoots: [], home, temporary })).toEqual({ ok: false, reason: 'forbidden' })
  })
  test('the temp tree is hidden', async () => {
    mkdirSync(join(home, 'tmp-elsewhere'), { recursive: true })
    const r = await listFolders(home, { scanRoots: [], home, temporary: join(home, 'tmp-elsewhere') })
    if (!r.ok) throw new Error()
    expect(r.folders.map(f => f.name)).not.toContain('tmp-elsewhere')
  })
  test('a slow listing answers partial instead of hanging', async () => {
    const t0 = Date.now()
    const r = await listFolders(home, { scanRoots: [], home, temporary, budgetMs: 50, list: () => new Promise(() => {}) })
    expect(r.ok && r.partial).toBe(true)
    expect(Date.now() - t0).toBeLessThan(500)
  })
  test('missing and bad paths', async () => {
    expect(await listFolders(join(home, 'nope'), { scanRoots: [], home, temporary })).toEqual({ ok: false, reason: 'not-found' })
    expect(await listFolders('', { scanRoots: [], home, temporary })).toEqual({ ok: false, reason: 'bad-path' })
  })
  test('parent is null at an allowed root', async () => {
    const r = await listFolders(home, { scanRoots: [], home, temporary })
    expect(r.ok && r.parent).toBe(null)
    const c = await listFolders(join(home, 'a'), { scanRoots: [], home, temporary })
    expect(c.ok && c.parent).toBe(home)
  })
})
describe('allowlist', () => {
  test('roots dedupe and match by prefix', () => {
    expect(allowedRoots(['/x', '/x/'], '/h')).toHaveLength(2)
    expect(isAllowedPath('/x/y', ['/x'])).toBe(true)
    expect(isAllowedPath('/xy', ['/x'])).toBe(false)
  })
})
