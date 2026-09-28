import { describe, expect, it } from 'bun:test'
import { groupDropOutcome } from './sessionGroupDrag'
import type { SessionUserGroupsValue } from '@agentistics/core'

const twoTop: SessionUserGroupsValue = {
  groups: [{ id: 'a', name: 'A', sessionKeys: [] }, { id: 'b', name: 'B', sessionKeys: [] }],
}

describe('groupDropOutcome', () => {
  it('the grip always reorders, whatever the target', () => {
    expect(groupDropOutcome(twoTop, 'grip', 'a', 'b')).toEqual({ action: 'reorder' })
  })

  it('the grip reorders even onto a target the one-level rule would refuse as a nest', () => {
    const nested: SessionUserGroupsValue = {
      groups: [{ id: 'a', name: 'A', sessionKeys: [] }, { id: 'b', name: 'B', sessionKeys: [], parentId: 'a' }],
    }
    expect(groupDropOutcome(nested, 'grip', 'a', 'b')).toEqual({ action: 'reorder' })
  })

  it('the body nests, when the one-level rule allows it', () => {
    expect(groupDropOutcome(twoTop, 'body', 'b', 'a')).toEqual({ action: 'nest', ok: true })
  })

  it('the body is refused with the exact reason when the source already has a child', () => {
    const g: SessionUserGroupsValue = {
      groups: [
        { id: 'a', name: 'A', sessionKeys: [] },
        { id: 'b', name: 'B', sessionKeys: [] },
        { id: 'c', name: 'C', sessionKeys: [], parentId: 'a' },
      ],
    }
    expect(groupDropOutcome(g, 'body', 'a', 'b')).toEqual({ action: 'nest', ok: false, code: 'source_has_children' })
  })

  it('the body is refused when the target is already nested', () => {
    const g: SessionUserGroupsValue = {
      groups: [
        { id: 'a', name: 'A', sessionKeys: [] },
        { id: 'b', name: 'B', sessionKeys: [], parentId: 'a' },
        { id: 'c', name: 'C', sessionKeys: [] },
      ],
    }
    expect(groupDropOutcome(g, 'body', 'c', 'b')).toEqual({ action: 'nest', ok: false, code: 'target_is_nested' })
  })

  it('dragging a folder onto itself is never an action, by either handle', () => {
    expect(groupDropOutcome(twoTop, 'grip', 'a', 'a')).toEqual({ action: 'none' })
    expect(groupDropOutcome(twoTop, 'body', 'a', 'a')).toEqual({ action: 'none' })
  })

  it('a stale id (the source vanished mid-drag) reads as refused, never throws', () => {
    expect(groupDropOutcome(twoTop, 'body', 'ghost', 'a')).toEqual({ action: 'nest', ok: false, code: 'no_such_group' })
  })
})
