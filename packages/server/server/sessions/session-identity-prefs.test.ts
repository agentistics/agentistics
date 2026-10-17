import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Preferences } from '../preferences'
import { createSessionRegistry } from './registry'
import { linkProcessConversation } from './sessions-host'
import { rekeySessionIdentities, withIdentityPreferences, type IdentityPrefsDeps } from './session-identity-prefs'

function fixture() {
  const prefs = {
    pinnedSessions: ['mid', 'conv', 'other'], mutedSessions: ['mid'],
    sessionGroups: { groups: [{ id: 'g', name: 'Work', sessionKeys: ['mid', 'other'] }] },
    checkin: { mid: { session: 'mid', intervalMin: 15 } },
    ui: { floatingPanels: { v: 1, sessions: { mid: { at: 5, windows: {} } } }, sessionTabs: true },
  } as Preferences
  const roles: Record<string, string> = { mid: 'worker', other: 'leader' }
  let writes = 0, updates = 0
  const deps: IdentityPrefsDeps = {
    update: async mutate => {
      updates++
      const patch = mutate(prefs)
      if (patch) { writes++; Object.assign(prefs, patch) }
      return prefs
    },
    roles: async links => {
      for (const [from, to] of links) {
        if (!roles[from]) continue
        roles[to] = roles[from]!
      }
    },
  }
  return { prefs, roles, deps, writes: () => writes, updates: () => updates }
}
const row = (id: string, conversationId?: string) => ({
  id, ...(conversationId ? { conversationId } : {}), harness: 'codex' as const,
  cwd: '/tmp', createdAt: '2026-10-17T12:00:00Z',
})

describe('session identity preferences', () => {
  test('the production registry used by server link callbacks is wrapped', async () => {
    const source = await readFile(new URL('./registry.ts', import.meta.url), 'utf8')
    expect(source).toContain('const defaultRegistry = withIdentityPreferences(createSessionRegistry(MANAGED_SESSIONS_FILE))')
  })

  test('notifies once for a change and preserves a newer destination layout', async () => {
    const f = fixture()
    const book = f.prefs.ui!.floatingPanels as { sessions: Record<string, unknown> }
    book.sessions.conv = { at: 10, windows: { live: { x: 1 } } }
    let signals = 0
    const deps = { ...f.deps, notify: async () => { signals++ } }
    await rekeySessionIdentities([row('mid', 'conv')], deps)
    await rekeySessionIdentities([row('mid', 'conv')], deps)
    expect(signals).toBe(1)
    expect((f.prefs.ui!.floatingPanels as typeof book).sessions).toEqual({ conv: { at: 10, windows: { live: { x: 1 } } } })
  })

  test('moves member, pin, mute, agenda, role and floating layout; repeats do not write', async () => {
    const f = fixture()
    await rekeySessionIdentities([row('mid', 'conv')], f.deps)
    expect(f.prefs.sessionGroups!.groups[0]!.sessionKeys).toEqual(['conv', 'other'])
    expect(f.prefs.pinnedSessions).toEqual(['conv', 'other'])
    expect(f.prefs.mutedSessions).toEqual(['conv'])
    expect(f.prefs.checkin).toEqual({ conv: { session: 'conv', intervalMin: 15 } })
    expect(f.roles).toEqual({ mid: 'worker', conv: 'worker', other: 'leader' })
    expect(f.prefs.ui).toEqual({ floatingPanels: { v: 1, sessions: { conv: { at: 5, windows: {} } } }, sessionTabs: true })
    await rekeySessionIdentities([row('mid', 'conv')], f.deps)
    expect(f.writes()).toBe(1)
  })

  test('equal, missing and empty ids do nothing', async () => {
    const f = fixture()
    await rekeySessionIdentities([row('mid', 'mid'), row('missing'), row('', 'conv')], f.deps)
    expect(f.updates()).toBe(0)
    expect(f.roles.mid).toBe('worker')
  })

  test('preference failure still migrates roles', async () => {
    const f = fixture()
    await rekeySessionIdentities([row('mid', 'conv')], { ...f.deps, update: async () => { throw Error('locked') } })
    expect(f.roles.conv).toBe('worker')
  })

  test('first registry read heals orphan keys in one update, preserving unrelated keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'folder-rekey-'))
    try {
      const raw = createSessionRegistry(join(dir, 'sessions.json'))
      await raw.add(row('mid', 'conv'))
      await raw.add(row('healthy', 'healthy-conv'))
      await raw.add(row('unlinked'))
      const f = fixture()
      const registry = withIdentityPreferences(raw, rows => rekeySessionIdentities(rows, f.deps))
      await Promise.all([registry.read(), registry.read()])
      expect(f.updates()).toBe(1)
      expect(f.prefs.sessionGroups!.groups[0]!.sessionKeys).toEqual(['conv', 'other'])
      expect(f.roles.other).toBe('leader')
      await registry.read()
      expect(f.updates()).toBe(1)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  test('add, adopt and bulk patch use persisted links, including adoption conflicts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'folder-rekey-'))
    try {
      const raw = createSessionRegistry(join(dir, 'sessions.json'))
      const calls: unknown[] = []
      const registry = withIdentityPreferences(raw, async rows => { calls.push(rows) })
      await registry.add(row('added', 'conv-a'))
      await raw.add(row('adopted'))
      await registry.adopt([row('adopted', 'conv-b'), row('added', 'stale')])
      expect(calls[1]).toEqual(expect.arrayContaining([row('added', 'conv-a'), row('adopted', 'conv-b')]))
      await registry.patchMany(['added', 'absent'], { conversationId: 'conv-c' })
      expect(calls[2]).toEqual([row('added', 'conv-c')])
      await registry.patch('added', { label: 'Title' })
      await registry.patch('absent', { conversationId: 'conv-d' })
      expect(calls).toHaveLength(3)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  test('server process-link path migrates only after the registry link is durable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'folder-rekey-'))
    try {
      const raw = createSessionRegistry(join(dir, 'sessions.json'))
      await raw.add(row('mid'))
      const f = fixture()
      const registry = withIdentityPreferences(raw, async rows => {
        expect((await raw.read())[0]!.conversationId).toBe('conv')
        await rekeySessionIdentities(rows, f.deps)
      })
      const linked = await linkProcessConversation({
        id: 'mid', harness: 'codex', pid: 123,
        readProcessConversation: async () => 'conv',
        recordConversation: (id, conversationId, conversationLink, conversationLinkVia) =>
          registry.patch(id, { conversationId, conversationLink, ...(conversationLinkVia ? { conversationLinkVia } : {}) }),
      })
      expect(linked).toBe(true)
      expect(f.prefs.mutedSessions).toEqual(['conv'])
      expect(f.prefs.sessionGroups!.groups[0]!.sessionKeys).toContain('conv')
      expect(f.roles.conv).toBe('worker')
      const failing = withIdentityPreferences(raw, async () => { throw Error('prefs unavailable') })
      expect(await failing.patch('mid', { conversationId: 'next' })).toBe(true)
      expect((await raw.read())[0]!.conversationId).toBe('next')
      expect(await failing.patch('absent', { conversationId: 'x' })).toBe(false)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
