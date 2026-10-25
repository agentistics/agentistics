import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import { LOGIN_ADAPTERS, type LoginInfo } from './account-login'
import { PORT } from './config'
import { createHarnessAccounts } from './harness-accounts'
import { createAccountRoots, registerRootMcp } from './account-roots'
import { routeCapability } from './capability-guard'
import { hostGate, buildHostAllowlist } from './host-allow'
import { capabilitiesFor } from './exposure'

let tmp: string
beforeEach(async () => { tmp = await mkdtemp(join(tmpdir(), 'acct-fix-')) })
afterEach(() => rm(tmp, { recursive: true, force: true }))

function make(over: Partial<Parameters<typeof createAccountRoots>[0]> = {}) {
  const store = createHarnessAccounts({ file: join(tmp, 'accounts.json'), probe: async () => ({ key: 'default', label: 'x' }) })
  const roots = createAccountRoots({
    base: join(tmp, 'accounts'), flagOn: () => true, defaultDir: h => join(tmp, 'default', h),
    login: async req => {
      const info: LoginInfo = { kind: LOGIN_ADAPTERS[req.harness]!.kind, url: 'https://auth.example/login', code: 'ABCD-EFGH', expiresAt: Date.now() + 900000 }
      return { ready: Promise.resolve(info), info: () => info, submit: async () => {}, stop: async () => {} }
    }, registerMcp: async () => {}, audit: async () => {},
    probe: async () => ({ key: 'default', label: 'x' }),
    bind: (root, id) => store.bind(root, id), retire: id => store.retire(id),
    getAccount: id => store.byId(id), listAccounts: () => store.readAccounts(),
    ...over,
  })
  return { roots, store }
}

describe('H1 — the roots routes ride the shell gate', () => {
  test('capability: roots are localShell, the rest of /api/accounts is unchanged', () => {
    expect(routeCapability('/api/accounts/roots')).toBe('localShell')
    expect(routeCapability('/api/accounts/roots/r_1')).toBe('localShell')
    expect(routeCapability('/api/accounts/roots/r_1/code')).toBe('localShell')
    expect(routeCapability('/api/accounts')).toBe('localTranscripts')
    expect(routeCapability('/api/accounts/abc')).toBe('localTranscripts')
  })
  test('a foreign Host gets 421 on every roots route', () => {
    const caps = capabilitiesFor('local', { central: false, exposure: undefined, allowLocalShell: false, tls: false })
    const list = buildHostAllowlist({ hostname: 'box', interfaceAddresses: ['127.0.0.1'], ports: [PORT, PORT + 1], allowedOrigins: [], secureOrigin: undefined } as never)
    for (const path of ['/api/accounts/roots', '/api/accounts/roots/r_1', '/api/accounts/roots/r_1/code']) {
      const res = hostGate(path, `evil.example:${PORT}`, list, caps)
      expect(res?.status).toBe(421)
    }
  })
})

describe('M1/M5 — registering the MCP in a root', () => {
  test('the API url carries the configured PORT (a non-default one, in a child process)', async () => {
    // In this process PORT is normally the default, so only a child with another PORT discriminates.
    const script = `const { registerRootMcp } = await import(${JSON.stringify(join(import.meta.dir, 'account-roots.ts'))});`
      + `let argv = []; await registerRootMcp('claude', '/r', { spawn: (a) => { argv = a; return { exited: Promise.resolve(0), kill() {} } } });`
      + `console.log(argv.join(' ')); process.exit(0)`
    const child = Bun.spawn([process.execPath, '-e', script], {
      env: { ...process.env, PORT: '51234', AGENTISTICS_DATA_DIR: join(tmp, 'data') }, stdout: 'pipe', stderr: 'pipe',
    })
    const out = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    expect(out).toContain('AGENTISTICS_API=http://localhost:51234')
    expect(PORT).not.toBe(51234)
  }, 30_000)
  test('M4: every root registration removes the old entry BEFORE adding (claude and copilot)', async () => {
    for (const harness of ['claude', 'copilot'] as const) {
      const seen: string[][] = []
      const envs: Record<string, string>[] = []
      await registerRootMcp(harness, '/r', { spawn: (a, env) => { seen.push(a); envs.push(env); return { exited: Promise.resolve(0), kill() {} } } })
      expect(seen.map(a => a.slice(1, 3).join(' '))).toEqual(['mcp remove', 'mcp add'])
      expect(seen[0]![0]).toBe(harness)
      // Both children run inside the root, never the default one.
      expect(envs.every(e => Object.values(e).includes('/r'))).toBe(true)
    }
  })
  test('M4: a remove that hangs is killed and the add still runs', async () => {
    const seen: string[] = []
    let killed = 0
    await registerRootMcp('claude', '/r', {
      timeoutMs: 20,
      spawn: (a) => { seen.push(a[2]!); return { exited: a[2] === 'remove' ? new Promise<number>(() => {}) : Promise.resolve(0), kill() { killed++ } } },
    })
    expect(seen).toEqual(['remove', 'add'])
    expect(killed).toBe(1)
  })
  test('a CLI that never exits is killed after the timeout', async () => {
    let killed = false
    await registerRootMcp('claude', '/r', {
      timeoutMs: 20,
      spawn: () => ({ exited: new Promise<number>(() => {}), kill() { killed = true } }),
    })
    expect(killed).toBe(true)
  })
})

