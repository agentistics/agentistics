import { describe, expect, test } from 'bun:test'
import { cleanInstallLine, NODE_LTS_VERSION, parseHarnessVersion, planHarnessInstall, planNodeInstall, withUserBin } from './harness-install-plan'

const base = { platform: 'linux', nodePresent: true, npmGlobalWritable: true, npmPrefix: '/tmp/.local' }

describe('harness installer plan', () => {
  test('uses the official installer table for every supported harness', () => {
    expect(planHarnessInstall('claude', base).command).toEqual(['sh', '-c', 'curl -fsSL https://claude.ai/install.sh | bash'])
    expect(planHarnessInstall('codex', base).command).toEqual(['npm', 'i', '-g', '--prefix', '/tmp/.local', '@openai/codex'])
    expect(planHarnessInstall('gemini', base).command).toEqual(['npm', 'i', '-g', '--prefix', '/tmp/.local', '@google/gemini-cli'])
    expect(planHarnessInstall('copilot', base).command).toEqual(['npm', 'i', '-g', '--prefix', '/tmp/.local', '@github/copilot'])
  })

  test('always uses the user npm prefix (even when the private Node makes the global one writable) and refuses npm installs without Node', () => {
    for (const writable of [true, false]) {
      expect(planHarnessInstall('gemini', { ...base, npmGlobalWritable: writable }).command)
        .toEqual(['npm', 'i', '-g', '--prefix', '/tmp/.local', '@google/gemini-cli'])
    }
    expect(withUserBin('/usr/bin', '/tmp')).toBe('/tmp/.local/bin:/usr/bin')  // bin of that prefix is first on PATH
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

  test('Node.js prerequisite is a user-level official tarball, per platform and arch', () => {
    const f = { ...base, nodePresent: false, arch: 'arm64', home: '/home/u' }
    const plan = planNodeInstall({ ...f, platform: 'darwin' })
    expect(plan.reason).toBe('ok')
    const script = plan.command![2]!
    expect(script).toContain(`https://nodejs.org/dist/v${NODE_LTS_VERSION}/node-v${NODE_LTS_VERSION}-darwin-arm64.tar.gz`)
    expect(script).toContain('/home/u/.local/bin')
    expect(script).not.toContain('sudo')
    expect(planNodeInstall({ ...f, arch: 'ia32' }).reason).toBe('unsupported-platform')
    expect(planNodeInstall({ ...f, platform: 'win32' }).reason).toBe('unsupported-platform')
  })

  test('no installer command ever uses sudo', () => {
    for (const id of ['claude', 'codex', 'gemini', 'copilot'] as const) {
      for (const writable of [true, false]) {
        expect((planHarnessInstall(id, { ...base, npmGlobalWritable: writable }).command ?? []).join(' ')).not.toContain('sudo')
      }
    }
  })

  test('user bin goes first on PATH once, and installer lines are cleaned', () => {
    expect(withUserBin('/usr/bin:/home/u/.local/bin', '/home/u')).toBe('/home/u/.local/bin:/usr/bin')
    expect(cleanInstallLine('\u001b[32mok\u001b[0m\r')).toBe('ok')
    expect(cleanInstallLine('x'.repeat(500)).length).toBe(200)
  })
})
