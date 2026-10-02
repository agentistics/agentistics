/**
 * migrate.ts — moving a plaintext secret file into a sealed one, correct at EVERY crash point.
 *
 *   P = read the legacy plaintext (a mode that is too open is migrated, not refused: that is the fix)
 *   1. seal(P) → write <target>.sealed atomically (tmp + fsync + rename + chmod + fsync dir)
 *   2. verify: re-read <target>.sealed FROM DISK, open it, constant-time compare with P
 *   3. scrub the original: overwrite with random bytes of the same length, fsync, unlink, fsync dir
 *   4. audit { type: 'vault.migrated', purpose, name } — never the value, never a length
 *
 * The sealed file has a NEW name, so both can coexist and every state is recognisable on restart:
 *
 *   plain only                                  → not started / crashed before 1 → run 1–4
 *   sealed + plain, sealed opens and equals P   → crashed between 2 and 3        → run 3–4
 *   sealed + plain, sealed opens and DIFFERS    → re-entered by an older binary  → keep BOTH, scrub
 *                                                                                 nothing, report it
 *     (never decided by mtime: a clock, a copy or a restore can make either one look newer, and the
 *     wrong guess destroys the secret the user meant to keep)
 *   sealed + plain, sealed does not open        → tampering or another machine   → leave both, refuse
 *   sealed only                                 → done
 *   stray <target>.sealed.tmp-*                 → crash inside 1 → unlink (sealed bytes, never plain)
 *   stray <legacy>.scrub                        → crash inside 3 → finish the scrub
 *
 * `decideMigration` is the table, PURE. `migrateFile` runs it over `SecretFs`.
 */
import { bytesEqual } from './format'
import type { OpenFailure, OpenOutcome } from './seal'
import { SCRUB_SUFFIX, TMP_MARK, baseOf, dirOf, finishScrub, scrubFile, writePrivateAtomic, type SecretFs } from './atomic'

export type SealedFinding =
  | { state: 'absent' }
  | { state: 'equal' }
  | { state: 'differs' }
  | { state: 'fails'; code: OpenFailure; kid?: string }

export type MigrationPlan =
  | { kind: 'nothing' }
  /** run 1–4 */
  | { kind: 'migrate' }
  /** run 3–4 */
  | { kind: 'scrub' }
  /** the two copies differ: keep both, scrub nothing, say so */
  | { kind: 'conflict' }
  /** leave both untouched and use neither */
  | { kind: 'refuse'; code: OpenFailure; kid?: string }

/** PURE. The recovery table. */
export function decideMigration(plainExists: boolean, sealed: SealedFinding): MigrationPlan {
  if (!plainExists) return { kind: 'nothing' }
  switch (sealed.state) {
    case 'absent': return { kind: 'migrate' }
    case 'equal': return { kind: 'scrub' }
    case 'differs': return { kind: 'conflict' }
    case 'fails': return { kind: 'refuse', code: sealed.code, ...(sealed.kid ? { kid: sealed.kid } : {}) }
  }
}

export interface Sealer {
  seal(purpose: string, name: string, plaintext: Uint8Array): Uint8Array
  open(purpose: string, name: string, bytes: Uint8Array): OpenOutcome
}

export interface MigrationItem {
  purpose: string
  name: string
  /** The legacy plaintext file. */
  plainPath: string
  /** Where the sealed file goes. */
  sealedPath: string
  /**
   * What is sealed, given the plaintext file's bytes. Absent → the whole file. A consumer whose
   * sealed record is a different shape (the preferences tokens) does not use this runner.
   */
  toSeal?: (plain: Uint8Array) => Uint8Array
}

export type MigrationOutcome =
  | { status: 'nothing' }
  | { status: 'migrated' }
  /** the original was already sealed; only the scrub was left (a crash between 2 and 3) */
  | { status: 'finished' }
  /** the two copies differ; both were kept, nothing scrubbed, still pending */
  | { status: 'conflict' }
  | { status: 'refused'; code: OpenFailure; kid?: string }
  /** steps 1–2 failed; the original is untouched and retried next start */
  | { status: 'failed'; reason: string }

/** Remove crashed tmp writes of `sealedPath`. Their content is sealed bytes, never plaintext. */
export async function unlinkStrays(fs: SecretFs, sealedPath: string): Promise<number> {
  const dir = dirOf(sealedPath)
  const prefix = baseOf(sealedPath) + TMP_MARK
  let n = 0
  for (const f of await fs.readdir(dir)) {
    if (f.startsWith(prefix)) { await fs.unlink(`${dir}/${f}`).catch(() => {}); n++ }
  }
  return n
}

function reasonOf(err: unknown): string {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : ''
  return code || 'write failed'
}

export async function migrateFile(
  fs: SecretFs, sealer: Sealer, item: MigrationItem, audit: (e: { type: 'vault.migrated'; purpose: string; name: string }) => void = () => {},
): Promise<MigrationOutcome> {
  await unlinkStrays(fs, item.sealedPath)
  // A scrub that crashed after moving the original aside: the verified sealed copy already exists
  // (a scrub never starts before it does), so finishing the scrub is all that is left.
  await finishScrub(fs, item.plainPath + SCRUB_SUFFIX)
  const plain = await fs.readFile(item.plainPath)
  const sealedBytes = await fs.readFile(item.sealedPath)
  if (plain === null) return { status: 'nothing' }
  const P = item.toSeal ? item.toSeal(plain) : plain

  let finding: SealedFinding = { state: 'absent' }
  if (sealedBytes !== null) {
    const o = sealer.open(item.purpose, item.name, sealedBytes)
    if (!o.ok) finding = { state: 'fails', code: o.code, ...(o.kid ? { kid: o.kid } : {}) }
    else if (bytesEqual(o.plaintext, P)) finding = { state: 'equal' }
    else finding = { state: 'differs' }
  }
  const plan = decideMigration(true, finding)
  switch (plan.kind) {
    case 'nothing': return { status: 'nothing' }
    case 'refuse': return { status: 'refused', code: plan.code, ...(plan.kid ? { kid: plan.kid } : {}) }
    case 'scrub':
      await scrubFile(fs, item.plainPath)
      audit({ type: 'vault.migrated', purpose: item.purpose, name: item.name })
      return { status: 'finished' }
    case 'conflict':
      return { status: 'conflict' }
    case 'migrate': {
      try {
        await writePrivateAtomic(fs, item.sealedPath, sealer.seal(item.purpose, item.name, P))
        const back = await fs.readFile(item.sealedPath)
        const o = back ? sealer.open(item.purpose, item.name, back) : null
        if (!o || !o.ok || !bytesEqual(o.plaintext, P)) return { status: 'failed', reason: 'the sealed copy did not read back equal' }
      } catch (err) {
        return { status: 'failed', reason: reasonOf(err) }
      }
      await scrubFile(fs, item.plainPath)
      audit({ type: 'vault.migrated', purpose: item.purpose, name: item.name })
      return { status: 'migrated' }
    }
  }
}
