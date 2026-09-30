/**
 * tools/file/binary.ts — "an image or PDF is returned BY REFERENCE (path, bytes, mime), never its
 * bytes" (spec §3). Two routes into that: the extension names a known image/PDF type outright, or
 * — for anything else — the first few KB contain a NUL byte, which UTF-8 text never legitimately
 * does. Pure and total: an unreadable extension or an empty buffer just answers "not binary".
 */

import { extname } from 'node:path'

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
}

/** The mime this extension is KNOWN to be (image or PDF), or `undefined` for anything else. */
export function mimeByExtension(path: string): string | undefined {
  const ext = extname(path).toLowerCase()
  if (ext === '.pdf') return 'application/pdf'
  return IMAGE_MIME_BY_EXT[ext]
}

const SNIFF_BYTES = 8000

/** A NUL byte in the first `SNIFF_BYTES` is treated as proof the content is not text. */
export function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, SNIFF_BYTES)
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true
  }
  return false
}
