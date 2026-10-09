/**
 * gemini-family-io.ts — the IO under `gemini-family.ts`: list one project's chat files, read each
 * one's header line, and group them into conversations. Shared by the adapter (one session per
 * conversation) and the chat reader (one transcript per conversation), so the two cannot disagree
 * about which files belong together.
 */

import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { groupGeminiFamilies, parseChatName, type ChatFamily } from './gemini-family'

/** How much of a file's start is read to find its header — it is ~250 bytes; a longer first line is not one. */
const HEADER_BYTES = 8192

/** `path|mtimeMs|size` -> the header's sessionId (or null). A stale entry is simply never asked for again. */
const headerMemo = new Map<string, string | null>()

/** The `sessionId` of a journal HEADER line, else `null`. A message record or a `$set` patch is not one. */
export function headerIdOf(line: string): string | null {
  try {
    const d = JSON.parse(line) as Record<string, unknown>
    if (typeof d.sessionId === 'string' && d.sessionId && ('projectHash' in d || 'startTime' in d) && !('type' in d)) return d.sessionId
  } catch { /* a partial or oversized first line is not a header */ }
  return null
}

async function readHeaderId(path: string): Promise<string | null> {
  let st
  try { st = await stat(path) } catch { return null }
  const key = `${path}|${st.mtimeMs}|${st.size}`
  if (headerMemo.has(key)) return headerMemo.get(key)!
  let id: string | null = null
  try {
    const fh = await open(path, 'r')
    try {
      const buf = Buffer.alloc(Math.min(HEADER_BYTES, st.size))
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      const first = buf.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0] ?? ''
      id = headerIdOf(first)
    } finally { await fh.close() }
  } catch { id = null }
  if (headerMemo.size > 5000) headerMemo.clear()
  headerMemo.set(key, id)
  return id
}

/**
 * The conversations of one `chats/` directory. `only` narrows the work to the files carrying one
 * suffix (the resolver asks about a single conversation and must not read every header in the
 * directory to answer it).
 */
export async function listGeminiFamilies(chatsDir: string, only?: { suffix: string }): Promise<ChatFamily[]> {
  const names = await readdir(chatsDir).catch(() => [] as string[])
  const candidates = names.filter(n => {
    if (!n.endsWith('.jsonl') && !n.endsWith('.json')) return false
    if (!only) return true
    return parseChatName(n)?.suffix === only.suffix.toLowerCase()
  })
  const refs = await Promise.all(candidates.map(async name => ({
    name,
    headerId: name.endsWith('.jsonl') && parseChatName(name) ? await readHeaderId(join(chatsDir, name)) : null,
  })))
  return groupGeminiFamilies(refs)
}
