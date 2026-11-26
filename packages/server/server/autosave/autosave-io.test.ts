/**
 * autosave-io.test.ts — a real round over THROWAWAY repositories under a temp dir (never a real repo, never the
 * real bundle folder): the primitives are real (git, fs), handed in from here.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { gitTestEnv } from '@agentistics/core/gitTestEnv'
import { join, relative } from 'node:path'
import { createAutosaver, resolveWindowsProfile, type AutosaveIo, type GitOptions, type TreeOutcome } from './autosave-io'
import { autosaveSlug } from './autosave-plan'

const ROOT = mkdtempSync(join(tmpdir(), 'autosave-test-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

const HOME = join(ROOT, 'home')
mkdirSync(HOME, { recursive: true })
const ENV = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C', LC_ALL: 'C' }

async function gitRaw(cwd: string, args: readonly string[], opts?: GitOptions) {
  const p = Bun.spawn(['git', ...args], {
    cwd, env: { ...gitTestEnv(ENV), ...(opts?.env ?? {}) },
    stdin: opts?.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { code, stdout, stderr }
}
async function g(cwd: string, ...args: string[]): Promise<string> {
  const r = await gitRaw(cwd, ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args])
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

let clock = Date.parse('2026-11-26T12:00:00Z')
let tmpN = 0
function realIo(over: Partial<AutosaveIo> = {}): AutosaveIo {
  return {
    home: HOME,
    now: () => clock,
    git: gitRaw,
    fileSize: async p => { try { return lstatSync(p).size } catch { return null } },
    listDir: async d => { try { return readdirSync(d) } catch { return null } },
    ensureDir: async d => { mkdirSync(d, { recursive: true }) },
    moveFile: async (a, b) => renameSync(a, b),
    duplicateFile: async (a, b) => copyFileSync(a, b),
    removeFile: async p => rmSync(p, { force: true }),
    makeTempDir: async () => { const d = join(ROOT, 'tmpidx', String(tmpN++)); mkdirSync(d, { recursive: true }); return d },
    removeTree: async d => rmSync(d, { recursive: true, force: true }),
    ...over,
  }
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

/** Everything the person owns in a checkout: the index, HEAD, every branch ref, and every working-tree file. */
async function snapshot(wt: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const indexPath = await g(wt, 'rev-parse', '--path-format=absolute', '--git-path', 'index')
  out['<index>'] = existsSync(indexPath) ? sha(readFileSync(indexPath)) : 'none'
  out['<index-mtime>'] = existsSync(indexPath) ? String(statSync(indexPath).mtimeMs) : 'none'
  out['<HEAD>'] = readFileSync(await g(wt, 'rev-parse', '--path-format=absolute', '--git-path', 'HEAD'), 'utf8')
  out['<branches>'] = await g(wt, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes')
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === '.git') continue
      const p = join(dir, name)
      const st = lstatSync(p)
      if (st.isDirectory()) walk(p)
      else out[relative(wt, p)] = `${sha(readFileSync(p))}:${st.mode}:${st.mtimeMs}`
    }
  }
  walk(wt)
  return out
}

let n = 0
/** origin (bare) + a clone with one pushed commit. */
async function makeRepo(): Promise<{ origin: string; wt: string }> {
  const base = join(ROOT, `r${n++}`)
  const origin = join(base, 'origin.git')
  const wt = join(base, 'work')
  mkdirSync(base, { recursive: true })
  await g(base, 'init', '-q', '--bare', '-b', 'main', origin)
  await g(base, 'clone', '-q', origin, wt)
  await g(wt, 'checkout', '-q', '-b', 'main')
  writeFileSync(join(wt, 'tracked.txt'), 'v1\n')
  writeFileSync(join(wt, '.gitignore'), 'ignored.log\n')
  mkdirSync(join(wt, 'src'))
  writeFileSync(join(wt, 'src', 'a.ts'), 'export const a = 1\n')
  await g(wt, 'add', '.')
  await g(wt, 'commit', '-q', '-m', 'init')
  await g(wt, 'push', '-q', 'origin', 'main')
  return { origin, wt }
}

/** The file list (and one file's bytes) of a saved ref, read back from the BUNDLE alone, in a fresh clone of origin. */
async function readBundle(origin: string, bundle: string, slug: string): Promise<{ files: string[]; show: (p: string) => Promise<string> }> {
  const v = join(ROOT, `verify${n++}`)
  await g(ROOT, 'clone', '-q', origin, v)
  await g(v, 'fetch', '-q', bundle, `refs/agentistics/autosave/${slug}:refs/saved/x`)
  const files = (await g(v, 'ls-tree', '-r', '--name-only', 'refs/saved/x')).split('\n').filter(Boolean).sort()
  return { files, show: p => g(v, 'show', `refs/saved/x:${p}`) }
}

