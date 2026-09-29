/**
 * tools/file/fs-io.ts — the small IO boundary every file tool shares: hashing, atomic writes and
 * the line-splitting convention that lets `file.patch` put a file back together byte-for-byte.
 * Everything a tool needs to know ABOUT a file (does it exist, is it stale) goes through here so
 * `read.ts`/`patch.ts`/`write.ts` compute a ledger entry, or judge staleness, the exact same way.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { LedgerEntry, ReadLedger } from './ledger.ts'

export function sha256OfBuffer(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex')
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Reads `path` fresh off disk and states what the ledger would record for it right now. */
export async function ledgerEntryOf(path: string): Promise<LedgerEntry> {
  const [buf, st] = await Promise.all([readFile(path), stat(path)])
  return { sha256: sha256OfBuffer(buf), mtimeMs: st.mtimeMs, size: buf.length }
}

export type StaleCheck = { stale: false } | { stale: true; reason: string }

/** Requires `path` to be IN the ledger AND to hash the same as what is on disk right now — the
 *  read-before-write rule (spec §2 D-T1). Call only once the path is known to exist. */
export async function checkNotStale(ledger: ReadLedger, path: string): Promise<StaleCheck> {
  const recorded = ledger.get(path)
  if (!recorded) {
    return { stale: true, reason: 'this file was never read in this session — read it first, then try again.' }
  }
  const current = await ledgerEntryOf(path)
  if (current.sha256 !== recorded.sha256) {
    return { stale: true, reason: 'the file changed on disk since it was read — read it again, then try again.' }
  }
  return { stale: false }
}

/** Writes `path` via a temp file in the SAME directory + rename, so a concurrent reader never sees
 *  a partial write and a crash mid-write never leaves a half-written file at the real path. */
export async function atomicWriteFile(path: string, content: string): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `.${basename(path)}.tmp-${randomUUID()}`)
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, path)
}

export async function removeFile(path: string): Promise<void> {
  await unlink(path)
}

export interface SplitFile {
  lines: string[]
  /** Whether the ORIGINAL text ended with `\n` — preserved on rejoin so a patch round-trips
   *  byte-for-byte on a file whose last line is not itself a trailing blank line. */
  trailingNewline: boolean
}

export function splitFileLines(text: string): SplitFile {
  if (text === '') return { lines: [], trailingNewline: false }
  const parts = text.split('\n')
  const trailingNewline = parts[parts.length - 1] === ''
  return { lines: trailingNewline ? parts.slice(0, -1) : parts, trailingNewline }
}

export function joinFileLines(split: SplitFile): string {
  const body = split.lines.join('\n')
  return split.trailingNewline ? body + '\n' : body
}

/** Maps a Node fs error to the tool error class it deserves, `'internal'` for anything else. */
export function classifyFsError(e: unknown): 'not-found' | 'permission' | 'internal' {
  const code = (e as { code?: string } | null)?.code
  if (code === 'ENOENT') return 'not-found'
  if (code === 'EACCES' || code === 'EPERM') return 'permission'
  return 'internal'
}
