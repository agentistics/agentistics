import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryProtector } from '@agentistics/vault'
import { __resetVaultForTests, __setVaultClockForTests, autoLockRemainingMs, ensureVaultOpen, lockVault, noteVaultActivity, sealToFile } from './service'
import { __resetPersonalForTests, createGroup, createItem } from './personal'
import { __setGrantMarkerDirForTests, __setConfirmEachUseForTests, __setUseTtlForTests, __resetGrantsForTests, authorizeUse, decideUse, grantBriefing, grantOf, grantSession, nativeVaultRefs, pendingUseRequests, refKey, revokeGrant, scrubDeep, scrubTerminalLine, VAULT_REF_INSTRUCTION } from './grants'

let testNow = 1_800_000_000_000
let markerDir = ''

afterEach(() => { __setConfirmEachUseForTests(false) })

beforeEach(async () => {
  testNow = 1_800_000_000_000
  const dir = await mkdtemp(join(tmpdir(), 'agentistics-grants-'))
  const mem = memoryProtector()
  __resetVaultForTests({ dir: join(dir, 'vault'), lang: 'en', protectors: [mem], autoInit: { candidates: [mem] } })
  __setVaultClockForTests(() => testNow)
  __resetPersonalForTests(); __resetGrantsForTests()
  __setGrantMarkerDirForTests(join(dir, 'run'))
  markerDir = join(dir, 'run')
  await sealToFile(join(dir, 'x.sealed'), 'github-backup', 'github-backup', new TextEncoder().encode('x'))
  expect(await ensureVaultOpen()).not.toBeNull()
})

/** The values a session's grant opens, through the sole gate (flag OFF in these tests). */
const grantEnv = async (sid: string) => {
  const out: Record<string, string> = {}
  for (const r of grantOf(sid)?.refs ?? []) { const v = await authorizeUse(sid, r.ref, { command: null, harness: 'test' }); if (v.ok) out[r.env] = v.value }
  return out
}

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

  test('personal-scrub is limited to 60 calls a minute per session and then holds the output back', async () => {
    const { handleVaultOp } = await import('./ops')
    const { becomeVaultHolder } = await import('./service')
    becomeVaultHolder()
    const op = (header: Record<string, unknown>) => handleVaultOp({ header: header as never, body: null, emit() {}, closed: new Promise(() => {}) })
    const it = (await createItem({ kind: 'api-key', name: 'Lim', fields: { value: 'sk-LIM-MARKER' } })).meta
    await grantSession('lim', [it.id], [])
    let last: unknown
    for (let i = 0; i < 60; i++) last = (await op({ op: 'personal-scrub', managedId: 'lim', text: 'plain' })).reply
    expect(last).toMatchObject({ ok: true })
    const over = (await op({ op: 'personal-scrub', managedId: 'lim', text: 'plain' })).reply as Record<string, unknown>
    expect(over).toMatchObject({ ok: true, changed: true })
    expect(JSON.parse(String(over.text))).toContain('held back by the vault')
    expect(String(over.text)).not.toContain('plain')
    // end to end through the hook's own answer: call 61 never reaches the model raw
    const { postToolAnswer } = await import('./hook-rewrite')
    const ans = postToolAnswer({ stdout: 'key=sk-SECRET-MARKER' }, String(over.text), over.changed === true)
    expect(ans).not.toBeNull()
    expect(ans).not.toContain('SECRET-MARKER')
    expect(ans).toContain('held back by the vault')
    // another session is not affected
    expect((await op({ op: 'personal-scrub', managedId: 'other', text: 'plain' })).reply).toMatchObject({ ok: true })
  })

  test('a session that never had a grant is neither counted nor limited by the scrub rate limit', async () => {
    const { handleVaultOp } = await import('./ops')
    const { becomeVaultHolder } = await import('./service')
    becomeVaultHolder()
    let last: Record<string, unknown> = {}
    for (let i = 0; i < 100; i++) last = (await handleVaultOp({ header: { op: 'personal-scrub', managedId: 'nogrant', text: 'plain' } as never, body: null, emit() {}, closed: new Promise(() => {}) })).reply as Record<string, unknown>
    expect(last).toMatchObject({ ok: true, changed: false })
  })

  test('granting leaves a value-free marker the hook can read with the server down', async () => {
    const { existsSync, readFileSync } = await import('node:fs')
    const { grantMarkerName } = await import('./hook-rewrite')
    const b = (await createItem({ kind: 'api-key', name: 'M', fields: { value: 'sk-M-MARKER' } })).meta
    expect(existsSync(join(markerDir, grantMarkerName('mk')))).toBe(false)
    await grantSession('mk', [b.id], [])
    expect(existsSync(join(markerDir, grantMarkerName('mk')))).toBe(true)
    expect(readFileSync(join(markerDir, grantMarkerName('mk')), 'utf8')).toBe('')
    expect(existsSync(join(markerDir, grantMarkerName('other')))).toBe(false)
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
    expect(await nativeVaultRefs.env('rt1')).toEqual({})
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

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms))
async function pendingCount(n: number): Promise<void> { for (let i = 0; i < 300 && pendingUseRequests().length < n; i++) await tick() }
const ctx = { command: null as string | null, harness: 'codex' }
const auditText = async () => { const { vaultDir } = await import('./service'); const { readFileSync, existsSync } = await import('node:fs'); const f = `${vaultDir()}/audit.jsonl`; return existsSync(f) ? readFileSync(f, 'utf8') : '' }