let bundleDir = ''
beforeEach(() => { bundleDir = join(ROOT, `bundles${n++}`) })
const only = (trees: TreeOutcome[], path: string) => { const t = trees.find(x => x.path === path); if (!t) throw new Error(`no outcome for ${path}`); return t }

describe('a round over a dirty tree', () => {
  test('dirty + untracked + secret-named + 6 MB → the bundle holds exactly the right set, and nothing the person owns moved', async () => {
    const { origin, wt } = await makeRepo()
    writeFileSync(join(wt, 'tracked.txt'), 'v2 uncommitted\n')
    writeFileSync(join(wt, 'src', 'staged.ts'), 'staged\n')
    await g(wt, 'add', 'src/staged.ts') // a staged change: the real index differs from HEAD, and must stay as it is
    writeFileSync(join(wt, 'notes.md'), 'untracked work\n')
    writeFileSync(join(wt, '*'), 'a file literally named star\n')
    writeFileSync(join(wt, '.env'), 'API_KEY=x\n')
    writeFileSync(join(wt, 'deploy.pem'), 'key\n')
    writeFileSync(join(wt, 'big.bin'), Buffer.alloc(6 * 1024 * 1024, 1))
    writeFileSync(join(wt, 'ignored.log'), 'ignored\n')
    const statusBefore = await g(wt, 'status', '--porcelain') // (a plain status refreshes the index: taken BEFORE the snapshot)
    const before = await snapshot(wt)

    const r = await createAutosaver(realIo()).round({ repos: [wt], bundleDir })
    expect(r.ran).toBe(true)
    const t = only(r.trees, wt)
    expect(t.outcome).toBe('saved')
    if (t.outcome !== 'saved') return
    expect(t.skippedFiles.map(s => `${s.path}:${s.reason}`).sort()).toEqual(['.env:secret', 'big.bin:too-large', 'deploy.pem:secret'])

    expect(await snapshot(wt)).toEqual(before)
    expect(await g(wt, '--no-optional-locks', 'status', '--porcelain')).toBe(statusBefore)
    expect(await g(wt, 'branch', '--list')).toBe('* main') // the hidden ref is not a branch

    const slug = autosaveSlug(wt, HOME)
    const b = await readBundle(origin, t.bundle, slug)
    expect(b.files).toEqual(['*', '.gitignore', 'notes.md', 'src/a.ts', 'src/staged.ts', 'tracked.txt'])
    expect(await b.show('tracked.txt')).toBe('v2 uncommitted')
    expect(existsSync(join(bundleDir, `${slug}.2026-11-26.bundle`))).toBe(true)
    expect(readdirSync(bundleDir).filter(f => f.endsWith('.tmp'))).toEqual([])
  })

  test('unchanged fingerprint → no new bundle; a change → a new one; a deleted bundle → saved again', async () => {
    const { wt } = await makeRepo()
    writeFileSync(join(wt, 'tracked.txt'), 'dirty\n')
    const saver = createAutosaver(realIo())
    const first = only((await saver.round({ repos: [wt], bundleDir })).trees, wt)
    expect(first.outcome).toBe('saved')
    const slug = autosaveSlug(wt, HOME)
    const current = join(bundleDir, `${slug}.bundle`)
    const bytes = readFileSync(current)
    const mtime = statSync(current).mtimeMs

    const second = only((await saver.round({ repos: [wt], bundleDir })).trees, wt)
    expect(second).toMatchObject({ outcome: 'skipped', why: 'unchanged' })
    expect(statSync(current).mtimeMs).toBe(mtime)
    expect(readFileSync(current).equals(bytes)).toBe(true)

    writeFileSync(join(wt, 'tracked.txt'), 'dirty again\n')
    expect(only((await saver.round({ repos: [wt], bundleDir })).trees, wt).outcome).toBe('saved')
    expect(readFileSync(current).equals(bytes)).toBe(false)

    rmSync(current)
    expect(only((await saver.round({ repos: [wt], bundleDir })).trees, wt).outcome).toBe('saved')
    expect(existsSync(current)).toBe(true)
  })
})

