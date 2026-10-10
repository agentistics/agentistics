import { describe, expect, it } from 'bun:test'
import { fileHandoffInParentGroup, handoffGroupPatch } from './handoff-group'
import { planAdoptions } from './session-adopt'
import { sessionIdentityKey } from '@agentistics/core'
import type { Preferences } from '../preferences'
import type { ManagedSession } from './types'

const prefs = (groups: { id: string; name: string; sessionKeys: string[] }[]) => ({ sessionGroups: { groups } }) as unknown as Preferences

describe('handoff joins the parent folder', () => {
  const parent = { id: 'p1', conversationId: 'conv-p' }

  it('files the child beside the parent', () => {
    const patch = handoffGroupPatch(prefs([{ id: 'g1', name: 'Líderes', sessionKeys: ['conv-p', 'other'] }]), parent, { id: 'c1', conversationId: 'conv-c' })
    expect(patch?.sessionGroups?.groups[0]?.sessionKeys).toEqual(['conv-p', 'other', 'conv-c'])
  })
  it('falls back to the managed id when the child has no conversation yet', () => {
    const patch = handoffGroupPatch(prefs([{ id: 'g1', name: 'x', sessionKeys: ['conv-p'] }]), parent, { id: 'c1' })
    expect(patch?.sessionGroups?.groups[0]?.sessionKeys).toContain('c1')
  })
  it('leaves the child unfiled when the parent is in no folder', () => {
    expect(handoffGroupPatch(prefs([{ id: 'g1', name: 'x', sessionKeys: ['zzz'] }]), parent, { id: 'c1' })).toBeUndefined()
    expect(handoffGroupPatch({} as Preferences, parent, { id: 'c1' })).toBeUndefined()
  })
  it('is a no-op when already a member, and exclusive across folders', () => {
    expect(handoffGroupPatch(prefs([{ id: 'g1', name: 'x', sessionKeys: ['conv-p', 'c1'] }]), parent, { id: 'c1' })).toBeUndefined()
    const patch = handoffGroupPatch(prefs([{ id: 'g1', name: 'x', sessionKeys: ['conv-p'] }, { id: 'g2', name: 'y', sessionKeys: ['c1'] }]), parent, { id: 'c1' })
    expect(patch?.sessionGroups?.groups.map(g => g.sessionKeys)).toEqual([['conv-p', 'c1'], []])
  })
  it('writes through the mutator and never throws', async () => {
    let state = prefs([{ id: 'g1', name: 'x', sessionKeys: ['conv-p'] }])
    const ok = await fileHandoffInParentGroup(parent, { id: 'c1' }, async m => { const p = m(state); if (p) state = { ...state, ...p } })
    expect(ok).toBe(true)
    expect(state.sessionGroups?.groups[0]?.sessionKeys).toEqual(['conv-p', 'c1'])
    expect(await fileHandoffInParentGroup(parent, { id: 'c1' }, async () => { throw new Error('boom') })).toBe(false)
  })
})

describe('adoption keeps the folder', () => {
  it('an adopted row has the predecessor\'s identity key, so its group membership holds', () => {
    const prior = { id: 'old', harness: 'claude', cwd: '/x', createdAt: '2026-01-01T00:00:00Z', conversationId: 'conv-1', taskId: 't1' } as ManagedSession
    const [row] = planAdoptions({
      rows: [{ id: 'new', status: 'unregistered' }],
      byManagedId: new Map([['new', { cwd: '/x', sessionId: 'conv-1' } as never]]),
      registry: [prior], harness: 'claude', nowIso: '2026-01-02T00:00:00Z',
    })
    expect(sessionIdentityKey(row!)).toBe(sessionIdentityKey(prior))
    expect(row!.taskId).toBe('t1')
  })
})
