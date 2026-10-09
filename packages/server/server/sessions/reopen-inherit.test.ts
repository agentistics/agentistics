import { describe, expect, it } from 'bun:test'
import { inheritedIdentity, inheritedLaunch } from './reopen-inherit'
import { planSpawn } from './spawn-spec'
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

describe('inheritedLaunch — a reopen keeps the model and effort', () => {
  it('re-applies both where the harness takes them', () => {
    expect(inheritedLaunch({ ...prev, model: 'sonnet', effort: 'high' }, 'claude')).toEqual({ model: 'sonnet', effort: 'high' })
    expect(inheritedLaunch({ ...prev, harness: 'codex', model: 'm', effort: 'high' }, 'codex')).toEqual({ model: 'm', effort: 'high' })
  })
  it('drops only the option the CLI cannot take', () => {
    expect(inheritedLaunch({ ...prev, model: 'sonnet', effort: 'bogus' }, 'claude')).toEqual({ model: 'sonnet' })
    expect(inheritedLaunch({ ...prev, harness: 'codex', model: 'm', effort: 'bogus' }, 'codex')).toEqual({ model: 'm' })
  })
  it('is empty without a row or without recorded options', () => {
    expect(inheritedLaunch(undefined, 'claude')).toEqual({})
    expect(inheritedLaunch(prev, 'claude')).toEqual({})
  })
  it('the resume argv carries --model / --effort', () => {
    const l = inheritedLaunch({ ...prev, model: 'sonnet', effort: 'high' }, 'claude')
    const plan = planSpawn({ harness: 'claude', cwd: '/x', resumeId: 'c1', ...l })
    expect(plan.ok && plan.plan.argv).toEqual(expect.arrayContaining(['--resume', 'c1', '--model', 'sonnet', '--effort', 'high']))
  })
})

describe('spawnManaged writes the registry row before the session exists', () => {
  it('addSession precedes backend.spawn, and a failed launch removes the row', async () => {
    const src = await Bun.file(new URL('../cli-start.ts', import.meta.url)).text()
    const fn = src.slice(src.indexOf('async function spawnManaged('))
    const add = fn.indexOf('await addSession(await spawnRow(')
    const spawn = fn.indexOf('await backend.spawn(')
    expect(add).toBeGreaterThan(0)
    expect(add).toBeLessThan(spawn)
    expect(fn.match(/await abandon\(\)/g)?.length).toBe(2)
  })
})
