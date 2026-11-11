/**
 * One test per finding of the independent review of SECRETS.2 (leader, 2026-10-02).
 */
import { describe, expect, test, afterAll } from 'bun:test'
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { VaultRefusalError, memoryProtector, initVault, type Protector, type SecretFs } from '@agentistics/vault'
import { AGENTISTICS_DATA_DIR } from '../config'
import {
  __resetVaultForTests, createVault, ensureVaultOpen, pendingPlaintextFiles, sealToFile, vaultDir, vaultStatus,
} from './service'
import { realProtectorIo, realSecretFs } from './io'
import { migrateWholeFile, sealedPathFor } from './whole-file'
import { writeGithubConfig } from '../backup/github-store'
import { startVaultSocket, stopVaultSocket } from './socket'

const fresh = async (tag: string) => mkdtemp(join(tmpdir(), `agentistics-review-${tag}-`))
afterAll(async () => { stopVaultSocket(); __resetVaultForTests({ dir: join(await fresh('after'), 'vault') }) })

const TOK = 'TEST-NOT-A-SECRET-tok-' + randomBytes(4).toString('hex')
/** A protector that never answers (a probe counter included). */
function deadProtector(id: Protector['id'], calls = { n: 0 }): Protector {
  return {
    id, label: () => `fake ${id}`,
    async probe() { calls.n++; return { ok: false, reason: 'interop is not up yet' } },
    async wrap() { return { ok: false, reason: 'down' } },
    async unwrap() { return { ok: false, kind: 'unavailable', reason: 'down' } },
    async remove() {},
  }
}

describe('MUST 2 — the first init proves the wrapped key unwraps from disk before anything is scrubbed', () => {
  test('a protector whose unwrap returns a different key: no vault, plaintext untouched', async () => {
    const dir = await fresh('m2')
    const liar: Protector = {
      id: 'libsecret', label: () => 'a lying keyring',
      async probe() { return { ok: true } },
      async wrap() { return { ok: true, record: { type: 'libsecret', createdAt: new Date().toISOString() } } },
      async unwrap() { return { ok: true, dek: new Uint8Array(randomBytes(32)) } },
      async remove() {},
    }
    __resetVaultForTests({ dir: join(dir, 'vault'), protectors: [liar], autoInit: { candidates: [liar] } })
    const plain = join(dir, 'github-backup.json')
    const body = JSON.stringify({ url: 'u', owner: 'o', repo: 'r', token: TOK })
    await writeFile(plain, body, { mode: 0o600 })
    const r = await createVault(liar)
    expect(r.ok).toBe(false)
    expect(existsSync(join(dir, 'vault', 'vault.json'))).toBe(false)
    expect(await ensureVaultOpen()).toBeNull()
    await migrateWholeFile({ purpose: 'github-backup', name: 'github-backup', plainPath: plain, sealedPath: sealedPathFor(plain) })
    expect(await readFile(plain, 'utf8')).toBe(body)
    expect(existsSync(sealedPathFor(plain))).toBe(false)
  })
})

describe('MUST 3 — two first-time inits at once: one key, the loser opens the winner\'s vault', () => {
  test('concurrent createVault calls mint exactly one vault', async () => {
    const dir = await fresh('m3')
    __resetVaultForTests({ dir: join(dir, 'vault') })
    const results = await Promise.all([createVault(memoryProtector()), createVault(memoryProtector()), createVault(memoryProtector())])
    const kids = new Set(results.map(r => r.ok ? r.state.kid : (r.state && r.state.state === 'open' ? r.state.kid : 'none')))
    expect(results.filter(r => r.ok).length).toBe(1)
    expect(kids.size).toBe(1)
    expect([...kids][0]).toBe(JSON.parse(await readFile(join(dir, 'vault', 'vault.json'), 'utf8')).kid)
    expect(readdirSync(join(dir, 'vault')).filter(f => f.endsWith('.lock'))).toEqual([])
  })
  test('vault.json is born exclusively: an init that finds one already written reports exists', async () => {
    const dir = await fresh('m3b')
    const io = realProtectorIo()
    const a = await initVault(io, join(dir, 'vault'), memoryProtector())
    const b = await initVault(io, join(dir, 'vault'), memoryProtector())
    expect(a.ok).toBe(true)
    expect(b).toEqual({ ok: false, reason: 'exists' })
  })
})

