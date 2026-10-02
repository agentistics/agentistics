import { describe, expect, it } from 'bun:test'
import { inheritedIdentity } from './reopen-inherit'
import type { ManagedSession } from './types'

const prev: ManagedSession = {
  id: 'old', harness: 'claude', cwd: '/x', createdAt: '2026-01-01T00:00:00Z',
  label: 'Cloud leader', labelSince: 5, note: 'n', task: 'T', taskId: 't-1', subtaskId: 's-1',
  attemptId: 'a-1', harnessName: 'hn', harnessNameSince: 7, conversationId: 'c',
}

describe('inheritedIdentity', () => {
  it('carries label, filing, note and harness name', () => {
    expect(inheritedIdentity(prev)).toEqual({
      label: 'Cloud leader', labelSince: 5, note: 'n', task: 'T', taskId: 't-1',
      subtaskId: 's-1', attemptId: 'a-1', harnessName: 'hn', harnessNameSince: 7,
    })
  })
  it('never carries per-process facts', () => {
    const r = inheritedIdentity(prev) as Record<string, unknown>
    for (const k of ['id', 'createdAt', 'endedAt', 'lastSeenMs', 'conversationId']) expect(k in r).toBe(false)
  })
  it('is empty without a previous row', () => expect(inheritedIdentity(undefined)).toEqual({}))
})

// Every path that mints a new managed id for an existing conversation must be born through
// `inheritedIdentity`. The two that drifted (resume: label + taskId lost; openTask: subtaskId lost)
// are pinned here over the SOURCE, the shape the repo's lint tests use.
describe('every reopen path inherits identity', () => {
  const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text()
  it('resume + reopenEntries hand the replaced row to spawnManaged', async () => {
    const src = await read('../cli-start.ts')
    expect(src).toContain('...inheritedIdentity(req.inherit)')
    expect(src).toContain('inherit: m,')
    expect(src).toContain('...(previous ? { inherit: previous } : {})')
  })
  it('openTask and takeover use it too', async () => {
    const src = await read('./cli-session.ts')
    expect(src).toContain('...inheritedIdentity(m)')
    expect(src).toContain('...inheritedIdentity(previous)')
  })
})
