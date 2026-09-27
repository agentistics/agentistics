/**
 * tools/fs/binary.ts — the "is this worth reading" check `fs.grep` runs before it opens a file:
 * a NUL byte in the first `sniffBytes` (the same heuristic `git`/GNU `grep` use) says binary, and
 * both that check and the size cap it sits beside are COUNTED by the caller, never silently
 * dropped — the catalogue's "state what was cut" rule (§3) applied to files instead of matches.
 */
import { open } from 'node:fs/promises'

export async function looksBinary(absPath: string, sniffBytes: number): Promise<boolean> {
  const fh = await open(absPath, 'r')
  try {
    const buf = Buffer.alloc(sniffBytes)
    const { bytesRead } = await fh.read(buf, 0, sniffBytes, 0)
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true
    }
    return false
  } finally {
    await fh.close()
  }
}
