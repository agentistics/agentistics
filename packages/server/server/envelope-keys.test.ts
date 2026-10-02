import { describe, it, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __setTeamConnDirForTests, envelopeKeyFile } from './config'
import {
  loadOrCreateKeypair, publicKeyOnly, pinPeerKey, pinnedKeyFor, pinnedPeers,
  __resetEnvelopeKeysForTests,
} from './envelope-keys'
import { sealedPathFor } from './vault/whole-file'
import { existsSync } from 'node:fs'

// Every test runs against a throwaway directory — nothing here may touch ~/.agentistics.
const dirs: string[] = []
async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentistics-envelope-keys-'))
  dirs.push(dir)
  __setTeamConnDirForTests(dir)
  __resetEnvelopeKeysForTests()
  return dir
}

beforeEach(async () => { await freshDir() })
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }) })

const CONN = 'c_aaaaaaaaaaaa'

describe('loadOrCreateKeypair', () => {
  it('generates a keypair on first use and reuses it afterwards', async () => {
    const first = await loadOrCreateKeypair()
    expect(first.publicKey).not.toBe('')
    expect(first.privateKey).not.toBe('')
    __resetEnvelopeKeysForTests()
    expect(await loadOrCreateKeypair()).toEqual(first)
  })

  it('stores the key SEALED, 0600 — the private half is never on disk in plain text', async () => {
    const kp = await loadOrCreateKeypair()
    const sealed = sealedPathFor(envelopeKeyFile())
    const mode = (await stat(sealed)).mode & 0o777
    expect(mode & 0o077).toBe(0)
    expect(await readFile(sealed, 'utf-8')).not.toContain(kp.privateKey)
    expect(existsSync(envelopeKeyFile())).toBe(false)
  })

  it('migrates a legacy plaintext key file: same keypair, plaintext gone', async () => {
    const { writeFile } = await import('node:fs/promises')
    const legacy = { publicKey: 'TEST-NOT-A-SECRET-pub', privateKey: 'TEST-NOT-A-SECRET-priv' }
    await writeFile(envelopeKeyFile(), JSON.stringify(legacy), { mode: 0o644 })
    __resetEnvelopeKeysForTests()
    expect(await loadOrCreateKeypair()).toEqual(legacy)
    expect(existsSync(envelopeKeyFile())).toBe(false)
    expect(await readFile(sealedPathFor(envelopeKeyFile()), 'utf-8')).not.toContain(legacy.privateKey)
  })

  it('regenerates rather than throwing when the stored file is junk', async () => {
    const { writeFile } = await import('node:fs/promises')
    await loadOrCreateKeypair()
    await writeFile(envelopeKeyFile(), '{ not json', 'utf-8')
    __resetEnvelopeKeysForTests()
    const kp = await loadOrCreateKeypair()
    expect(kp.privateKey).not.toBe('')
  })
})

describe('publicKeyOnly', () => {
  it('exposes the public half and a fingerprint, never the private half', async () => {
    const kp = await loadOrCreateKeypair()
    const pub = await publicKeyOnly()
    expect(pub.publicKey).toBe(kp.publicKey)
    expect(pub.fingerprint).not.toBe('')
    expect(JSON.stringify(pub)).not.toContain(kp.privateKey)
    expect(Object.keys(pub).sort()).toEqual(['fingerprint', 'publicKey'])
  })

  it('the private key is not written into the pin file either', async () => {
    const kp = await loadOrCreateKeypair()
    await pinPeerKey(CONN, 'peer-1', 'PEERKEY')
    const pins = await readFileText(CONN)
    expect(pins).not.toContain(kp.privateKey)
  })
})

async function readFileText(connId: string): Promise<string> {
  const { envelopePinsFile } = await import('./config')
  return readFile(envelopePinsFile(connId), 'utf-8')
}

