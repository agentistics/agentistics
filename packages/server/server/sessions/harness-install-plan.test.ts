import { describe, expect, test } from 'bun:test'
import { parseHarnessVersion, planHarnessInstall } from './harness-install-plan'

const base = { platform: 'linux', nodePresent: true, npmGlobalWritable: true, npmPrefix: '/tmp/.local' }

describe('harness installer plan', () => {
  test('uses the official installer table for every supported harness', () => {
    expect(planHarnessInstall('claude', base).command).toEqual(['sh', '-c', 'curl -fsSL https://claude.ai/install.sh | bash'])
    expect(planHarnessInstall('codex', base).command).toEqual(['npm', 'i', '-g', '@openai/codex'])
    expect(planHarnessInstall('gemini', base).command).toEqual(['npm', 'i', '-g', '@google/gemini-cli'])
    expect(planHarnessInstall('copilot', base).command).toEqual(['npm', 'i', '-g', '@github/copilot'])
  })

  test('falls back to a user npm prefix and refuses npm installs without Node', () => {
    expect(planHarnessInstall('codex', { ...base, npmGlobalWritable: false }).command)
      .toEqual(['npm', 'i', '-g', '--prefix', '/tmp/.local', '@openai/codex'])
    expect(planHarnessInstall('gemini', { ...base, nodePresent: false }).reason).toBe('node-required')
  })

  test('supports Linux and macOS only', () => {
    expect(planHarnessInstall('claude', { ...base, platform: 'darwin' }).reason).toBe('ok')
    expect(planHarnessInstall('claude', { ...base, platform: 'win32' }).reason).toBe('unsupported-platform')
  })

  test('parses CLI versions without accepting arbitrary text', () => {
    expect(parseHarnessVersion('codex-cli 0.113.0')).toBe('0.113.0')
    expect(parseHarnessVersion('Claude Code v2.1.261')).toBe('2.1.261')
    expect(parseHarnessVersion('not installed')).toBeNull()
  })
})
