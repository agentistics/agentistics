import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { resolveDataDir } from './data-dir'
import { join } from 'node:path'
import { gitTestEnv } from '@agentistics/core/gitTestEnv'
import { guardedSeed, realDataDir, parseArgs, buildThrowawayEnv, isThrowawayEnvDrop, seedSourceOk, serveCwdOk, serveLockRefusal, runOwnedPids, isAgentisticsCheckout, serveBuildNotice, THROWAWAY_ENV_DROP, THROWAWAY_ENV_KEEP } from './cli-run'
import { buildSeed } from './run-seed'

describe('throwaway env (I8, I12)', () => {
  const source = { HOME: '/real', PATH: '/bin', CODEX_HOME: '/real/.codex2', CLAUDE_CONFIG_DIR: '/real/c', XDG_CONFIG_HOME: '/real/.config', GEMINI_CLI_HOME: '/g', KIMI_CODE_HOME: '/k', AGENTISTICS_FLOWS: '1', AGENTISTICS_DATA_DIR: '/real/.agentistics', XDG_RUNTIME_DIR: '/run/user/1000' }
  const env = buildThrowawayEnv('/tmp/h', 'amb-x', 48100, 48101, source, { tmp: '/tmp/agr-abc' })
  test('I12 no config-moving variable survives; XDG dirs live inside the run HOME; XDG_RUNTIME_DIR stays', () => {
    for (const k of THROWAWAY_ENV_DROP) expect(env[k]).toBeUndefined()
    expect(env.KIMI_CODE_HOME).toBeUndefined()
    expect(isThrowawayEnvDrop('KIMI_ANY_HOME')).toBe(true)
    expect(env.XDG_CONFIG_HOME).toBe('/tmp/h/.config')
    expect(env.XDG_DATA_HOME).toBe('/tmp/h/.local/share')
    expect(env.XDG_STATE_HOME).toBe('/tmp/h/.local/state')
    expect(env.XDG_CACHE_HOME).toBe('/tmp/h/.cache')
    expect(env.XDG_RUNTIME_DIR).toBe('/run/user/1000')
  })
  test('I8 HOME, TMPDIR, TMUX_TMPDIR and ports are the run\'s own', () => {
    expect(env.HOME).toBe('/tmp/h')
    expect(env.TMPDIR).toBe('/tmp/agr-abc')
    expect(env.TMUX_TMPDIR).toBe('/tmp/agr-abc')
    expect(env.PORT).toBe('48100')
    expect(env.WEB_PORT).toBe('48101')
    expect(env.AGENTISTICS_DIR).toBe('/tmp/h/.agentistics')
  })
})

describe('--serve guards (I15, I16)', () => {
  test('inside a heavy job (env, flock ancestor) or with an inherited fd => refused', () => {
    expect(serveLockRefusal({ AGENTISTICS_HEAVY_JOB: '1' }, [], [])).toContain('heavy job')
    expect(serveLockRefusal({}, ['flock -o /tmp/agentistics-heavy.lock bash'], [])).toContain('heavy job')
    expect(serveLockRefusal({}, [], [7])).toContain('fd 7')
    expect(serveLockRefusal({}, ['bash'], [])).toBeNull()
  })
})

describe('--seed-from / --cwd validation', () => {
  test('a seed is accepted only under <dataDir>/flows/ambientes/<id>/semente', () => {
    const data = realpathSync(mkdtempSync(join(tmpdir(), 'ambdata-')))
    const ok = join(data, 'flows', 'ambientes', 'amb-x', 'semente'); mkdirSync(ok, { recursive: true })
    const other = join(data, 'flows', 'ambientes', 'amb-x', 'saida'); mkdirSync(other, { recursive: true })
    expect(seedSourceOk(ok, data)).toBe(ok)
    expect(seedSourceOk(other, data)).toBeNull()
    expect(seedSourceOk(data, data)).toBeNull()
    expect(seedSourceOk('/etc', data)).toBeNull()
    const link = join(data, 'link'); symlinkSync('/etc', link)
    expect(seedSourceOk(link, data)).toBeNull()
  })
  test('--cwd refuses a plain directory and a main checkout', () => {
    const d = mkdtempSync(join(tmpdir(), 'ambcwd-'))
    expect(serveCwdOk(d)).toBeNull()
    Bun.spawnSync(['git', 'init', '-q', d], { env: gitTestEnv() })
    expect(serveCwdOk(d)).toBeNull()
  })
})