describe('which trees', () => {
  test('a clean pushed tree is skipped; an unpushed clean commit is bundled as HEAD itself; a linked worktree is found from its repo', async () => {
    const { origin, wt } = await makeRepo()
    const linked = join(ROOT, `linked${n++}`)
    await g(wt, 'worktree', 'add', '-q', '-b', 'feat', linked)
    writeFileSync(join(linked, 'feat.txt'), 'feat\n')
    await g(linked, 'add', 'feat.txt')
    await g(linked, 'commit', '-q', '-m', 'feat work')
    const head = await g(linked, 'rev-parse', 'HEAD')
    const before = await snapshot(linked)

    const r = await createAutosaver(realIo()).round({ repos: [wt], bundleDir })
    expect(only(r.trees, wt)).toMatchObject({ outcome: 'skipped', why: 'clean' })
    const t = only(r.trees, linked)
    expect(t).toMatchObject({ outcome: 'saved', commit: head })
    expect(await snapshot(linked)).toEqual(before)
    if (t.outcome === 'saved') expect((await readBundle(origin, t.bundle, t.slug)).files).toContain('feat.txt')
  })

  test('a registry cwd in a SUBFOLDER saves the whole tree (root untracked included), and repo + subfolder are ONE tree', async () => {
    const { origin, wt } = await makeRepo()
    writeFileSync(join(wt, 'root-untracked.txt'), 'at the root\n')
    writeFileSync(join(wt, 'src', 'sub-untracked.ts'), 'in src\n')
    const sub = join(wt, 'src')

    const alone = await createAutosaver(realIo()).round({ repos: [], trees: [sub], bundleDir })
    expect(alone.trees.length).toBe(1)
    const t = only(alone.trees, wt)
    expect(t.outcome).toBe('saved')
    if (t.outcome === 'saved') {
      const files = (await readBundle(origin, t.bundle, t.slug)).files
      expect(files).toContain('root-untracked.txt')
      expect(files).toContain('src/sub-untracked.ts')
    }

    bundleDir = join(ROOT, `bundles${n++}`)
    const both = await createAutosaver(realIo()).round({ repos: [wt], trees: [sub, `${wt}/`], bundleDir })
    expect(both.trees.map(x => x.path)).toEqual([wt])
    expect(readdirSync(bundleDir).filter(f => f.endsWith('.bundle') && !/\.\d{4}-\d{2}-\d{2}\.bundle$/.test(f)).length).toBe(1)
  })

  test('dirty only by filtered files and nothing unpushed → nothing-saveable, no bundle written', async () => {
    const { wt } = await makeRepo()
    writeFileSync(join(wt, '.env.local'), 'S=1\n')
    const t = only((await createAutosaver(realIo()).round({ repos: [wt], bundleDir })).trees, wt)
    expect(t).toMatchObject({ outcome: 'skipped', why: 'nothing-saveable' })
    expect(readdirSync(bundleDir)).toEqual([])
  })

  test('a repo with no identity and signing ON still saves (fixed identity, --no-gpg-sign), no prompt', async () => {
    const { wt } = await makeRepo()
    await g(wt, 'config', 'user.useConfigOnly', 'true')
    await g(wt, 'config', 'commit.gpgsign', 'true')
    await g(wt, 'config', 'gpg.program', '/bin/false')
    writeFileSync(join(wt, 'tracked.txt'), 'x\n')
    expect(only((await createAutosaver(realIo()).round({ repos: [wt], bundleDir })).trees, wt).outcome).toBe('saved')
  })
})

