import { describe, expect, test } from 'bun:test'
import { memoryGroups, type MemoryFactWire } from './memoryView'

const f = (p: Partial<MemoryFactWire>): MemoryFactWire => ({ chainId: 'mem_1', factId: 'mem_1', scope: 'repo', repoKey: 'github.com/o/r', category: 'convention', statement: 'x', origin: 'person', validFrom: '2026-10-01T00:00:00Z', validTo: null, ...p })

describe('B6.6: the memory page groups', () => {
  test('one row per fact with what it replaced; repositories before the person', () => {
    const groups = memoryGroups([
      f({ factId: 'v1', statement: 'Postgres.', validTo: '2026-10-02T00:00:00Z' }),
      f({ factId: 'v2', statement: 'SQLite.', validFrom: '2026-10-02T00:00:00Z' }),
      f({ chainId: 'mem_2', factId: 'mem_2', scope: 'person', repoKey: undefined, category: 'preference', statement: 'PT answers.' }),
      f({ chainId: 'mem_3', factId: 'mem_3', repoKey: 'path:/home/u/notes', statement: 'Plain folder.' }),
    ], 'pt')
    expect(groups.map(g => g.label)).toEqual(['/home/u/notes', 'github.com/o/r', 'Sobre você'])
    const repo = groups.find(g => g.label === 'github.com/o/r')!
    expect(repo.rows).toHaveLength(1)
    expect(repo.rows[0]).toMatchObject({ statement: 'SQLite.', history: [{ statement: 'Postgres.', from: '2026-10-01', to: '2026-10-02' }] })
  })
})
