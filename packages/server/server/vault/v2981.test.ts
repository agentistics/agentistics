/**
 * v2.98.1 — the vault fixes from the owner's real use of v2.98.0 (board t-afdb361ae7):
 *  1. adding a second presence kind broke the flow (the security key failed with an internal English
 *     sentence on Windows; re-running Hello failed with "a credential with this name already exists");
 *  3. everything through the UI: a page ON this computer (loopback) proves the person with ONE gesture
 *     instead of the terminal's setup code, recovers with the 24 words, and is never told to run a command.
 * Fake protectors and a fake clock; nothing is spawned and nothing under ~/.agentistics is touched.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { base32Decode, hotp, parseVaultJson, presenceSentence, type Protector, type ProtectorId, type UnwrapResult } from '@agentistics/vault'
import { __resetVaultForTests, __setVaultClockForTests, becomeVaultHolder, lockVault, sealToFile, vaultDir, vaultStatus } from './service'
import { __resetGateForTests, mintSetupCode } from './gate'
import { handleVaultHttp, loopbackRequest } from './http'
import { COMMAND_RE, uiReply, uiSentence } from './ui-sentence'

const STORE = new Map<string, Uint8Array>()
type Fake = Protector & { gestures: number; wraps: number; proofs: number }
function fake(id: ProtectorId, opts: { probeReason?: string } = {}): Fake {
  const self: Fake = {
    id, gestures: 0, wraps: 0, proofs: 0,
    label: () => `${id} (fake)`,
    async probe() { return opts.probeReason ? { ok: false as const, reason: opts.probeReason } : { ok: true as const } },
    async wrap(dek: Uint8Array, kid: string) { self.wraps++; STORE.set(`${id}:${kid}`, new Uint8Array(dek)); return { ok: true as const, record: { type: id, createdAt: '2026-10-02T00:00:00.000Z' } } },
    async unwrap(_r: unknown, kid: string): Promise<UnwrapResult> {
      if (id === 'hello' || id === 'fido2') self.gestures++
      const d = STORE.get(`${id}:${kid}`)
      return d ? { ok: true, dek: new Uint8Array(d) } : { ok: false, kind: 'missing', reason: 'presence-lost: credential-deleted' }
    },
    async remove(_r: unknown, kid: string) { STORE.delete(`${id}:${kid}`) },
    ...(id === 'hello' || id === 'fido2' ? { async proveHuman() { self.proofs++; return { ok: true as const } } } : {}),
  }
  return self
}

let T = 1_800_000_000_000
const clock = () => T
let seed: Uint8Array
const codeAt = () => hotp(seed, Math.floor(T / 1000 / 30))
const next = () => { T += 30_000 }

let dir = ''
let dpapi = fake('dpapi'), hello = fake('hello'), fido2 = fake('fido2')
function restart(opts: { soon?: ProtectorId[]; lang?: 'en' | 'pt' } = {}): void {
  __resetVaultForTests({ dir: join(dir, 'vault'), lang: opts.lang ?? 'en', protectors: [dpapi, hello, fido2], autoInit: { candidates: [dpapi] }, presenceSoon: opts.soon ?? [] })
  __setVaultClockForTests(clock)
  __resetGateForTests(clock)
}

type J = Record<string, any>
const LOCAL = { host: 'localhost:47292', origin: 'http://localhost:47292', peer: '127.0.0.1' }
const LAN = { host: '192.168.0.10:47292', origin: 'http://192.168.0.10:47292', peer: '192.168.0.20' }
async function http(method: 'GET' | 'POST', path: string, body?: unknown, where: { host: string; origin: string; peer: string } = LOCAL): Promise<{ status: number; json: J }> {
  const headers: Record<string, string> = { host: where.host, 'sec-fetch-site': 'same-origin', ...(method === 'POST' ? { 'content-type': 'application/json', origin: where.origin } : {}) }
  const req = new Request(`http://${where.host}${path}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) })
  const res = await handleVaultHttp(req, new URL(req.url), { cors: {}, session: 'local', peer: where.peer })
  if (!res) return { status: 404, json: {} }
  const text = await res.text()
  return { status: res.status, json: text.startsWith('{') ? JSON.parse(text) : {} }
}

async function fresh(opts: { soon?: ProtectorId[]; lang?: 'en' | 'pt' } = {}): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), 'agentistics-v2981-'))
  STORE.clear()
  dpapi = fake('dpapi'); hello = fake('hello'); fido2 = fake('fido2')
  T = 1_800_000_000_000
  restart(opts)
  await sealToFile(join(dir, 'gh.sealed'), 'github-backup', 'github-backup', new TextEncoder().encode('TEST-NOT-A-SECRET'))
}

/** The whole wizard from a LOCAL page: gesture → authenticator → presence → recovery. Returns the 24 words. */
async function enrolLocally(): Promise<string[]> {
  expect((await http('POST', '/api/vault/local-proof')).json).toMatchObject({ ok: true, kind: 'hello' })
  const a = await http('POST', '/api/vault/authenticator/begin', {})
  expect(a.status).toBe(200)
  seed = base32Decode(a.json.secret)
  expect((await http('POST', '/api/vault/authenticator/confirm', { code: codeAt() })).status).toBe(200)
  next()
  expect((await http('POST', '/api/vault/presence/enroll', { protector: 'hello', code: codeAt() })).status).toBe(200)
  next()
  const r = await http('POST', '/api/vault/recovery/begin', {})
  const typed = (r.json.positions as number[]).map(p => (r.json.words as string[])[p - 1]!)
  expect((await http('POST', '/api/vault/recovery/confirm', { typed })).status).toBe(200)
  next()
  return r.json.words as string[]
}

