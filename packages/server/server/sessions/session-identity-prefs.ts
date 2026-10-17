/** Carry preferences across sessionIdentityKey's managed-id → conversation-id transition. */
import { updatePreferences, type Preferences } from '../preferences'
import { defaultRoleDeps, loadRoles, rekeyStoredRole } from './session-roles'
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
  roles: async links => {
    const deps = await defaultRoleDeps()
    const doc = await loadRoles(deps)
    for (const [from, to] of links) {
      if (doc.roles[from] || doc.lastDeliveredRole?.[from]) {
        await rekeyStoredRole([from], [from, to], deps).catch(() => {})
      }
    }
  },
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
 * The first read repairs old links once, before the fleet publishes its snapshot. Raw registry
 * operations stay independent of preferences (including tests and their temporary registries).
 */
export function withIdentityPreferences(
  registry: SessionRegistry,
  rekey: (rows: readonly ConversationIdentity[]) => Promise<void> = rekeySessionIdentities,
): SessionRegistry {
  const repair = (rows: readonly ConversationIdentity[]) => Promise.resolve().then(() => rekey(rows)).catch(() => {})
  let healed: Promise<void> | undefined
  return {
    ...registry,
    async read() {
      const rows = await registry.read()
      healed ??= repair(rows)
      await healed
      return rows
    },
    async add(row) {
      await registry.add(row)
      await repair([row])
    },
    async adopt(rows) {
      await registry.adopt(rows)
      // Adoption fills missing fields; use the actual persisted links, not stale input records.
      const ids = new Set(rows.map(r => r.id))
      await repair((await registry.read()).filter(r => ids.has(r.id)))
    },
    async patch(id, patch) {
      const matched = await registry.patch(id, patch)
      if (matched && patch.conversationId) await repair([{ id, conversationId: patch.conversationId }])
      return matched
    },
    async link(id, patch, opts) {
      const outcome = await registry.link(id, patch, opts)
      if (outcome.ok) await repair([{ id, conversationId: patch.conversationId }])
      return outcome
    },
    async patchMany(ids, patch) {
      const matched = await registry.patchMany(ids, patch)
      if (matched && patch.conversationId) {
        const wanted = new Set(ids)
        await repair((await registry.read()).filter(r => wanted.has(r.id)))
      }
      return matched
    },
  }
}
