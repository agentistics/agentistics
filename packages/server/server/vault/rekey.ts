/**
 * vault/rekey.ts — a NEW data key when presence retires the silent OS wrapper (review S7).
 *
 * Why: enrolling presence used to re-wrap the SAME DEK and delete `dek.dpapi`. Any earlier copy of
 * that file — a filesystem snapshot, a dotfile sync, a WSL disk backup — still opens the vault in
 * silence through DPAPI, for ever, and "no silent wrapper exists" (§1.2, §9.2) only holds if no such
 * copy does. A new DEK makes every earlier copy a blob that opens nothing.
 *
 * What: every sealed record of the human scope is re-sealed under the new key, crash-safely, with a
 * JOURNAL, and the old key is kept until every record has been re-sealed AND verified:
 *
 *   1. PREPARE   find every `*.sealed` under the data dir whose header names the OLD kid; for each,
 *                open with the old DEK, seal under the new one to `<file>.rekey`, read it back from
 *                disk and require the same plaintext. Journal: `prepared`.
 *                crash → the old vault is untouched; the `.rekey` files are leftovers, removed by
 *                `finishRekeyIfPending` (the journal says they were never committed).
 *   2. WRAP      the caller wraps the NEW DEK under the presence credential and the recovery key
 *                (staged — see recovery.ts); the recovery one verified by an unwrap, the presence one
 *                by its own in-memory seal check (no second gesture; the first unlock re-checks it).
 *   3. COMMIT    ONE write of vault.json naming the new kid and the new wrappers (the silent ones go
 *                to `retired`, each carrying the OLD kid it must be removed under). Journal: `committed`.
 *   4. FINISH    rename every `<file>.rekey` over `<file>`, then drop the journal.
 *                crash → `finishRekeyIfPending` completes it on the next open; until then a reader
 *                of `<file>` falls back to `<file>.rekey` (`openFromFile`), so nothing is unreadable.
 *
 * One owner per file still holds for MEANING: the engine's `provider-keys/*.sealed` are re-sealed
 * byte-for-byte in content, same purpose, same name — the vault re-keys what it sealed, it does not
 * read, migrate or delete what the engine decided. The runner scope (`vault-runner/`) has its own DEK
 * and is never touched.
 */
import { readdir, lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { openRecord, parseSealed, sealToBytes, writePrivateAtomic } from '@agentistics/vault'
import { secretFs, vaultDir } from './service'

export const REKEY_SUFFIX = '.rekey'
const JOURNAL = 'rekey.json'
/** Never scanned: huge, and holding nothing sealed (archive, sessions) or another scope (vault-runner). */
const SKIP_DIRS = new Set(['archive', 'sessions', 'vault-runner', 'run', 'node_modules', '.git'])

export interface RekeyJournal { v: 1; phase: 'prepared' | 'committed'; oldKid: string; newKid: string; files: string[] }

/** The data directory the vault belongs to — where every record it sealed lives. */
export function dataRoot(): string { return dirname(vaultDir()) }
function journalPath(): string { return join(vaultDir(), JOURNAL) }

/** Every `*.sealed` file under the data dir whose header names `kid` (symlinks and other scopes skipped). */
export async function findSealedUnder(root: string, kid: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6) return
    let entries: import('node:fs').Dirent[]
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(p, depth + 1); continue }
      if (!e.isFile() || !e.name.endsWith('.sealed')) continue
      const raw = await secretFs().readFile(p)
      if (!raw) continue
      const f = parseSealed(new TextDecoder().decode(raw))
      if (f && f.kid === kid) out.push(p)
    }
  }
  await walk(root, 0)
  return out.sort()
}

async function writeJournal(j: RekeyJournal): Promise<void> {
  await writePrivateAtomic(secretFs(), journalPath(), new TextEncoder().encode(JSON.stringify(j) + '\n'))
}
async function readJournal(): Promise<RekeyJournal | null> {
  const raw = await secretFs().readFile(journalPath())
  if (!raw) return null
  try {
    const j = JSON.parse(new TextDecoder().decode(raw)) as RekeyJournal
    return j && j.v === 1 && (j.phase === 'prepared' || j.phase === 'committed') && Array.isArray(j.files) ? j : null
  } catch { return null }
}
async function dropJournal(): Promise<void> { await secretFs().unlink(journalPath()).catch(() => {}) }

/** Test seam: throw at a named point, to prove every crash leaves a vault that opens. */
let _crashAt: string | null = null
export function __rekeyCrashAtForTests(point: string | null): void { _crashAt = point }
function maybeCrash(point: string): void { if (_crashAt === point) { _crashAt = null; throw new Error(`injected crash at ${point}`) } }

