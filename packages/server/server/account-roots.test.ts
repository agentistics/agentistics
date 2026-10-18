import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import { HARNESS_SECRETS } from './backup/backup-plan'
import { createHarnessAccounts, ISOLATION_ENV } from './harness-accounts'
import {
  LOGIN_START, ROOT_SHARED, applyAccountToPlan, createAccountRoots, linkSharedFiles, looksLikeCredential,
} from './account-roots'
import { handleAccountsRequest } from './accounts-web'
import { rootMcpRegistration } from './mcp-launch'

let tmp: string
let defaults: Record<string, string>
const audits: string[] = []
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'acct-roots-'))
  defaults = {}
  for (const h of HARNESS_ORDER) { defaults[h] = join(tmp, 'default', h); await mkdir(defaults[h]!, { recursive: true }) }
  audits.length = 0
})
afterEach(() => rm(tmp, { recursive: true, force: true }))

function make(over: Partial<Parameters<typeof createAccountRoots>[0]> = {}) {
  const store = createHarnessAccounts({ file: join(tmp, 'accounts.json'), probe: async () => ({ key: 'default', label: 'x' }) })
  const spawned: unknown[] = []
  const roots = createAccountRoots({
    base: join(tmp, 'accounts'), flagOn: () => true, defaultDir: h => defaults[h]!,
    spawn: async req => { spawned.push(req); return { ok: true, message: 'ok', id: 'sess1' } },
    registerMcp: async () => {},
    audit: async i => { audits.push(i.action) },
    probe: async () => ({ key: 'default', label: 'x' }),
    bind: (root, id) => store.bind(root, id), retire: id => store.retire(id),
    getAccount: id => store.byId(id), listAccounts: () => store.readAccounts(),
    ...over,
  })
  return { roots, store, spawned }
}

describe('ROOT_SHARED', () => {
  test('no table name is a credential file of HARNESS_SECRETS', () => {
    for (const h of HARNESS_ORDER) for (const name of ROOT_SHARED[h] ?? []) {
      const secretNames = HARNESS_SECRETS[h].map(r => r.pattern.split('/').pop()!)
      expect(secretNames).not.toContain(name)
      expect(looksLikeCredential(name)).toBe(false)
    }
  })
  test('tables agree: no isolation variable means no shared list and no login', () => {
    for (const h of HARNESS_ORDER) {
      expect(ROOT_SHARED[h] === null).toBe(ISOLATION_ENV[h] === null)
      expect(LOGIN_START[h] === null).toBe(ISOLATION_ENV[h] === null)
    }
  })
})

describe('createRoot', () => {
  test('links only allowlisted files that exist, dirs are 0700', async () => {
    await writeFile(join(defaults.claude!, 'settings.json'), '{}')
    await writeFile(join(defaults.claude!, '.credentials.json'), 'SECRET')
    await writeFile(join(defaults.claude!, 'history.jsonl'), '')
    const { roots } = make()
    const out = await roots.createRoot('claude')
    if (!out.ok) throw new Error('refused')
    expect(out.linked).toEqual(['settings.json'])
    expect(await readlink(join(out.root, 'settings.json'))).toBe(join(defaults.claude!, 'settings.json'))
    await expect(lstat(join(out.root, '.credentials.json'))).rejects.toThrow()
    await expect(lstat(join(out.root, 'history.jsonl'))).rejects.toThrow()
    expect((await stat(out.root)).mode & 0o777).toBe(0o700)
    expect(out.env).toEqual({ CLAUDE_CONFIG_DIR: out.root })
    expect(audits).toContain('account.update')
  })
  test('a credential-looking name is never linked even if a table listed it', async () => {
    await writeFile(join(defaults.codex!, 'auth.json'), 'SECRET')
    await writeFile(join(defaults.codex!, 'config.toml'), '')
    const to = join(tmp, 'to'); await mkdir(to)
    expect(await linkSharedFiles(['auth.json', 'config.toml', '../x'], defaults.codex!, to)).toEqual(['config.toml'])
  })
  test('gemini config lives in <root>/.gemini', async () => {
    await writeFile(join(defaults.gemini!, 'settings.json'), '{}')
    const out = await make().roots.createRoot('gemini')
    if (!out.ok) throw new Error('refused')
    expect(await readlink(join(out.root, '.gemini', 'settings.json'))).toBe(join(defaults.gemini!, 'settings.json'))
  })
  test('antigravity is refused in words', async () => {
    const out = await make().roots.createRoot('antigravity')
    expect(out.ok).toBe(false)
    if (!out.ok) { expect(out.reason).toBe('unsupported'); expect(out.message).toContain('single login') }
  })
  test('flag off refuses', async () => {
    const out = await make({ flagOn: () => false }).roots.createRoot('claude')
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('disabled')
    await expect(stat(join(tmp, 'accounts'))).rejects.toThrow()
  })
})

