import type { StartHost } from '../cli-start'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'

const ROW_TTL_MS = 2_000
export const MAX_ROW_ENTRIES = 256
const LOAD_TIMEOUT_MS = 10_000

type Resolution = { exact?: ControlSession; referenced?: ControlSession }
type Entry = { promise: Promise<Resolution>; expires: number; pending: boolean }

/** One fleet walk supplies the row and its cwd to every detail reader in an open burst. */
export function createSessionRowCache(now = Date.now, revision: () => unknown = () => undefined, timeoutMs = LOAD_TIMEOUT_MS) {
  const entries = new Map<string, Entry>()
  const sources = new WeakMap<StartHost, number>()
  let nextSource = 0
  let pending = 0
  let seenRevision: unknown = undefined
  function clear() { entries.clear(); seenRevision = revision() }
  function trim() {
    for (const [key, value] of entries) {
      if (!value.pending && now() >= value.expires) entries.delete(key)
    }
  }
  return {
    clear,
    get size() { return entries.size },
    async resolve(host: StartHost, ref: string, conversationRef = false): Promise<ControlSession | undefined> {
      const current = revision()
      if (current !== seenRevision) clear()
      trim()
      let source = sources.get(host)
      if (source === undefined) { source = nextSource++; sources.set(host, source) }
      // Keep the complete localized row attached to its canonical source and language.
      const key = JSON.stringify([source, host.lang, ref])
      let entry = entries.get(key)
      if (!entry) {
        if (pending >= MAX_ROW_ENTRIES) throw new Error('Session row resolution capacity exceeded')
        if (entries.size >= MAX_ROW_ENTRIES) {
          for (const [oldKey, value] of entries) {
            if (!value.pending) { entries.delete(oldKey); break }
          }
        }
        if (entries.size >= MAX_ROW_ENTRIES) throw new Error('Session row resolution capacity exceeded')
        pending++
        let timer: ReturnType<typeof setTimeout>
        const load = Promise.resolve().then(async () => {
          const fleet = await host.sessions?.()
          return {
            exact: fleet?.sessions.find(row => row.id === ref),
            referenced: fleet?.sessions.find(row => row.id === ref || row.conversationId === ref),
          }
        })
        // A caller deadline cannot cancel sessions(). Keep its admission slot occupied until
        // the actual load settles, including after cache invalidation or a caller timeout.
        void load.then(() => { pending-- }, () => { pending-- })
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Session row resolution timed out')), timeoutMs)
          timer.unref?.()
        })
        const promise = Promise.race([load, deadline])
        entry = { promise, pending: true, expires: Infinity }
        entries.set(key, entry)
        const inserted = entry
        void promise.then(() => {
          clearTimeout(timer)
          inserted.pending = false
          inserted.expires = now() + ROW_TTL_MS
          trim()
        }, () => {
          clearTimeout(timer)
          if (entries.get(key) === inserted) entries.delete(key)
          trim()
        })
      }
      const resolved = await entry.promise
      return conversationRef ? resolved.referenced : resolved.exact
    },
  }
}

type RowCache = Pick<ReturnType<typeof createSessionRowCache>, 'clear' | 'resolve'>
const caches = new WeakMap<StartHost, RowCache>()

/** Registered hosts remain distinct canonical sources even when using the same cache. */
export function shareSessionRowCache(host: StartHost, cache: RowCache): void {
  caches.set(host, cache)
}

function binding(host: StartHost): { host: StartHost; cache: RowCache } {
  let parent = host
  let cache = caches.get(parent)
  while (!cache && (parent = Object.getPrototypeOf(parent))) cache = caches.get(parent)
  if (!cache) {
    cache = createSessionRowCache()
    caches.set(host, cache)
  }
  return { host: parent || host, cache }
}

export function invalidateSessionRowCache(host: StartHost): void {
  binding(host).cache.clear()
}

export function resolveSessionRow(host: StartHost, ref: string, conversationRef = false) {
  const canonical = binding(host)
  return canonical.cache.resolve(canonical.host, ref, conversationRef)
}

/** The production chat stream's five-second fleet memo, with explicit shared freshness. */
export function createChatRowHost(host: StartHost, ttlMs = 5_000, now = Date.now) {
  binding(host)
  const memo = Object.create(host) as StartHost
  let rowAt = 0
  let rows: ReturnType<NonNullable<StartHost['sessions']>> | null = null
  if (host.sessions) {
    memo.sessions = () => {
      if (!rows || now() - rowAt >= ttlMs) {
        rowAt = now()
        const loaded = host.sessions!.call(host)
        rows = loaded
        void loaded.catch(() => { if (rows === loaded) rows = null })
      }
      return rows!
    }
  }
  return { host: memo, fresh() { rows = null; invalidateSessionRowCache(host) } }
}
