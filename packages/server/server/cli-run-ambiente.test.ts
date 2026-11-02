import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitEnv } from './backup/repo-probe'
import { buildThrowawayEnv, isThrowawayEnvDrop, seedSourceOk, serveCwdOk, serveLockRefusal, runOwnedPids, THROWAWAY_ENV_DROP, THROWAWAY_ENV_KEEP } from './cli-run'
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
    Bun.spawnSync(['git', 'init', '-q', d], { env: gitEnv() })
    expect(serveCwdOk(d)).toBeNull()
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

describe('B3 every path-moving env variable the server reads is dropped or kept on purpose', () => {
  test('lint: process.env.X with _HOME/_DIR/_FILE/CONFIG in server sources is in THROWAWAY_ENV_DROP or THROWAWAY_ENV_KEEP (with a reason)', () => {
    const root = join(import.meta.dir)
    const names = new Set<string>()
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue }
        if (!p.endsWith('.ts') || p.endsWith('.test.ts')) continue
        for (const m of readFileSync(p, 'utf8').matchAll(/process\.env\.([A-Z0-9_]+)/g)) if (/(_HOME|_DIR|_FILE|CONFIG)/.test(m[1]!)) names.add(m[1]!)
      }
    }
    walk(root)
    expect(names.size).toBeGreaterThan(20)
    const missing = [...names].filter(n => !isThrowawayEnvDrop(n) && !(n in THROWAWAY_ENV_KEEP))
    expect(missing).toEqual([])
    for (const reason of Object.values(THROWAWAY_ENV_KEEP)) expect(reason.length).toBeGreaterThan(10)
  })
  test('a parent env that relocates the journal/archive/harness homes does not reach the run', () => {
    const src = { HOME: '/real', AGENTISTICS_JOURNAL_DIR: '/real/j', AGENTISTICS_ARCHIVE_DIR: '/real/a', AGENTISTICS_GIT_STATS_CACHE_FILE: '/real/g', CLAUDE_DIR: '/c', HERMES_HOME: '/h', CODEX_DIR: '/x' }
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
