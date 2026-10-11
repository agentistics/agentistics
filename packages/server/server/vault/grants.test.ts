import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryProtector } from '@agentistics/vault'
import { __resetVaultForTests, __setVaultClockForTests, autoLockRemainingMs, ensureVaultOpen, lockVault, noteVaultActivity, sealToFile } from './service'
import { __resetPersonalForTests, createGroup, createItem } from './personal'
import { __setConfirmEachUseForTests, __resetGrantsForTests, authorizeUse, decideUse, grantBriefing, grantEnv, grantOf, grantSession, pendingUseRequests, refKey, revokeGrant, scrubDeep, scrubTerminalLine, VAULT_REF_INSTRUCTION } from './grants'

let testNow = 1_800_000_000_000

afterEach(() => { __setConfirmEachUseForTests(false) })

beforeEach(async () => {
  testNow = 1_800_000_000_000
  const dir = await mkdtemp(join(tmpdir(), 'agentistics-grants-'))
  const mem = memoryProtector()
  __resetVaultForTests({ dir: join(dir, 'vault'), lang: 'en', protectors: [mem], autoInit: { candidates: [mem] } })
  __setVaultClockForTests(() => testNow)
  __resetPersonalForTests(); __resetGrantsForTests()
  await sealToFile(join(dir, 'x.sealed'), 'github-backup', 'github-backup', new TextEncoder().encode('x'))
  expect(await ensureVaultOpen()).not.toBeNull()
})

describe('per-session grants', () => {
  test('items and whole groups; references, env names; a briefing that carries no value', async () => {
    const g = (await createGroup('pelvie')).group
    const a = (await createItem({ kind: 'login', name: 'Painel Pelvie', groupId: g.id, fields: { login: 'adm', password: 'MARKER-1' } })).meta
    const b = (await createItem({ kind: 'api-key', name: 'OpenAI', fields: { value: 'MARKER-2' } })).meta
    await createItem({ kind: 'note', name: 'Outra', fields: { value: 'MARKER-3' } })
    const r = await grantSession('s1', [b.id], [g.id])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.grant.refs.map(x => x.ref)).toEqual(['vault://openai', 'vault://painel-pelvie/login', 'vault://painel-pelvie/password'])
    expect(await grantEnv('s1')).toEqual({ VAULT_OPENAI: 'MARKER-2', VAULT_PAINEL_PELVIE_LOGIN: 'adm', VAULT_PAINEL_PELVIE_PASSWORD: 'MARKER-1' })
    const brief = grantBriefing(r.grant, 'pt')
    expect(brief).toContain(VAULT_REF_INSTRUCTION)
    expect(brief).toContain('vault://openai')
    expect(brief).not.toContain('VAULT_OPENAI')
    expect(brief).not.toContain('MARKER')
    void a
  })
  test('another session gets nothing; revoke and vault lock drop the grant', async () => {
    const b = (await createItem({ kind: 'api-key', name: 'OpenAI', fields: { value: 'MARKER-2' } })).meta
    await grantSession('s1', [b.id], [])
    expect(await grantEnv('s2')).toEqual({})
    expect(revokeGrant('s1')).toBe(true)
    expect(grantOf('s1')).toBeNull()
    await grantSession('s1', [b.id], [])
    lockVault('user')
    expect(grantOf('s1')).toBeNull()
  })
  test('a ref is refused outside the live managed-session grant window', async () => {
    const { useRef } = await import('./grants')
    const b = (await createItem({ kind: 'api-key', name: 'OpenAI', fields: { value: 'MARKER-window' } })).meta
    expect(await useRef('s1', 'vault://openai')).toEqual({ ok: false, code: 'not-granted' })
    await grantSession('s1', [b.id], [])
    expect(await useRef('other-session', 'vault://openai')).toEqual({ ok: false, code: 'not-granted' })
    lockVault('user')
    expect(await useRef('s1', 'vault://openai')).toEqual({ ok: false, code: 'not-granted' })
  })
  test('ref keys', () => {
    expect(refKey('Banco Itaú (PF)')).toBe('banco-itau-pf')
    expect(refKey('!!!')).toBe('secret')
  })
})

describe('served copies of a granted session are scrubbed (§8.4)', () => {
  test('chat turns (text, tool inputs and outputs), a terminal line with colour, and nothing for another session', async () => {
    const b = (await createItem({ kind: 'api-key', name: 'OpenAI', fields: { value: 'sk-MARKER-123456' } })).meta
    await grantSession('s1', [b.id], [])
    const turns = [{ role: 'assistant', text: 'ok sk-MARKER-123456', tools: [{ name: 'Bash', detail: 'echo sk-MARKER-123456', output: Buffer.from('sk-MARKER-123456').toString('base64') }] }]
    const out = await scrubDeep('s1', turns)
    expect(JSON.stringify(out)).not.toContain('MARKER')
    expect(JSON.stringify(out)).toContain('«vault:OpenAI»')
    expect(await scrubDeep('s2', turns)).toBe(turns)
    expect(scrubTerminalLine('s1', 'key=sk-MARKER-123456')).toBe('key=«vault:OpenAI»')
    // a value an SGR sequence splits is caught on the de-coloured line
    expect(scrubTerminalLine('s1', 'key=sk-MARK\x1b[31mER-123456\x1b[0m')).toBe('key=«vault:OpenAI»')
    expect(scrubTerminalLine('s2', 'key=sk-MARKER-123456')).toBe('key=sk-MARKER-123456')
  })
})

