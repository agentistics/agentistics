/**
 * tools/file/ledger.ts — the read-before-write memory `file.patch`/`file.write` are checked
 * against (spec §2 D-T1: "read-before-write, revalidated against the disk at write time"). A
 * session's three file tools share ONE ledger (`createFileTools` wires it), keyed by the
 * RESOLVED, symlink-followed path (`../paths.ts`), because judging staleness on the path the model
 * typed would let a symlink swap the file being compared without the ledger noticing.
 *
 * The ledger is deliberately dumb: it holds the last known {sha256, mtimeMs, size} per path and
 * nothing else. Whether that is "stale" is decided by the caller re-hashing the CURRENT disk
 * content and comparing — the ledger never reads a file itself.
 */

export interface LedgerEntry {
  sha256: string
  mtimeMs: number
  size: number
}

export interface ReadLedger {
  /** Records (or replaces) what is known about `path` — called after every successful read/write. */
  record(path: string, entry: LedgerEntry): void
  /** `undefined` when this session has never read (or written through this ledger) `path`. */
  get(path: string): LedgerEntry | undefined
  /** Forgets `path` — called after a delete, so a stale entry cannot authorise anything later. */
  forget(path: string): void
}

/** In-memory, per-session ledger. A session's file tools all share one instance. */
export function createReadLedger(): ReadLedger {
  const entries = new Map<string, LedgerEntry>()
  return {
    record(path, entry) {
      entries.set(path, entry)
    },
    get(path) {
      return entries.get(path)
    },
    forget(path) {
      entries.delete(path)
    },
  }
}
