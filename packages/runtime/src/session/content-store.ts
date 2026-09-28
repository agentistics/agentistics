/**
 * session/content-store.ts — `createFileContentStore(dir)`: a file-backed, sha256-addressed
 * `ContentSink` (`tools/contract.ts`) plus a `get`, for reading a message body or a tool result back
 * off a `MessageRecord`/`ToolCallRecord`'s `ContentRef`.
 *
 * - **`put` never throws** (`ContentSink`'s own contract) — any failure (a full disk, a permission
 *   error) is `null`, and the caller (the loop's `onHistory`/`onToolCall` hooks, `runtime.ts`) counts
 *   it rather than crashing a run over a write it could not make.
 * - **`get` treats its argument as UNTRUSTED input.** A sha256 read back off a stored record could,
 *   in principle, be anything a caller passes in (a resume path, a future HTTP handler) — it is
 *   validated as exactly 64 lowercase hex characters BEFORE it ever reaches a path, or a caller could
 *   walk the filesystem with `../../etc/passwd` dressed up as a "sha256".
 * - **Files are written ATOMICALLY**: to a temp name in the same fan-out directory, `chmod`ed to the
 *   target mode explicitly (never relying on the process umask), then renamed over the destination.
 *   A rename within one filesystem is atomic, so a reader never observes a partially written body.
 * - **Content-addressed and therefore idempotent.** The same text always hashes to the same path, so
 *   re-`put`ting identical content overwrites the same bytes rather than growing the store — this is
 *   what lets a re-emission of the same message (a retried write) cost nothing extra on disk.
 * - **Mode 0600 on the file, 0700 on its two fan-out directories** — a run's conversation text and
 *   tool output are conversation content, never world-readable.
 */

import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ContentRef, ContentSink } from '../tools/contract.ts'

const SHA256_HEX = /^[0-9a-f]{64}$/

const FILE_MODE = 0o600
const DIR_MODE = 0o700

/** Two levels of fan-out so one directory never holds every object the store has ever seen. */
function pathFor(dir: string, sha256: string): { subDir: string; file: string } {
  const subDir = join(dir, sha256.slice(0, 2), sha256.slice(2, 4))
  return { subDir, file: join(subDir, sha256) }
}

export interface FileContentStore extends ContentSink {
  /** `null` on a bad sha (untrusted input) or a read failure — never a throw. */
  get(sha256: string): Promise<string | null>
}

export function createFileContentStore(dir: string): FileContentStore {
  return {
    async put(text: string): Promise<ContentRef | null> {
      try {
        const sha256 = createHash('sha256').update(text, 'utf8').digest('hex')
        const bytes = Buffer.byteLength(text, 'utf8')
        const { subDir, file } = pathFor(dir, sha256)
        await mkdir(subDir, { recursive: true })
        await chmod(subDir, DIR_MODE)
        const tmp = join(subDir, `.tmp-${process.pid}-${randomBytes(8).toString('hex')}`)
        await writeFile(tmp, text, 'utf8')
        await chmod(tmp, FILE_MODE)
        await rename(tmp, file)
        return { sha256, bytes }
      } catch {
        return null
      }
    },

    async get(sha256: string): Promise<string | null> {
      if (!SHA256_HEX.test(sha256)) return null
      try {
        return await readFile(pathFor(dir, sha256).file, 'utf8')
      } catch {
        return null
      }
    },
  }
}