describe('pinPeerKey', () => {
  it('pins on first sight and accepts the same key afterwards', async () => {
    expect(await pinPeerKey(CONN, 'peer-1', 'K1')).toBe('new')
    expect(await pinnedKeyFor(CONN, 'peer-1')).toBe('K1')
    expect(await pinPeerKey(CONN, 'peer-1', 'K1')).toBe('same')
  })

  it('refuses a changed key AND keeps the original pin', async () => {
    await pinPeerKey(CONN, 'peer-1', 'K1')
    expect(await pinPeerKey(CONN, 'peer-1', 'K2')).toBe('changed')
    // The old key stays the reference until a human resolves it — a substituted key must not be
    // able to install itself simply by being presented twice.
    expect(await pinnedKeyFor(CONN, 'peer-1')).toBe('K1')
    expect(await pinPeerKey(CONN, 'peer-1', 'K2')).toBe('changed')
  })

  it('keeps pins per connection — the same machine id on two centrals is two machines', async () => {
    const other = 'c_bbbbbbbbbbbb'
    await pinPeerKey(CONN, 'peer-1', 'K1')
    expect(await pinnedKeyFor(other, 'peer-1')).toBeNull()
    expect(await pinPeerKey(other, 'peer-1', 'K9')).toBe('new')
    expect(await pinnedKeyFor(CONN, 'peer-1')).toBe('K1')
  })

  it('treats an empty id or key as a refusal, never as a pin', async () => {
    expect(await pinPeerKey(CONN, '', 'K1')).toBe('changed')
    expect(await pinPeerKey(CONN, 'peer-1', '')).toBe('changed')
    expect(await pinnedKeyFor(CONN, 'peer-1')).toBeNull()
  })
})

describe('pinnedPeers', () => {
  it('lists fingerprints, not keys', async () => {
    const kp = await loadOrCreateKeypair()
    await pinPeerKey(CONN, 'peer-1', kp.publicKey)
    const peers = await pinnedPeers(CONN)
    expect(peers).toHaveLength(1)
    expect(peers[0]!.machineId).toBe('peer-1')
    expect(peers[0]!.fingerprint).toMatch(/^([0-9a-f]{4} ){7}[0-9a-f]{4}$/)
    expect(JSON.stringify(peers)).not.toContain(kp.publicKey)
  })

  it('is empty for a connection with no peers yet', async () => {
    expect(await pinnedPeers(CONN)).toEqual([])
  })
})

describe('pinned peer names', () => {
  it('stores the machine name alongside the key and returns it with the fingerprint', async () => {
    await pinPeerKey(CONN, 'peer-1', 'K1', 'Laptop B')
    const peers = await pinnedPeers(CONN)
    expect(peers[0]!.machineName).toBe('Laptop B')
    expect(peers[0]!.machineId).toBe('peer-1')
  })

  it('refreshes a renamed machine without touching the key', async () => {
    await pinPeerKey(CONN, 'peer-1', 'K1', 'Old Name')
    expect(await pinPeerKey(CONN, 'peer-1', 'K1', 'New Name')).toBe('same')
    expect((await pinnedPeers(CONN))[0]!.machineName).toBe('New Name')
    expect(await pinnedKeyFor(CONN, 'peer-1')).toBe('K1')
  })

  it('never lets a rename smuggle in a different key', async () => {
    await pinPeerKey(CONN, 'peer-1', 'K1', 'Laptop B')
    expect(await pinPeerKey(CONN, 'peer-1', 'K2', 'Laptop B')).toBe('changed')
    expect(await pinnedKeyFor(CONN, 'peer-1')).toBe('K1')
  })

  it('reads a pin written in the earlier key-only form rather than dropping it', async () => {
    // Dropping it would silently downgrade an established peer back to first sight.
    const { writeFile, mkdir } = await import('node:fs/promises')
    const { envelopePinsFile } = await import('./config')
    const path = envelopePinsFile(CONN)
    await mkdir(require('node:path').dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ 'peer-1': 'LEGACYKEY' }), 'utf-8')
    expect(await pinnedKeyFor(CONN, 'peer-1')).toBe('LEGACYKEY')
    expect(await pinPeerKey(CONN, 'peer-1', 'LEGACYKEY')).toBe('same')
    expect(await pinPeerKey(CONN, 'peer-1', 'OTHER')).toBe('changed')
  })
})