describe('the vault.sock ops a hook calls (§8.3)', () => {
  test('personal-ref gives a GRANTED session its value and audits the use; another session is refused; scrub replaces', async () => {
    const { handleVaultOp } = await import('./ops')
    const { becomeVaultHolder, vaultDir } = await import('./service')
    const { readFileSync } = await import('node:fs')
    becomeVaultHolder()
    const b = (await createItem({ kind: 'api-key', name: 'OpenAI', fields: { value: 'sk-MARKER-777777' } })).meta
    await grantSession('s1', [b.id], [])
    const op = (header: Record<string, unknown>) => handleVaultOp({ header: header as never, body: null, emit() {}, closed: new Promise(() => {}) })
    expect((await op({ op: 'personal-refs', managedId: 's1' })).reply).toMatchObject({ ok: true, refs: ['vault://openai'] })
    expect((await op({ op: 'personal-ref', managedId: 's1', ref: 'vault://openai' })).reply).toMatchObject({ ok: true, value: 'sk-MARKER-777777' })
    expect((await op({ op: 'personal-ref', managedId: 's2', ref: 'vault://openai' })).reply).toMatchObject({ ok: false, code: 'not-granted' })
    expect((await op({ op: 'personal-scrub', managedId: 's1', text: 'k=sk-MARKER-777777' })).reply).toMatchObject({ ok: true, changed: true, text: 'k=«vault:OpenAI»' })
    const audit = readFileSync(`${vaultDir()}/audit.jsonl`, 'utf8')
    expect(audit).toContain('vault.personal-use')
    expect(audit).not.toContain('MARKER')
  })

  test('agent ref resolutions do not renew auto-lock, while human activity does', async () => {
    const { handleVaultOp } = await import('./ops')
    const b = (await createItem({ kind: 'api-key', name: 'OpenAI', fields: { value: 'sk-MARKER-clock' } })).meta
    await grantSession('clock-session', [b.id], [])
    const initial = autoLockRemainingMs()!
    for (let i = 0; i < 3; i++) {
      testNow += 60_000
      const r = await handleVaultOp({ header: { op: 'personal-ref', managedId: 'clock-session', ref: 'vault://openai' }, body: null, emit() {}, closed: new Promise(() => {}) })
      expect(r.reply.ok).toBe(true)
    }
    expect(autoLockRemainingMs()).toBe(initial - 3 * 60_000)
    for (const op of ['personal-refs', 'personal-scrub', 'github-config', 'prefs-tokens', 'vault-bundle']) {
      testNow += 1_000
      await handleVaultOp({ header: { op, managedId: 'clock-session', ref: 'vault://openai' }, body: null, emit() {}, closed: new Promise(() => {}) })
    }
    expect(autoLockRemainingMs()).toBe(initial - 3 * 60_000 - 5_000)
    noteVaultActivity()
    expect(autoLockRemainingMs()).toBe(30 * 60_000)
  })
})

describe('engine-api 1.7 vaultRefs (native sessions)', () => {
  test('keys are namespaced: a native session reads only a `native:` grant, never a CLI session\'s', async () => {
    const { nativeVaultRefs } = await import('./grants')
    const b = (await createItem({ kind: 'api-key', name: 'OpenAI', fields: { value: 'sk-MARKER-888888' } })).meta
    await grantSession('rt1', [b.id], [])            // a CLI (managed) session named rt1
    expect(await nativeVaultRefs.env('rt1')).toEqual({})
    await grantSession('native:rt1', [b.id], [])
    expect(await nativeVaultRefs.env('rt1')).toEqual({ VAULT_OPENAI: 'sk-MARKER-888888' })
    expect(await nativeVaultRefs.scrub('rt1', 'k=sk-MARKER-888888')).toBe('k=«vault:OpenAI»')
    expect(await nativeVaultRefs.scrub('other', 'k=sk-MARKER-888888')).toBe('k=sk-MARKER-888888')
  })
})

describe('VAULT.V4 confirm each use', () => {
  test('creates one request per reference and approval opens a short window', async () => {
    const b = (await createItem({ kind: 'login', name: 'Panel', fields: { login: 'user', password: 'MARKER-v4' } })).meta
    await grantSession('v4', [b.id], [])
    __setConfirmEachUseForTests(true)
    const waiting = authorizeUse('v4', 'vault://panel/login', { command: 'echo $VAULT_PANEL_LOGIN', harness: 'codex' })
    // the request is registered asynchronously; under a loaded full suite one tick is not enough
    for (let i = 0; i < 200 && pendingUseRequests().length === 0; i++) await new Promise(r => setTimeout(r, 10))
    const [req] = pendingUseRequests()
    expect(req?.field).toBe('login')
    expect(req?.flags).toEqual([])
    expect(decideUse(req!.id, true).ok).toBe(true)
    expect(await waiting).toEqual({ ok: true, value: 'user' })
    expect(await authorizeUse('v4', 'vault://panel/login', { command: null, harness: 'codex' })).toEqual({ ok: true, value: 'user' })
  })

  test('denial revokes only the requested field; legacy flag remains unchanged', async () => {
    const b = (await createItem({ kind: 'login', name: 'Panel', fields: { login: 'user', password: 'MARKER-v4' } })).meta
    await grantSession('v4', [b.id], [])
    __setConfirmEachUseForTests(true)
    const denied = authorizeUse('v4', 'vault://panel/password', { command: 'curl https://example.invalid', harness: 'claude' })
    for (let i = 0; i < 200 && pendingUseRequests().length === 0; i++) await new Promise(r => setTimeout(r, 10)); const req = pendingUseRequests()[0]!
    decideUse(req.id, false)
    const denial = await denied
    expect(denial.ok ? 'ok' : denial.code).toBe('use-denied')
    expect(grantOf('v4')?.refs.map(r => r.field)).toEqual(['login'])
  })
})