describe('--serve checkout warning', () => {
  test('warns for a checkout-shaped cwd with no command and includes the installed version', () => {
    const checkout = mkdtempSync(join(tmpdir(), 'serve-cwd-'))
    mkdirSync(join(checkout, 'packages/server/bin'), { recursive: true })
    writeFileSync(join(checkout, 'packages/server/bin/cli.ts'), '')
    const git = Bun.spawnSync(['git', '-C', checkout, 'init', '-q'], { env: gitTestEnv() })
    expect(git.exitCode).toBe(0)
    expect(isAgentisticsCheckout(checkout)).toBe(true)
    expect(serveBuildNotice(checkout, [])).toMatchObject({ warning: expect.stringContaining('installed agentop v'), summary: expect.stringContaining('servedBuild: installed agentop v') })
  })

  test('does not warn when a command is provided or cwd is not a checkout', () => {
    const checkout = mkdtempSync(join(tmpdir(), 'serve-cwd-command-'))
    mkdirSync(join(checkout, 'packages/server/bin'), { recursive: true })
    writeFileSync(join(checkout, 'packages/server/bin/cli.ts'), '')
    Bun.spawnSync(['git', '-C', checkout, 'init', '-q'], { env: gitTestEnv() })
    expect(serveBuildNotice(checkout, ['bun', 'server'])).toBeNull()
    expect(serveBuildNotice(mkdtempSync(join(tmpdir(), 'serve-cwd-plain-')), [])).toBeNull()
  })
})

describe('linked worktrees, SIGTERM during the seed, empty AGENTISTICS_DIR', () => {
  const git = (cwd: string, ...a: string[]) => { const r = Bun.spawnSync(['git', '-C', cwd, ...a], { env: gitTestEnv(), stdout: 'pipe', stderr: 'pipe' }); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); return r.stdout.toString() }
  test('--cwd accepts a REAL linked worktree (absolute --git-common-dir) and still refuses its main checkout', () => {
    const main = realpathSync(mkdtempSync(join(tmpdir(), 'ambmain-')))
    git(main, 'init', '-q', '-b', 'main'); git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x')
    const wt = join(main, '.worktrees', 'w1')
    git(main, 'worktree', 'add', '-q', '-b', 'amb/w1', wt)
    expect(serveCwdOk(wt)).toBe(realpathSync(wt))
    expect(serveCwdOk(main)).toBeNull()
  })
  test('R3 a SIGTERM that arrives during the seed cleans up and reports interrupted; a failing seed cleans and rethrows', async () => {
    let cleaned = 0
    const bus = new EventEmitter() as unknown as Pick<NodeJS.Process, 'on' | 'off'>
    expect(await guardedSeed(() => { (bus as unknown as EventEmitter).emit('SIGTERM') }, () => { cleaned++ }, bus)).toBe('interrupted')
    expect((bus as unknown as EventEmitter).listenerCount('SIGTERM')).toBe(0)
    expect(cleaned).toBe(1)
    expect(await guardedSeed(() => {}, () => { cleaned++ }, bus)).toBe('done')
    expect(cleaned).toBe(1)
    await expect(guardedSeed(() => { throw new Error('boom') }, () => { cleaned++ }, bus)).rejects.toThrow('boom')
    expect(cleaned).toBe(2)
  })
  test('R5 an empty AGENTISTICS_DIR means the default in both the config and the launcher', () => {
    const was = process.env.AGENTISTICS_DIR
    process.env.AGENTISTICS_DIR = ''
    try { expect(realDataDir()).toMatch(/\.agentistics$/) } finally { if (was === undefined) delete process.env.AGENTISTICS_DIR; else process.env.AGENTISTICS_DIR = was }
    expect(resolveDataDir({ env: { AGENTISTICS_DIR: '' }, home: '/h', ownerHome: '/h', makeTemp: () => '/tmp/x' }).dir).toBe('/h/.agentistics')
  })
})

describe('only the run\'s own pids (I20)', () => {
  test('a process whose HOME merely starts with the run HOME is not matched', () => {
    const proc = mkdtempSync(join(tmpdir(), 'ambproc-'))
    for (const [pid, home] of [['11', '/r/home-1'], ['12', '/r/home-10'], ['13', '/r/home-1/sub']]) {
      mkdirSync(join(proc, pid!)); writeFileSync(join(proc, pid!, 'environ'), `A=b\0HOME=${home}\0`)
    }
    expect(runOwnedPids('/r/home-1', proc, 1)).toEqual([11])
  })
})

