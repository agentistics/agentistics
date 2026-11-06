import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultClaudeConfigDir, isManagedAccountRoot } from './default-claude-root'

const DATA = '/h/.agentistics'
describe('default claude root', () => {
  test('a managed account root in the env is a leak, not the default login', () => {
    expect(defaultClaudeConfigDir({ CLAUDE_CONFIG_DIR: `${DATA}/accounts/claude/r_c08acd72c52c` }, DATA)).toBeUndefined()
    expect(isManagedAccountRoot(`${DATA}/accounts/claude/r_x/sub`, DATA)).toBe(true)
  })
  test('a hand-set root outside the managed folder still wins', () => {
    expect(defaultClaudeConfigDir({ CLAUDE_CONFIG_DIR: '/work/claude' }, DATA)).toBe('/work/claude')
    expect(defaultClaudeConfigDir({ CLAUDE_CONFIG_DIR: `${DATA}/accounts-other` }, DATA)).toBe(`${DATA}/accounts-other`)
  })
  test('absent env is absent', () => { expect(defaultClaudeConfigDir({}, DATA)).toBeUndefined() })
})

import { AGENTISTICS_DATA_DIR } from './config'
import { claudeCredentialsFile } from './claude-usage'
import { defaultHarnessRoot } from './harness-accounts'
import { planSpawn } from './sessions/spawn-spec'

describe('a leaked managed-account CLAUDE_CONFIG_DIR never becomes the default login', () => {
  const leaked = join(AGENTISTICS_DATA_DIR, 'accounts', 'claude', 'r_c08acd72c52c')
  const withEnv = <T>(value: string | undefined, run: () => T): T => {
    const before = process.env.CLAUDE_CONFIG_DIR
    if (value === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = value
    try { return run() } finally { if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before }
  }
  test('the default root and the default usage credentials are ~/.claude, not the leaked account', () => {
    withEnv(leaked, () => {
      expect(defaultHarnessRoot('claude')).not.toBe(leaked)
      expect(claudeCredentialsFile().startsWith(leaked)).toBe(false)
    })
  })
  test('an accountless claude spawn drops the leaked variable; a hand-set one is kept', () => {
    const plan = withEnv(leaked, () => planSpawn({ harness: 'claude', cwd: '/w' }))
    expect(plan.ok && plan.plan.unsetEnv).toEqual(['CLAUDE_CONFIG_DIR'])
    const own = withEnv('/work/claude', () => planSpawn({ harness: 'claude', cwd: '/w' }))
    expect(own.ok && own.plan.unsetEnv).toBeUndefined()
  })
})

describe('managed-root detection resolves symlinks and case', () => {
  test('a symlinked data dir and its real path name the same managed folder', () => {
    const real = realpathSync(mkdtempSync(join(tmpdir(), 'dcr-')))
    try {
      mkdirSync(join(real, 'data', 'accounts', 'claude'), { recursive: true })
      symlinkSync(join(real, 'data'), join(real, 'link'))
      expect(isManagedAccountRoot(join(real, 'link', 'accounts', 'claude', 'r_x'), join(real, 'data'))).toBe(true)
      expect(isManagedAccountRoot(join(real, 'data', 'accounts', 'claude', 'r_x'), join(real, 'link'))).toBe(true)
      expect(isManagedAccountRoot(join(real, 'link', 'accounts-other'), join(real, 'data'))).toBe(false)
    } finally { rmSync(real, { recursive: true, force: true }) }
  })
  test('/private/var vs /var style aliases (a symlinked parent of the data dir)', () => {
    const real = realpathSync(mkdtempSync(join(tmpdir(), 'dcr-')))
    try {
      mkdirSync(join(real, 'private', 'var', 'h', '.agentistics'), { recursive: true })
      symlinkSync(join(real, 'private', 'var'), join(real, 'var'))
      expect(isManagedAccountRoot(join(real, 'private', 'var', 'h', '.agentistics', 'accounts', 'claude', 'r_x'), join(real, 'var', 'h', '.agentistics'))).toBe(true)
    } finally { rmSync(real, { recursive: true, force: true }) }
  })
  test('case differences count on win32/darwin (drive letter), not on linux', () => {
    expect(isManagedAccountRoot('c:/Users/H/.agentistics/accounts/claude/r_x', 'C:/Users/H/.agentistics', 'win32')).toBe(true)
    expect(isManagedAccountRoot('/users/h/.AGENTISTICS/accounts/claude/r_x', '/Users/h/.agentistics', 'darwin')).toBe(true)
    expect(isManagedAccountRoot('/h/.AGENTISTICS/accounts/claude/r_x', '/h/.agentistics', 'linux')).toBe(false)
  })
})
