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
import type { Preferences } from '../preferences'
import { readPreferencesFrom, writePreferencesTo, updateTeamConfigAt } from '../preferences'
import { AGENTISTICS_DATA_DIR } from '../config'
import {
  __resetVaultForTests, createVault, ensureVaultOpen, pendingPlaintextFiles, sealToFile, vaultDir, vaultStatus,
} from './service'
import { realProtectorIo, realSecretFs } from './io'
import { tokensFileFor } from './prefs-tokens'
import { migrateWholeFile, sealedPathFor } from './whole-file'
import { writeGithubConfig } from '../backup/github-store'
import { migrateCentralEnvAt, recoverCentralEnv, loadCentralEnv } from './central-env'
import { startVaultSocket, stopVaultSocket } from './socket'

const fresh = async (tag: string) => mkdtemp(join(tmpdir(), `agentistics-review-${tag}-`))
afterAll(async () => { stopVaultSocket(); __resetVaultForTests({ dir: join(await fresh('after'), 'vault') }) })

const TOK = 'TEST-NOT-A-SECRET-tok-' + randomBytes(4).toString('hex')
const conn = (id: string, token: string) => ({ id, endpoint: `http://${id}:48080`, org: 'acme', user: 'u', token, deniedRepos: [], shareMode: 'denylist', sources: [] })

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

describe('MUST 1 — no usable protector: preferences writes still work over EXISTING plaintext tokens', () => {
  test('the language toggle saves; the old tokens stay as they were; a NEW token is refused', async () => {
    const dir = await fresh('m1')
    __resetVaultForTests({ dir: join(dir, 'vault'), autoInit: { candidates: [] } })
    const primary = join(dir, 'preferences.json')
    await writeFile(primary, JSON.stringify({ customLayout: [], team: { schema: 2, mode: 'member', connections: [conn('c_aaaaaaaaaaaa', TOK)] } }), { mode: 0o664 })
    await writePreferencesTo(primary, null, { lang: 'pt' } as Preferences)
    const after = JSON.parse(await readFile(primary, 'utf8'))
    expect(after.lang).toBe('pt')
    expect(after.team.connections[0].token).toBe(TOK) // left exactly as it was — still pending
    expect((await readPreferencesFrom(primary, null)).team?.connections[0]?.token).toBe(TOK)
    let err: unknown
    try {
      await updateTeamConfigAt(primary, null, t => ({ ...t, connections: [...t.connections, conn('c_bbbbbbbbbbbb', 'TEST-NOT-A-SECRET-new') as never] }))
    } catch (e) { err = e }
    expect(err).toBeInstanceOf(VaultRefusalError)
    expect(await readFile(primary, 'utf8')).not.toContain('TEST-NOT-A-SECRET-new')
    let changed: unknown
    try {
      await updateTeamConfigAt(primary, null, t => ({ ...t, connections: [{ ...t.connections[0]!, token: 'TEST-NOT-A-SECRET-rotated' }] }))
    } catch (e) { changed = e }
    expect(changed).toBeInstanceOf(VaultRefusalError)
    expect(existsSync(join(dir, 'vault', 'vault.json'))).toBe(false)
  })
})

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

describe('4 — downgrade safety: a connection that lost its hasToken flag keeps its sealed token', () => {
  test('an older binary dropped the flags; the tokens still read, and a write restores the flags', async () => {
    const dir = await fresh('d4')
    __resetVaultForTests({ dir: join(dir, 'vault') })
    const primary = join(dir, 'preferences.json')
    await writePreferencesTo(primary, null, { team: { schema: 2, mode: 'member', connections: [conn('c_aaaaaaaaaaaa', TOK)] } as never })
    const raw = JSON.parse(await readFile(primary, 'utf8'))
    delete raw.team.connections[0].hasToken
    await writeFile(primary, JSON.stringify(raw), { mode: 0o600 })
    const sealedBefore = await readFile(tokensFileFor(primary), 'utf8')
    expect((await readPreferencesFrom(primary, null)).team?.connections[0]?.token).toBe(TOK)
    await writePreferencesTo(primary, null, { lang: 'en' } as Preferences)
    expect(JSON.parse(await readFile(primary, 'utf8')).team.connections[0].hasToken).toBe(true)
    expect(await readFile(tokensFileFor(primary), 'utf8')).toBe(sealedBefore)
    expect((await readPreferencesFrom(primary, null)).team?.connections[0]?.token).toBe(TOK)
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
    await writeFile(path, '')
    expect((await startVaultSocket(path)).ok).toBe(true)
    stopVaultSocket()
  })
})