describe('failure and retention', () => {
  test('a crash mid-bundle keeps the previous bundle byte for byte, puts the ref back, and the next round saves', async () => {
    const { wt } = await makeRepo()
    writeFileSync(join(wt, 'tracked.txt'), 'one\n')
    const ok = createAutosaver(realIo())
    expect(only((await ok.round({ repos: [wt], bundleDir })).trees, wt).outcome).toBe('saved')
    const slug = autosaveSlug(wt, HOME)
    const current = join(bundleDir, `${slug}.bundle`)
    const previous = readFileSync(current)
    const refBefore = await g(wt, 'rev-parse', `refs/agentistics/autosave/${slug}`)

    writeFileSync(join(wt, 'tracked.txt'), 'two\n')
    // The bundle process dies after writing half a file to its temp name.
    const crashing = createAutosaver(realIo({
      git: async (cwd, args, opts) => {
        if (args[0] === 'bundle' && args[1] === 'create') { writeFileSync(String(args[3]), 'PARTIAL'); return { code: 137, stdout: '', stderr: 'killed' } }
        return gitRaw(cwd, args, opts)
      },
    }))
    expect(only((await crashing.round({ repos: [wt], bundleDir })).trees, wt)).toMatchObject({ outcome: 'failed', why: 'bundle' })
    expect(readFileSync(current).equals(previous)).toBe(true)
    expect(await g(wt, 'rev-parse', `refs/agentistics/autosave/${slug}`)).toBe(refBefore)
    expect(readdirSync(bundleDir).filter(f => f.endsWith('.tmp'))).toEqual([])

    expect(only((await ok.round({ repos: [wt], bundleDir })).trees, wt).outcome).toBe('saved')
    expect(readFileSync(current).equals(previous)).toBe(false)
  })

  test('a failed FIRST bundle leaves no ref behind', async () => {
    const { wt } = await makeRepo()
    writeFileSync(join(wt, 'tracked.txt'), 'one\n')
    const failing = createAutosaver(realIo({ git: async (c, a, o) => (a[0] === 'bundle' && a[1] === 'create' ? { code: 1, stdout: '', stderr: 'x' } : gitRaw(c, a, o)) }))
    expect(only((await failing.round({ repos: [wt], bundleDir })).trees, wt).outcome).toBe('failed')
    expect(await g(wt, 'for-each-ref', 'refs/agentistics')).toBe('')
  })

  /** The commit the CURRENT bundle holds for the tree's hidden ref (read from the bundle file itself). */
  async function bundleHead(wt: string, slug: string): Promise<string> {
    const out = await g(wt, 'bundle', 'list-heads', join(bundleDir, `${slug}.bundle`), `refs/agentistics/autosave/${slug}`)
    return out.split(/\s+/)[0] ?? ''
  }

  test('a failing MOVE (C: full, file held by Windows) → the next round writes the bundle again, never "unchanged"', async () => {
    const { wt } = await makeRepo()
    writeFileSync(join(wt, 'tracked.txt'), 'one\n')
    const ok = createAutosaver(realIo())
    expect(only((await ok.round({ repos: [wt], bundleDir })).trees, wt).outcome).toBe('saved')
    const slug = autosaveSlug(wt, HOME)
    const refBefore = await g(wt, 'rev-parse', `refs/agentistics/autosave/${slug}`)

    writeFileSync(join(wt, 'tracked.txt'), 'two\n')
    const failingMove = createAutosaver(realIo({ moveFile: async () => { throw new Error('EBUSY') } }))
    expect(only((await failingMove.round({ repos: [wt], bundleDir })).trees, wt)).toMatchObject({ outcome: 'failed', why: 'bundle-move' })
    expect(await g(wt, 'rev-parse', `refs/agentistics/autosave/${slug}`)).toBe(refBefore)
    expect(readdirSync(bundleDir).filter(f => f.endsWith('.tmp'))).toEqual([])

    const next = only((await ok.round({ repos: [wt], bundleDir })).trees, wt)
    expect(next.outcome).toBe('saved')
    expect(await bundleHead(wt, slug)).toBe(await g(wt, 'rev-parse', `refs/agentistics/autosave/${slug}`))
  })

  test('an EXCEPTION in the bundle step → the next round writes the bundle again', async () => {
    const { wt } = await makeRepo()
    writeFileSync(join(wt, 'tracked.txt'), 'one\n')
    const ok = createAutosaver(realIo())
    expect(only((await ok.round({ repos: [wt], bundleDir })).trees, wt).outcome).toBe('saved')
    const slug = autosaveSlug(wt, HOME)

    writeFileSync(join(wt, 'tracked.txt'), 'two\n')
    const throwing = createAutosaver(realIo({
      git: async (c, a, o) => { if (a[0] === 'bundle' && a[1] === 'create') throw new Error('spawn died'); return gitRaw(c, a, o) },
    }))
    expect(only((await throwing.round({ repos: [wt], bundleDir })).trees, wt).outcome).toBe('failed')
    expect(only((await ok.round({ repos: [wt], bundleDir })).trees, wt).outcome).toBe('saved')
    expect(await bundleHead(wt, slug)).toBe(await g(wt, 'rev-parse', `refs/agentistics/autosave/${slug}`))
  })

  test('the VM dies right after update-ref (nothing can put the ref back) → the next round still re-bundles', async () => {
    const { wt } = await makeRepo()
    writeFileSync(join(wt, 'tracked.txt'), 'one\n')
    const ok = createAutosaver(realIo())
    expect(only((await ok.round({ repos: [wt], bundleDir })).trees, wt).outcome).toBe('saved')
    const slug = autosaveSlug(wt, HOME)
    const oldHead = await bundleHead(wt, slug)

    writeFileSync(join(wt, 'tracked.txt'), 'two\n')
    let dead = false
    const dying = createAutosaver(realIo({
      git: async (c, a, o) => {
        if (dead) throw new Error('process gone')
        if (a[0] === 'bundle' && a[1] === 'create') { dead = true; throw new Error('process gone') }
        return gitRaw(c, a, o)
      },
    }))
    await dying.round({ repos: [wt], bundleDir })
    // The ref moved and stayed moved; the bundle on disk is still the old one.
    expect(await g(wt, 'rev-parse', `refs/agentistics/autosave/${slug}`)).not.toBe(oldHead)
    expect(await bundleHead(wt, slug)).toBe(oldHead)

    expect(only((await ok.round({ repos: [wt], bundleDir })).trees, wt).outcome).toBe('saved')
    expect(await bundleHead(wt, slug)).toBe(await g(wt, 'rev-parse', `refs/agentistics/autosave/${slug}`))
    expect(await bundleHead(wt, slug)).not.toBe(oldHead)
  })

  test('retention keeps N daily snapshots + the current bundle, and sweeps a crashed temp', async () => {
    const { wt } = await makeRepo()
    const saver = createAutosaver(realIo())
    const slug = autosaveSlug(wt, HOME)
    for (let day = 1; day <= 5; day++) {
      clock = Date.parse(`2026-11-${String(day).padStart(2, '0')}T12:00:00Z`)
      writeFileSync(join(wt, 'tracked.txt'), `day ${day}\n`)
      expect(only((await saver.round({ repos: [wt], bundleDir, keepDaily: 3 })).trees, wt).outcome).toBe('saved')
    }
    writeFileSync(join(bundleDir, `.${slug}.bundle.tmp`), 'left by a crash')
    clock = Date.parse('2026-11-06T12:00:00Z')
    writeFileSync(join(wt, 'tracked.txt'), 'day 6\n')
    await saver.round({ repos: [wt], bundleDir, keepDaily: 3 })
    expect(readdirSync(bundleDir).sort()).toEqual([`${slug}.2026-11-04.bundle`, `${slug}.2026-11-05.bundle`, `${slug}.2026-11-06.bundle`, `${slug}.bundle`].sort())
    clock = Date.parse('2026-11-26T12:00:00Z')
  })
})

