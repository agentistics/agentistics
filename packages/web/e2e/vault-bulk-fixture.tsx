import React, { useState } from 'react'
import { SecretsArea, type usePersonalVault } from '../src/pages/VaultPage'
import type { PersonalGroup, PersonalMeta } from '../src/lib/vaultPersonal'
import type { Gated } from '../src/pages/vault/VaultAreas'

export const fakeItems = (): PersonalMeta[] => ['Demo Alpha', 'Demo Beta', 'Demo Gamma', 'Other entry'].map((name, i) => ({
  id: `pi_demo${i}`, name, kind: 'note', groupId: null, tags: [], notes: '', url: '', fields: ['value'],
  createdAt: '2026-11-10T12:00:00Z', updatedAt: '2026-11-10T12:00:00Z', version: 1, deletedAt: null,
}))
export const fakeGroup: PersonalGroup = { id: 'pg_demo', name: 'Equipe', version: 1, createdAt: '', updatedAt: '' }

/** In-memory metadata only: this fixture never contacts a running vault or handles real values. */
export function fakeVaultFetch(partial = false) {
  const stored = fakeItems()
  const calls: Record<string, unknown>[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    if (path.endsWith('/personal/move')) {
      calls.push(body)
      const item = stored.find(m => m.id === body.id)!
      if (partial && item.name === 'Demo Beta') return Response.json({ ok: false, code: 'stale-version', sentence: 'Atualizado em outra janela' }, { status: 409 })
      Object.assign(item, { groupId: body.groupId, version: item.version + 1 })
      return Response.json({ ok: true, meta: { ...item } })
    }
    if (path.endsWith('/personal/groups')) return Response.json({ ok: true, group: { ...fakeGroup, id: 'pg_created', name: body.name } })
    return Response.json({ ok: true })
  }) as typeof fetch
  return { fetcher, stored, calls }
}

export function VaultBulkFixture({ mobile = false }: { mobile?: boolean }) {
  const [items, setItems] = useState(fakeItems)
  const [groups, setGroups] = useState([fakeGroup])
  const gated: Gated = call => call()
  const personal = { items, setItems, groups, setGroups, gated, load: async () => {},
    systemItems: [{ kind: 'codex', file: 'synthetic-system-entry', state: 'sealed' }],
  } as ReturnType<typeof usePersonalVault>
  return <main style={{ maxWidth: 1000, margin: '0 auto', padding: 16 }}>
    <h1>Cofre</h1><SecretsArea lang="pt" isMobile={mobile} personal={personal} pending={0} onFlash={() => {}} />
    <output data-fixture-groups style={{ display: 'none' }}>{JSON.stringify(items.map(m => ({ name: m.name, groupId: m.groupId })))}</output>
  </main>
}
