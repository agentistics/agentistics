/**
 * owner-ledger.ts — FLUXO.AVISOS: which owner messages the host has ALREADY sent to the request bus.
 *
 * The engine's pedido id is `hash(conversation, at, text)`. A message the owner typed in the composer carries the
 * composer's clock and the conversation of whichever session the composer resolved to; the hand-off relay replays the
 * same message later from the TRANSCRIPT of the session it was typed into, with that transcript's clock (minutes off
 * when the turn was queued) and that session's conversation. One message, two ids, two "Pedido do dono" subtasks ~20 s
 * apart while two leaders were alive on the task.
 *
 * The ledger is keyed on a SCOPE (`conv:<conversation>` or `task:<task>`) + a hash of the text, with NO per-session
 * identity in the key: it answers "did this exact message already go to the bus?" however many sessions saw it.
 *  - relay: any earlier entry in the conversation it came from, however old, is a duplicate;
 *  - composer: an entry in the same task within `DUPLICATE_WINDOW_MS` is a duplicate (the same words sent twice in
 *    ten minutes are one request; "continue" a day later are two).
 *
 * `<dataDir>/owner-messages.json`, newest `LEDGER_MAX` entries, written under the cross-process file lock.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock } from '../sessions/file-lock'

export const LEDGER_MAX = 2_000
export const DUPLICATE_WINDOW_MS = 10 * 60_000

export interface LedgerDoc { version: 1; entries: Record<string, string> }

/** PURE. The stable key of one message in one scope (whitespace-insensitive). */
export function ledgerKey(scope: string, text: string): string {
  const norm = text.replace(/\s+/g, ' ').trim()
  return `${scope}:${createHash('sha256').update(norm).digest('hex').slice(0, 16)}`
}
export const convScope = (conversationId: string) => `conv:${conversationId}`
export const taskScope = (taskId: string) => `task:${taskId}`

/** PURE. Oldest entries leave first once the ledger is over its cap. */
export function pruneLedger(entries: Record<string, string>, max = LEDGER_MAX): Record<string, string> {
  const keys = Object.keys(entries)
  if (keys.length <= max) return entries
  const keep = keys.sort((a, b) => (Date.parse(entries[b]!) || 0) - (Date.parse(entries[a]!) || 0)).slice(0, max)
  return Object.fromEntries(keep.map(k => [k, entries[k]!]))
}

export function defaultLedgerPath(): string {
  const dir = process.env.AGENTISTICS_DIR ?? join(process.env.HOME ?? '', '.agentistics')
  return join(dir, 'owner-messages.json')
}

async function readDoc(path: string): Promise<LedgerDoc> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
    const entries = raw && typeof raw === 'object' && typeof (raw as LedgerDoc).entries === 'object' && (raw as LedgerDoc).entries ? (raw as LedgerDoc).entries : {}
    return { version: 1, entries: Object.fromEntries(Object.entries(entries).filter(([, v]) => typeof v === 'string')) }
  } catch { return { version: 1, entries: {} } }
}

export interface OwnerLedger {
  /** Was this text already recorded in `scope`? With `withinMs`, only entries from the last `withinMs` count. */
  has(scope: string, text: string, now?: number, withinMs?: number): Promise<boolean>
  add(scopes: readonly string[], text: string, at: string): Promise<void>
}

export function createOwnerLedger(path = defaultLedgerPath()): OwnerLedger {
  return {
    async has(scope, text, now = Date.now(), withinMs) {
      const at = (await readDoc(path)).entries[ledgerKey(scope, text)]
      if (at === undefined) return false
      if (withinMs === undefined) return true
      const t = Date.parse(at)
      return Number.isFinite(t) && Math.abs(now - t) <= withinMs
    },
    async add(scopes, text, at) {
      await mkdir(dirname(path), { recursive: true })
      await withFileLock(path, async () => {
        const doc = await readDoc(path)
        for (const scope of scopes) doc.entries[ledgerKey(scope, text)] = at
        const tmp = `${path}.${process.pid}.tmp`
        await writeFile(tmp, JSON.stringify({ version: 1, entries: pruneLedger(doc.entries) }) + '\n', { mode: 0o600 })
        await rename(tmp, path)
      })
    },
  }
}
