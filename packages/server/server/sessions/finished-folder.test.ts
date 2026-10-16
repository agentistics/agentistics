import { describe, expect, test } from 'bun:test'
import type { SessionUserGroupsValue } from '@agentistics/core'
import { findFinishedFolder, isFinishedFolder, isFinishedFolderName } from './finished-folder'

const V = (groups: SessionUserGroupsValue['groups']): SessionUserGroupsValue => ({ groups })

describe('isFinishedFolderName', () => {
  test('matches Finalizadas / Finished, case-insensitive and trimmed', () => {
    for (const n of ['Finalizadas', 'finalizadas', ' FINISHED ', 'Finished']) expect(isFinishedFolderName(n)).toBe(true)
  })
  test('does not match look-alikes', () => {
    for (const n of ['Finalizada', 'Unfinished', 'Finished work', '', 'Em andamento']) expect(isFinishedFolderName(n)).toBe(false)
  })
})

describe('isFinishedFolder', () => {
  const v = V([
    { id: 'top', name: 'Motor', sessionKeys: [] },
    { id: 'fin', name: 'Finalizadas', sessionKeys: [], parentId: 'top' },
    { id: 'old', name: 'Archive', sessionKeys: [] },
    { id: 'fin2', name: 'Finished', sessionKeys: [] },
    { id: 'kid', name: 'Batch 1', sessionKeys: [], parentId: 'fin2' },
  ])
  test('a folder named finished is finished', () => {
    expect(isFinishedFolder(v, v.groups[1]!)).toBe(true)
    expect(isFinishedFolder(v, v.groups[3]!)).toBe(true)
  })
  test('a folder inside a finished folder is finished', () => {
    expect(isFinishedFolder(v, v.groups[4]!)).toBe(true)
  })
  test('ordinary folders are not', () => {
    expect(isFinishedFolder(v, v.groups[0]!)).toBe(false)
    expect(isFinishedFolder(v, v.groups[2]!)).toBe(false)
  })
})

describe('findFinishedFolder', () => {
  test('prefers the finished child of the folder\'s TOP folder', () => {
    const v = V([
      { id: 'top', name: 'Motor', sessionKeys: [] },
      { id: 'run', name: 'Em andamento', sessionKeys: ['a'], parentId: 'top' },
      { id: 'fin', name: 'Finalizadas', sessionKeys: [], parentId: 'top' },
      { id: 'gfin', name: 'Finished', sessionKeys: [] },
    ])
    expect(findFinishedFolder(v, 'run')?.id).toBe('fin')
    expect(findFinishedFolder(v, 'top')?.id).toBe('fin')
  })
  test('falls back to a top-level finished folder', () => {
    const v = V([
      { id: 'top', name: 'Motor', sessionKeys: [] },
      { id: 'gfin', name: 'finalizadas', sessionKeys: [] },
    ])
    expect(findFinishedFolder(v, 'top')?.id).toBe('gfin')
    expect(findFinishedFolder(v)?.id).toBe('gfin')
    expect(findFinishedFolder(v, 'nope')?.id).toBe('gfin')
  })
  test('a top-level finished folder nested elsewhere is not taken as top-level', () => {
    const v = V([
      { id: 'a', name: 'A', sessionKeys: [] },
      { id: 'afin', name: 'Finalizadas', sessionKeys: [], parentId: 'a' },
      { id: 'b', name: 'B', sessionKeys: [] },
    ])
    expect(findFinishedFolder(v, 'b')).toBeUndefined()
    expect(findFinishedFolder(v, 'afin')?.id).toBe('afin')
  })
  test('none when nothing is named finished', () => {
    expect(findFinishedFolder(V([{ id: 'a', name: 'A', sessionKeys: [] }]), 'a')).toBeUndefined()
  })
})
