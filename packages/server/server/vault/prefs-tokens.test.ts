import { describe, expect, test, afterAll } from 'bun:test'
import { mkdtemp, readFile, writeFile, stat, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __forgetMemoryKey, VaultRefusalError } from '@agentistics/vault'
import type { Preferences } from '../preferences'
import { migratePreferencesTokensAt, pendingPreferencesTokensAt, readPreferencesFrom, writePreferencesTo, updateTeamConfigAt } from '../preferences'
import { __resetVaultForTests, ensureVaultOpen, lockVault } from './service'
import { stripAndSealTokens, tokensFileFor } from './prefs-tokens'

const TOKEN_A = 'TEST-NOT-A-SECRET-token-a-' + Math.random().toString(36).slice(2)
const TOKEN_B = 'TEST-NOT-A-SECRET-token-b-' + Math.random().toString(36).slice(2)

function conn(id: string, endpoint: string, token: string) {
  return { id, endpoint, org: 'acme', user: 'lucas', token, deniedRepos: [], shareMode: 'denylist', sources: [] }
}
const TEAM = {
  schema: 2, mode: 'member',
  connections: [conn('c_aaaaaaaaaaaa', 'http://a:48080', TOKEN_A), conn('c_bbbbbbbbbbbb', 'http://b:48080', TOKEN_B)],
  endpoint: 'http://a:48080', org: 'acme', user: 'lucas', token: TOKEN_A,
}

async function paths() {
  const dir = await mkdtemp(join(tmpdir(), 'agentistics-vault-prefs-'))
  __resetVaultForTests({ dir: join(dir, 'vault') })
  return { dir, primary: join(dir, 'preferences.json'), legacy: join(dir, 'claude', 'agentistics-preferences.json') }
}

async function fileText(p: string) { return readFile(p, 'utf-8') }

// Leave the process on a fresh vault dir: later test files must not inherit a lost key.
afterAll(async () => { __resetVaultForTests({ dir: join(await mkdtemp(join(tmpdir(), 'agentistics-vault-after-')), 'vault') }) })