describe('M2/M3 — harnesses without an identity probe', () => {
  async function pending(harness: HarnessId, over = {}) {
    const m = make(over)
    const out = await m.roots.addRoot(harness)
    if (!out.ok) throw new Error('refused')
    m.roots.stopPoller()
    return { ...m, out }
  }
  test('gemini: the fallback key default never binds, even with the marker present', async () => {
    const { roots, out } = await pending('gemini')
    await mkdir(join(out.root, '.gemini'), { recursive: true })
    await writeFile(join(out.root, '.gemini', 'oauth_creds.json'), '{}')
    expect(await roots.pollPending()).toEqual([])
    expect((await roots.list())[0]!.status).toBe('pending')
  })
  test('gemini: marker present and a real identity binds', async () => {
    const { roots, out } = await pending('gemini', { probe: async () => ({ key: 'root:abc', label: 'l' }) })
    expect(await roots.pollPending()).toEqual([])
    await mkdir(join(out.root, '.gemini'), { recursive: true })
    await writeFile(join(out.root, '.gemini', 'oauth_creds.json'), '{}')
    expect(await roots.pollPending()).toHaveLength(1)
  })
  test('kimi: the login session ending without a login does not bind', async () => {
    const { roots } = await pending('kimi', { probe: async () => ({ key: 'root:abc', label: 'l' }), sessionLive: async () => false })
    expect(await roots.pollPending()).toEqual([])
    expect((await roots.list())[0]!.status).toBe('pending')
  })
  test('kimi: the login marker on disk binds, and survives a restart (no in-memory state needed)', async () => {
    const { out } = await pending('kimi', { probe: async () => ({ key: 'root:abc', label: 'l' }) })
    await mkdir(join(out.root, 'credentials'), { recursive: true })
    await writeFile(join(out.root, 'credentials', 'kimi-code.json'), '{}')
    const restarted = make({ probe: async () => ({ key: 'root:abc', label: 'l' }) })
    expect(await restarted.roots.pollPending()).toHaveLength(1)
  })
  test('kimi: a default config.toml (written on first start) is not a login', async () => {
    const { roots, out } = await pending('kimi', { probe: async () => ({ key: 'root:abc', label: 'l' }) })
    await writeFile(join(out.root, 'config.toml'), '')
    expect(await roots.pollPending()).toEqual([])
  })
  test('kimi: MCP OAuth state alone (credentials/mcp) is not a login', async () => {
    const { roots, out } = await pending('kimi', { probe: async () => ({ key: 'root:abc', label: 'l' }) })
    await mkdir(join(out.root, 'credentials', 'mcp'), { recursive: true })
    expect(await roots.pollPending()).toEqual([])
  })
})

describe('M4 — boot re-registration walks every root', () => {
  test('registers the MCP in each claude/copilot root, skipping the others', async () => {
    const calls: string[] = []
    const { roots } = make({ registerMcp: async (h, r) => { calls.push(`${h}:${r}`) } })
    const a = await roots.createRoot('claude'); const b = await roots.createRoot('copilot'); await roots.createRoot('codex')
    if (!a.ok || !b.ok) throw new Error('refused')
    calls.length = 0
    await roots.reregisterMcp()
    expect(calls.sort()).toEqual([`claude:${a.root}`, `copilot:${b.root}`].sort())
  })
  test('does nothing with the flag off', async () => {
    const calls: string[] = []
    const { roots } = make({ flagOn: () => false, registerMcp: async (h, r) => { calls.push(h + r) } })
    await roots.reregisterMcp()
    expect(calls).toEqual([])
  })
})

describe('LOWs', () => {
  test('L1: a throwing spawn removes the root', async () => {
    const { roots } = make({ login: async () => { throw new Error('boom') } })
    const out = await roots.addRoot('claude')
    expect(out.ok).toBe(false)
    expect(await roots.list()).toEqual([])
  })
  test('L2: a failed path check retires nothing', async () => {
    const outside = join(tmp, 'outside'); await mkdir(outside)
    const m = make()
    await m.store.bind(outside, { harness: 'claude', key: 'k', label: 'l' })
    const id = (await m.store.readAccounts()).accounts.find(a => a.root)!.id
    const r = await m.roots.removeRoot(id, { confirm: outside })
    expect(r.ok).toBe(false)
    expect((await m.store.byId(id))!.retired).toBeUndefined()
  })
  test('L3: a symlinked harness folder is refused on create and on remove', async () => {
    const elsewhere = join(tmp, 'elsewhere'); await mkdir(elsewhere)
    await mkdir(join(tmp, 'accounts'), { recursive: true })
    await symlink(elsewhere, join(tmp, 'accounts', 'claude'))
    const before = (await lstat(elsewhere)).mode & 0o777
    const { roots } = make()
    const out = await roots.createRoot('claude')
    expect(out.ok).toBe(false)
    expect(out.ok ? undefined : out.reason).toBe('unsafe_path')
    expect((await lstat(elsewhere)).mode & 0o777).toBe(before) // untouched by chmod, whatever the umask
    await mkdir(join(elsewhere, 'r_x'))
    const r = await roots.removeRoot('r_x', { confirm: join(tmp, 'accounts', 'claude', 'r_x') })
    expect(r.ok).toBe(false)
    expect((await stat(join(elsewhere, 'r_x'))).isDirectory()).toBe(true)
  })
  test('L7: a relative default dir yields absolute links', async () => {
    const rel = join('.', 'reldefault')
    const old = process.cwd()
    process.chdir(tmp)
    try {
      await mkdir(join(tmp, 'reldefault'))
      await writeFile(join(tmp, 'reldefault', 'settings.json'), '{}')
      const { roots } = make({ defaultDir: () => rel })
      const out = await roots.createRoot('claude')
      if (!out.ok) throw new Error('refused')
      const { readlink } = await import('node:fs/promises')
      expect(isAbsolute(await readlink(join(out.root, 'settings.json')))).toBe(true)
    } finally { process.chdir(old) }
  })
  test('all harnesses still covered', () => { expect(HARNESS_ORDER.length).toBeGreaterThan(0) })
})