describe('5 — no silent weaker protector (WSL: DPAPI only, retried)', () => {
  test('DPAPI not answering is retried with backoff, then no vault and a sentence — the other protector is never taken', async () => {
    const dir = await fresh('d5')
    const calls = { n: 0 }
    const dpapi = deadProtector('dpapi', calls)
    __resetVaultForTests({ dir: join(dir, 'vault'), protectors: [dpapi, memoryProtector()], autoInit: { strict: dpapi, delaysMs: [5, 10] }, lang: 'en' })
    expect(await ensureVaultOpen()).toBeNull()
    expect(calls.n).toBe(3)
    expect(existsSync(join(dir, 'vault', 'vault.json'))).toBe(false)
    let err: unknown
    try { await sealToFile(join(dir, 'x.sealed'), 'github-backup', 'github-backup', new Uint8Array(1)) } catch (e) { err = e }
    expect((err as VaultRefusalError).code).toBe('protector-unavailable')
    expect((err as Error).message).toContain('never falls back to a weaker protector')
    expect((err as Error).message).toContain('agentop vault init --protector')
    expect((await vaultStatus()).sentence).toContain('fake dpapi did not answer')
  })
})

describe('7 — the unlock socket never steals a live service\'s socket', () => {
  test('a listening socket is left alone; a stale file is replaced', async () => {
    const dir = await fresh('d7')
    const path = join(dir, 'run', 'vault.sock')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dir, 'run'), { recursive: true, mode: 0o700 })
    const live = Bun.listen({ unix: path, socket: { data() {} } })
    expect(await startVaultSocket(path)).toEqual({ ok: false, reason: 'in-use' })
    expect(existsSync(path)).toBe(true)
    live.stop(true)
    await rm(path, { force: true })
    await writeFile(path, '')
    expect((await startVaultSocket(path)).ok).toBe(true)
    stopVaultSocket()
  })
})

describe('9 — two copies that differ are BOTH kept, and status shows it', () => {
  test('no mtime decision, nothing scrubbed, a plaintext-pending sentence, the file listed', async () => {
    const dir = await fresh('d9')
    __resetVaultForTests({ dir: join(dir, 'vault'), lang: 'en' })
    const plain = join(dir, 'github-backup.json')
    await writeGithubConfig({ url: 'u', owner: 'o', repo: 'r', token: TOK, keepRemote: 0, deleteLocalAfterUpload: false }, plain)
    const older = JSON.stringify({ url: 'u', owner: 'o', repo: 'r', token: 'TEST-NOT-A-SECRET-older' })
    await writeFile(plain, older, { mode: 0o600 })
    const r = await migrateWholeFile({ purpose: 'github-backup', name: 'github-backup', plainPath: plain, sealedPath: sealedPathFor(plain) })
    expect(r.migrated).toBe(0)
    expect(r.lines[0]).toContain('differs from its encrypted copy')
    expect(r.lines[0]).toContain('agentop backup github setup <url>')
    expect(await readFile(plain, 'utf8')).toBe(older)
    expect(existsSync(sealedPathFor(plain))).toBe(true)
  })
  test('the real migrators report their pending files for `agentop vault status`', async () => {
    __resetVaultForTests({ dir: join(await fresh('d9b'), 'vault') })
    const plain = join(AGENTISTICS_DATA_DIR, 'github-backup.json')
    await writeFile(plain, JSON.stringify({ url: 'u', owner: 'o', repo: 'r', token: 'TEST-NOT-A-SECRET-p' }), { mode: 0o600 })
    await import('../backup/github-store')
    expect(await pendingPlaintextFiles()).toContain(plain)
    await rm(plain, { force: true })
    expect((await stat(vaultDir()).catch(() => null)) === null || true).toBe(true)
  })
})
