/** Carry preferences across sessionIdentityKey's managed-id → conversation-id transition. */
import { updatePreferences, type Preferences } from '../preferences'
import { rekeyStoredRoleBatch } from './session-roles'
import { isServerProcess } from './shared-snapshot'
import { PORT } from '../config'
import type { SessionRegistry } from './registry'

export interface ConversationIdentity { id: string; conversationId?: string }
export interface IdentityPrefsDeps {
  update: typeof updatePreferences
  roles: (links: ReadonlyMap<string, string>) => Promise<void>
  notify?: () => Promise<void>
}
const defaults: IdentityPrefsDeps = {
  update: updatePreferences,
  roles: async links => { await rekeyStoredRoleBatch(links) },
  notify: async () => {
    if (isServerProcess()) {
      const { broadcastSessionGroupsChanged } = await import('../sse')
      broadcastSessionGroupsChanged()
    } else {
      await fetch(`http://127.0.0.1:${PORT}/api/session-groups-broadcast`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        signal: AbortSignal.timeout(1500),
      })
    }
  },
}

/** One locked preferences update for the whole registry, including startup orphan repair.
 * Roles live in their own store. Each store is best effort: neither can prevent a durable link.
 * Open tabs live per browser; ui.sessionTabs is only a feature flag, not session keys.
 */
export async function rekeySessionIdentities(
  rows: readonly ConversationIdentity[], deps: IdentityPrefsDeps = defaults,
): Promise<void> {
  const links = new Map(rows.filter(r => r.id && r.conversationId && r.id !== r.conversationId)
    .map(r => [r.id, r.conversationId!]))
  if (!links.size) return
  let changed = false
  await deps.update(cur => {
    const patch: Partial<Preferences> = {}
    const swap = (keys: string[]) => [...new Set(keys.map(k => links.get(k) ?? k))]
    for (const field of ['pinnedSessions', 'mutedSessions'] as const) {
      const keys = cur[field]
      if (keys?.some(k => links.has(k))) patch[field] = swap(keys)
    }
    if (cur.sessionGroups?.groups.some(g => g.sessionKeys.some(k => links.has(k)))) {
      patch.sessionGroups = { ...cur.sessionGroups, groups: cur.sessionGroups.groups.map(g => ({
        ...g, sessionKeys: swap(g.sessionKeys),
      })) }
    }
    if (cur.checkin && [...links.keys()].some(k => cur.checkin![k] !== undefined)) {
      const checkin = { ...cur.checkin }
      for (const [from, to] of links) {
        if (cur.checkin[from] === undefined) continue
        checkin[to] = { ...cur.checkin[from] as Record<string, unknown>, session: to }
        delete checkin[from]
      }
      patch.checkin = checkin
    }
    const book = cur.ui?.floatingPanels as { v?: unknown; sessions?: Record<string, { at?: number }> } | undefined
    if (book?.v === 1 && book.sessions && [...links.keys()].some(k => book.sessions![k] !== undefined)) {
      const sessions = { ...book.sessions }
      for (const [from, to] of links) {
        const source = book.sessions[from]
        if (!source) continue
        // Keep the most recently arranged windows when both keys have a layout.
        if (!sessions[to] || (source.at ?? 0) >= (sessions[to]!.at ?? 0)) sessions[to] = source
        delete sessions[from]
      }
      patch.ui = { ...cur.ui, floatingPanels: { ...book, sessions } }
    }
    changed = Object.keys(patch).length > 0
    return changed ? patch : undefined
  }).then(async () => { if (changed) await deps.notify?.() }).catch(() => {})
  await deps.roles(links).catch(() => {})
}

/** The production registry's link boundary: all server/CLI writers share this wrapper.
 * The server repairs old links once in the background; short-lived CLI readers skip that scan.
 * Writes still await their own repair after the registry link is durable. Raw registry
 * operations stay independent of preferences (including tests and their temporary registries).
 */
export function withIdentityPreferences(
  registry: SessionRegistry,
  rekey: (rows: readonly ConversationIdentity[]) => Promise<void> = rekeySessionIdentities,
  options: {
    /** Evaluated on read: the server role can be set after the registry module is imported. */
    readRepair?: () => boolean
    backgroundReadRepair?: boolean
    onReadRepair?: () => void | Promise<void>
  } = {},
): SessionRegistry {
  const repair = (rows: readonly ConversationIdentity[]) => Promise.resolve().then(() => rekey(rows)).catch(() => {})
  let healed: Promise<void> | undefined
  return {
    ...registry,
    async read() {
      const rows = await registry.read()
      if (options.readRepair && !options.readRepair()) return rows
      healed ??= (() => {
        const started = performance.now()
        return repair(rows).finally(async () => {
          // stderr: a timing diagnostic that lands AFTER the caller has moved on (the repair is not
          // awaited), so on stdout it could follow a CLI verb's or a test script's JSON output.
          if (options.backgroundReadRepair) console.error(`[boot-fleet] identity repair (background): ${Math.round(performance.now() - started)} ms`)
          await Promise.resolve().then(options.onReadRepair).catch(() => {})
        })
      })()
      if (!options.backgroundReadRepair) await healed
      return rows
    },
    async remove(id) {
      await healed
      return registry.remove(id)
    },
    async add(row) {
      await healed
      await registry.add(row)
      await repair([row])
    },
    async adopt(rows) {
      await healed
      await registry.adopt(rows)
      // Adoption fills missing fields; use the actual persisted links, not stale input records.
      const ids = new Set(rows.map(r => r.id))
      await repair((await registry.read()).filter(r => ids.has(r.id)))
    },
    async patch(id, patch) {
      await healed
      const matched = await registry.patch(id, patch)
      if (matched && patch.conversationId) await repair([{ id, conversationId: patch.conversationId }])
      return matched
    },
    async link(id, patch, opts) {
      await healed
      const outcome = await registry.link(id, patch, opts)
      if (outcome.ok) await repair([{ id, conversationId: patch.conversationId }])
      return outcome
    },
    async patchMany(ids, patch) {
      await healed
      const matched = await registry.patchMany(ids, patch)
      if (matched && patch.conversationId) {
        const wanted = new Set(ids)
        await repair((await registry.read()).filter(r => wanted.has(r.id)))
      }
      return matched
    },
  }
}