describe('addRoot / login / poll', () => {
  test('starts the login session in the root with the harness login argv', async () => {
    const { roots, spawned } = make()
    const out = await roots.addRoot('codex')
    if (!out.ok) throw new Error('refused')
    expect(out.sessionId).toBe('sess1')
    const req = spawned[0] as { account: { env: Record<string, string>; loginArgv: string[] } }
    expect(req.account.loginArgv).toEqual(['codex', 'login'])
    expect(req.account.env).toEqual({ CODEX_HOME: out.root })
    expect((await roots.list())[0]!.status).toBe('pending')
    roots.stopPoller()
  })
  test('failed login start leaves no root behind', async () => {
    const { roots } = make({ spawn: async () => ({ ok: false, message: 'no tmux' }) })
    expect((await roots.addRoot('claude')).ok).toBe(false)
    expect(await roots.list()).toEqual([])
  })
  test('a confirmed identity binds the root; unconfirmed stays pending', async () => {
    let key = 'default'
    const { roots, store } = make({ probe: async () => ({ key, label: 'me@x' }) })
    const out = await roots.addRoot('claude')
    if (!out.ok) throw new Error('refused')
    expect(await roots.pollPending()).toEqual([])
    key = 'org:me@x'
    const ids = await roots.pollPending()
    expect(ids).toHaveLength(1)
    expect((await store.byId(ids[0]!))!.root).toBe(out.root)
    expect((await roots.list())[0]!.status).toBe('bound')
    roots.stopPoller()
  })
})

describe('removeRoot', () => {
  async function bound(over = {}) {
    const m = make({ probe: async () => ({ key: 'k', label: 'l' }), ...over })
    const out = await m.roots.addRoot('claude')
    if (!out.ok) throw new Error('refused')
    const [id] = await m.roots.pollPending()
    m.roots.stopPoller()
    return { ...m, out, id: id! }
  }
  test('refused while a session runs', async () => {
    const { roots, id } = await bound({ sessionLive: async () => true })
    const r = await roots.removeRoot(id, { confirm: undefined })
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.status).toBe(409); expect(r.reason).toBe('root_in_use') }
  })
  test('without confirm the account is retired and the directory stays', async () => {
    const { roots, store, out, id } = await bound()
    const r = await roots.removeRoot(id)
    expect(r.ok && r.retired && !r.removedDir && r.confirmWith === out.root).toBe(true)
    expect((await store.byId(id))!.retired).toBe(true)
    expect((await stat(out.root)).isDirectory()).toBe(true)
  })
  test('wrong confirm changes nothing', async () => {
    const { roots, store, out, id } = await bound()
    const r = await roots.removeRoot(id, { confirm: out.root + 'x' })
    expect(r.ok).toBe(false)
    expect((await store.byId(id))!.retired).toBeUndefined()
  })
  test('exact confirm removes the directory but never what the links point at', async () => {
    await writeFile(join(defaults.claude!, 'settings.json'), 'keep')
    const { roots, out, id } = await bound()
    const r = await roots.removeRoot(id, { confirm: out.root })
    expect(r.ok && r.removedDir).toBe(true)
    await expect(stat(out.root)).rejects.toThrow()
    expect((await stat(join(defaults.claude!, 'settings.json'))).isFile()).toBe(true)
    expect(audits).toContain('account.delete')
  })
  test('a path outside the accounts base is never removed', async () => {
    const outside = join(tmp, 'precious'); await mkdir(outside)
    const link = join(tmp, 'accounts', 'claude', 'r_evil')
    await mkdir(join(tmp, 'accounts', 'claude'), { recursive: true })
    await symlink(outside, link)
    const { roots } = make()
    const r = await roots.removeRoot('r_evil', { confirm: link })
    expect(r.ok).toBe(false)
    expect((await stat(outside)).isDirectory()).toBe(true)
  })
  test('a BOUND account whose root is a symlink or outside the base reaches the real guard', async () => {
    const outside = join(tmp, 'precious2'); await mkdir(outside)
    await writeFile(join(outside, 'keep'), 'x')
    const link = join(tmp, 'accounts', 'claude', 'r_link')
    await mkdir(join(tmp, 'accounts', 'claude'), { recursive: true })
    await symlink(outside, link)
    const m = make()
    await m.store.bind(link, { harness: 'claude', key: 'k1', label: 'l' })
    await m.store.bind(outside, { harness: 'claude', key: 'k2', label: 'l' })
    const acc = (await m.store.readAccounts()).accounts
    for (const a of acc.filter(a => a.root)) {
      const r = await m.roots.removeRoot(a.id, { confirm: a.root! })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('not_a_root')
      expect((await m.store.byId(a.id))!.retired).toBeUndefined()
    }
    expect((await stat(join(outside, 'keep'))).isFile()).toBe(true)
  })
})

