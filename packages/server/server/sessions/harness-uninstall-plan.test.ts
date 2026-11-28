import { describe, expect, test } from 'bun:test'
import { planHarnessUninstall, UNINSTALL_PACKAGES, type HarnessUninstallFacts, type UninstallHarness } from './harness-uninstall-plan'

const HOME = '/home/u'
const at = (binPath: string | null, realPath = binPath, over: Partial<HarnessUninstallFacts> = {}): HarnessUninstallFacts =>
  ({ platform: 'linux', home: HOME, binPath, realPath, ...over })
const ALL = Object.keys(UNINSTALL_PACKAGES) as UninstallHarness[]

describe('harness uninstall plan', () => {
  test('npm: removed from the prefix the binary actually lives in (ours, nvm, Homebrew node)', () => {
    for (const platform of ['linux', 'darwin']) {
      for (const prefix of [`${HOME}/.local`, `${HOME}/.nvm/versions/node/v22.1.0`, '/opt/homebrew']) {
        const plan = planHarnessUninstall('codex', at(`${prefix}/bin/codex`, `${prefix}/lib/node_modules/@openai/codex/bin/codex.js`, { platform }))
        expect(plan.command).toEqual(['npm', 'uninstall', '-g', '--prefix', prefix, '@openai/codex'])
        expect(plan.removes).toEqual([`${prefix}/lib/node_modules/@openai/codex`, `${prefix}/bin/codex`])
      }
    }
  })

  test('npm prefix that needs sudo: a sentence with the command, nothing to run', () => {
    const plan = planHarnessUninstall('gemini', at('/usr/bin/gemini', '/usr/lib/node_modules/@google/gemini-cli/bundle/gemini.js', { prefixWritable: false }))
    expect(plan.reason).toBe('manual')
    expect(plan.command).toBeUndefined()
    expect(plan.manual!.en).toContain('sudo npm uninstall -g --prefix /usr @google/gemini-cli')
  })

  test('bun global', () => {
    const plan = planHarnessUninstall('gemini', at(`${HOME}/.bun/bin/gemini`, `${HOME}/.bun/install/global/node_modules/@google/gemini-cli/bundle/gemini.js`))
    expect(plan.command).toEqual(['bun', 'remove', '-g', '@google/gemini-cli'])
  })

  test('Volta', () => {
    const plan = planHarnessUninstall('copilot', at(`${HOME}/.volta/bin/copilot`, `${HOME}/.volta/bin/volta-shim`))
    expect(plan.command).toEqual(['volta', 'uninstall', '@github/copilot'])
  })

  test('Claude official installer: exactly the binary link and the versions folder', () => {
    for (const platform of ['linux', 'darwin']) {
      const plan = planHarnessUninstall('claude', at(`${HOME}/.local/bin/claude`, `${HOME}/.local/share/claude/versions/2.1.0`, { platform }))
      expect(plan.command).toEqual(['/bin/rm', '-rf', '--', `${HOME}/.local/bin/claude`, `${HOME}/.local/share/claude/versions`])
    }
  })

  test('opencode official installer: only the binary', () => {
    const bin = `${HOME}/.opencode/bin/opencode`
    expect(planHarnessUninstall('opencode', at(bin)).command).toEqual(['/bin/rm', '-f', '--', bin])
  })

  test('Windows: the npm shim only', () => {
    const bin = 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd'
    const plan = planHarnessUninstall('codex', at(bin, bin, { platform: 'win32', shimHasPackage: true }))
    expect(plan.command).toEqual(['npm.cmd', 'uninstall', '-g', '--prefix', 'C:\\Users\\u\\AppData\\Roaming\\npm', '@openai/codex'])
    const native = 'C:\\Users\\u\\.local\\bin\\claude.exe'
    expect(planHarnessUninstall('claude', at(native, native, { platform: 'win32' })).reason).toBe('manual')
  })

  test('an installer we do not recognise: manual text, never an argv', () => {
    const cases: Array<[UninstallHarness, HarnessUninstallFacts]> = [
      ['codex', at('/usr/bin/codex')],
      ['codex', at('/opt/homebrew/bin/codex', '/opt/homebrew/Caskroom/codex/1.0/codex', { platform: 'darwin' })],
      ['gemini', at('/opt/homebrew/bin/gemini', '/opt/homebrew/Cellar/gemini-cli/1/libexec/lib/node_modules/@google/gemini-cli/bin.js', { platform: 'darwin' })],
      ['claude', at(`${HOME}/.local/bin/claude`)], // a hand-copied binary, not the installer's link
      ['claude', at('/snap/bin/claude')],
      ['opencode', at('/usr/local/bin/opencode')],
      ['copilot', at(`${HOME}/bin/copilot`, `${HOME}/.claude/copilot`)],
      ['codex', at('/usr/bin/codex', '/usr/bin/codex', { platform: 'freebsd' })],
    ]
    for (const [harness, facts] of cases) {
      const plan = planHarnessUninstall(harness, facts)
      expect(plan.reason).toBe('manual')
      expect(plan.command).toBeUndefined()
      expect(plan.manual!.pt.length).toBeGreaterThan(20)
    }
  })

  test('nothing found is not-installed', () => {
    expect(planHarnessUninstall('codex', at(null))).toEqual({ harness: 'codex', reason: 'not-installed', removes: [] })
  })

  test('no plan ever names a config, session or credential folder', () => {
    const shapes = (h: UninstallHarness): HarnessUninstallFacts[] => {
      const pkg = UNINSTALL_PACKAGES[h]
      return [
        at(`${HOME}/.local/bin/${h}`, `${HOME}/.local/share/claude/versions/2`),
        at(`${HOME}/.local/bin/${h}`, `${HOME}/.local/lib/node_modules/${pkg}/cli.js`),
        at(`${HOME}/.bun/bin/${h}`, `${HOME}/.bun/install/global/node_modules/${pkg}/cli.js`),
        at(`${HOME}/.volta/bin/${h}`, `${HOME}/.volta/bin/volta-shim`),
        at(`${HOME}/.opencode/bin/${h}`),
      ]
    }
    const userData = ['.claude', '.codex', '.gemini', '.copilot', '.config', '.local/share/opencode', '.agentistics'].map(d => `${HOME}/${d}`)
    for (const harness of ALL) {
      for (const facts of shapes(harness)) {
        const plan = planHarnessUninstall(harness, facts)
        for (const word of [...(plan.command ?? []), ...plan.removes]) {
          for (const dir of userData) expect(word === dir || word.startsWith(`${dir}/`)).toBe(false)
          expect([HOME, `${HOME}/`, `${HOME}/.local`, `${HOME}/.local/share`, `${HOME}/.local/share/claude`, '/']).not.toContain(
            plan.command?.[0] === '/bin/rm' ? word : '')
        }
      }
    }
  })
})
