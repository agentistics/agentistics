/**
 * Review S6: a recovery-key rotation used to WRAP straight over `dek.recovery` and verify after — so a
 * read-back that failed left neither the old words nor the new ones opening the vault, while the user
 * was told the rotation failed (and so believed the old words still worked). Now: staging file, verify
 * from disk, then replace.
 */
import { describe, expect, test } from 'bun:test'
import { RECOVERY_FILE, newRecoveryEntropy, recoveryProtector, writeRecoveryVerified } from './recovery'
import type { ProtectorIo } from './protectors/types'

function memIo(opts: { corruptStaging?: boolean } = {}) {
  const files = new Map<string, Uint8Array>()
  const io: ProtectorIo = {
    async run() { throw new Error('no process') },
    async readFile(p) {
      const d = files.get(p) ?? null
      if (d && opts.corruptStaging && p.endsWith('.new')) { const c = new Uint8Array(d); c[c.length - 10]! ^= 0xff; return c }
      return d
    },
    async writeFile(p, d) { files.set(p, new Uint8Array(d)) },
    async removeFile(p) { files.delete(p) },
    async createExclusive(p, d) { if (files.has(p)) return false; files.set(p, d); return true },
    async firstExisting() { return null },
    async which() { return null },
  }
  return { io, files }
}

const DEK = new Uint8Array(32).fill(9)
const KID = 'k0123456789abcdef'

async function opens(io: ProtectorIo, entropy: Uint8Array): Promise<boolean> {
  const u = await recoveryProtector({ io, vaultDir: '/v', entropy }).unwrap({ type: 'recovery', createdAt: 'x' }, KID)
  return u.ok && u.dek.every((b, i) => b === DEK[i])
}

describe('S6 — rotating the recovery key never leaves the vault without one', () => {
  test('a read-back that fails leaves the OLD words opening the vault, and nothing staged behind', async () => {
    const { io, files } = memIo()
    const oldE = newRecoveryEntropy()
    expect((await recoveryProtector({ io, vaultDir: '/v', entropy: oldE }).wrap(DEK, KID)).ok).toBe(true)
    const bad = memIo({ corruptStaging: true })
    for (const [k, v] of files) bad.files.set(k, v)
    const r = await writeRecoveryVerified(bad.io, '/v', DEK, KID, newRecoveryEntropy())
    expect(r.ok).toBe(false)
    expect(await opens(bad.io, oldE)).toBe(true)
    expect([...bad.files.keys()].some(k => k.endsWith('.new'))).toBe(false)
  })
  test('a good rotation: the NEW words open, the old ones do not, the staging file is gone', async () => {
    const { io, files } = memIo()
    const oldE = newRecoveryEntropy()
    await recoveryProtector({ io, vaultDir: '/v', entropy: oldE }).wrap(DEK, KID)
    const newE = newRecoveryEntropy()
    const r = await writeRecoveryVerified(io, '/v', DEK, KID, newE)
    expect(r.ok).toBe(true)
    expect(r.ok && r.record.params?.file).toBe(RECOVERY_FILE)
    expect(await opens(io, newE)).toBe(true)
    expect(await opens(io, oldE)).toBe(false)
    expect([...files.keys()]).toEqual([`/v/${RECOVERY_FILE}`])
  })
})