describe('VAULT.V4 confirm each use — behaviour (fake clock, fixture vault)', () => {
  beforeEach(() => { __resetGrantsForTests(() => testNow) })

  test('flag OFF: a use opens at once — no request, no pending, no "asked" entry', async () => {
    const b = (await createItem({ kind: 'api-key', name: 'OpenAI', fields: { value: 'MARKER-off' } })).meta
    await grantSession('s1', [b.id], [])
    expect(await authorizeUse('s1', 'vault://openai', ctx)).toEqual({ ok: true, value: 'MARKER-off' })
    expect(pendingUseRequests()).toEqual([])
    expect(await auditText()).not.toContain('personal-use-asked')
  })

  test('legacy native env: OFF opens every granted value; ON never opens a confirmable one (only "no confirm" items)', async () => {
    const a = (await createItem({ kind: 'api-key', name: 'Sensitive', fields: { value: 'MARKER-sens' } })).meta
    const f = (await createItem({ kind: 'api-key', name: 'Free', confirmEach: false, fields: { value: 'MARKER-free' } })).meta
    await grantSession('native:n1', [a.id, f.id], [])
    expect(await nativeVaultRefs.env('n1')).toEqual({ VAULT_FREE: 'MARKER-free' })
    __setConfirmEachUseForTests(true)
    expect(await nativeVaultRefs.env('n1')).toEqual({ VAULT_FREE: 'MARKER-free' })
  })

  test('native use decides only cited refs and reports unknown refs without opening them', async () => {
    const a = (await createItem({ kind: 'api-key', name: 'Sensitive', fields: { value: 'MARKER-use' } })).meta
    const b = (await createItem({ kind: 'api-key', name: 'Free', confirmEach: false, fields: { value: 'MARKER-free-use' } })).meta
    await grantSession('native:n1', [a.id, b.id], [])
    __setConfirmEachUseForTests(true)
    const free = await nativeVaultRefs.use('n1', ['vault://free', 'vault://missing'], { command: 'echo $VAULT_FREE', callId: 'call-2' })
    expect(free.env).toEqual({})
    expect(free.refused.map(r => r.ref)).toEqual(['vault://missing'])
    expect(free.refused[0]!.sentence).toContain('vault://missing')
  })

  test('native use handles empty, duplicate and case-sensitive reference lists', async () => {
    const a = (await createItem({ kind: 'api-key', name: 'Free', confirmEach: false, fields: { value: 'MARKER-list' } })).meta
    await grantSession('native:n1', [a.id], [])
    expect(await nativeVaultRefs.use('n1', [], { command: 'true', callId: 'empty' })).toEqual({ env: {}, refused: [] })
    expect(await nativeVaultRefs.use('n1', ['vault://free', 'vault://free'], { command: 'true', callId: 'dup' })).toEqual({
      env: { VAULT_FREE: 'MARKER-list' }, refused: [],
    })
    const wrongCase = await nativeVaultRefs.use('n1', ['VAULT://FREE'], { command: 'true', callId: 'case' })
    expect(wrongCase.env).toEqual({})
    expect(wrongCase.refused[0]!.sentence).toContain('VAULT://FREE')
  })

  test('native use refuses the whole command when a grant is revoked while resolving', async () => {
    const a = (await createItem({ kind: 'api-key', name: 'Race', confirmEach: false, fields: { value: 'MARKER-race' } })).meta
    await grantSession('native:n1', [a.id], [])
    const use = nativeVaultRefs.use('n1', ['vault://race'], { command: 'true', callId: 'race' })
    expect(revokeGrant('native:n1')).toBe(true)
    const result = await use
    expect(result.env).toEqual({})
    expect(result.refused[0]!.sentence).toContain('Race')
    expect(JSON.stringify(result)).not.toContain('MARKER-race')
  })

  test('denying a native use removes the ref and notifies onRevoke using its display name', async () => {
    const a = (await createItem({ kind: 'api-key', name: 'Sensitive Name', fields: { value: 'MARKER-deny-native' } })).meta
    await grantSession('native:n1', [a.id], [])
    __setConfirmEachUseForTests(true)
    const seen: (string | '*')[] = []
    const off = nativeVaultRefs.onRevoke!(id => seen.push(id))
    const waiting = nativeVaultRefs.use('n1', ['vault://sensitive-name'], { command: 'true', callId: 'deny-native' })
    await pendingCount(1)
    expect(decideUse(pendingUseRequests()[0]!.id, false).ok).toBe(true)
    const result = await waiting
    off()
    expect(result.env).toEqual({})
    expect(result.refused[0]!.sentence).toContain('Sensitive Name')
    expect(seen).toEqual(['n1'])
    expect(grantOf('native:n1')?.refs).toEqual([])
  })

  test('native use opens an approved confirmable ref and revoke notifications cover revoke and lock', async () => {
    const a = (await createItem({ kind: 'api-key', name: 'Sensitive', fields: { value: 'MARKER-approved-use' } })).meta
    await grantSession('native:n1', [a.id], [])
    __setConfirmEachUseForTests(true)
    const waiting = nativeVaultRefs.use('n1', ['vault://sensitive'], { command: 'echo $VAULT_SENSITIVE', callId: 'call-3' })
    await pendingCount(1)
    expect(decideUse(pendingUseRequests()[0]!.id, true).ok).toBe(true)
    expect(await waiting).toEqual({ env: { VAULT_SENSITIVE: 'MARKER-approved-use' }, refused: [] })
    const seen: (string | '*')[] = []
    const off = nativeVaultRefs.onRevoke!(sessionId => seen.push(sessionId))
    expect(revokeGrant('native:n1')).toBe(true)
    await grantSession('native:n1', [a.id], [])
    lockVault('user')
    off()
    expect(seen).toEqual(['n1', '*'])
  })

  test('a "no confirm" item skips the request even with the flag ON', async () => {
    const f = (await createItem({ kind: 'api-key', name: 'Free', confirmEach: false, fields: { value: 'MARKER-free' } })).meta
    await grantSession('s1', [f.id], [])
    __setConfirmEachUseForTests(true)
    expect(await authorizeUse('s1', 'vault://free', ctx)).toEqual({ ok: true, value: 'MARKER-free' })
    expect(pendingUseRequests()).toEqual([])
  })

  test('timeout: the wait ends refused (use-pending), the value never leaves, a late approval is refused', async () => {
    const b = (await createItem({ kind: 'api-key', name: 'OpenAI', fields: { value: 'MARKER-timeout' } })).meta
    await grantSession('s1', [b.id], [])
    __setConfirmEachUseForTests(true); __setUseTtlForTests(40)
    const waiting = authorizeUse('s1', 'vault://openai', ctx)
    await pendingCount(1)
    const id = pendingUseRequests()[0]!.id
    testNow += 91_000 // the vault's clock moves past the deadline too
    const r = await waiting
    expect(r).toEqual({ ok: false, code: 'use-pending' })
    expect(JSON.stringify(r)).not.toContain('MARKER')
    expect(pendingUseRequests()).toEqual([])
    expect(decideUse(id, true)).toEqual({ ok: false, code: 'use-not-pending' })
    const audit = await auditText()
    expect(audit).toContain('personal-use-expired')
    expect(audit).not.toContain('personal-use-approved')
    expect(audit).not.toContain('MARKER')
  })

  test('lock during a pending request: the wait is cancelled, the request dies with the epoch, nothing is opened', async () => {
    const b = (await createItem({ kind: 'api-key', name: 'OpenAI', fields: { value: 'MARKER-lock' } })).meta
    await grantSession('s1', [b.id], [])
    __setConfirmEachUseForTests(true)
    const waiting = authorizeUse('s1', 'vault://openai', ctx)
    await pendingCount(1)
    const id = pendingUseRequests()[0]!.id
    lockVault('user')
    expect(await waiting).toEqual({ ok: false, code: 'use-pending' })
    expect(pendingUseRequests()).toEqual([])
    expect(decideUse(id, true)).toMatchObject({ ok: false })
    expect(grantOf('s1')).toBeNull()
    expect(await authorizeUse('s1', 'vault://openai', ctx)).toEqual({ ok: false, code: 'not-granted' })
    expect(await auditText()).toContain('personal-use-cancelled')
  })

  test('pending limit: at most 3 per session — the 4th reference is refused at once with use-busy', async () => {
    const ids: string[] = []
    for (const n of ['A', 'B', 'C', 'D']) ids.push((await createItem({ kind: 'api-key', name: `Key ${n}`, fields: { value: `MARKER-${n}` } })).meta.id)
    await grantSession('s1', ids, [])
    __setConfirmEachUseForTests(true)
    const first = ['a', 'b', 'c'].map(n => authorizeUse('s1', `vault://key-${n}`, ctx))
    await pendingCount(3)
    expect(await authorizeUse('s1', 'vault://key-d', ctx)).toEqual({ ok: false, code: 'use-busy' })
    expect(pendingUseRequests()).toHaveLength(3)
    for (const r of pendingUseRequests()) decideUse(r.id, false)
    await Promise.all(first)
  })

  test('concurrent calls for the same reference share ONE request (count), and one approval releases all of them', async () => {
    const b = (await createItem({ kind: 'api-key', name: 'OpenAI', fields: { value: 'MARKER-conc' } })).meta
    await grantSession('s1', [b.id], [])
    __setConfirmEachUseForTests(true)
    const calls = [1, 2, 3].map(() => authorizeUse('s1', 'vault://openai', ctx))
    await pendingCount(1); await tick(50)
    const list = pendingUseRequests()
    expect(list).toHaveLength(1)
    expect(list[0]!.count).toBe(3)
    expect(decideUse(list[0]!.id, true)).toEqual({ ok: true })
    expect(await Promise.all(calls)).toEqual([{ ok: true, value: 'MARKER-conc' }, { ok: true, value: 'MARKER-conc' }, { ok: true, value: 'MARKER-conc' }])
    const audit = await auditText()
    expect(audit.match(/personal-use-asked/g)).toHaveLength(1)
    expect(audit).not.toContain('MARKER')
  })

  test('denial answers use-denied and the request payload carries no value', async () => {
    const b = (await createItem({ kind: 'api-key', name: 'OpenAI', fields: { value: 'MARKER-deny' } })).meta
    await grantSession('s1', [b.id], [])
    __setConfirmEachUseForTests(true)
    const w = authorizeUse('s1', 'vault://openai', { command: 'echo \u202e hi\u0007', harness: 'claude' })
    await pendingCount(1)
    const [req] = pendingUseRequests()
    expect(JSON.stringify(req, (_k, v) => (v instanceof Set ? [...v] : v))).not.toContain('MARKER')
    expect(req!.command).toBe('echo  hi')
    decideUse(req!.id, false)
    expect(await w).toEqual({ ok: false, code: 'use-denied' })
    expect(await auditText()).not.toContain('MARKER')
  })
})
