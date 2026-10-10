import { describe, expect, test } from 'bun:test'
import { buildInventory, orphanReason, type ProcEntry } from './inventory'

const entry = (o: Partial<ProcEntry>): ProcEntry => ({
  pid: 10, ppid: 5, argv: ['/usr/bin/agentop', 'mcp'], exe: '/usr/bin/agentop', rssBytes: 1, swapBytes: 0,
  cpuPercent: 0, ageSec: 1, env: {}, ...o,
})
const ctx = { selfPid: 1, alive: () => true, helpers: new Map() }

describe('orphanReason', () => {
  test('ppid 1 on an mcp/cli is an orphan; on a server/watch it is not', () => {
    expect(orphanReason('mcp', { ppid: 1 })).toBe('parent-gone')
    expect(orphanReason('cli', { ppid: 1 })).toBe('parent-gone')
    expect(orphanReason('server', { ppid: 1 })).toBeUndefined()
    expect(orphanReason('watch', { ppid: 1 })).toBeUndefined()
  })
  test('a deleted cwd wins', () => {
    expect(orphanReason('cli', { ppid: 7, cwdGone: true })).toBe('cwd-deleted')
  })
})

describe('owner mapping', () => {
  test('an mcp carries the managed id found up its parent chain', () => {
    const [p] = buildInventory([entry({ ancestorManagedId: 'abc123' })], ctx)
    expect(p!.managedId).toBe('abc123')
    expect(p!.orphanWhy).toBeUndefined()
  })
  test('an orphaned relay is flagged', () => {
    const [p] = buildInventory([entry({ argv: ['/usr/bin/agentop', '__structured-relay'], ppid: 1 })], ctx)
    expect(p!.kind).toBe('cli')
    expect(p!.orphanWhy).toBe('parent-gone')
  })
})