afterAll(async () => { __resetVaultForTests({ dir: join(await mkdtemp(join(tmpdir(), 'agentistics-v2981-done-')), 'vault') }) })
beforeEach(async () => { await fresh() })

describe('loopbackRequest — a page ON this computer, and nothing else', () => {
  const h = (o: Record<string, string>) => ({ headers: new Headers(o) })
  test('peer, Host and Origin all loopback', () => {
    expect(loopbackRequest(h({ host: 'localhost:47292', origin: 'http://localhost:47292' }), '127.0.0.1', { requireOrigin: true })).toBe(true)
    expect(loopbackRequest(h({ host: '127.0.0.1:47291', origin: 'http://127.0.0.1:47291' }), '::ffff:127.0.0.1', { requireOrigin: true })).toBe(true)
    expect(loopbackRequest(h({ host: '[::1]:47292', origin: 'http://[::1]:47292' }), '::1', { requireOrigin: true })).toBe(true)
  })
  test('the LAN, a tunnel, a relay, a hostile site and DNS rebinding are all refused', () => {
    expect(loopbackRequest(h({ host: 'localhost:47292', origin: 'http://localhost:47292' }), '192.168.0.20', { requireOrigin: true })).toBe(false) // LAN peer
    expect(loopbackRequest(h({ host: 'my.tunnel.example', origin: 'https://my.tunnel.example' }), '127.0.0.1', { requireOrigin: true })).toBe(false) // tunnel Host
    expect(loopbackRequest(h({ host: 'localhost:47292', origin: 'http://localhost:47292', 'x-forwarded-for': '203.0.113.9' }), '127.0.0.1', { requireOrigin: true })).toBe(false) // relay
    expect(loopbackRequest(h({ host: 'localhost:47292', origin: 'https://evil.example' }), '127.0.0.1', { requireOrigin: true })).toBe(false) // hostile page
    expect(loopbackRequest(h({ host: 'rebind.evil.example:47292', origin: 'http://rebind.evil.example:47292' }), '127.0.0.1', { requireOrigin: true })).toBe(false) // rebinding
    expect(loopbackRequest(h({ host: 'localhost:47292' }), '127.0.0.1', { requireOrigin: true })).toBe(false) // an action needs the Origin
    expect(loopbackRequest(h({ host: 'localhost:47292' }), null, { requireOrigin: false })).toBe(false) // unknown peer
  })
})

describe('S2, v2.98.1: the FIRST enrolment from a loopback page is proven by ONE gesture, not the setup code', () => {
  test('without the gesture a loopback page still owes a proof; with it, no setup code is asked', async () => {
    const v = await http('GET', '/api/vault')
    expect(v.json).toMatchObject({ loopback: true, localProofKind: 'hello', setupCode: { owed: true } })
    expect((await http('POST', '/api/vault/authenticator/begin', {})).json.code).toBe('setup-code-required')
    const p = await http('POST', '/api/vault/local-proof')
    expect(p.json).toMatchObject({ ok: true, kind: 'hello' })
    expect(hello.proofs).toBe(1)
    expect((await http('GET', '/api/vault')).json.setupCode.owed).toBe(false)
    expect((await http('POST', '/api/vault/authenticator/begin', {})).status).toBe(200)
  })
  test('the gesture is refused off loopback, and a loopback proof never stands for a LAN request', async () => {
    expect((await http('POST', '/api/vault/local-proof', {}, LAN)).json.code).toBe('not-loopback')
    expect(hello.proofs).toBe(0)
    expect((await http('GET', '/api/vault', undefined, LAN)).json).toMatchObject({ loopback: false, localProofKind: null })
    await http('POST', '/api/vault/local-proof')
    expect((await http('POST', '/api/vault/authenticator/begin', {}, LAN)).json.code).toBe('setup-code-required')
    // …where the terminal's setup code still works (the fallback).
    expect((await http('POST', '/api/vault/authenticator/begin', { setupCode: mintSetupCode().code }, LAN)).status).toBe(200)
  })
  test('a machine with no presence device keeps the setup code, said in words', async () => {
    __resetVaultForTests({ dir: join(dir, 'vault'), lang: 'en', protectors: [dpapi], autoInit: { candidates: [dpapi] } })
    __setVaultClockForTests(clock); __resetGateForTests(clock)
    expect((await http('GET', '/api/vault')).json.localProofKind).toBeNull()
    const r = await http('POST', '/api/vault/local-proof')
    expect(r.json.code).toBe('no-local-proof')
  })
  test('the proof expires with its 10 minutes', async () => {
    await http('POST', '/api/vault/local-proof')
    T += 11 * 60_000
    expect((await http('POST', '/api/vault/authenticator/begin', {})).json.code).toBe('setup-code-required')
  })
})