export type Prepared = { ok: true; files: string[] } | { ok: false; reason: string }

/**
 * Phase 1. Re-seal every record of `oldKid` under the new key to `<file>.rekey`, each verified from
 * disk. The OLD records are not touched. Any failure removes what was staged and reports.
 */
export async function prepareRekey(
  old: { dek: Uint8Array; kid: string }, next: { dek: Uint8Array; kid: string },
  /** Files the CALLER will stage as `<file>.rekey` before the commit (the recovery wrapper): journaled now, so a crash at any point finishes or rolls them back with the rest. */
  extra: string[] = [],
): Promise<Prepared> {
  const files = await findSealedUnder(dataRoot(), old.kid)
  await writeJournal({ v: 1, phase: 'prepared', oldKid: old.kid, newKid: next.kid, files: [...files, ...extra] })
  const staged: string[] = []
  try {
    for (const f of files) {
      const raw = await secretFs().readFile(f)
      const head = raw ? parseSealed(new TextDecoder().decode(raw)) : null
      if (!raw || !head) return fail(`${f} could not be read`)
      const o = openRecord({ dek: old.dek, kid: old.kid, purpose: head.purpose, name: head.name, bytes: raw })
      if (!o.ok) return fail(`${f} did not open under the current key (${o.code})`)
      try {
        const sealed = sealToBytes({ dek: next.dek, kid: next.kid, purpose: head.purpose, name: head.name, plaintext: o.plaintext })
        await writePrivateAtomic(secretFs(), f + REKEY_SUFFIX, sealed)
        staged.push(f + REKEY_SUFFIX)
        maybeCrash('prepare-mid')
        const back = await secretFs().readFile(f + REKEY_SUFFIX)
        const v = back ? openRecord({ dek: next.dek, kid: next.kid, purpose: head.purpose, name: head.name, bytes: back }) : null
        const same = v?.ok === true && v.plaintext.length === o.plaintext.length && v.plaintext.every((b, i) => b === o.plaintext[i])
        if (v?.ok) v.plaintext.fill(0)
        if (!same) return fail(`${f} did not read back under the new key`)
      } finally { o.plaintext.fill(0) }
    }
    return { ok: true, files }
  } catch (err) {
    if (String((err as Error)?.message ?? '').startsWith('injected crash')) throw err
    return fail((err as Error)?.message ?? 'the records could not be re-sealed')
  }

  async function fail(reason: string): Promise<Prepared> {
    for (const s of staged) await secretFs().unlink(s).catch(() => {})
    for (const e of extra) await secretFs().unlink(e + REKEY_SUFFIX).catch(() => {})
    await dropJournal()
    return { ok: false, reason }
  }
}

/** Phase 3's journal mark (the caller has just written vault.json with the new kid). */
export async function markCommitted(j: { oldKid: string; newKid: string; files: string[] }): Promise<void> {
  maybeCrash('before-commit-mark')
  await writeJournal({ v: 1, phase: 'committed', ...j })
}

/** Phase 4: every `<file>.rekey` replaces `<file>`; then the journal goes. Idempotent. */
export async function finishRekey(files: string[]): Promise<void> {
  maybeCrash('before-finish')
  for (const f of files) {
    const staged = f + REKEY_SUFFIX
    if (await secretFs().lstat(staged)) await secretFs().rename(staged, f)
  }
  await dropJournal()
}

/** A prepare that never committed: remove its staged files and journal, leaving the old vault as it was. */
export async function abandonRekey(files: string[]): Promise<void> {
  for (const f of files) await secretFs().unlink(f + REKEY_SUFFIX).catch(() => {})
  await dropJournal()
}

/**
 * On every open: a journal left by a crash is completed (committed — the vault.json kid is the new one)
 * or rolled back (prepared — the vault.json kid is still the old one). `openKid` is the kid that opened.
 */
export async function finishRekeyIfPending(openKid: string): Promise<void> {
  const j = await readJournal()
  if (!j) return
  // The COMMIT POINT is vault.json naming the new kid — so the kid that OPENED decides, not the
  // journal's phase (a crash between the vault.json write and the `committed` mark leaves `prepared`).
  if (openKid === j.newKid) return finishRekey(j.files)
  if (openKid === j.oldKid) return abandonRekey(j.files) // never committed: vault.json still names the old key
  // A journal from some other key pair: say nothing, touch nothing (it is not this vault's).
}

export function __resetRekeyForTests(): void { _crashAt = null }
