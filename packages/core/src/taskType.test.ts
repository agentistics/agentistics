import { describe, expect, it } from 'bun:test'
import {
  CORE_TYPE_ID, DEFAULT_TASK_TYPES, canDeleteType, coreStatusMigration, isKnownTypeId,
  isValidTypeColor, nextTypeId, planTypeMigration, sortTaskTypes, type TaskTypeDef,
} from './taskType'

describe('DEFAULT_TASK_TYPES', () => {
  it('is exactly CORE', () => {
    expect(DEFAULT_TASK_TYPES.map(t => t.id)).toEqual([CORE_TYPE_ID])
    expect(DEFAULT_TASK_TYPES[0]!.label).toBe('CORE')
  })
})

describe('planTypeMigration', () => {
  it('seeds CORE on a book with no list', () => {
    expect(planTypeMigration({ existing: [], usedTypeIds: [] })!.map(t => t.id)).toEqual(['core'])
    expect(planTypeMigration({ existing: undefined, usedTypeIds: [] })!.map(t => t.id)).toEqual(['core'])
  })
  it('never touches an existing list (a deleted CORE is not re-created)', () => {
    const only: TaskTypeDef[] = [{ id: 'x', label: 'X', color: '#111111', order: 0 }]
    expect(planTypeMigration({ existing: only, usedTypeIds: ['core'] })).toBeNull()
  })
  it('adds an in-use unknown id as an ordinary entry', () => {
    const out = planTypeMigration({ existing: [], usedTypeIds: ['spike', 'core', 'spike', ''] })!
    expect(out.map(t => t.id)).toEqual(['core', 'spike'])
    expect(out[1]).toMatchObject({ label: 'spike', order: 1 })
  })
})

describe('coreStatusMigration', () => {
  it('moves a status=core task to type=core + in_progress', () => {
    expect(coreStatusMigration({ status: 'core' })).toEqual({ status: 'in_progress', type: 'core' })
  })
  it('keeps a type that is already set', () => {
    expect(coreStatusMigration({ status: 'core', type: 'other' })).toEqual({ status: 'in_progress', type: 'other' })
  })
  it('leaves every other task alone, so it is idempotent', () => {
    expect(coreStatusMigration({ status: 'in_progress', type: 'core' })).toBeNull()
    expect(coreStatusMigration({ status: 'todo' })).toBeNull()
  })
})

describe('vocabulary helpers', () => {
  const list: TaskTypeDef[] = [
    { id: 'b', label: 'B', color: '#222222', order: 1 },
    { id: 'a', label: 'A', color: '#111111', order: 1 },
    { id: 'c', label: 'C', color: '#333333', order: 0 },
  ]
  it('sorts by order then id, totally', () => {
    expect(sortTaskTypes(list).map(t => t.id)).toEqual(['c', 'a', 'b'])
  })
  it('knows its ids', () => {
    expect(isKnownTypeId('a', list)).toBe(true)
    expect(isKnownTypeId('zzz', list)).toBe(false)
  })
  it('deletes only while unused', () => {
    expect(canDeleteType({ usageCount: 0 })).toEqual({ ok: true })
    expect(canDeleteType({ usageCount: 2 })).toEqual({ ok: false, reason: 'in_use' })
  })
  it('shares the colour and id rules with statuses', () => {
    expect(isValidTypeColor('#aabbcc')).toBe(true)
    expect(isValidTypeColor('blue')).toBe(false)
    expect(nextTypeId('Deep Work', ['deep_work'])).toBe('deep_work_2')
  })
})
