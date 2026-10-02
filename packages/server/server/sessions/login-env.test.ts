import { describe, expect, test, beforeEach } from 'bun:test'
import { mkdtempSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseLoginEnv, mergeLoginEnv, resolveLoginEnv, sessionEnv, resetLoginEnvMemo, LOGIN_ENV_MAX_BYTES, runLoginShell,
} from './login-env'
import { spawnArgs } from './tmux-cli'

const nul = (...kv: string[]) => kv.join('\0') + '\0'
const file = () => join(mkdtempSync(join(tmpdir(), 'lenv-')), 'login-env.json')
const prof = { truecolorTerm: null } as never

describe('parseLoginEnv', () => {
  test('keeps PATH and the allowlist only, ignoring rc noise before the marker', () => {
    const raw = 'welcome banner\n__AGENTISTICS_ENV_BEGIN__\0' + nul('PATH=/a/bin:/b', 'NVM_DIR=/n', 'ANTHROPIC_API_KEY=sk-x', 'HOME=/h')
    expect(parseLoginEnv(raw)).toEqual({ PATH: '/a/bin:/b', NVM_DIR: '/n' })
  })
  test('garbage or missing PATH yields null', () => {
    expect(parseLoginEnv('\u0000\u0001garbage')).toBeNull()
    expect(parseLoginEnv(nul('NVM_DIR=/n'))).toBeNull()
    expect(parseLoginEnv(nul('PATH=relative:.'))).toBeNull()
  })
  test('multiline values are dropped', () => {
    expect(parseLoginEnv(nul('PATH=/a', 'GOPATH=/x\ny'))).toEqual({ PATH: '/a' })
  })
})

describe('mergeLoginEnv', () => {
  test('login PATH first, own PATH appended and deduped', () => {
    expect(mergeLoginEnv({ PATH: '/u/bin:/usr/bin' }, '/usr/bin:/bin').PATH).toBe('/u/bin:/usr/bin:/bin')
  })
  test('no login env keeps own PATH', () => {
    expect(mergeLoginEnv(null, '/usr/bin').PATH).toBe('/usr/bin')
  })
})

describe('resolveLoginEnv', () => {
  test('writes a 0600 cache; a later timeout returns the cached env', async () => {
    const f = file()
    const ok = await resolveLoginEnv({ file: f, shell: '/bin/zsh', run: async () => nul('PATH=/x/bin', 'VOLTA_HOME=/v') })
    expect(ok.source).toBe('login')
    expect(statSync(f).mode & 0o777).toBe(0o600)
    expect(readFileSync(f, 'utf8')).not.toContain('SECRET')
    const down = await resolveLoginEnv({ file: f, shell: '/bin/zsh', run: async () => null })
    expect(down).toEqual({ env: { PATH: '/x/bin', VOLTA_HOME: '/v' }, source: 'cache' })
  })
  test('nothing cached and shell dead -> none', async () => {
    expect((await resolveLoginEnv({ file: file(), run: async () => null })).source).toBe('none')
  })
  test('falls back to /bin/bash when $SHELL fails', async () => {
    const seen: string[] = []
    const r = await resolveLoginEnv({ file: file(), shell: '/bin/fish', run: async s => { seen.push(s); return s === '/bin/bash' ? nul('PATH=/y') : null } })
    expect(seen).toEqual(['/bin/fish', '/bin/bash'])
    expect(r.source).toBe('login')
  })
  test('a real run is bounded and returns the PATH', async () => {
    const raw = await runLoginShell('/bin/bash')
    expect(raw === null || parseLoginEnv(raw) !== null).toBe(true)
    expect(LOGIN_ENV_MAX_BYTES).toBeGreaterThan(0)
  })
})

describe('sessionEnv TTL', () => {
  beforeEach(resetLoginEnvMemo)
  test('re-resolves only after the TTL', async () => {
    let calls = 0, t = 0
    const o = { file: file(), ownPath: '/usr/bin', now: () => t, run: async () => { calls++; return nul(`PATH=/p${calls}`) } }
    expect((await sessionEnv(o)).PATH).toBe('/p1:/usr/bin')
    t = 59_000
    await sessionEnv(o)
    expect(calls).toBe(1)
    t = 61_000
    expect((await sessionEnv(o)).PATH).toBe('/p2:/usr/bin')
  })
})

describe('spawn argv', () => {
  test('carries the resolved PATH and toolchain vars via -e', () => {
    const argv = spawnArgs(prof, { id: 'a', cwd: '/w', argv: ['claude'], path: '/n/bin:/usr/bin', env: { PATH: '/n/bin:/usr/bin', NVM_DIR: '/n' } })
    expect(argv).toContain('PATH=/n/bin:/usr/bin')
    expect(argv).toContain('NVM_DIR=/n')
    expect(argv.filter(a => a.startsWith('PATH=')).length).toBe(1)
  })
})