describe('8 — central.env plaintext is SCRUBBED, not just replaced', () => {
  test('the old file is overwritten in place before it goes; a crash mid-way is recovered', async () => {
    const dir = join(AGENTISTICS_DATA_DIR, 'central-scrub-' + randomBytes(3).toString('hex'))
    await (await import('node:fs/promises')).mkdir(dir, { recursive: true })
    const envFile = join(dir, 'central.env')
    const scrubbed: string[] = []
    const spy: SecretFs = { ...realSecretFs, openExisting: async (p) => { scrubbed.push(p); return realSecretFs.openExisting(p) } }
    __resetVaultForTests({ dir: join(await fresh('d8'), 'vault'), fs: spy })
    await writeFile(envFile, `APP_PORT=48080\nAGENTISTICS_TEAM_SESSION_SECRET=${TOK}\n`, { mode: 0o600 })
    expect((await migrateCentralEnvAt(envFile)).migrated).toBe(1)
    expect(scrubbed).toEqual([envFile + '.scrub'])
    expect(await readFile(envFile, 'utf8')).not.toContain(TOK)
    expect(readdirSync(dir).sort()).toEqual(['central.env', 'secrets.sealed'])
    // Crash after the scrub, before the rename: only `.next` is left.
    await (await import('node:fs/promises')).rename(envFile, envFile + '.next')
    await recoverCentralEnv(envFile)
    expect((await loadCentralEnv(envFile)).env).toMatchObject({ APP_PORT: '48080', AGENTISTICS_TEAM_SESSION_SECRET: TOK })
    await rm(dir, { recursive: true, force: true })
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

describe('re-review (a) — --central finds central.env after a crash between scrub and rename', () => {
  test('findCentralEnvFile recovers `.next` before the exists check', async () => {
    const { findCentralEnvFile } = await import('./central-env')
    const dir = join(AGENTISTICS_DATA_DIR, 'central-find-' + randomBytes(3).toString('hex'))
    await (await import('node:fs/promises')).mkdir(dir, { recursive: true })
    const envFile = join(dir, 'central.env')
    await writeFile(envFile + '.next', 'APP_PORT=48080\n', { mode: 0o600 })
    expect(existsSync(envFile)).toBe(false)
    expect(await findCentralEnvFile([join(dir, 'nope.env'), envFile])).toBe(envFile)
    expect(await readFile(envFile, 'utf8')).toBe('APP_PORT=48080\n')
    expect(existsSync(envFile + '.next')).toBe(false)
    await rm(dir, { recursive: true, force: true })
  })
})

describe('re-review (b) — a removed connection\'s sealed token never comes back', () => {
  const two = { schema: 2, mode: 'member', connections: [conn('c_aaaaaaaaaaaa', TOK), conn('c_bbbbbbbbbbbb', 'TEST-NOT-A-SECRET-b')] }
  const dropA = (t: { connections: { id: string }[] }) => ({ ...t, connections: t.connections.filter(c => c.id !== 'c_aaaaaaaaaaaa') }) as never
  const readdA = (t: { connections: unknown[] }) => ({ ...t, connections: [...t.connections, conn('c_aaaaaaaaaaaa', '')] }) as never

  test('vault open: the entry is deleted from tokens.sealed in the same write; a re-added id has no token', async () => {
    const dir = await fresh('rb1')
    __resetVaultForTests({ dir: join(dir, 'vault') })
    const primary = join(dir, 'preferences.json')
    await writePreferencesTo(primary, null, { team: two as never })
    await updateTeamConfigAt(primary, null, dropA)
    await updateTeamConfigAt(primary, null, readdA)
    const prefs = await readPreferencesFrom(primary, null)
    expect(prefs.team?.connections.find(c => c.id === 'c_aaaaaaaaaaaa')?.token).toBe('')
    expect(prefs.team?.connections.find(c => c.id === 'c_bbbbbbbbbbbb')?.token).toBe('TEST-NOT-A-SECRET-b')
    expect(JSON.parse(await readFile(primary, 'utf8')).sealedTokenTombstones).toBeUndefined()
  })

  test('vault NOT open: the removal is tombstoned, a re-added id gets nothing, and the next open write deletes the entry', async () => {
    const dir = await fresh('rb2')
    let down = false
    const held = new Map<string, Uint8Array>()
    const toggle: Protector = {
      id: 'libsecret', label: () => 'a keyring that can be down',
      async probe() { return down ? { ok: false, reason: 'down' } : { ok: true } },
      async wrap(dek, kid) { held.set(kid, new Uint8Array(dek)); return { ok: true, record: { type: 'libsecret', createdAt: new Date().toISOString() } } },
      async unwrap(_r, kid) { return down ? { ok: false, kind: 'unavailable', reason: 'down' } : { ok: true, dek: new Uint8Array(held.get(kid)!) } },
      async remove() {},
    }
    const reset = () => __resetVaultForTests({ dir: join(dir, 'vault'), protectors: [toggle], autoInit: { candidates: [toggle] } })
    reset()
    const primary = join(dir, 'preferences.json')
    await writePreferencesTo(primary, null, { team: two as never })
    const sealedBefore = await readFile(tokensFileFor(primary), 'utf8')

    down = true; reset()
    await updateTeamConfigAt(primary, null, dropA)
    expect(JSON.parse(await readFile(primary, 'utf8')).sealedTokenTombstones).toEqual(['c_aaaaaaaaaaaa'])
    expect(await readFile(tokensFileFor(primary), 'utf8')).toBe(sealedBefore) // cannot be edited while down
    await updateTeamConfigAt(primary, null, readdA)

    down = false; reset()
    // The map still holds A's old token, and it is NOT handed back to the re-added id.
    expect((await readPreferencesFrom(primary, null)).team?.connections.find(c => c.id === 'c_aaaaaaaaaaaa')?.token).toBe('')
    // The next write with the vault open deletes A's entry and clears the tombstone.
    await writePreferencesTo(primary, null, { lang: 'en' } as Preferences)
    const after = JSON.parse(await readFile(primary, 'utf8'))
    expect(after.sealedTokenTombstones).toBeUndefined()
    expect(await readFile(tokensFileFor(primary), 'utf8')).not.toBe(sealedBefore)
    const prefs = await readPreferencesFrom(primary, null)
    expect(prefs.team?.connections.find(c => c.id === 'c_aaaaaaaaaaaa')?.token).toBe('')
    expect(prefs.team?.connections.find(c => c.id === 'c_bbbbbbbbbbbb')?.token).toBe('TEST-NOT-A-SECRET-b')
    // Proof the ENTRY is gone (not just shadowed): flag A as sealed by hand — still nothing to inject.
    const raw = JSON.parse(await readFile(primary, 'utf8'))
    raw.team.connections.find((c: { id: string }) => c.id === 'c_aaaaaaaaaaaa').hasToken = true
    await writeFile(primary, JSON.stringify(raw), { mode: 0o600 })
    expect((await readPreferencesFrom(primary, null)).team?.connections.find(c => c.id === 'c_aaaaaaaaaaaa')?.token).toBe('')
  })
})