describe('S3 — the tokens leave preferences.json', () => {
  test('a write seals the tokens; the file holds none, is 0600 and says hasToken; reads see them', async () => {
    const { primary, legacy } = await paths()
    await writePreferencesTo(primary, legacy, { team: TEAM as never })
    const text = await fileText(primary)
    expect(text).not.toContain(TOKEN_A)
    expect(text).not.toContain(TOKEN_B)
    expect(JSON.parse(text).team.connections.every((c: { hasToken?: boolean }) => c.hasToken === true)).toBe(true)
    expect(JSON.parse(text).team.token).toBeUndefined()
    expect((await stat(primary)).mode & 0o777).toBe(0o600)
    const sealed = await fileText(tokensFileFor(primary))
    expect(sealed).not.toContain(TOKEN_A)
    const prefs = await readPreferencesFrom(primary, legacy)
    expect(prefs.team?.connections.map(c => c.token)).toEqual([TOKEN_A, TOKEN_B])
    expect(prefs.team?.token).toBe(TOKEN_A)
  })

  test('removing a connection drops its sealed token', async () => {
    const { primary, legacy } = await paths()
    await writePreferencesTo(primary, legacy, { team: TEAM as never })
    await updateTeamConfigAt(primary, legacy, t => ({ ...t, connections: t.connections.filter(c => c.id !== 'c_aaaaaaaaaaaa') }))
    const prefs = await readPreferencesFrom(primary, legacy)
    expect(prefs.team?.connections.map(c => c.token)).toEqual([TOKEN_B])
    // Opening the map directly: A is gone from it, not just hidden.
    const raw = JSON.parse(await fileText(primary))
    const back = await stripAndSealTokens(primary, raw, raw)
    expect(JSON.stringify(back)).not.toContain(TOKEN_A)
  })

  test('an upgraded install: plaintext tokens at 0664 are migrated — sealed, verified, file rewritten 0600', async () => {
    const { primary, legacy } = await paths()
    await writeFile(primary, JSON.stringify({ customLayout: [], team: TEAM }), { mode: 0o664 })
    expect(await pendingPreferencesTokensAt(primary, legacy)).toBe(3)
    const r = await migratePreferencesTokensAt(primary, legacy)
    expect(r.lines).toEqual([])
    expect(await fileText(primary)).not.toContain(TOKEN_A)
    expect((await stat(primary)).mode & 0o777).toBe(0o600)
    expect(await pendingPreferencesTokensAt(primary, legacy)).toBe(0)
    expect((await readPreferencesFrom(primary, legacy)).team?.connections.map(c => c.token)).toEqual([TOKEN_A, TOKEN_B])
    // Idempotent: a second pass changes nothing.
    const before = await fileText(primary)
    await migratePreferencesTokensAt(primary, legacy)
    expect(await fileText(primary)).toBe(before)
  })

  test('S4: the legacy copy has its token fields scrubbed in place, the rest left alone', async () => {
    const { primary, legacy } = await paths()
    await mkdir(join(legacy, '..'), { recursive: true })
    await writeFile(legacy, JSON.stringify({ customLayout: [], lang: 'pt', team: TEAM }))
    await migratePreferencesTokensAt(primary, legacy)
    const l = JSON.parse(await fileText(legacy))
    expect(JSON.stringify(l)).not.toContain(TOKEN_A)
    expect(l.lang).toBe('pt')
    expect(l.team.connections[0].endpoint).toBe('http://a:48080')
    expect(await fileText(primary)).not.toContain(TOKEN_A)
    expect((await readPreferencesFrom(primary, legacy)).team?.connections.map(c => c.token)).toEqual([TOKEN_A, TOKEN_B])
  })

  test('crash after the sealed map, before the preferences rewrite: the next pass finishes it', async () => {
    const { primary, legacy } = await paths()
    const plaintext = { customLayout: [], team: TEAM }
    await writeFile(primary, JSON.stringify(plaintext), { mode: 0o664 })
    // Step 1 alone (the map is sealed and verified), then "crash" before the file is rewritten.
    await stripAndSealTokens(primary, JSON.parse(JSON.stringify(plaintext)), null)
    expect(existsSync(tokensFileFor(primary))).toBe(true)
    expect(await fileText(primary)).toContain(TOKEN_A)
    // Reads still work in that state…
    expect((await readPreferencesFrom(primary, legacy)).team?.connections.map(c => c.token)).toEqual([TOKEN_A, TOKEN_B])
    // …and the next pass scrubs the file.
    await migratePreferencesTokensAt(primary, legacy)
    expect(await fileText(primary)).not.toContain(TOKEN_A)
    expect((await readPreferencesFrom(primary, legacy)).team?.connections.map(c => c.token)).toEqual([TOKEN_A, TOKEN_B])
  })

  test('a vault that cannot open: other preferences still save, connections keep hasToken, a NEW token is refused in words', async () => {
    const { primary, legacy } = await paths()
    await writePreferencesTo(primary, legacy, { team: TEAM as never })
    const sealedBefore = await fileText(tokensFileFor(primary))
    lockVault()
    const { dir } = { dir: join(primary, '..') }
    __forgetMemoryKey(JSON.parse(await fileText(join(dir, 'vault', 'vault.json'))).kid) // → protector-lost
    const prefs = await readPreferencesFrom(primary, legacy)
    expect(prefs.team?.connections.map(c => c.token)).toEqual(['', ''])
    await writePreferencesTo(primary, legacy, { lang: 'pt' } as Preferences)
    const after = JSON.parse(await fileText(primary))
    expect(after.lang).toBe('pt')
    expect(after.team.connections.every((c: { hasToken?: boolean }) => c.hasToken === true)).toBe(true)
    expect(await fileText(tokensFileFor(primary))).toBe(sealedBefore)
    let err: unknown
    try {
      await updateTeamConfigAt(primary, legacy, t => ({ ...t, connections: [...t.connections, conn('c_cccccccccccc', 'http://c:48080', 'TEST-NOT-A-SECRET-new') as never] }))
    } catch (e) { err = e }
    expect(err).toBeInstanceOf(VaultRefusalError)
    expect((err as VaultRefusalError).code).toBe('protector-lost')
    expect((err as Error).message).not.toContain('TEST-NOT-A-SECRET-new')
    expect(await fileText(primary)).not.toContain('TEST-NOT-A-SECRET-new')
  })
})

describe('no vault is created for a machine with nothing to seal', () => {
  test('a solo machine reading and writing preferences never creates a vault', async () => {
    const { dir, primary, legacy } = await paths()
    await writePreferencesTo(primary, legacy, { lang: 'en' } as Preferences)
    await readPreferencesFrom(primary, legacy)
    expect(existsSync(join(dir, 'vault', 'vault.json'))).toBe(false)
    expect(await ensureVaultOpen({ create: false })).toBeNull()
  })
})
