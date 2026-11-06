import { describe, expect, it } from 'bun:test'
import type { TaskStatusDef } from '@agentistics/core'
import {
  defaultVisibleStatuses, hiddenStatuses, isDefaultVisible, moveStatus, uniqueStatusLabels, visibleStatuses,
} from './statusDefaults'

const def = (id: string, label: string, order: number): TaskStatusDef =>
  ({ id, label, color: '#999', order, protected: false } as unknown as TaskStatusDef)

const LIST = [
  def('backlog', 'Backlog', 0), def('todo', 'To do', 1), def('in_progress', 'In progress', 2),
  def('blocked', 'Blocked', 3), def('in_review', 'In review', 4), def('done', 'Done', 5),
  def('ideias_adiado', 'Ideias adiado', 6), def('abandoned', 'Abandoned', 7),
]

describe('default status visibility', () => {
  it('shows blocked > todo > in progress > in review > done, in that order', () => {
    expect(defaultVisibleStatuses(LIST)).toEqual(['blocked', 'todo', 'in_progress', 'in_review', 'done'])
  })
  it('hides everything else, but keeps it reachable', () => {
    const shown = defaultVisibleStatuses(LIST)
    expect(hiddenStatuses(shown, LIST)).toEqual(['backlog', 'ideias_adiado', 'abandoned'])
  })
  it('finds a custom status by its label when the id differs', () => {
    const list = [def('x1', 'In Review', 0), def('todo', 'To do', 1), def('done', 'Done', 2)]
    expect(defaultVisibleStatuses(list)).toEqual(['todo', 'x1', 'done'])
  })
  it('someone who never chose (null) gets the default; a stored choice is kept, stale ids dropped', () => {
    expect(visibleStatuses(null, LIST)).toEqual(defaultVisibleStatuses(LIST))
    expect(visibleStatuses(['done', 'backlog', 'gone'], LIST)).toEqual(['done', 'backlog'])
  })
  it('knows when the arrangement is the default', () => {
    expect(isDefaultVisible(null, LIST)).toBe(true)
    expect(isDefaultVisible(['blocked', 'todo', 'in_progress', 'in_review', 'done'], LIST)).toBe(true)
    expect(isDefaultVisible(['todo', 'done'], LIST)).toBe(false)
  })
  it('moves a status one step and ignores the ends', () => {
    expect(moveStatus(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(moveStatus(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c'])
  })
})

describe('two statuses sharing a label', () => {
  const dup = [def('todo', 'To do', 1), def('in_review', 'In review', 2), def('x_ab12', 'In review', 3), def('done', 'Done', 4)]
  it('shows the one with the canonical id by default and hides the other', () => {
    expect(defaultVisibleStatuses(dup)).toEqual(['todo', 'in_review', 'done'])
    expect(hiddenStatuses(defaultVisibleStatuses(dup), dup)).toEqual(['x_ab12'])
  })
  it('never yields the same visible name twice', () => {
    const names = Object.values(uniqueStatusLabels(dup)).map(n => n.toLowerCase())
    expect(new Set(names).size).toBe(names.length)
    expect(uniqueStatusLabels(dup).in_review).toBe('In review')
    expect(uniqueStatusLabels(dup).x_ab12).toBe('In review (x_ab12)')
  })
})