describe('removeRoot — cancelling a pending login', () => {
  test('ends its own live login session, then drops the pending root without confirm', async () => {
    let live = true
    const ended: string[] = []
    const m = make({
      sessionLive: async () => live,
      endSession: async id => { ended.push(id); live = false; return true },
    })
    const out = await m.roots.addRoot('claude')
    if (!out.ok) throw new Error('refused')
    m.roots.stopPoller()
    const r = await m.roots.removeRoot(out.pendingId)
    expect(r.ok && r.removedDir).toBe(true)
    expect(ended).toEqual(['sess1'])
    await expect(stat(out.root)).rejects.toThrow()
    expect(await m.roots.list()).toEqual([])
  })
  test('the login session title is plain words', async () => {
    const m = make()
    await m.roots.addRoot('claude')
    expect((m.spawned[0] as { label: string }).label).toBe('Login · Claude Code')
    m.roots.stopPoller()
  })
  test('a pending root whose login session cannot be ended still refuses (409)', async () => {
    const m = make({ sessionLive: async () => true, endSession: async () => false })
    const out = await m.roots.addRoot('claude')
    if (!out.ok) throw new Error('refused')
    m.roots.stopPoller()
    const r = await m.roots.removeRoot(out.pendingId)
    expect(!r.ok && r.status === 409).toBe(true)
    expect((await stat(out.root)).isDirectory()).toBe(true)
  })
  test('a FOREIGN session in the pending root still refuses and is never ended', async () => {
    const ended: string[] = []
    const m = make({
      sessionLive: async id => id === 'foreign',
      sessionsOfAccount: async () => ['foreign'],
      endSession: async id => { ended.push(id); return true },
    })
    const out = await m.roots.addRoot('claude')
    if (!out.ok) throw new Error('refused')
    m.roots.stopPoller()
    const r = await m.roots.removeRoot(out.pendingId)
    expect(!r.ok && r.status === 409 && r.reason === 'root_in_use').toBe(true)
    expect(ended).toEqual([])
    expect((await stat(out.root)).isDirectory()).toBe(true)
  })
})

