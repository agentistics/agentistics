/**
 * HARNESS.LOGIN.TODOS — installing and signing in works for EVERY assistant, wherever its installer
 * put the CLI. Each fake CLI is dropped in the directory its real installer uses (all OUTSIDE the
 * server's default PATH), and the checks follow the whole chain: detection → the sign-in offer →
 * the login process, which must run that very file and print what the real CLI prints.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import { installedLoginHarnesses, launchLoginProcess, LOGIN_ADAPTERS, startAccountLogin } from './account-login'
import { SHELL_SOCKET } from './sessions/tmux-cli'
import { handleAccountsRequest } from './accounts-web'
import { findHarnessBinary, harnessSearchPath } from './sessions/user-path'

/** Where each assistant's own installer puts its binary, relative to HOME (see user-path.ts). */
const INSTALL_DIR: Record<HarnessId, string> = {
  claude: '.local/bin', codex: '.bun/bin', gemini: '.bun/bin', copilot: '.volta/bin', kimi: '.kimi-code/bin',
  antigravity: '.local/bin', opencode: '.local/bin',
}
const BIN: Record<HarnessId, string> = { claude: 'claude', codex: 'codex', gemini: 'gemini', copilot: 'copilot', kimi: 'kimi', antigravity: 'agy', opencode: 'opencode' }
/** What each CLI prints when asked to sign in — same shape as the captures in account-login.test.ts. */
const SAYS: Partial<Record<HarnessId, string>> = {
  claude: 'Open this URL:\\nhttps://claude.com/cai/oauth/authorize?code=true&client_id=fake&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=FAKE\\nPaste code here if prompted >',
  gemini: 'Open this URL:\\nhttps://accounts.google.com/o/oauth2/v2/auth?client_id=fake&state=FAKE\\nEnter the authorization code:',
  codex: 'Open https://auth.openai.com/codex/device\\nEnter this one-time code: ABCD-EFGH\\nexpires in 15 minutes',
  copilot: 'Open https://github.com/login/device\\nEnter code: ABCD-1234',
  kimi: 'Open https://www.kimi.com/code/authorize_device?user_code=ABCD-EFGH\\nCode: ABCD-EFGH',
}

let home: string, tmuxDir: string
const saved = { HOME: process.env.HOME, PATH: process.env.PATH, TMUX_TMPDIR: process.env.TMUX_TMPDIR, TMUX: process.env.TMUX }
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'login-matrix-home-'))
  tmuxDir = await mkdtemp(join(tmpdir(), 'login-matrix-tmux-'))
  for (const h of HARNESS_ORDER) {
    const dir = join(home, INSTALL_DIR[h])
    await mkdir(dir, { recursive: true })
    const file = join(dir, BIN[h])
    // Builtins only: the login PATH holds just node/bun/sh/env/…, never sleep.
    await writeFile(file, `#!/bin/sh\nprintf '${SAYS[h] ?? 'fake'}\\n'\nread -r _wait\n`)
    await chmod(file, 0o755)
  }
  process.env.HOME = home
  process.env.PATH = '/usr/bin:/bin' // the bare PATH of a LaunchAgent: none of the install dirs
  process.env.TMUX_TMPDIR = tmuxDir // never the owner's tmux sockets
  delete process.env.TMUX
})
afterAll(async () => {
  Bun.spawnSync(['tmux', '-L', SHELL_SOCKET, 'kill-server'], { env: { ...process.env, TMUX_TMPDIR: tmuxDir } })
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  await rm(home, { recursive: true, force: true }); await rm(tmuxDir, { recursive: true, force: true })
})

describe('detection looks where the installers put the binary', () => {
  for (const h of HARNESS_ORDER) {
    test(`${h}: found in ~/${INSTALL_DIR[h]} although the server PATH is bare`, () => {
      expect(Bun.which(BIN[h], { PATH: process.env.PATH! })).toBeNull() // the old lookup: invisible
      expect(findHarnessBinary(BIN[h])).toBe(join(home, INSTALL_DIR[h], BIN[h]))
    })
  }
  test('the search path adds Homebrew and the user dirs after what the process already had', () => {
    const p = harnessSearchPath('/usr/bin:/bin', home).split(':')
    expect(p.slice(0, 3)).toEqual(['/usr/bin', '/bin', join(home, '.local/bin')]) // the process's own PATH still decides first
    expect(p).toContain('/opt/homebrew/bin')
    expect(p).toContain(join(home, '.bun/bin'))
  })
  test('only assistants with a sign-in recipe are offered; antigravity is installed but has none', () => {
    const offered = installedLoginHarnesses()
    expect(offered.sort()).toEqual((HARNESS_ORDER.filter(h => LOGIN_ADAPTERS[h] !== null) as HarnessId[]).sort())
    expect(offered).not.toContain('antigravity')
    expect(findHarnessBinary('agy')).toBeTruthy()
  })
  test('GET /api/accounts/roots reports the installed list fresh, with no sessions or accounts', async () => {
    const deps = { base: join(home, 'accounts'), flagOn: () => true, listAccounts: async () => ({ version: 2 as const, accounts: [], bindings: {}, segments: {} }) }
    const res = await handleAccountsRequest(new Request('http://x/api/accounts/roots'), [], {}, deps as never)
    const body = await res.json() as { roots: unknown[]; installed: HarnessId[] }
    expect(body.installed).toContain('codex')
    expect(body.installed.sort()).toEqual(installedLoginHarnesses().sort())
  })
  test('a CLI that is not installed is not offered', () => {
    expect(installedLoginHarnesses(bin => (bin === 'codex' ? '/x/codex' : undefined))).toEqual(['codex'])
  })
})

describe('the sign-in runs the installed file and shows what the CLI prints', () => {
  const signIn = HARNESS_ORDER.filter(h => LOGIN_ADAPTERS[h] !== null)
  for (const h of signIn) {
    test(`${h}: the dialog gets its link${LOGIN_ADAPTERS[h]!.kind === 'device' ? ' and code' : ''}`, async () => {
      const root = await mkdtemp(join(tmpdir(), `login-matrix-root-${h}-`))
      if (h === 'gemini') await mkdir(join(root, '.gemini')) // addRoot creates it in production
      let failure: string | undefined
      const handle = await startAccountLogin({ harness: h, pendingId: `r_${h}`, root, env: {} }, async reason => { failure = reason }, { overallTimeoutMs: 20_000, readyTimeoutMs: 8_000 })
      try {
        const info = await handle.ready
        expect(failure).toBeUndefined()
        expect(info.url.startsWith('https://')).toBe(true)
        expect(info.kind).toBe(LOGIN_ADAPTERS[h]!.kind)
        if (info.kind === 'device') expect(info.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
      } finally { await handle.stop(); await rm(root, { recursive: true, force: true }) }
    }, 20_000)
  }
  test('antigravity has no recipe: the launch refuses and the UI explains how to sign in', async () => {
    await expect(launchLoginProcess({ harness: 'antigravity', pendingId: 'r_agy', root: home, env: {} })).rejects.toThrow()
  })
  test('a CLI missing everywhere is login_unavailable, not a hang', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'login-matrix-empty-'))
    const was = process.env.HOME
    process.env.HOME = empty
    try { await expect(launchLoginProcess({ harness: 'codex', pendingId: 'r_none', root: empty, env: {} })).rejects.toMatchObject({ reason: 'login_unavailable' }) }
    finally { process.env.HOME = was; await rm(empty, { recursive: true, force: true }) }
  })
})