describe('the round gate', () => {
  test('low memory skips the scheduled round and writes nothing; the critical round runs', async () => {
    const { wt } = await makeRepo()
    writeFileSync(join(wt, 'tracked.txt'), 'x\n')
    const io = realIo({ memAvailableBytes: async () => 512 * 1024 * 1024 })
    const skipped = await createAutosaver(io).round({ repos: [wt], bundleDir })
    expect(skipped).toMatchObject({ ran: false, why: 'low-memory', trees: [] })
    expect(existsSync(bundleDir)).toBe(false)
    const critical = await createAutosaver(io).round({ repos: [wt], bundleDir, critical: true })
    expect(only(critical.trees, wt).outcome).toBe('saved')
  })

  test('one round at a time per autosaver', async () => {
    const { wt } = await makeRepo()
    writeFileSync(join(wt, 'tracked.txt'), 'x\n')
    const saver = createAutosaver(realIo())
    const [a, b] = await Promise.all([saver.round({ repos: [wt], bundleDir }), saver.round({ repos: [wt], bundleDir })])
    expect([a.why, b.why]).toContain('already-running')
  })

  test('the Windows profile is resolved through cmd.exe + wslpath, bounded, and null on any failure', async () => {
    const calls: string[][] = []
    const ok = await resolveWindowsProfile(async argv => {
      calls.push(argv)
      return argv[0] === 'cmd.exe' ? { code: 0, stdout: 'C:\\Users\\b\r\n' } : { code: 0, stdout: '/mnt/c/Users/b\n' }
    })
    expect(ok).toBe('/mnt/c/Users/b')
    expect(calls[1]).toEqual(['wslpath', '-u', 'C:\\Users\\b'])
    expect(await resolveWindowsProfile(async () => null)).toBeNull()
    expect(await resolveWindowsProfile(async () => ({ code: 0, stdout: '%USERPROFILE%\r\n' }))).toBeNull()
  })
})
