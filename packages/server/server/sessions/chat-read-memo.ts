/**
 * chat-read-memo.ts — a chat view's transcript read, kept while the transcript has not changed (PERF.IDLE).
 *
 * Every open chat stream re-reads its conversation on a 10 s safety timer, on every fleet-row refresh
 * and on every append; the readers parse the WHOLE file (a long Claude transcript is tens of MB). Most
 * of those wakes find the file exactly as the last read left it. The result is therefore kept per
 * (path, window) and handed back while the file's size and mtime are the ones it was read at — the
 * same stamp `parse-cache.ts` trusts for the dashboard's own parse.
 *
 * Gemini is never kept: its reader concatenates a FAMILY of files (`gemini-family.ts`), and the stamp
 * of the newest member alone does not say whether an older one changed.
 *
 * What is handed back is a fresh wrapper and a fresh array over the same turn objects; nothing on the
 * chat path edits a turn in place (every step maps to new objects), so the kept copy stays as read.
 */
import { stat } from 'node:fs/promises'
import type { ChatTurn } from '@agentistics/core'

const MAX_ENTRIES = 32
interface Kept { size: number; mtimeMs: number; read: { turns: ChatTurn[]; older?: boolean } }
const kept = new Map<string, Kept>()

export async function readChatMemo(
  path: string,
  max: number,
  harness: string | undefined,
  read: () => Promise<{ turns: ChatTurn[]; older?: boolean }>,
): Promise<{ turns: ChatTurn[]; older?: boolean }> {
  if (harness === 'gemini') return read()
  const key = `${path}\0${max}`
  const before = await stat(path).catch(() => null)
  const hit = kept.get(key)
  if (before && hit && hit.size === before.size && hit.mtimeMs === before.mtimeMs) {
    kept.delete(key); kept.set(key, hit) // most recently used last
    return { ...hit.read, turns: [...hit.read.turns] }
  }
  const fresh = await read()
  // Kept only when the file did not move WHILE it was read: otherwise the stamp names bytes the read
  // may not have seen.
  const after = before ? await stat(path).catch(() => null) : null
  if (before && after && after.size === before.size && after.mtimeMs === before.mtimeMs) {
    kept.set(key, { size: before.size, mtimeMs: before.mtimeMs, read: { ...fresh, turns: [...fresh.turns] } })
    while (kept.size > MAX_ENTRIES) kept.delete(kept.keys().next().value as string)
  } else kept.delete(key)
  return fresh
}

/** Tests only. */
export function clearChatMemo(): void { kept.clear() }