/** Every read form used in the repo: `process.env.X`, `env.X`, `process.env['X']`, `env["X"]`. */
const ENV_READ = /(?:process\.env|\benv)(?:\.|\[\s*['"])([A-Z][A-Z0-9_]+)/g
const PATH_MOVING = /(_HOME|_DIR|_FILE|_DB|_PATH|CONFIG)/

describe('B3 every path-moving env variable the server reads is dropped or kept on purpose', () => {
  test('lint: every env read form (process.env.X, env.X, brackets, destructuring, helper getters) of a _HOME/_DIR/_FILE/_DB/_PATH/CONFIG name in server sources is in THROWAWAY_ENV_DROP or THROWAWAY_ENV_KEEP (with a reason)', () => {
    const root = join(import.meta.dir)
    const names = new Set<string>()
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue }
        if (!p.endsWith('.ts') || p.endsWith('.test.ts') || p.endsWith('.generated.ts')) continue
        const text = readFileSync(p, 'utf8')
        for (const m of text.matchAll(ENV_READ)) if (PATH_MOVING.test(m[1]!)) names.add(m[1]!)
        // destructuring: `const { A, B: x } = process.env` / `= env`
        for (const d of text.matchAll(/\{([^{}]*)\}\s*=\s*(?:process\.env|env)\b/g)) for (const k of d[1]!.matchAll(/\b([A-Z][A-Z0-9_]+)\b/g)) if (PATH_MOVING.test(k[1]!)) names.add(k[1]!)
        // helper getters: `getenv('X')`, `readEnv("X")`, `envVar('X')`, `env.get('X')`
        for (const h of text.matchAll(/\b(?:\w*[eE]nv\w*)(?:\.get)?\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g)) if (PATH_MOVING.test(h[1]!)) names.add(h[1]!)
      }
    }
    walk(root)
    expect(names.size).toBeGreaterThan(20)
    const missing = [...names].filter(n => !isThrowawayEnvDrop(n) && !(n in THROWAWAY_ENV_KEEP))
    expect(missing).toEqual([])
    for (const reason of Object.values(THROWAWAY_ENV_KEEP)) expect(reason.length).toBeGreaterThan(10)
  })
  test('a parent env that relocates the journal/archive/harness homes does not reach the run', () => {
    const src = { HOME: '/real', OPENCODE_DB: '/real/o.db', OPENCODE_DIR: '/real/o', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/real/s', AGENTISTICS_JOURNAL_DIR: '/real/j', AGENTISTICS_ARCHIVE_DIR: '/real/a', AGENTISTICS_GIT_STATS_CACHE_FILE: '/real/g', CLAUDE_DIR: '/c', HERMES_HOME: '/h', CODEX_DIR: '/x' }
    const env = buildThrowawayEnv('/tmp/h', 'amb-x', 48100, 48101, src, { tmp: '/tmp/t' })
    for (const k of Object.keys(src).filter(k => k !== 'HOME')) expect(env[k]).toBeUndefined()
  })
})

describe('B1 seeds come from AGENTISTICS_DIR; B4 --seed-real builds in the launcher', () => {
  test('seedSourceOk honours AGENTISTICS_DIR (not AGENTISTICS_DATA_DIR) for its default data dir', () => {
    const data = realpathSync(mkdtempSync(join(tmpdir(), 'ambdir-')))
    const ok = join(data, 'flows', 'ambientes', 'amb-x', 'semente'); mkdirSync(ok, { recursive: true })
    const saved = { d: process.env.AGENTISTICS_DIR, o: process.env.AGENTISTICS_DATA_DIR }
    process.env.AGENTISTICS_DIR = data; process.env.AGENTISTICS_DATA_DIR = '/nonexistent'
    try { expect(seedSourceOk(ok)).toBe(ok) } finally { for (const [k, v] of [['AGENTISTICS_DIR', saved.d], ['AGENTISTICS_DATA_DIR', saved.o]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
  })
  test('buildSeed straight into the run home carries only the allow list', () => {
    const src = mkdtempSync(join(tmpdir(), 'ambsrc-')), dst = join(mkdtempSync(join(tmpdir(), 'ambdst-')), '.agentistics')
    mkdirSync(join(src, 'content')); writeFileSync(join(src, 'content', 'c'), 'c'); mkdirSync(join(src, 'structured')); writeFileSync(join(src, 'accounts.json'), '{}')
    expect(buildSeed(src, dst)).toEqual(['content'])
    expect(existsSync(join(dst, 'structured'))).toBe(false); expect(existsSync(join(dst, 'accounts.json'))).toBe(false)
  })
})

describe('R4 --seed-real wiring in parseArgs', () => {
  test('needs --serve, is exclusive with --seed-from, and is carried through', () => {
    expect(() => parseArgs(['--rm', '--seed-real'])).toThrow(/only apply with --serve/)
    expect(() => parseArgs(['--rm', '--serve', '--seed-real', '--seed-from', '/x'])).toThrow(/exclusive/)
    expect(parseArgs(['--rm', '--serve', '--seed-real', '--cwd', '/w'])).toMatchObject({ serve: true, seedReal: true, seedFrom: null, cwd: '/w' })
  })
})
