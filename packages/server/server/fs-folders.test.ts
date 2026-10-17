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

describe('createProjectFolder', () => {
  const { mkdirSync: mk, existsSync, symlinkSync: ln, writeFileSync: wf } = require('node:fs') as typeof import('node:fs')
  const { createProjectFolder, createFolderStatus } = require('./fs-folders') as typeof import('./fs-folders')
  const deps = { scanRoots: [] as string[], home, temporary, record: () => {} }

  test('creates the folder inside an allowed parent', async () => {
    const r = await createProjectFolder({ parent: home, name: 'meu-projeto' }, deps)
    expect(r).toEqual({ ok: true, path: join(home, 'meu-projeto') })
    expect(existsSync(join(home, 'meu-projeto'))).toBe(true)
  })
  test('a second attempt says exists (409) and names the path', async () => {
    const r = await createProjectFolder({ parent: home, name: 'meu-projeto' }, deps)
    expect(r).toEqual({ ok: false, reason: 'exists', path: join(home, 'meu-projeto') })
    expect(createFolderStatus('exists')).toBe(409)
  })
  test('names with spaces and accents are kept', async () => {
    const r = await createProjectFolder({ parent: home, name: 'Meu App Ótimo' }, deps)
    expect(r.ok).toBe(true)
  })
  test('traversal, absolute name and separators are refused (400)', async () => {
    for (const name of ['..', '../x', '/etc/x', 'a/b', 'a\\b', '.']) {
      const r = await createProjectFolder({ parent: home, name }, deps)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(createFolderStatus(r.reason)).toBe(400)
    }
  })
  test('invalid names: empty, long, reserved chars, Windows reserved, trailing dot/space, hidden', async () => {
    for (const name of ['', '  ', 'x'.repeat(65), 'a:b', 'a*b', 'CON', 'nul.txt', 'com1', 'app.', 'app ', '.hidden', 'node_modules']) {
      const r = await createProjectFolder({ parent: home, name }, deps)
      expect(r.ok).toBe(false)
    }
    expect(existsSync(join(home, '.hidden'))).toBe(false)
  })
  test('a relative or non-string parent and a parent outside the roots are forbidden (403)', async () => {
    for (const parent of ['relative/dir', '', 42, null, outside, '/etc']) {
      const r = await createProjectFolder({ parent, name: 'x' }, deps)
      expect(r).toEqual({ ok: false, reason: 'forbidden' })
    }
    expect(createFolderStatus('forbidden')).toBe(403)
    expect(existsSync(join(outside, 'x'))).toBe(false)
  })
  test('a parent that climbs out with .. is forbidden', async () => {
    const r = await createProjectFolder({ parent: join(home, '..', 'outside'), name: 'x' }, deps)
    expect(r).toEqual({ ok: false, reason: 'forbidden' })
  })
  test('a symlinked parent that leads out of the roots is forbidden', async () => {
    const r = await createProjectFolder({ parent: join(home, 'link'), name: 'viaLink' }, deps)
    expect(r).toEqual({ ok: false, reason: 'forbidden' })
    expect(existsSync(join(outside, 'viaLink'))).toBe(false)
  })
  test('a dangling symlink at the name counts as existing and is not followed', async () => {
    ln(join(outside, 'nowhere'), join(home, 'dangling'))
    const r = await createProjectFolder({ parent: home, name: 'dangling' }, deps)
    expect(r.ok).toBe(false)
    expect(existsSync(join(outside, 'nowhere'))).toBe(false)
  })
  test('an absent parent is parent-missing (404) unless it is the suggested default and createParent is set', async () => {
    const missing = join(home, 'nao-existe')
    expect(await createProjectFolder({ parent: missing, name: 'x', createParent: true }, deps)).toEqual({ ok: false, reason: 'parent-missing' })
    expect(existsSync(missing)).toBe(false)
    expect(createFolderStatus('parent-missing')).toBe(404)
    const nested = join(home, 'projetos', 'fundo')
    expect((await createProjectFolder({ parent: nested, name: 'x', createParent: true }, deps)).ok).toBe(false)
    expect(existsSync(join(home, 'projetos'))).toBe(false)
    const r = await createProjectFolder({ parent: join(home, 'projetos'), name: 'novo', createParent: true }, deps)
    expect(r).toEqual({ ok: true, path: join(home, 'projetos', 'novo'), createdParent: join(home, 'projetos') })
    expect((await createProjectFolder({ parent: join(home, 'projects'), name: 'novo' }, deps))).toEqual({ ok: false, reason: 'parent-missing' })
  })
  test('a parent that is a file is parent-missing', async () => {
    wf(join(home, 'plain.txt'), 'x')
    const r = await createProjectFolder({ parent: join(home, 'plain.txt'), name: 'x' }, deps)
    expect(r.ok).toBe(false)
  })
  test('an enabled disk is a valid parent', async () => {
    const r = await createProjectFolder({ parent: disk, name: 'noDisco' }, { ...deps, scanRoots: [disk] })
    expect(r.ok).toBe(true)
    expect((await createProjectFolder({ parent: disk, name: 'outro' }, deps)).ok).toBe(false)
  })
  void mk
})

