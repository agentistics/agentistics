/**
 * memoryView.ts — PURE. The native runtime's memory (`GET /api/memory`, B6.6) as the settings page
 * shows it: one row per FACT (its chain), the current version first, the versions it replaced below,
 * grouped by where it applies — each repository, then the person.
 */
export interface MemoryFactWire {
  chainId: string
  factId: string
  scope: 'repo' | 'person'
  repoKey?: string
  category: string
  statement: string | null
  origin: 'person' | 'model' | 'derived'
  validFrom: string
  validTo: string | null
}

export interface MemoryRow {
  chainId: string
  category: string
  statement: string | null
  origin: MemoryFactWire['origin']
  since: string
  history: { statement: string | null; from: string; to: string }[]
}

export interface MemoryGroup { key: string; scope: 'repo' | 'person'; label: string; rows: MemoryRow[] }

export function memoryGroups(facts: readonly MemoryFactWire[], lang: 'pt' | 'en'): MemoryGroup[] {
  const chains = new Map<string, MemoryFactWire[]>()
  for (const f of facts) chains.set(f.chainId, [...(chains.get(f.chainId) ?? []), f])
  const groups = new Map<string, MemoryGroup>()
  for (const versions of chains.values()) {
    const sorted = [...versions].sort((a, b) => (a.validFrom < b.validFrom ? 1 : -1))
    const cur = sorted.find(v => v.validTo === null) ?? sorted[0]!
    const key = cur.scope === 'person' ? 'person' : `repo:${cur.repoKey ?? ''}`
    const label = cur.scope === 'person' ? (lang === 'pt' ? 'Sobre você' : 'About you') : (cur.repoKey ?? '?').replace(/^path:/, '')
    const g = groups.get(key) ?? { key, scope: cur.scope, label, rows: [] }
    g.rows.push({
      chainId: cur.chainId, category: cur.category, statement: cur.statement, origin: cur.origin, since: cur.validFrom.slice(0, 10),
      history: sorted.filter(v => v !== cur).map(v => ({ statement: v.statement, from: v.validFrom.slice(0, 10), to: (v.validTo ?? '').slice(0, 10) })),
    })
    groups.set(key, g)
  }
  for (const g of groups.values()) g.rows.sort((a, b) => (a.since < b.since ? 1 : -1))
  return [...groups.values()].sort((a, b) => (a.scope === b.scope ? a.label.localeCompare(b.label) : a.scope === 'repo' ? -1 : 1))
}
