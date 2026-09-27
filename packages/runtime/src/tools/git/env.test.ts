import { describe, expect, test } from 'bun:test'
import { buildGitEnv } from './env.ts'

describe('buildGitEnv', () => {
  test('strips GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE style overrides', () => {
    const base = { PATH: '/usr/bin', GIT_DIR: '/somewhere/.git', GIT_WORK_TREE: '/somewhere', GIT_INDEX_FILE: '/tmp/idx' }
    const env = buildGitEnv(base)
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.GIT_WORK_TREE).toBeUndefined()
    expect(env.GIT_INDEX_FILE).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
  })

  test('strips the external-diff / config-override / ssh family too', () => {
    const base = {
      GIT_EXTERNAL_DIFF: '/tmp/evil',
      GIT_CONFIG: '/tmp/evil.conf',
      GIT_ASKPASS: '/tmp/evil-askpass',
      GIT_SSH_COMMAND: '/tmp/evil-ssh',
    }
    const env = buildGitEnv(base)
    expect(env.GIT_EXTERNAL_DIFF).toBeUndefined()
    expect(env.GIT_CONFIG).toBeUndefined()
    expect(env.GIT_ASKPASS).toBeUndefined()
    expect(env.GIT_SSH_COMMAND).toBeUndefined()
  })

  test('sets the four fixed values', () => {
    const env = buildGitEnv({})
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0')
    expect(env.GIT_PAGER).toBe('cat')
    expect(env.LC_ALL).toBe('C')
  })

  test('an inherited GIT_PAGER is overridden, not merely left stripped', () => {
    const env = buildGitEnv({ GIT_PAGER: 'less' })
    expect(env.GIT_PAGER).toBe('cat')
  })

  test('drops undefined-valued entries rather than passing them through', () => {
    const env = buildGitEnv({ SOMETHING: undefined } as unknown as NodeJS.ProcessEnv)
    expect('SOMETHING' in env).toBe(false)
  })
})
