import { describe, expect, test } from 'bun:test'
import { cleanInstallLine, installFailureDetail, installSearchPath, NODE_LTS_VERSION, parseHarnessVersion, planHarnessInstall, planNodeInstall, withUserBin } from './harness-install-plan'

const base = { platform: 'linux', nodePresent: true, npmGlobalWritable: true, npmPrefix: '/tmp/.local' }

describe('harness installer plan', () => {
  test('uses the official installer table for every supported harness', () => {
    expect(planHarnessInstall('claude', base).command).toEqual(['/bin/sh', '-c', 'curl -fsSL https://claude.ai/install.sh | bash'])
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

  test('opencode: the official curl installer, its own `opencode upgrade` to update, and no Node.js needed', () => {
    expect(planHarnessInstall('opencode', { ...base, nodePresent: false }).command).toEqual(['/bin/sh', '-c', 'curl -fsSL https://opencode.ai/install | bash'])
    expect(planHarnessInstall('opencode', { ...base, nodePresent: false }, 'update')).toMatchObject({ reason: 'ok', command: ['opencode', 'upgrade'], verify: ['opencode', '--version'] })
    expect(planHarnessInstall('codex', base, 'update').command).toEqual(['npm', 'i', '-g', '--prefix', '/tmp/.local', '@openai/codex']) // no updater of its own: re-install
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

  test('installer scripts run under /bin/sh by absolute path (a GUI-launched PATH may lack /bin)', () => {
    expect(planHarnessInstall('claude', { ...base, platform: 'darwin' }).command![0]).toBe('/bin/sh')
    expect(planNodeInstall({ ...base, arch: 'arm64', home: '/h' }).command![0]).toBe('/bin/sh')
  })

  test('the installer PATH always carries the system directories, after the user ones', () => {
    const p = installSearchPath('/Users/u/.local/bin').split(':')
    expect(p[0]).toBe('/Users/u/.local/bin')
    for (const d of ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin']) expect(p).toContain(d)
    expect(installSearchPath('').split(':')).toContain('/bin')
    expect(installSearchPath('/bin:/usr/bin').split(':').filter(d => d === '/bin').length).toBe(1)
  })

  test('a failure is explained: spawn error, exit code, stderr tail — bounded and in the asked language', () => {
    expect(installFailureDetail({ code: 1, spawnError: 'Executable not found in $PATH: "sh"' }, 'pt')).toBe('O instalador não iniciou: Executable not found in $PATH: "sh"')
    expect(installFailureDetail({ code: 7 }, 'pt')).toBe('O instalador saiu com código 7 (sem nenhuma mensagem).')
    expect(installFailureDetail({ code: 7 }, 'en')).toBe('The installer exited with code 7 (without any message).')
    expect(installFailureDetail({ code: 22, stderrTail: ['a', 'curl: (22) 403', 'Download failed'] }, 'en')).toBe('The installer exited with code 22 (a · curl: (22) 403 · Download failed).')
    expect(installFailureDetail({ code: 1, stderrTail: ['x'.repeat(900)] }, 'en').length).toBeLessThan(400)
  })
})
