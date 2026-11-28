import { describe, expect, test } from 'bun:test'
import { liveRowsOf } from './harness-uninstall'
import { handleHarnessInstallRoute, handleHarnessUninstallRoute, type UninstallDeps } from './harness-install'
import { availableHarnesses, resetHarnessAvailability } from './harness-available'
import { restoreHostWhich, setHostWhichForTests, resetHostWhich } from '../host-which'
import type { HarnessUninstallFacts } from './harness-uninstall-plan'

const installed: HarnessUninstallFacts = {
  platform: 'linux', home: '/h', binPath: '/h/.local/bin/codex', realPath: '/h/.local/lib/node_modules/@openai/codex/bin/codex.js',
}
const gone: HarnessUninstallFacts = { platform: 'linux', home: '/h', binPath: null, realPath: null }

/** Nothing real ever runs: the facts flip to `gone` once the fake uninstaller has "run". */
function fakes(over: Partial<UninstallDeps> & { calls?: string[][]; code?: number; stays?: boolean } = {}): Partial<UninstallDeps> {
  let ran = false
  return {
    runner: async (argv, onLine) => { over.calls?.push(argv); ran = true; onLine('removed 1 package'); return over.code ?? 0 },
    facts: async () => (ran && !over.stays ? gone : installed),
    liveSessions: async () => [],
    runningInside: async () => false,
    ...over,
  }
}
const post = (body: unknown = { confirmed: true }) => new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) })
const get = () => new Request('http://localhost/x?lang=en')

describe('harness uninstall route', () => {
  test('GET says what is removed and what is kept, and runs nothing', async () => {
    const calls: string[][] = []
    const view = await (await handleHarnessUninstallRoute(get(), 'codex', fakes({ calls }))).json()
    expect(view).toEqual({ reason: 'ok', removes: ['/h/.local/lib/node_modules/@openai/codex', '/h/.local/bin/codex'], keeps: ['~/.codex'] })
    expect(calls).toEqual([])
  })

  test('refuses without confirmation and an unknown harness', async () => {
    const calls: string[][] = []
    const res = await handleHarnessUninstallRoute(post({}), 'codex', fakes({ calls }))
    expect(await res.json()).toEqual({ error: 'confirmation_required' })
    expect((await handleHarnessUninstallRoute(post(), 'kimi', fakes({ calls }))).status).toBe(404)
    expect(calls).toEqual([])
  })

  test('runs the plan, streams its lines and ends done', async () => {
    const calls: string[][] = []
    const text = await (await handleHarnessUninstallRoute(post({ confirmed: true, lang: 'en' }), 'codex', fakes({ calls }))).text()
    expect(calls).toEqual([['npm', 'uninstall', '-g', '--prefix', '/h/.local', '@openai/codex']])
    expect(text).toContain('removed 1 package')
    expect(text).toContain('"type":"done"')
    expect(text).toContain('Uninstall complete.')
  })

  test('refuses with live sessions and lists them; nothing runs and the lock is free', async () => {
    const calls: string[][] = []
    const res = await handleHarnessUninstallRoute(post({ confirmed: true, lang: 'en' }), 'codex', fakes({ calls, liveSessions: async () => ['Fix the parser (/repo)'] }))
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string; message: string }
    expect(body.error).toBe('live-sessions')
    expect(body.message).toContain('Fix the parser (/repo)')
    expect(calls).toEqual([])
    const view = await (await handleHarnessUninstallRoute(get(), 'codex', fakes({ liveSessions: async () => ['x'] }))).json() as { reason: string }
    expect(view.reason).toBe('live-sessions')
    const next = await handleHarnessUninstallRoute(post(), 'codex', fakes())
    expect(next.status).toBe(200)
    await next.text()
  })

  test('refuses when sessions cannot be checked, when run from inside one, and for an unrecognised install', async () => {
    const calls: string[][] = []
    const cases: Array<[string, Partial<UninstallDeps>]> = [
      ['live-unknown', { liveSessions: async () => { throw new Error('tmux') } }],
      ['running-inside', { runningInside: async () => true }],
      ['manual', { facts: async () => ({ ...installed, binPath: '/usr/bin/codex', realPath: '/usr/bin/codex' }) }],
      ['not-installed', { facts: async () => gone }],
    ]
    for (const [code, over] of cases) {
      const res = await handleHarnessUninstallRoute(post(), 'codex', fakes({ calls, ...over }))
      expect(res.status).toBe(409)
      expect((await res.json() as { error: string }).error).toBe(code)
    }
    expect(calls).toEqual([])
  })

  test('a failed command, or a binary that is still there, is an error and releases the lock', async () => {
    const failed = await (await handleHarnessUninstallRoute(post({ confirmed: true, lang: 'en' }), 'codex', fakes({ code: 1 }))).text()
    expect(failed).toContain('The uninstaller exited with code 1')
    expect(failed).not.toContain('"type":"done"')
    const still = await (await handleHarnessUninstallRoute(post({ confirmed: true, lang: 'en' }), 'codex', fakes({ stays: true }))).text()
    expect(still).toContain('still on this computer')
    expect(still).not.toContain('"type":"done"')
  })

  test('shares the one-job lock with the install route', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const first = await handleHarnessUninstallRoute(post(), 'codex', fakes({ runner: async () => { await gate; return 0 } }))
    const reading = first.text()
    const install = await handleHarnessInstallRoute(post(), 'gemini', 'install', { runner: async () => 0, facts: async () => ({ platform: 'linux', nodePresent: true, npmPrefix: '/h/.local' }) })
    expect(install.status).toBe(409)
    release(); await reading
  })

  test('success resets availability: the next ask looks at the machine again', async () => {
    let present = true
    setHostWhichForTests({ search: name => (name === 'codex' && !present ? null : `/bin/${name}`), exists: p => present || !p.endsWith('/codex') })
    try {
      resetHarnessAvailability(); resetHostWhich()
      expect(availableHarnesses(1000).ids).toContain('codex')
      present = false
      expect(availableHarnesses(1001).ids).toContain('codex') // memoized
      await (await handleHarnessUninstallRoute(post(), 'codex', fakes())).text()
      expect(availableHarnesses(1002).ids).not.toContain('codex')
    } finally { restoreHostWhich(); resetHarnessAvailability() }
  })

  test('only rows with something running count as live', () => {
    const row = (status: string, harness = 'codex') => ({ id: status, harness, status, cwd: '/r' })
    expect(liveRowsOf('codex', [row('running'), row('external'), row('unregistered'), row('exited'), row('lost'), row('closed'), row('running', 'gemini')]))
      .toEqual(['running (/r)', 'external (/r)', 'unregistered (/r)'])
  })
})
