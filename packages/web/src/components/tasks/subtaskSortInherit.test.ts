import { describe, expect, it } from 'bun:test'
import type { SortKey, SortSpec, SubtaskSortSpec } from '@agentistics/core'
import { effectiveSubtaskSort, inheritedSubtaskSort, pickSubtaskSort } from './subtaskSortInherit'

const main = (key: SortKey, dir: 'asc' | 'desc' = 'asc'): SortSpec => ({ key, dir })

// --- inheritedSubtaskSort ------------------------------------------------------------------------

describe('inheritedSubtaskSort', () => {
  it('maps every column that genuinely corresponds, keeping the direction', () => {
    expect(inheritedSubtaskSort(main('status', 'desc'))).toEqual({ key: 'status', dir: 'desc' })
    expect(inheritedSubtaskSort(main('sessions'))).toEqual({ key: 'sessions', dir: 'asc' })
    expect(inheritedSubtaskSort(main('rounds', 'desc'))).toEqual({ key: 'rounds', dir: 'desc' })
    expect(inheritedSubtaskSort(main('cost'))).toEqual({ key: 'cost', dir: 'asc' })
    expect(inheritedSubtaskSort(main('tokens', 'desc'))).toEqual({ key: 'tokens', dir: 'desc' })
    expect(inheritedSubtaskSort(main('started'))).toEqual({ key: 'started', dir: 'asc' })
    expect(inheritedSubtaskSort(main('title', 'desc'))).toEqual({ key: 'title', dir: 'desc' })
  })

  it('maps "delivered" to the subtask\'s own "completed" — the same fact one level apart', () => {
    expect(inheritedSubtaskSort(main('delivered', 'desc'))).toEqual({ key: 'completed', dir: 'desc' })
  })

  it('is null for every column with no subtask equivalent', () => {
    const unmapped: SortKey[] = [
      'manual', 'priority', 'due', 'created', 'updated', 'attempts', 'comments', 'subtasks',
      'progress', 'harnesses',
    ]
    for (const key of unmapped) expect(inheritedSubtaskSort(main(key))).toBeNull()
  })
})

// --- effectiveSubtaskSort -------------------------------------------------------------------------

describe('effectiveSubtaskSort', () => {
  it('an explicit override always wins, whatever the main table is doing', () => {
    const override: SubtaskSortSpec = { key: 'title', dir: 'desc' }
    expect(effectiveSubtaskSort(main('cost'), override)).toBe(override)
    expect(effectiveSubtaskSort(main('due'), override)).toBe(override)
  })

  it('no override — falls back to the inherited translation of the main sort', () => {
    expect(effectiveSubtaskSort(main('cost', 'desc'), null)).toEqual({ key: 'cost', dir: 'desc' })
  })

  it('no override and no equivalent column — the grid follows nothing (its own creation order)', () => {
    expect(effectiveSubtaskSort(main('priority'), null)).toBeNull()
  })
})

// --- pickSubtaskSort -------------------------------------------------------------------------------

describe('pickSubtaskSort', () => {
  it('first click with no inheritance to build on: straight to ascending', () => {
    // The main table is sorted by a column with no subtask equivalent (priority), so there is
    // nothing to continue from.
    expect(pickSubtaskSort(main('priority'), null, 'status')).toEqual({ key: 'status', dir: 'asc' })
  })

  it('cycles asc -> desc -> back to no override (none of it repeats what inheritance already gives)', () => {
    const m = main('priority') // no equivalent — inheritedSubtaskSort is null throughout
    const asc = pickSubtaskSort(m, null, 'status')
    expect(asc).toEqual({ key: 'status', dir: 'asc' })
    const desc = pickSubtaskSort(m, asc, 'status')
    expect(desc).toEqual({ key: 'status', dir: 'desc' })
    expect(pickSubtaskSort(m, desc, 'status')).toBeNull()
  })

  it('a column already following inheritance continues the cycle from there, not from ascending', () => {
    // Main sorts by cost ascending — inheritedSubtaskSort is {cost, asc} with no override yet.
    const m = main('cost', 'asc')
    const next = pickSubtaskSort(m, null, 'cost')
    // cycleSort({cost,asc}, 'cost') -> {cost,desc}; it does not equal the inherited {cost,asc}, so
    // it is kept as a real override.
    expect(next).toEqual({ key: 'cost', dir: 'desc' })
  })

  it('the override drops back to null the moment the cycle would only repeat inheritance', () => {
    const m = main('cost', 'asc')
    const overridden = pickSubtaskSort(m, null, 'cost') // {cost, desc}
    // Clicking "cost" again from {cost,desc} cycles to null outright (cycleSort's own third state).
    expect(pickSubtaskSort(m, overridden, 'cost')).toBeNull()
  })

  it('switching to a DIFFERENT key always starts fresh at ascending, even with an override in force', () => {
    const m = main('cost', 'asc')
    const override: SubtaskSortSpec = { key: 'cost', dir: 'desc' }
    expect(pickSubtaskSort(m, override, 'title')).toEqual({ key: 'title', dir: 'asc' })
  })

  it('clicking the already-inherited column when the main direction is already desc clears immediately', () => {
    // inheritedSubtaskSort is {cost, desc}; cycleSort({cost,desc}, 'cost') is null by definition
    // (its own third state), so there is no intermediate "override" step to pass through here.
    const m = main('cost', 'desc')
    expect(pickSubtaskSort(m, null, 'cost')).toBeNull()
  })
})
