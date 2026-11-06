import { describe, expect, test } from 'bun:test'
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

import { join } from 'node:path'
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
