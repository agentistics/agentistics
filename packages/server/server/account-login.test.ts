import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOGIN_ADAPTERS, LoginFailure, parseLoginOutput, startAccountLogin, type LoginProcess, type LoginRequest } from './account-login'
import { createAccountRoots } from './account-roots'
import { createHarnessAccounts } from './harness-accounts'

const samples = {
  claude: "Browser didn't open? Use the url below to sign in\nhttps://claude.ai/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=PUBLIC_STATE\nPaste code here if prompted >",
  gemini: '\x1b[2JPlease visit the following URL to authorize the application:\nhttps://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fcodeassist.google.com%2Fauthcode\nEnter the authorization code: ',
  codex: '1. Open this link\nhttps://auth.openai.com/codex/device\n2. Enter this one-time code\nABCD-EFGH\n(expires in 15 minutes)',
  copilot: 'To authenticate, visit https://github.com/login/device and enter code ABCD-EFGH.\nWaiting for authorization...',
  kimi: 'Opening browser for Kimi device login: https://www.kimi.com/device?user_code=ABCD-EFGH\nIf the browser did not open, paste the URL above and enter code: ABCD-EFGH\nCode expires in 120s.',
} as const

/** Fake CLI transport, including chunked stdout, secret stdin and a process that can be killed. */
function fakeCli(initial: string[] = []) {
  const chunks = [...initial], writes: string[] = []
  let stopped = false, ended = false, wake: (() => void) | undefined, resolveExit!: (code: number) => void
  const exited = new Promise<number>(r => { resolveExit = r })
  const proc: LoginProcess = {
    exited,
    async read() {
      if (!chunks.length && !ended) await new Promise<void>(r => { wake = r })
      return chunks.shift() ?? null
    },
    async write(code) { writes.push(code) },
    async stop() { stopped = true; ended = true; resolveExit(0); wake?.() },
  }
  return { proc, writes, stopped: () => stopped,
    output(s: string) { chunks.push(s); wake?.(); wake = undefined },
    exit(code: number) { ended = true; resolveExit(code); wake?.() },
  }
}
const request = (harness: keyof typeof samples): LoginRequest => ({ harness, pendingId: 'r_fake', root: '/fake/root', env: {} })
const tick = () => new Promise(r => setTimeout(r, 5))

describe('headless login adapters', () => {
  for (const harness of Object.keys(samples) as (keyof typeof samples)[]) {
    test(`${harness}: parses its URL and flow from ANSI/chunked fake CLI output`, async () => {
      const cli = fakeCli([samples[harness].slice(0, 32), samples[harness].slice(32)])
      const failures: string[] = []
      const handle = await startAccountLogin(request(harness), async reason => { failures.push(reason) }, { launch: async () => cli.proc })
      try {
        const info = await handle.ready
        expect(info.kind).toBe(LOGIN_ADAPTERS[harness]!.kind)
        expect(info.url).toStartWith('https://')
        expect(info.url).not.toContain('\x1b')
        if (info.kind === 'device') expect(info.code).toBe('ABCD-EFGH')
        else expect(info).not.toHaveProperty('code')
        expect(failures).toEqual([])
      } finally { await handle.stop() }
      expect(cli.stopped()).toBe(true)
    })
  }
  test('the login boundary never logs raw output or input', async () => {
    const src = await Bun.file(join(import.meta.dir, 'account-login.ts')).text()
    expect(/console\.(?:log|info|warn|error|debug|trace)/.test(src)).toBe(false)
    expect(src).toContain("tmux(['load-buffer', '-b', buffer, '-'], code)")
  })
  test('device CLI argv cannot fall back to a localhost/browser flow', () => {
    expect(LOGIN_ADAPTERS.codex!.argv).toEqual(['codex', 'login', '--device-auth'])
    expect(LOGIN_ADAPTERS.copilot!.argv).toEqual(['copilot', 'login', '--device-code'])
    expect(LOGIN_ADAPTERS.gemini!.pty).toBe(true)
    expect(LOGIN_ADAPTERS.claude!.pty).toBe(true)
    expect(LOGIN_ADAPTERS.antigravity).toBeNull()
    expect(LOGIN_ADAPTERS.opencode).toBeNull()
  })
  test('unknown hosts and automatic localhost callback URLs are rejected', () => {
    expect(parseLoginOutput('codex', 'https://evil.test/device ABCD-EFGH')).toBeNull()
    expect(parseLoginOutput('claude', 'https://claude.ai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1234%2Fcallback')).toBeNull()
    expect(parseLoginOutput('codex', 'https://auth.openai.com/codex/device')).toBeNull()
  })
  test('device expiry is bounded by 15 minutes; Kimi seconds are honored', () => {
    expect(parseLoginOutput('kimi', samples.kimi, 1000)!.expiresAt).toBe(121000)
    expect(parseLoginOutput('codex', samples.codex.replace('15 minutes', '90 minutes'), 1000)!.expiresAt).toBe(901000)
  })
  for (const harness of ['claude', 'gemini'] as const) {
    test(`${harness}: pasted code is written once and never included in metadata/errors`, async () => {
      const cli = fakeCli([samples[harness]])
      const handle = await startAccountLogin(request(harness), async () => {}, { launch: async () => cli.proc })
      try {
        await handle.ready
        const secret = 'FAKE_PRIVATE_AUTH_CODE#STATE'
        await handle.submit(secret)
        cli.output(secret + '\nTOKEN_SHOULD_NEVER_ESCAPE')
        expect(cli.writes).toEqual([secret])
        expect(JSON.stringify(handle.info())).not.toContain(secret)
        await expect(handle.submit(secret)).rejects.toThrow('Sign-in did not finish')
      } finally { await handle.stop() }
    })
  }
  test('rejects control characters before writing anything', async () => {
    const cli = fakeCli([samples.claude])
    const handle = await startAccountLogin(request('claude'), async () => {}, { launch: async () => cli.proc })
    try { await handle.ready; await expect(handle.submit('secret\ncommand')).rejects.toBeInstanceOf(LoginFailure); expect(cli.writes).toEqual([]) }
    finally { await handle.stop() }
  })
  test('transport exceptions cannot echo a pasted code', async () => {
    const cli = fakeCli([samples.claude]), failures: string[] = []
    cli.proc.write = async code => { throw new Error(code) }
    const handle = await startAccountLogin(request('claude'), async r => { failures.push(r) }, { launch: async () => cli.proc })
    await handle.ready
    await expect(handle.submit('FAKE_SECRET')).rejects.toThrow('Sign-in did not finish. Start again.')
    expect(failures).toEqual(['login_failed'])
    expect(cli.stopped()).toBe(true)
  })
  test('Copilot plaintext prompt is refused without sending yes, including after link readiness', async () => {
    const cli = fakeCli([samples.copilot]), failures: string[] = []
    const handle = await startAccountLogin(request('copilot'), async r => { failures.push(r) }, { launch: async () => cli.proc })
    await handle.ready
    cli.output('System keychain unavailable. Store token in plaintext config file? (y/N)')
    await tick()
    expect(failures).toEqual(['plaintext_refused'])
    expect(cli.writes).toEqual([])
    expect(cli.stopped()).toBe(true)
  })
  test('a CLI that never produces a link times out and is killed', async () => {
    const cli = fakeCli(), failures: string[] = []
    const handle = await startAccountLogin(request('codex'), async r => { failures.push(r) }, { launch: async () => cli.proc, readyTimeoutMs: 10 })
    await expect(handle.ready).rejects.toThrow('Sign-in expired')
    await tick()
    expect(failures).toEqual(['login_timeout']); expect(cli.stopped()).toBe(true)
  })
  test('overall cap kills an already-ready device login', async () => {
    const cli = fakeCli([samples.codex]), failures: string[] = []
    const handle = await startAccountLogin(request('codex'), async r => { failures.push(r) }, { launch: async () => cli.proc, overallTimeoutMs: 15 })
    await handle.ready
    await new Promise(r => setTimeout(r, 30))
    expect(failures).toEqual(['login_timeout']); expect(cli.stopped()).toBe(true)
  })
  test('success exit alone never reports an account as bound', async () => {
    const cli = fakeCli([samples.codex]), failures: string[] = []
    const handle = await startAccountLogin(request('codex'), async r => { failures.push(r) }, { launch: async () => cli.proc })
    await handle.ready; cli.exit(0); await tick()
    expect(failures).toEqual([])
    expect(handle.info()).not.toHaveProperty('accountId')
    await handle.stop()
  })
})