describe('routes', () => {
  const call = (path: string, method: string, body?: unknown, deps = {}) =>
    handleAccountsRequest(new Request(`http://x${path}`, {
      method, body: body ? JSON.stringify(body) : undefined, headers: body ? { 'content-type': 'application/json' } : undefined,
    }), HARNESS_ORDER, {}, deps as never)
  test('flag off → 404 on every roots route', async () => {
    const off = { base: join(tmp, 'accounts'), flagOn: () => false }
    expect((await call('/api/accounts/roots', 'GET', undefined, off)).status).toBe(404)
    expect((await call('/api/accounts/roots', 'POST', { harness: 'claude' }, off)).status).toBe(404)
    expect((await call('/api/accounts/roots/r_1', 'DELETE', undefined, off)).status).toBe(404)
    await expect(stat(join(tmp, 'accounts'))).rejects.toThrow()
  })
  test('a POST whose content-type is not JSON is refused (forces a CORS preflight)', async () => {
    const deps = { base: join(tmp, 'accounts'), flagOn: () => true }
    const res = await handleAccountsRequest(new Request('http://x/api/accounts/roots', {
      method: 'POST', body: JSON.stringify({ harness: 'claude' }), headers: { 'content-type': 'text/plain' },
    }), HARNESS_ORDER, {}, deps as never)
    expect(res.status).toBe(415)
    await expect(stat(join(tmp, 'accounts'))).rejects.toThrow()
  })
  test('POST creates and DELETE needs confirm for the directory', async () => {
    const deps = {
      base: join(tmp, 'accounts'), flagOn: () => true, defaultDir: (h: HarnessId) => defaults[h]!,
      spawn: async () => ({ ok: true, message: 'ok', id: 's' }), registerMcp: async () => {}, audit: async () => {},
      listAccounts: async () => ({ version: 2 as const, accounts: [], bindings: {}, segments: {} }),
      getAccount: async () => null,
    }
    const created = await call('/api/accounts/roots', 'POST', { harness: 'kimi' }, deps)
    expect(created.status).toBe(200)
    const { pendingId, root } = await created.json() as { pendingId: string; root: string }
    expect((await call('/api/accounts/roots', 'POST', { harness: 'antigravity' }, deps)).status).toBe(422)
    // a pending root has no account to keep: Cancel (no body) drops it
    const gone = await call(`/api/accounts/roots/${pendingId}`, 'DELETE', undefined, deps)
    expect(((await gone.json()) as { removedDir: boolean }).removedDir).toBe(true)
    await expect(stat(root)).rejects.toThrow()
  })
})

describe('plan + mcp', () => {
  test('applyAccountToPlan adds env; a login replaces the plan', () => {
    const plan = { argv: ['claude', '--x'], env: { A: '1' }, initialPrompt: { mode: 'type' }, contextFile: {}, conversationId: 'c' } as never as {
      argv: string[]; env?: Record<string, string>; initialPrompt?: unknown; contextFile?: unknown; conversationId?: string }
    applyAccountToPlan(plan, { env: { CLAUDE_CONFIG_DIR: '/r' }, loginArgv: ['claude', 'auth', 'login'] })
    expect(plan.argv).toEqual(['claude', 'auth', 'login'])
    expect(plan.env).toEqual({ A: '1', CLAUDE_CONFIG_DIR: '/r' })
    expect(plan.initialPrompt).toBeUndefined(); expect(plan.contextFile).toBeUndefined(); expect(plan.conversationId).toBeUndefined()
  })
  test('MCP is registered per root only where the config is not shared', () => {
    const launch = { command: 'agentop', args: ['mcp'] }
    const reg = (h: HarnessId) => rootMcpRegistration(h, '/r', launch, 'http://localhost:1')
    expect(reg('claude')!.env).toEqual({ CLAUDE_CONFIG_DIR: '/r' })
    expect(reg('copilot')!.env).toEqual({ COPILOT_HOME: '/r' })
    for (const h of ['codex', 'gemini', 'kimi', 'antigravity', 'opencode'] as const) expect(reg(h)).toBeNull()
  })
  test('this module never logs', async () => {
    const src = await Bun.file(join(import.meta.dir, 'account-roots.ts')).text()
    expect(/console\.(log|info|warn|error)/.test(src)).toBe(false)
  })
})