describe('1(a): a kind this platform has but cannot offer yet is "coming soon", never a failure', () => {
  test('fido2 is not offered on Windows/WSL; the view says it is coming soon; asking for it refuses in words', async () => {
    await fresh({ soon: ['fido2'], lang: 'pt' })
    const v = await http('GET', '/api/vault')
    expect(v.json.presenceAvailable).toEqual(['hello'])
    expect(v.json.presenceSoon).toEqual(['fido2'])
    for (const path of ['/api/vault/presence/probe', '/api/vault/presence/enroll']) {
      const r = await http('POST', path, { protector: 'fido2' })
      expect(r.json.code).toBe('presence-soon')
      expect(r.json.sentence).toContain('em breve')
      expect(r.json.sentence).not.toMatch(/webauthn|not verified|bridge/i)
    }
    expect(fido2.wraps + fido2.gestures).toBe(0)
  })
})

describe('1(b)/(c): presence already on — enrolling the SAME kind again changes nothing and never fails', () => {
  test('a second Hello enrolment answers ok, wraps nothing and keeps the vault as it was', async () => {
    await enrolLocally()
    const before = readFileSync(join(vaultDir(), 'vault.json'), 'utf8')
    const wraps = hello.wraps
    const r = await http('POST', '/api/vault/presence/enroll', { protector: 'hello', code: codeAt() })
    expect(r).toMatchObject({ status: 200, json: { ok: true, removed: [] } })
    expect(hello.wraps).toBe(wraps)
    expect(readFileSync(join(vaultDir(), 'vault.json'), 'utf8')).toBe(before)
  })
})