describe('a created project is a valid cwd for every harness', () => {
  test('the folder createProjectFolder made plans a spawn for a NON-Claude harness unchanged', async () => {
    const { createProjectFolder } = await import('./fs-folders')
    const { planFleetSpawn } = await import('./sessions/fleet-spawn')
    const made = await createProjectFolder({ parent: home, name: 'projeto-codex' }, { scanRoots: [], home, temporary })
    if (!made.ok) throw new Error('expected the folder to be created')
    for (const id of ['codex', 'agy', 'kimi', 'claude']) {
      const out = planFleetSpawn({ harness: id, cwd: made.path }, [{ id, supportsModel: false, efforts: [] }])
      expect(out).toEqual({ ok: true, plan: { harness: id, cwd: made.path, attach: false, accountDecided: true } })
    }
  })
})

describe('createProjectFolder — r1 security fixes', () => {
  const fs = require('node:fs') as typeof import('node:fs')
  const { createProjectFolder, foldsCase } = require('./fs-folders') as typeof import('./fs-folders')
  const fresh = (tag: string) => {
    const b = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `fsf-${tag}-`))
    const h = join(b, 'home'); const out = join(b, 'outside')
    mkdirSync(h, { recursive: true }); mkdirSync(out, { recursive: true })
    return { h, out, deps: { scanRoots: [] as string[], home: h, temporary: join(b, 'tmp'), record: () => {} } }
  }

  test('TOCTOU: a parent swapped for an outside symlink between check and mkdir is undone and refused', async () => {
    const { h, out, deps } = fresh('swap')
    const work = join(h, 'work'); mkdirSync(work)
    const r = await createProjectFolder({ parent: work, name: 'evil' }, {
      ...deps,
      beforeMkdir: () => { fs.rmSync(work, { recursive: true }); symlinkSync(out, work) },
    })
    expect(r).toEqual({ ok: false, reason: 'forbidden' })
    expect(fs.existsSync(join(out, 'evil'))).toBe(false)
  })
  test('a symlink component anywhere between the root and the parent is refused before any write', async () => {
    const { h, out, deps } = fresh('chain')
    mkdirSync(join(out, 'deep'))
    symlinkSync(out, join(h, 'via'))
    const r = await createProjectFolder({ parent: join(h, 'via', 'deep'), name: 'x' }, deps)
    expect(r).toEqual({ ok: false, reason: 'forbidden' })
    expect(fs.existsSync(join(out, 'deep', 'x'))).toBe(false)
    // Even a symlink that stays INSIDE the home is not followed.
    mkdirSync(join(h, 'real')); symlinkSync(join(h, 'real'), join(h, 'alias'))
    expect(await createProjectFolder({ parent: join(h, 'alias'), name: 'y' }, deps)).toEqual({ ok: false, reason: 'forbidden' })
    expect(fs.existsSync(join(h, 'real', 'y'))).toBe(false)
  })
  test('case is folded only on win32/darwin', () => {
    expect(foldsCase('linux')).toBe(false)
    expect(foldsCase('win32')).toBe(true)
    expect(foldsCase('darwin')).toBe(true)
  })
  test('Linux: a case variant of the home is NOT the home — nothing is written there', async () => {
    const { h, deps } = fresh('case')
    const variant = h.replace(/home$/, 'HOME'); mkdirSync(variant)
    const r = await createProjectFolder({ parent: join(variant, 'projects'), name: 'x', createParent: true }, { ...deps, platform: 'linux' })
    expect(r).toEqual({ ok: false, reason: 'forbidden' })
    expect(fs.existsSync(join(variant, 'projects'))).toBe(false)
    expect(await createProjectFolder({ parent: join(h, 'Projetos'), name: 'x', createParent: true }, { ...deps, platform: 'linux' }))
      .toEqual({ ok: false, reason: 'parent-missing' })
    expect(fs.existsSync(join(h, 'Projetos'))).toBe(false)
  })
  test('createParent only under the HOME root, not an enabled disk', async () => {
    const { h, deps } = fresh('disk')
    const d = join(h, '..', 'disk'); mkdirSync(d)
    const r = await createProjectFolder({ parent: join(d, 'projects'), name: 'x', createParent: true }, { ...deps, scanRoots: [d] })
    expect(r).toEqual({ ok: false, reason: 'parent-missing' })
  })
  test('createParent creates the default parent then the project, and records both', async () => {
    const { h, deps } = fresh('parent')
    const seen: unknown[] = []
    const r = await createProjectFolder({ parent: join(h, 'projetos'), name: 'loja', createParent: true }, { ...deps, record: e => seen.push(e) })
    expect(r).toEqual({ ok: true, path: join(h, 'projetos', 'loja'), createdParent: join(h, 'projetos') })
    expect(seen).toEqual([{ path: join(h, 'projetos', 'loja'), createdParent: join(h, 'projetos') }])
  })
  test('exists + path only for a real directory inside the roots; a file or symlink is exists-other', async () => {
    const { h, out, deps } = fresh('exists')
    mkdirSync(join(h, 'pasta'))
    fs.writeFileSync(join(h, 'arquivo'), 'x')
    symlinkSync(out, join(h, 'atalho'))
    symlinkSync(join(h, 'pasta'), join(h, 'atalho-dentro'))
    expect(await createProjectFolder({ parent: h, name: 'pasta' }, deps)).toEqual({ ok: false, reason: 'exists', path: join(h, 'pasta') })
    for (const name of ['arquivo', 'atalho', 'atalho-dentro']) {
      expect(await createProjectFolder({ parent: h, name }, deps)).toEqual({ ok: false, reason: 'exists-other' })
    }
  })
  test('a successful creation is recorded once; a refusal records nothing', async () => {
    const { h, out, deps } = fresh('audit')
    const seen: unknown[] = []
    const rec = { ...deps, record: (e: unknown) => seen.push(e) }
    await createProjectFolder({ parent: h, name: 'ok' }, rec)
    await createProjectFolder({ parent: h, name: 'ok' }, rec)
    await createProjectFolder({ parent: out, name: 'no' }, rec)
    expect(seen).toEqual([{ path: join(h, 'ok') }])
  })
  test('the default recorder writes one [audit] line', () => {
    const { logFolderCreated } = require('./fs-folders') as typeof import('./fs-folders')
    const orig = console.info; const lines: string[] = []
    console.info = (s: string) => { lines.push(s) }
    try { logFolderCreated({ path: '/h/x' }) } finally { console.info = orig }
    expect(lines).toEqual(['[audit] fs.folder.create path="/h/x"'])
  })
})