describe('login lifecycle with private roots', () => {
  test('cancelling the create request before a URL kills the process and removes its root', async () => {
    const base = await mkdtemp(join(tmpdir(), 'login-abort-')), cli = fakeCli()
    const store = createHarnessAccounts({ file: join(base, 'accounts.json'), probe: async () => ({ key: 'default', label: 'default' }) })
    let launched!: () => void
    const starting = new Promise<void>(r => { launched = r })
    const roots = createAccountRoots({ base: join(base, 'roots'), flagOn: () => true, defaultDir: () => join(base, 'absent'),
      audit: async () => {}, registerMcp: async () => {}, listAccounts: () => store.readAccounts(), getAccount: id => store.byId(id),
      loginOptions: { launch: async () => { launched(); return cli.proc } },
    })
    try {
      const controller = new AbortController()
      const adding = roots.addRoot('codex', controller.signal)
      await starting; await tick(); controller.abort()
      expect((await adding).ok).toBe(false)
      expect(cli.stopped()).toBe(true)
      expect(await roots.list()).toEqual([])
    } finally { roots.stopPoller(); await rm(base, { recursive: true, force: true }) }
  })
  test('expiry kills the child, removes the pending directory, and exposes a safe refusal', async () => {
    const base = await mkdtemp(join(tmpdir(), 'login-lifecycle-'))
    const cli = fakeCli([samples.codex])
    const store = createHarnessAccounts({ file: join(base, 'accounts.json'), probe: async () => ({ key: 'default', label: 'default' }) })
    const roots = createAccountRoots({ base: join(base, 'roots'), flagOn: () => true, defaultDir: () => join(base, 'absent'),
      audit: async () => {}, registerMcp: async () => {}, listAccounts: () => store.readAccounts(),
      getAccount: id => store.byId(id), probe: async () => ({ key: 'default', label: 'default' }),
      loginOptions: { launch: async () => cli.proc, overallTimeoutMs: 15 },
    })
    try {
      const out = await roots.addRoot('codex')
      if (!out.ok) throw new Error('refused')
      await new Promise(r => setTimeout(r, 35))
      expect(cli.stopped()).toBe(true)
      await expect(stat(out.root)).rejects.toThrow()
      expect((await roots.list())[0]!.error).toBe('login_timeout')
      expect((await roots.list())[0]!.status).toBe('failed')
    } finally { roots.stopPoller(); await rm(base, { recursive: true, force: true }) }
  })
})