describe('1(d): no internal text ever reaches the page', () => {
  test('a protector reason that is not a closed key is never repeated (EN and PT)', async () => {
    for (const lang of ['en', 'pt'] as const) {
      hello = fake('hello', { probeReason: 'presence-unavailable: the Windows security-key bridge (webauthn.dll) is not verified on real hardware yet' })
      restart({ lang })
      await http('POST', '/api/vault/local-proof')
      const r = await http('POST', '/api/vault/presence/probe', { protector: 'hello' })
      expect(r.json.code).toBe('presence-unavailable')
      expect(r.json.sentence).not.toMatch(/webauthn|not verified|real hardware/i)
      expect(r.json.sentence).not.toMatch(COMMAND_RE)
    }
  })
  test('every presence sentence, through the page filter, names a control instead of a command', () => {
    for (const code of ['presence-cancelled', 'presence-timeout', 'presence-unavailable', 'presence-lost'] as const) {
      for (const lang of ['en', 'pt'] as const) {
        for (const reason of [code, `${code}: bridge-failed`, 'presence-lost: not-reproducible']) {
          const u = uiSentence(presenceSentence(code, lang, 'X', reason), lang)
          expect(u.sentence).not.toMatch(COMMAND_RE)
        }
      }
    }
    expect(uiSentence('If it is gone, run `agentop vault recover` with your 24 words.', 'en')).toEqual({ sentence: 'If it is gone, use "Recover with the 24 words", on this page.', action: 'recover' })
    expect(uiReply({ ok: false, code: 'presence-needs-recovery-words', sentence: 'x `agentop vault enroll --presence` y' }, 'pt').sentence).not.toContain('agentop')
  })

  /**
   * THE LINT: every JSON body /api/vault* sends leaves through ONE function that runs the page filter.
   * A route that builds its own `new Response(JSON.stringify(…))` bypasses it — and fails here.
   */
  test('http.ts has exactly one JSON exit, and it applies uiReply', () => {
    const src = readFileSync(join(import.meta.dir, 'http.ts'), 'utf8')
    expect(src.match(/new Response\(JSON\.stringify\(/g)?.length).toBe(1)
    expect(src).toMatch(/new Response\(JSON\.stringify\(uiReply\(/)
  })

  /**
   * Every terminal command a vault sentence can name has a page control — except the ones listed here,
   * each with its reason. A new sentence naming `agentop vault <verb>` fails until it is decided.
   */
  test('the commands vault sentences name are all mapped to a page control, or explicitly excepted', () => {
    const EXCEPT: Record<string, string> = {
      'setup-code': 'the deliberate fallback: a first setup from off this computer, or a machine with no presence device (§7b)',
      init: 'creating a vault: the service does it on its own at start; a page reaches the vault only once it exists',
      status: 'only inside "re-enter them with the commands … lists" for lost secrets; the page lists them itself',
      reset: 'destructive, terminal-only by design (review S3)',
      'add-passphrase': 'terminal-only setup for a machine with no OS protector',
    }
    const files = ['gate.ts', 'service.ts', '../../../vault/src/sentences.ts', '../../../vault/src/protectors/presence.ts']
    const seen = new Set<string>()
    for (const f of files) {
      const src = readFileSync(join(import.meta.dir, f), 'utf8')
      for (const m of src.matchAll(/`agentop vault ([a-z-]+)/g)) seen.add(m[1]!)
      for (const m of src.matchAll(/\\`agentop vault ([a-z-]+)/g)) seen.add(m[1]!)
    }
    expect(seen.size).toBeGreaterThan(3)
    for (const verb of seen) {
      if (EXCEPT[verb]) continue
      const out = uiSentence(`Run \`agentop vault ${verb}\`.`, 'en').sentence
      expect(out, verb).not.toContain('agentop')
    }
  })
})

describe('3(b): recovery with the 24 words from a page ON this computer', () => {
  test('off loopback the words are refused before they are read', async () => {
    const r = await http('POST', '/api/vault/recover', { words: 'abandon '.repeat(24).trim() }, LAN)
    expect(r.json.code).toBe('not-loopback')
    expect(r.json.sentence).not.toMatch(COMMAND_RE)
  })
  test('the right words open the vault in recovery mode, and the SAME loopback page may finish the re-enrolment', async () => {
    const words = await enrolLocally()
    becomeVaultHolder()
    lockVault('user')
    expect((await http('POST', '/api/vault/recover', { words: 'abandon '.repeat(24).trim() })).json.code).toMatch(/recovery-(words|denied)/)
    const ok = await http('POST', '/api/vault/recover', { words: words.join(' ') })
    expect(ok).toMatchObject({ status: 200, json: { ok: true } })
    expect(ok.json.todo).toContain('authenticator')
    expect((await vaultStatus()).state).toBe('open')
    // From the LAN the same session is refused (review M2: the channel is this computer).
    expect((await http('POST', '/api/vault/authenticator/begin', {}, LAN)).json.code).toBe('recovery-tty-only')
    // From the loopback page that recovered, the re-enrolment goes ahead.
    expect((await http('POST', '/api/vault/authenticator/begin', {})).status).toBe(200)
    expect(parseVaultJson(readFileSync(join(vaultDir(), 'vault.json')))).not.toBeNull()
  })
  test('five wrong tries pause the page recovery', async () => {
    await enrolLocally()
    becomeVaultHolder()
    lockVault('user')
    for (let i = 0; i < 5; i++) await http('POST', '/api/vault/recover', { words: 'abandon '.repeat(24).trim() })
    expect((await http('POST', '/api/vault/recover', { words: 'abandon '.repeat(24).trim() })).json.code).toBe('recover-paused')
  })
})

describe('the main machine: turning personal confirmation off with the 24 words from the loopback page', () => {
  test('wrong words are refused in words; off loopback the words are ignored', async () => {
    await enrolLocally()
    const { handleVaultOp } = await import('./ops')
    becomeVaultHolder()
    await handleVaultOp({ header: { op: 'require-presence' }, body: null, emit() {}, closed: new Promise(() => {}) })
    const lan = await http('POST', '/api/vault/presence/disable', { code: codeAt(), words: 'abandon '.repeat(24).trim() }, LAN)
    expect(lan.json.code).toBe('recovery-required')
    next()
    const local = await http('POST', '/api/vault/presence/disable', { code: codeAt(), words: 'abandon '.repeat(24).trim() })
    expect(local.json.code).toBe('recovery-denied')
  })
})
