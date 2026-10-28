import { beforeEach, describe, expect, test } from 'bun:test'
import { defaultRunner, handleHarnessInstallRoute, installEnv, type Runner } from './harness-install'
import type { HarnessInstallFacts } from './harness-install-plan'

const facts = (over: Partial<HarnessInstallFacts> = {}) => async (): Promise<HarnessInstallFacts> => ({
  platform: 'linux', arch: 'x64', home: '/h', nodePresent: true, npmGlobalWritable: true, npmPrefix: '/h/.local', ...over,
})
const post = (body: unknown) => new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) })
const ok = { confirmed: true }

/** A fake runner: installers emit `lines`, `--version` prints a version. Nothing real ever runs. */
const fake = (opts: { code?: number; lines?: string[]; calls?: string[][]; verify?: string } = {}): Runner =>
  async (argv, onLine) => {
    opts.calls?.push(argv)
    if (argv.includes('--version')) { onLine(opts.verify ?? 'codex-cli 0.113.0'); return 0 }
    for (const l of opts.lines ?? []) onLine(l)
    return opts.code ?? 0
  }

describe('harness install route', () => {
  beforeEach(() => { /* each test drains its stream, which releases the lock */ })

  test('refuses to run without the confirmation call', async () => {
    const calls: string[][] = []
    const res = await handleHarnessInstallRoute(new Request('http://localhost/x', { method: 'POST', body: '{}' }), 'codex', 'install', { runner: fake({ calls }), facts: facts() })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'confirmation_required' })
    expect(calls).toEqual([])
  })

  test('refuses an unknown harness', async () => {
    const res = await handleHarnessInstallRoute(post(ok), 'kimi', 'install', { runner: fake(), facts: facts() })
    expect(res.status).toBe(404)
  })

  test('streams the installer lines as progress, then verifies the version', async () => {
    const res = await handleHarnessInstallRoute(post(ok), 'codex', 'install', { runner: fake({ lines: ['\u001b[32mdownloading\u001b[0m', 'added 1 package'] }), facts: facts() })
    const text = await res.text()
    expect(text).toContain('"message":"downloading"')
    expect(text).toContain('added 1 package')
    expect(text).toContain('"type":"done"')
    expect(text).toContain('"version":"0.113.0"')
  })

  test('failure is a plain sentence and releases the lock for a retry', async () => {
    const res = await handleHarnessInstallRoute(post(ok), 'codex', 'install', { runner: fake({ code: 1 }), facts: facts() })
    const text = await res.text()
    expect(text).toContain('Não consegui terminar')
    expect(text).not.toContain('"type":"done"')
    const retry = await handleHarnessInstallRoute(post(ok), 'codex', 'install', { runner: fake(), facts: facts() })
    expect(retry.status).toBe(200)
    await retry.text()
  })

  test('the route speaks the language the UI asked for', async () => {
    const res = await handleHarnessInstallRoute(post({ ...ok, lang: 'en' }), 'codex', 'install', { runner: fake({ code: 1 }), facts: facts() })
    const text = await res.text()
    expect(text).toContain('It did not finish')
    expect(text).not.toContain('Instalando')
  })

  test('a version that cannot be read back is a failure, not a success', async () => {
    const res = await handleHarnessInstallRoute(post(ok), 'codex', 'install', { runner: fake({ verify: 'command not found' }), facts: facts() })
    const t = await res.text()
    expect(t).toContain('não consegui abri-lo para confirmar')
    expect(t).not.toContain('internet')
  })

  test('one install at a time', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const slow: Runner = async argv => { if (argv.includes('--version')) return 0; await gate; return 0 }
    const first = await handleHarnessInstallRoute(post(ok), 'codex', 'install', { runner: slow, facts: facts() })
    const reading = first.text()
    await new Promise(r => setTimeout(r, 20))
    const second = await handleHarnessInstallRoute(post(ok), 'gemini', 'install', { runner: fake(), facts: facts() })
    expect(second.status).toBe(409)
    release(); await reading
  })

  test('npm harness without Node answers node-required and runs nothing', async () => {
    const calls: string[][] = []
    const res = await handleHarnessInstallRoute(post(ok), 'gemini', 'install', { runner: fake({ calls }), facts: facts({ nodePresent: false }) })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'node-required' })
    expect(calls).toEqual([])
  })

  test('with installNode it installs Node.js first (user-level), then the harness', async () => {
    const calls: string[][] = []
    const res = await handleHarnessInstallRoute(post({ ...ok, installNode: true }), 'gemini', 'install', { runner: fake({ calls, verify: 'gemini 0.9.0' }), facts: facts({ nodePresent: false }) })
    const text = await res.text()
    expect(calls[0]![2]).toContain('nodejs.org/dist')
    expect(calls[1]).toEqual(['npm', 'i', '-g', '--prefix', '/h/.local', '@google/gemini-cli'])
    expect(text).toContain('"type":"done"')
  })

  test('a failed Node.js install stops before the harness', async () => {
    const calls: string[][] = []
    const runner: Runner = async argv => { calls.push(argv); return 1 }
    const res = await handleHarnessInstallRoute(post({ ...ok, installNode: true }), 'gemini', 'install', { runner, facts: facts({ nodePresent: false }) })
    expect(await res.text()).toContain('Node.js')
    expect(calls.length).toBe(1)
  })

  test('unsupported platform is refused', async () => {
    const res = await handleHarnessInstallRoute(post(ok), 'claude', 'install', { runner: fake(), facts: facts({ platform: 'win32' }) })
    expect(await res.json()).toEqual({ error: 'unsupported-platform' })
  })
})

