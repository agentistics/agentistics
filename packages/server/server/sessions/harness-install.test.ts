import { beforeEach, describe, expect, test } from 'bun:test'
import { handleHarnessInstallRoute, handleHarnessLoginRoute, type Runner } from './harness-install'
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

describe('harness login route', () => {
  test('starts the harness in an ordinary session in the home directory', async () => {
    let seen: unknown
    const out = await handleHarnessLoginRoute({ harness: 'codex' }, 'pt', async (_l, b) => { seen = b; return { ok: true, message: 'ok', id: 's1' } })
    expect(out.body.id).toBe('s1')
    expect((seen as { harness: string; cwd: string }).harness).toBe('codex')
    expect((seen as { cwd: string }).cwd.startsWith('/')).toBe(true)
  })
  test('refuses a harness it does not manage', async () => {
    const out = await handleHarnessLoginRoute({ harness: 'rm -rf' }, 'en', async () => ({ ok: true, message: '' }))
    expect(out.status).toBe(404)
  })
})
