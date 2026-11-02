import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitEnv } from './backup/repo-probe'
import { buildThrowawayEnv, isThrowawayEnvDrop, seedSourceOk, serveCwdOk, serveLockRefusal, runOwnedPids, THROWAWAY_ENV_DROP } from './cli-run'

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
