import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import claudeCapture from './fixtures/account-login/claude.json'
import codexCapture from './fixtures/account-login/codex.json'
import copilotCapture from './fixtures/account-login/copilot.json'
import geminiPreamble from './fixtures/account-login/gemini.json'
import geminiRetryCapture from './fixtures/account-login/gemini-url-invalid.json'
import { claudeKeychainService, diagnoseLogin, LOGIN_ADAPTERS, stripLoginAnsi, loginRefusal, LoginFailure, maskLoginText, loginScreenSaid, parseLoginOutput, parsePaneDead, startAccountLogin, submitPasted, codeStillTyped, type LoginProcess, type LoginRequest } from './account-login'
import { createAccountRoots, rootEnv } from './account-roots'
import { claudeProbeEnv, createHarnessAccounts } from './harness-accounts'

// Captured installed CLIs, with one-time codes/state/PKCE replaced by same-shape fakes.
const [geminiFirst, geminiRetry] = geminiRetryCapture.split('<<<QA: typed fake code qa-fake-123>>>')
const samples = {
  claude: claudeCapture,
  gemini: geminiFirst!,
  codex: codexCapture,
  copilot: copilotCapture,
  // No live Kimi capture was supplied; keep this explicitly synthetic adapter sample.
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
        if (info.kind === 'device') expect(info.code).toBe(parseLoginOutput(harness, samples[harness])!.code)
        else expect(info).not.toHaveProperty('code')
        expect(failures).toEqual([])
      } finally { await handle.stop() }
      expect(cli.stopped()).toBe(true)
    })
  }

  test('OSC 8 BEL and ST terminators cannot consume visible Claude links', () => {
    for (const raw of [samples.claude, samples.claude.replaceAll('\x07', '\x1b\\')]) {
      const clean = stripLoginAnsi(raw)
      expect(clean).not.toContain('\x1b')
      expect(parseLoginOutput('claude', raw)!.url).toStartWith('https://claude.com/cai/oauth/authorize?')
    }
    expect(parseLoginOutput('claude', samples.claude.replaceAll('claude.com/cai', 'evil.test/cai'))).toBeNull()
  })
  test('real Codex 4+5 and Copilot 4+4 codes retain their full length', () => {
    expect(parseLoginOutput('codex', samples.codex)!.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{5}$/)
    expect(parseLoginOutput('copilot', samples.copilot)!.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    expect(parseLoginOutput('gemini', geminiPreamble)).toBeNull()
  })
  for (const harness of ['gemini', 'claude'] as const) {
    test(`${harness}: rejection refreshes the link and accepts another code without echoing input`, async () => {
      const cli = fakeCli([samples[harness]])
      const failures: string[] = []
      const handle = await startAccountLogin(request(harness), async r => { failures.push(r) }, { launch: async () => cli.proc })
      try {
        const first = await handle.ready
        await handle.submit('qa-fake-123')
        const retry = harness === 'gemini' ? geminiRetry! : 'Invalid authorization code\n' + samples.claude.replaceAll('state=', 'state=retry-')
        cli.output(retry)
        await tick()
        expect(handle.info()!.error).toBe('invalid_code')
        expect(handle.info()!.url).not.toBe(first.url)
        expect(JSON.stringify(handle.info())).not.toContain('qa-fake-123')
        const latest = handle.info()!.url
        await handle.submit('SECOND_FAKE_CODE')
        expect(handle.info()!.error).toBeUndefined()
        // A PTY snapshot still contains earlier diagnostics; it must not reject this attempt.
        cli.output(retry + '\nSECOND_FAKE_CODE')
        await tick()
        expect(handle.info()!.error).toBeUndefined()
        expect(handle.info()!.url).toBe(latest)
        expect(cli.writes).toEqual(['qa-fake-123', 'SECOND_FAKE_CODE'])
        expect(failures).toEqual([])
      } finally { await handle.stop() }
    })
  }
  test('CONTAS.LOGIN: a CLI that ends after the pasted code with no account bound is a visible failure, not an endless wait', async () => {
    const cli = fakeCli([samples.claude])
    const failures: string[] = []
    const handle = await startAccountLogin(request('claude'), async r => { failures.push(r) }, { launch: async () => cli.proc, bindGraceMs: 20 })
    try {
      await handle.ready
      await handle.submit('FAKE_CODE')
      cli.exit(0)
      await tick()
      expect(failures).toEqual([])
      await new Promise(r => setTimeout(r, 40))
      expect(failures).toEqual(['login_failed'])
    } finally { await handle.stop() }
  })
  test('CONTAS.LOGIN: a binding that stops the handle inside the grace never reports a failure', async () => {
    const cli = fakeCli([samples.claude])
    const failures: string[] = []
    const handle = await startAccountLogin(request('claude'), async r => { failures.push(r) }, { launch: async () => cli.proc, bindGraceMs: 20 })
    await handle.ready
    await handle.submit('FAKE_CODE')
    cli.exit(0)
    await tick()
    await handle.stop()
    await new Promise(r => setTimeout(r, 40))
    expect(failures).toEqual([])
  })
  test('PTY redraws replace the pane rather than duplicating prompt counters', async () => {
    const cli = fakeCli([samples.claude, samples.claude + '\n'])
    cli.proc.snapshot = true
    const handle = await startAccountLogin(request('claude'), async () => {}, { launch: async () => cli.proc })
    try {
      await handle.ready; await tick()
      await handle.submit('FIRST_FAKE_CODE')
      cli.output(samples.claude + '\nFIRST_FAKE_CODE\nPaste code here if prompted > ')
      await tick()
      expect(handle.info()!.error).toBe('invalid_code')
      await handle.submit('SECOND_FAKE_CODE')
      expect(cli.writes).toHaveLength(2)
    } finally { await handle.stop() }
  })
  test('Claude re-prompt with the same link restores paste without retaining the echo', async () => {
    const cli = fakeCli([samples.claude])
    const handle = await startAccountLogin(request('claude'), async () => {}, { launch: async () => cli.proc })
    try {
      await handle.ready
      await handle.submit('FIRST_FAKE_CODE')
      cli.output(samples.claude + '\nFIRST_FAKE_CODE\nPaste code here if prompted > ')
      await tick()
      expect(handle.info()!.error).toBe('invalid_code')
      expect(JSON.stringify(handle.info())).not.toContain('FIRST_FAKE_CODE')
      await handle.submit('SECOND_FAKE_CODE')
      expect(cli.writes).toEqual(['FIRST_FAKE_CODE', 'SECOND_FAKE_CODE'])
    } finally { await handle.stop() }
  })
  for (const prompt of [
    'Would you like to store the token in the plain text config file instead?',
    'System keychain is unavailable.', 'Failed to access the keychain.',
    'Unable to open keychain.', 'Token could not be saved.',
  ]) test(`Copilot refuses: ${prompt}`, async () => {
    expect(loginRefusal(prompt)).toBe('plaintext_refused')
    const cli = fakeCli([samples.copilot]), failures: string[] = []
    const handle = await startAccountLogin(request('copilot'), async r => { failures.push(r) }, { launch: async () => cli.proc })
    await handle.ready; cli.output(prompt); await tick()
    expect(failures).toEqual(['plaintext_refused'])
    expect(cli.writes).toEqual([])
    expect(cli.stopped()).toBe(true)
  })

  test('the login boundary never logs raw output or input', async () => {
    const src = await Bun.file(join(import.meta.dir, 'account-login.ts')).text()
    // One sink, fed only masked screens (see the r3 masking tests) and fixed facts.
    expect(src.match(/console\.(?:log|info|warn|error|debug|trace)/g)).toEqual(['console.warn'])
    expect(src).toContain('export const loginLog = (line: string) => console.warn(line)')
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

describe('CONTAS.LOGIN r3: the code is submitted, and a stuck or failed sign-in says what the CLI said', () => {
  test('the Enter is sent apart from the paste, after a wait, and pressed once more only when the code is still in the field', async () => {
    const events: string[] = []
    const code = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789#ZyXwVuTsRqPoNmLkJiHgFe'
    let screen = `Paste code here if prompted > ${code}`
    await submitPasted({
      paste: async () => { events.push('paste') },
      enter: async () => { events.push('enter') },
      screen: async () => screen,
    }, { code, sleep: async ms => { events.push(`sleep ${ms}`) } })
    expect(events).toEqual(['paste', 'sleep 500', 'enter', 'sleep 1500', 'enter'])
    events.length = 0
    screen = 'Paste code here if prompted > '
    await submitPasted({
      paste: async () => { events.push('paste') },
      enter: async () => { events.push('enter'); screen = 'Login successful' },
      screen: async () => screen,
    }, { code, sleep: async ms => { events.push(`sleep ${ms}`) } })
    expect(events).toEqual(['paste', 'sleep 500', 'enter', 'sleep 1500'])
  })
  test('a dead pane reports its real exit status', () => {
    expect(parsePaneDead('0 \n')).toBeNull()
    expect(parsePaneDead('1 1\n')).toBe(1)
    expect(parsePaneDead('1 0')).toBe(0)
    // Dead but not yet reaped: no status is not a failure until the grace is over.
    expect(parsePaneDead('1 \n', false)).toBeNull()
    expect(parsePaneDead('1 \n', true)).toBe(1)
    expect(parsePaneDead('1 0', false)).toBe(0)
  })
  test('a CLI still alive after the code fails with what its screen says, never waits forever', async () => {
    const cli = fakeCli([samples.claude])
    cli.proc.snapshot = true
    const failures: { reason: string; detail?: string }[] = [], logs: string[] = []
    const code = 'SECRETCODEabcdefghij0123456789#STATEPARTxyz'
    const handle = await startAccountLogin(request('claude'), async (reason, detail) => { failures.push({ reason, detail }) },
      { launch: async () => cli.proc, submitTimeoutMs: 30, log: l => logs.push(l) })
    await handle.ready
    await handle.submit(code)
    cli.output(`${samples.claude}\nPaste code here if prompted > ${code}\nOAuth error: Invalid code`)
    await new Promise(r => setTimeout(r, 80))
    expect(failures).toHaveLength(1)
    expect(failures[0]!.reason).toBe('login_failed')
    expect(failures[0]!.detail).toContain('OAuth error: Invalid code')
    for (const text of [failures[0]!.detail!, ...logs]) {
      expect(text).not.toContain('SECRETCODE')
      expect(text).not.toContain('STATEPART')
      expect(text).not.toContain('https://')
    }
    expect(logs.join('\n')).toContain('OAuth error: Invalid code')
  })
  test('a CLI that exits non-zero after the code fails at once with its last words', async () => {
    const cli = fakeCli([samples.claude])
    cli.proc.snapshot = true
    const failures: { reason: string; detail?: string }[] = []
    const handle = await startAccountLogin(request('claude'), async (reason, detail) => { failures.push({ reason, detail }) },
      { launch: async () => cli.proc, log: () => {} })
    await handle.ready
    await handle.submit('FAKECODE123#abc')
    cli.output(`${samples.claude}\nPaste code here if prompted > Login failed: Request failed with status code 400`)
    await tick()
    cli.exit(1)
    await tick(); await tick()
    expect(failures).toEqual([{ reason: 'login_failed', detail: 'Login failed: Request failed with status code 400' }])
  })
  test('masking removes the code, its halves, links and long tokens', () => {
    const out = maskLoginText('pasted ABCD1234#WXYZ9876 at https://claude.com/x?state=s and tok_' + 'q'.repeat(30), ['ABCD1234#WXYZ9876', 'ABCD1234', 'WXYZ9876'])
    expect(out).not.toContain('ABCD1234'); expect(out).not.toContain('WXYZ9876'); expect(out).not.toContain('claude.com'); expect(out).not.toContain('qqqq')
    expect(loginScreenSaid('header\nPaste code here if prompted > Login successful\nPane is dead (status 0)')).toBe('Login successful')
  })
})

describe('CONTAS.LOGIN r3: login and probe name the same macOS keychain item', () => {
  test('the item mirrors the CLI: sha256(CLAUDE_CONFIG_DIR)[:8], SECURESTORAGE wins, none = the plain item', () => {
    const dir = '/Users/someone/.agentistics/accounts/claude/r_0123456789ab'
    const hex = new Bun.CryptoHasher('sha256').update(dir).digest('hex').slice(0, 8)
    expect(claudeKeychainService({ CLAUDE_CONFIG_DIR: dir })).toBe(`Claude Code-credentials-${hex}`)
    expect(claudeKeychainService({})).toBe('Claude Code-credentials')
    expect(claudeKeychainService({ CLAUDE_CONFIG_DIR: dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: '/x' })).not.toBe(`Claude Code-credentials-${hex}`)
  })
  test('the probe env of a root names the item the login env of that root writes, even with an inherited SECURESTORAGE dir', () => {
    const root = '/Users/someone/.agentistics/accounts/claude/r_0123456789ab'
    const login = rootEnv('claude', root)
    const probe = claudeProbeEnv(root, { HOME: '/Users/someone', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/elsewhere', CLAUDE_CONFIG_DIR: '/old' })
    expect(claudeKeychainService(probe as Record<string, string>)).toBe(claudeKeychainService(login))
    expect(claudeKeychainService(login)).not.toBe('Claude Code-credentials')
  })
})

describe('CONTAS.LOGIN r3: a finished sign-in the probe cannot see says why (macOS keychain)', () => {
  const req = { harness: 'claude' as const, pendingId: 'r_x', root: '/Users/a/.agentistics/accounts/claude/r_x', env: { CLAUDE_CONFIG_DIR: '/Users/a/.agentistics/accounts/claude/r_x' } }
  test('item present → keychain_unreadable; absent → login_not_saved; never -w; not macOS or not claude → nothing', async () => {
    const calls: string[][] = []
    expect(await diagnoseLogin(req, 'darwin', async argv => { calls.push(argv); return 0 })).toBe('keychain_unreadable')
    expect(await diagnoseLogin(req, 'darwin', async argv => { calls.push(argv); return 44 })).toBe('login_not_saved')
    expect(await diagnoseLogin(req, 'linux', async () => 0)).toBeUndefined()
    expect(await diagnoseLogin({ ...req, harness: 'codex' }, 'darwin', async () => 0)).toBeUndefined()
    for (const argv of calls) {
      expect(argv).not.toContain('-w'); expect(argv).not.toContain('-g')
      expect(argv).toEqual(['security', 'find-generic-password', '-s', claudeKeychainService(req.env)])
    }
  })
  test('the CLI ended cleanly with no account bound: the diagnosis replaces login_failed', async () => {
    const cli = fakeCli([samples.claude])
    const failures: string[] = []
    const handle = await startAccountLogin(request('claude'), async r => { failures.push(r) },
      { launch: async () => cli.proc, bindGraceMs: 10, diagnose: async () => 'keychain_unreadable', log: () => {} })
    await handle.ready
    await handle.submit('FAKE_CODE')
    cli.exit(0)
    await new Promise(r => setTimeout(r, 50))
    expect(failures).toEqual(['login_unreadable'])
  })
})

/**
 * A model of `claude auth login` 2.1.310, read from its own source and checked live: readline over
 * stdin, NO echo, each line split on '#'; a line missing either half prints "Invalid code. Please
 * make sure the full code was copied." and keeps waiting; the first whole line is exchanged and
 * nothing is printed until that exchange answers.
 */
function claudeReadline(initial: string) {
  let screen = initial, field = '', taken = false
  return {
    get screen() { return screen },
    paste(text: string) { field += text },
    enter() {
      const [code, state] = field.trim().split('#'); field = ''
      if (!code || !state) { screen += 'Invalid code. Please make sure the full code was copied.\n'; return }
      taken = true
    },
    taken: () => taken,
  }
}

describe('CONTAS.LOGIN r4: a correct code is never reported as refused', () => {
  const code = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEfG#ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210-_ZyXwVu'
  test('a slow token exchange gets no second Enter, so the CLI never prints "Invalid code"', async () => {
    const cli = claudeReadline(`${samples.claude}\nPaste code here if prompted > `)
    const before = cli.screen
    await submitPasted({ paste: async () => cli.paste(code), enter: async () => cli.enter(), screen: async () => cli.screen }, { code, sleep: async () => {} })
    expect(cli.taken()).toBe(true)
    expect(cli.screen).toBe(before)
    expect(cli.screen).not.toContain('Invalid code')
  })
  test('end to end: the reader keeps waiting for the binding instead of concluding invalid_code', async () => {
    const cli = claudeReadline(`${samples.claude}\nPaste code here if prompted > `)
    let wake: (() => void) | undefined, last = '', resolveExit!: (n: number) => void
    const proc: LoginProcess = {
      snapshot: true, exited: new Promise<number>(r => { resolveExit = r }),
      async read() { while (cli.screen === last) await new Promise<void>(r => { wake = r }); last = cli.screen; return last },
      async write(c) { await submitPasted({ paste: async () => cli.paste(c), enter: async () => { cli.enter(); wake?.() }, screen: async () => cli.screen }, { code: c, sleep: async () => {} }) },
      async stop() { resolveExit(0) },
    }
    const logs: string[] = []
    const handle = await startAccountLogin(request('claude'), async () => {}, { launch: async () => proc, log: l => logs.push(l), submitTimeoutMs: 60_000 })
    await handle.ready
    await handle.submit(code)
    await new Promise(r => setTimeout(r, 30))
    expect(cli.taken()).toBe(true)
    expect(handle.info()!.error).toBeUndefined()
    expect(logs.filter(l => l.includes('invalid_code'))).toEqual([])
    await handle.stop()
  })
  test('a code the CLI really refuses is invalid_code, and the server log says why, masked', async () => {
    const cli = fakeCli([samples.claude])
    cli.proc.snapshot = true
    const logs: string[] = []
    const handle = await startAccountLogin(request('claude'), async () => {}, { launch: async () => cli.proc, log: l => logs.push(l), submitTimeoutMs: 60_000 })
    await handle.ready
    await handle.submit('SECRETCODEonlyhalfnostate0123456789')
    cli.output(`${samples.claude}\nPaste code here if prompted > Invalid code. Please make sure the full code was copied.`)
    await new Promise(r => setTimeout(r, 30))
    expect(handle.info()!.error).toBe('invalid_code')
    const why = logs.find(l => l.includes('concluded invalid_code'))!
    expect(why).toContain('the CLI said the code is invalid')
    expect(why).toContain('Invalid code. Please make sure the full code was copied.')
    expect(why).not.toContain('SECRETCODE')
    expect(why).not.toContain('https://')
    await handle.stop()
  })
  test('the code reaches the CLI whole: its #state half is never cut', async () => {
    const cli = claudeReadline('Paste code here if prompted > ')
    await submitPasted({ paste: async () => cli.paste(code), enter: async () => cli.enter(), screen: async () => cli.screen }, { code, sleep: async () => {} })
    expect(cli.taken()).toBe(true)
  })
  test('codeStillTyped reads only the last line of the screen', () => {
    expect(codeStillTyped(`Paste code here if prompted > ${code}`, code)).toBe(true)
    expect(codeStillTyped('Paste code here if prompted > ', code)).toBe(false)
    expect(codeStillTyped(`${code}\nLogin successful.`, code)).toBe(false)
  })
})