describe('harness install failures are never silent (macOS report, 2.159.3)', () => {
  test('a runner that throws (spawn failed) puts the reason in the dialog message', async () => {
    const runner: Runner = async () => { throw new Error('Executable not found in $PATH: "sh"') }
    const text = await (await handleHarnessInstallRoute(post(ok), 'claude', 'install', { runner, facts: facts({ platform: 'darwin' }) })).text()
    expect(text).toContain('Não consegui terminar')
    expect(text).toContain('O instalador não iniciou: Executable not found')
  })

  test('a non-zero exit with no output still says the code', async () => {
    const text = await (await handleHarnessInstallRoute(post({ ...ok, lang: 'en' }), 'claude', 'install', { runner: fake({ code: 3 }), facts: facts() })).text()
    expect(text).toContain('It did not finish')
    expect(text).toContain('exited with code 3 (without any message)')
  })

  test('the last stderr lines explain the failure', async () => {
    const runner: Runner = async (argv, onLine) => { onLine('Setting up', 'stdout'); onLine('curl: (6) Could not resolve host', 'stderr'); return 6 }
    const text = await (await handleHarnessInstallRoute(post(ok), 'claude', 'install', { runner, facts: facts() })).text()
    expect(text).toContain('código 6 (curl: (6) Could not resolve host)')
  })

  test('a silent installer keeps the stream alive with SSE comments (Bun idleTimeout would cut it)', async () => {
    const runner: Runner = async (argv, onLine) => {
      if (argv.includes('--version')) { onLine('2.1.0 (Claude Code)'); return 0 }
      await new Promise(r => setTimeout(r, 80)); return 0
    }
    const res = await handleHarnessInstallRoute(post(ok), 'claude', 'install', { runner, facts: facts(), keepaliveMs: 10 })
    const text = await res.text()
    expect(text).toContain(': keepalive')
    expect(text).toContain('"type":"done"')
  })

  test('the real runner reaches /bin/sh even when the server PATH has no system dirs', async () => {
    const saved = process.env.PATH
    process.env.PATH = '/nonexistent'
    try {
      expect(installEnv().PATH!.split(':')).toContain('/bin')
      const lines: Array<[string, string | undefined]> = []
      const code = await defaultRunner(['/bin/sh', '-c', 'echo out; echo boom >&2; exit 4'], (l, s) => lines.push([l, s]), 5000)
      expect(code).toBe(4)
      expect(lines).toContainEqual(['out', 'stdout'])
      expect(lines).toContainEqual(['boom', 'stderr'])
    } finally { process.env.PATH = saved }
  })
})
