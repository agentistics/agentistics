/**
 * DOCKER.AMBIENTES S2 round 2 (SPEC r4) — each test here fails without its fix (kill-mutant): the QA of 27/11 proved
 * every one of these against the r3 code, in the real Docker or with processes.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENV_IMAGES } from '@agentistics/core'
import { admitMountPoints, admitWorktree, GIB, MaskListingError, runInDocker, worktreeEntries, worktreeOf } from './docker-run'
import { containerEnv } from './container-env'
import { generationRemoval, GEN_ENVELOPE_BYTES, GEN_BUDGET_BYTES, heldGenerations, readLedger, releaseGenerations, reserveGenerations, withLedger } from './ledger'
import { maskMounts } from './masks'
import { containerPlan, nmSlots } from './plans'
import { buildStaging, GENERATED_NPMRC, needsRepoFile } from './staging'

setDefaultTimeout(120_000)
const FAKE_TS = join(import.meta.dir, 'fake-docker.testing.ts')
const RACE_TS = join(import.meta.dir, 'ledger-race.testing.ts')
const CLI_TS = join(import.meta.dir, '..', '..', 'bin', 'cli.ts')
const BUN = ENV_IMAGES.find(i => i.key === 'bun-1.3')!

let dir: string, data: string, repo: string, log: string, state: string, FAKE: string
const git = (cwd: string, ...a: string[]) => { const r = spawnSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentistics-s2r2-'))
  data = join(dir, 'data'); repo = join(dir, 'repo'); log = join(dir, 'docker.log'); state = join(dir, 'state.json')
  mkdirSync(data); mkdirSync(repo)
  git(repo, 'init', '-q')
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'x', workspaces: ['packages/*'] }))
  mkdirSync(join(repo, 'packages', 'core'), { recursive: true })
  writeFileSync(join(repo, 'packages', 'core', 'package.json'), '{}')
  writeFileSync(state, '{}')
  FAKE = join(dir, 'docker')
  writeFileSync(FAKE, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_TS}' "$@"\n`, { mode: 0o755 })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const env = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, AGENTISTICS_DOCKER_BIN: FAKE, AGENTISTICS_FAKE_DOCKER_LOG: log, AGENTISTICS_FAKE_DOCKER_STATE: state })
const calls = (): string[][] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
const run = (cwd = repo) => runInDocker({ command: ['bun', 'test'], cwd, ttlSec: 60, dataDir: data, env: env(), memAvailable: () => 10 * GIB, memTotal: () => 12 * GIB, log: () => {} })
const created = () => calls().filter(a => a[0] === 'create' || a[0] === 'volume' && a[1] === 'create')

describe('r4 #1 — a host node_modules with content is never hidden by a mount point', () => {
  test('admitMountPoints: absent ⇒ created (and returned for the ledger), empty ⇒ ok and not claimed', () => {
    const slots = nmSlots(['packages/core'])
    mkdirSync(join(repo, 'packages', 'core', 'node_modules'))
    const a = admitMountPoints(repo, slots)
    expect(a).toEqual({ ok: true, created: [join(repo, 'node_modules')] })
    expect(lstatSync(join(repo, 'node_modules')).isDirectory()).toBe(true)
  })
  test('content ⇒ nm_host_nao_vazio and NOTHING is created for any slot', () => {
    mkdirSync(join(repo, 'packages', 'core', 'node_modules', 'local-package'), { recursive: true })
    writeFileSync(join(repo, 'packages', 'core', 'node_modules', 'local-package', 'fix.patch'), 'x')
    const a = admitMountPoints(repo, nmSlots(['packages/core']))
    expect(a).toMatchObject({ ok: false, code: 'nm_host_nao_vazio', path: join(repo, 'packages', 'core', 'node_modules') })
    expect(existsSync(join(repo, 'node_modules'))).toBe(false)
  })
  test('a file or a symlink in place of node_modules is refused (lstat, never followed)', () => {
    writeFileSync(join(repo, 'node_modules'), 'file')
    expect(admitMountPoints(repo, nmSlots([]))).toMatchObject({ ok: false })
    rmSync(join(repo, 'node_modules'))
    mkdirSync(join(dir, 'elsewhere')); symlinkSync(join(dir, 'elsewhere'), join(repo, 'node_modules'))
    expect(admitMountPoints(repo, nmSlots([]))).toMatchObject({ ok: false })
  })
  test('the ledger `mountpoints` lists exactly what agentop created', () => {
    expect(admitWorktree(data, 's1', false, repo, nmSlots(['packages/core']))).toBeNull()
    expect(readLedger(data).sessions['s1']!.mountpoints!.sort()).toEqual([join(repo, 'node_modules'), join(repo, 'packages', 'core', 'node_modules')].sort())
    // an empty directory that was already there is not claimed
    const other = join(dir, 'repo2'); mkdirSync(join(other, 'node_modules'), { recursive: true })
    expect(admitWorktree(data, 's2', false, other, nmSlots([]))).toBeNull()
    expect(readLedger(data).sessions['s2']?.mountpoints ?? []).toEqual([])
  })
  test('runInDocker: host content in node_modules ⇒ stays in the namespace, no volume, no container', async () => {
    mkdirSync(join(repo, 'node_modules', 'local-package'), { recursive: true })
    writeFileSync(join(repo, 'node_modules', 'local-package', 'fix.patch'), 'x')
    const r = await run()
    expect(r).toMatchObject({ ran: false, fallback: true })
    expect((r as any).reason).toMatch(/nm_host_nao_vazio/)
    expect(created()).toEqual([])
    expect(readFileSync(join(repo, 'node_modules', 'local-package', 'fix.patch'), 'utf8')).toBe('x')
  })
})

describe('r4 #2 — the download never mounts the worktree', () => {
  const slots = nmSlots(['packages/core'])
  test('staging holds ONLY the positive list + one generated .npmrc + empty node_modules mount points', () => {
    writeFileSync(join(repo, 'bun.lock'), '{"lockfileVersion":1}')
    for (const f of ['.pnpmfile.cjs', '.npmrc', '.yarnrc.yml', '.pnp.cjs', 'bunfig.toml', '.env']) writeFileSync(join(repo, f), 'SENTINELA-REPO-FILE')
    mkdirSync(join(repo, 'patches')); writeFileSync(join(repo, 'patches', 'a.patch'), 'x')
    const stage = join(dir, 'stage')
    const r = buildStaging(repo, slots, stage)
    expect(r.ok).toBe(true)
    const all: string[] = []
    const walk = (d: string, rel = '') => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = rel ? `${rel}/${e.name}` : e.name; all.push(p); if (e.isDirectory()) walk(join(d, e.name), p) } }
    walk(stage)
    expect(all.sort()).toEqual(['.npmrc', 'bun.lock', 'node_modules', 'package.json', 'packages', 'packages/core', 'packages/core/node_modules', 'packages/core/package.json'].sort())
    expect(readFileSync(join(stage, '.npmrc'), 'utf8')).toBe(GENERATED_NPMRC)
    expect(readFileSync(join(stage, '.npmrc'), 'utf8')).not.toMatch(/SENTINELA/)
  })
  test('a lockfile or manifest that needs a repo file ⇒ install_exige_arquivo_do_repo, nothing staged', () => {
    for (const bad of ['"dep": "file:../local"', '"x": "link:./y"', '"patchedDependencies": {"a": "patches/a.patch"}', 'resolution: "x@patch:x@1#./p.patch"', 'dep: portal:../p']) {
      writeFileSync(join(repo, 'package-lock.json'), `{ ${bad} }`)
      const stage = join(dir, `stage-${Math.random()}`)
      const r = buildStaging(repo, slots, stage)
      expect(r).toMatchObject({ ok: false, code: 'install_exige_arquivo_do_repo' })
      expect(existsSync(stage)).toBe(false)
    }
    expect(needsRepoFile('"resolved": "https://registry.npmjs.org/a/-/a-1.tgz", "link": true')).toBeNull()
  })
})

describe('r4 #3 — no git toplevel ⇒ nothing is mounted unmasked', () => {
  test('worktreeOf is null outside a repository (it used to answer with the cwd itself)', () => {
    const plain = join(dir, 'plain'); mkdirSync(plain)
    expect(worktreeOf(plain)).toBeNull()
  })
  test('runInDocker from a folder with .ssh/.env and no git: namespace fallback, zero docker create', async () => {
    const plain = join(dir, 'plain'); mkdirSync(join(plain, '.ssh'), { recursive: true })
    writeFileSync(join(plain, '.ssh', 'id_rsa'), 'SENTINELA-KEY'); writeFileSync(join(plain, '.env'), 'T=SENTINELA')
    const r = await run(plain)
    expect(r).toMatchObject({ ran: false, fallback: true })
    expect((r as any).reason).toMatch(/not inside a git worktree/)
    expect(created()).toEqual([])
  })
})

describe('r4 #4 — a failed ls-files is a refusal, never an empty mask list', () => {
  test('worktreeEntries throws MaskListingError on a corrupt index (git ls-files exits 128)', () => {
    writeFileSync(join(repo, '.env'), 'T=SENTINELA')
    git(repo, 'add', 'package.json'); git(repo, 'commit', '-q', '-m', 'x')
    writeFileSync(join(repo, '.git', 'index'), 'garbage-not-an-index')
    expect(spawnSync('git', ['-C', repo, 'rev-parse', '--show-toplevel']).status).toBe(0) // the case QA B measured
    expect(() => worktreeEntries(repo)).toThrow(MaskListingError)
  })
  test('runInDocker with the corrupt index: refused (no fallback to an unmasked run), no container created', async () => {
    writeFileSync(join(repo, '.env'), 'T=SENTINELA')
    git(repo, 'add', 'package.json'); git(repo, 'commit', '-q', '-m', 'x')
    writeFileSync(join(repo, '.git', 'index'), 'garbage-not-an-index')
    const r = await run()
    expect(r).toMatchObject({ ran: false, fallback: false })
    expect((r as any).reason).toMatch(/credential masks cannot be computed/)
    expect(calls().some(a => a[0] === 'create' && a.some(x => /-cmd-/.test(x)))).toBe(false)
  })
})

describe('r4 #5 — submodules, nested repositories and nested worktrees are hidden whole', () => {
  test('nested repo and nested worktree appear as foreignDirs; a gitlink (submodule) too', () => {
    git(repo, 'add', 'package.json'); git(repo, 'commit', '-q', '-m', 'x')
    const nested = join(repo, 'vendor', 'nested'); mkdirSync(nested, { recursive: true }); git(nested, 'init', '-q')
    writeFileSync(join(nested, '.env'), 'T=SENTINELA'); writeFileSync(join(nested, '.git', 'config'), '[remote "o"]\n url = https://u:SENTINELA@h/r\n')
    const wtDir = join(repo, '.claude', 'worktrees', 'w1'); mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
    git(repo, 'worktree', 'add', '-q', '-b', 'w1', wtDir)
    writeFileSync(join(wtDir, '.env'), 'T=SENTINELA')
    mkdirSync(join(repo, 'sub')); writeFileSync(join(repo, 'sub', '.env'), 'T=SENTINELA')
    git(repo, 'update-index', '--add', '--cacheinfo', `160000,${git(repo, 'rev-parse', 'HEAD').trim()},sub`)
    const w = worktreeEntries(repo)
    expect(w.foreignDirs).toEqual(['.claude/worktrees/w1', 'sub', 'vendor/nested'])
    const { mounts, masked } = maskMounts(repo, w.entries, { foreignDirs: w.foreignDirs })
    for (const d of w.foreignDirs) expect(mounts).toContainEqual({ type: 'tmpfs', target: `${repo}/${d}`, readonly: true })
    expect(masked).toEqual(expect.arrayContaining(['sub/', 'vendor/nested/', '.claude/worktrees/w1/']))
  })
  test('a foreign dir inside an already masked directory is not mounted twice; unsafe names are ignored', () => {
    const { mounts } = maskMounts('/w', [{ path: '.ssh/config' }], { foreignDirs: ['.ssh/deep/repo', '../etc', 'node_modules/x', 'ok/repo/'] })
    expect(mounts.map(m => m.target).sort()).toEqual(['/w/.ssh', '/w/ok/repo'])
  })
})

describe('r4 #6 — the ledger lock is exclusive', () => {
  test('6 processes × 150 updates reach 900/900', async () => {
    const procs = Array.from({ length: 6 }, () => spawn(process.execPath, [RACE_TS, data, '150'], { stdio: 'ignore' }))
    const codes = await Promise.all(procs.map(p => new Promise<number>(res => p.once('exit', c => res(c ?? 1)))))
    expect(codes).toEqual([0, 0, 0, 0, 0, 0])
    expect(readLedger(data).sessions['race']!.nmGen).toBe(900)
  })
  test('a lock file is never observable empty: it holds a pid from the first byte', () => {
    withLedger(data, () => { expect(Number(readFileSync(join(data, 'docker', 'ledger.lock'), 'utf8'))).toBe(process.pid) })
    expect(existsSync(join(data, 'docker', 'ledger.lock'))).toBe(false)
  })
  test('an EMPTY lock (a writer between create and write in the old scheme) is waited on, not deleted', () => {
    mkdirSync(join(data, 'docker'), { recursive: true })
    const lockPath = join(data, 'docker', 'ledger.lock')
    writeFileSync(lockPath, '')
    // the event loop is blocked while the lock waits, so the "owner" finishing is a separate process
    spawn('sh', ['-c', `sleep 0.3; rm -f '${lockPath}'`], { stdio: 'ignore', detached: true }).unref()
    const t0 = Date.now()
    withLedger(data, () => {})
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100) // it waited for the owner instead of removing the lock at once
  })
})

describe('r4 #6 — two generations reserved; g<n> pending while a container references it', () => {
  test('an install reserves 2; the third concurrent one does not fit the 16 GiB envelope; release frees', () => {
    expect(GEN_ENVELOPE_BYTES / GEN_BUDGET_BYTES).toBe(4)
    expect(reserveGenerations(data, 'a', [1, 2])).toEqual({ ok: true })
    expect(reserveGenerations(data, 'b', [3, 4])).toEqual({ ok: true })
    const c = reserveGenerations(data, 'c', [5, 6])
    expect(c).toMatchObject({ ok: false })
    expect((c as any).reason).toMatch(/^disco_cheio.*a: g1,g2/)
    expect(heldGenerations(readLedger(data))).toBe(4)
    releaseGenerations(data, 'a')
    expect(reserveGenerations(data, 'c', [5, 6])).toEqual({ ok: true })
  })
  test('a g<n>_pendente counts in the envelope', () => {
    withLedger(data, l => { l.sessions['a'] = { state: 'pronto', perRun: false, createdAt: '', nmGen: 1, volumes: [], containers: [], execs: {}, pendingGens: ['v-g1', 'v-g0'] } })
    expect(reserveGenerations(data, 'b', [1, 2])).toMatchObject({ ok: true })
    expect(reserveGenerations(data, 'c', [1, 2])).toMatchObject({ ok: false })
  })
  test('generationRemoval: only an empty `docker ps -a --filter volume=` that succeeded removes', () => {
    expect(generationRemoval(0, '')).toBe('remove')
    expect(generationRemoval(0, '\n')).toBe('remove')
    expect(generationRemoval(0, 'abc123\n')).toBe('pending')
    expect(generationRemoval(1, '')).toBe('pending')
  })
})

describe('BAIXA', () => {
  test('npm_config_cache (agentop-owned, lower-case) reaches the download container; a repo profile cannot set lower-case names', () => {
    const e = containerEnv({ host: {}, sid: 's', extra: { BUN_INSTALL_CACHE_DIR: '/cache/bun', npm_config_cache: '/cache/npm' }, profile: { http_proxy: 'http://evil', lower: 'x', UPPER_OK: '1' } })
    expect(e.npm_config_cache).toBe('/cache/npm')
    expect(e.BUN_INSTALL_CACHE_DIR).toBe('/cache/bun')
    expect(e.http_proxy).toBeUndefined()
    expect(e.lower).toBeUndefined()
    expect(e.UPPER_OK).toBe('1')
  })
  test('the docker-env flag description no longer says nothing runs in a container', async () => {
    const { EXPERIMENTAL_FEATURES } = await import('@agentistics/core')
    const flag = EXPERIMENTAL_FEATURES.find(f => f.id === 'docker-env')!
    for (const t of [flag.description.en, flag.description.pt]) expect(t).not.toMatch(/Nada roda em cont|Nothing runs in a container/)
    expect(flag.description.en).toMatch(/disposable container/)
  })
  test('plan sanity: a command container still mounts the worktree rw (the staging rule is download-only)', () => {
    const p = containerPlan({ kind: 'cmd', name: 'n', image: BUN.ref, uid: 1, gid: 1, memoryBytes: GIB, root: '/w', cwd: '/w', envFile: '/e', labels: {}, volumes: { scratch: 's', nm: 'n' }, nm: nmSlots([]), masks: [], optDir: '/o', saidaDir: '/s', ttlSec: 1, argv: ['x'] })
    expect(p.mounts.find(m => m.target === '/w')).toEqual({ type: 'bind', source: '/w', target: '/w', readonly: false })
  })
})

describe('M5 — flag OFF ⇒ zero docker on the CLI path (even with `docker` chosen)', () => {
  const cli = (flag: '0' | '1', args: string[]) => {
    const home = join(dir, 'home'); mkdirSync(join(home, '.agentistics'), { recursive: true })
    writeFileSync(join(home, '.agentistics', 'preferences.json'), '{"envBackend":{"all":"docker"}}')
    writeFileSync(log, '')
    // `docker` found on PATH (that is how detection and the real runs find it): the fake, logging every call
    mkdirSync(join(dir, 'shim'), { recursive: true })
    writeFileSync(join(dir, 'shim', 'docker'), `#!/bin/sh\nexec '${process.execPath}' '${FAKE_TS}' "$@"\n`, { mode: 0o755 })
    const e: Record<string, string> = { PATH: `${join(dir, 'shim')}:${process.env.PATH!}`, HOME: home, AGENTISTICS_DOCKER_BIN: FAKE, AGENTISTICS_FAKE_DOCKER_LOG: log, AGENTISTICS_FAKE_DOCKER_STATE: state, AGENTISTICS_DOCKER_ENV: flag, AGENTISTICS_HEAVY_JOB: '1' }
    for (const k of ['VOLTA_HOME', 'BUN_INSTALL']) if (process.env[k]) e[k] = process.env[k]!
    spawnSync(process.execPath, [CLI_TS, ...args], { cwd: repo, env: e, timeout: 90_000, encoding: 'utf8' })
    return calls()
  }
  test('flag OFF: run --rm, run, env install touch no docker binary', () => {
    expect(cli('0', ['run', '--rm', '--', 'true'])).toEqual([])
    expect(cli('0', ['run', '--', 'true'])).toEqual([])
    expect(cli('0', ['env', 'install'])).toEqual([])
  })
  test('positive control: flag ON does call docker (so the empty logs above mean something)', () => {
    expect(cli('1', ['run', '--rm', '--', 'true']).length).toBeGreaterThan(0)
  })
})
