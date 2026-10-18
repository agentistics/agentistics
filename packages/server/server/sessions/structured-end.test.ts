import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionRegistry } from './registry'
import { planCrashGroup } from './crash-group'
import { durableStore } from './structured-durable'
import { withStructured } from './structured-backend'
import type { ManagedSession, SessionBackend } from './types'

const entry = (id: string): ManagedSession => ({
  id, harness: 'codex', cwd: '/tmp', createdAt: '2026-08-12T10:00:00.000Z', lastSeenMs: Date.now(),
})

test('structured boot records relay exits before removing them, and leaves genuine losses eligible', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'structured-end-'))
  try {
    const store = durableStore(join(dir, 'structured'))
    for (const id of ['done', 'fell']) {
      await mkdir(store.dirOf(id), { recursive: true })
      await writeFile(join(store.dirOf(id), 'spawn.json'), '{}')
    }
    await writeFile(join(store.dirOf('done'), 'exit.json'), JSON.stringify({ code: 0, at: Date.now() }))
    const registry = createSessionRegistry(join(dir, 'registry.json'))
    await registry.add(entry('done'))
    await registry.add(entry('fell'))
    const backend = withStructured({} as SessionBackend, {
      structured: async () => null, acp: async () => null, allowed: async () => [], durable: store,
      onEnded: async id => {
        expect(store.endedAt?.(id)).not.toBeNull()
        await registry.patch(id, { endedAt: store.endedAt!(id)! })
      },
    })
    await backend.reattach()
    expect(planCrashGroup({ entries: await registry.read(), backendIds: new Set() })?.entries.map(e => e.id)).toEqual(['fell'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})
