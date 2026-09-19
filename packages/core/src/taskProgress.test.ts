import { describe, expect, it } from 'bun:test'
import { groupProgress, taskProgress } from './taskProgress'

describe('taskProgress', () => {
  it('is NULL with no subtasks — "nobody broke this up" is not "nothing is done"', () => {
    expect(taskProgress(0, 0)).toEqual({ done: 0, total: 0, percent: null, complete: false })
  })

  it('rounds DOWN, so 99 of 100 never reads 100%', () => {
    expect(taskProgress(99, 100).percent).toBe(99)
    expect(taskProgress(2, 3).percent).toBe(66)
    expect(taskProgress(1, 1000).percent).toBe(0)
  })

  it('is complete only when every one is closed', () => {
    expect(taskProgress(3, 3)).toMatchObject({ percent: 100, complete: true })
    expect(taskProgress(2, 3).complete).toBe(false)
  })

  it('clamps a count that cannot be right rather than reporting over 100%', () => {
    // A store read mid-write can hand over more done than total; a 140% bar draws outside its cell.
    expect(taskProgress(7, 5)).toMatchObject({ done: 5, percent: 100, complete: true })
    expect(taskProgress(-2, 5)).toMatchObject({ done: 0, percent: 0 })
  })
})

describe('groupProgress — a subtask GROUP\'s own progress, one hierarchy level below a task\'s (§F.1)', () => {
  it('counts `true` entries as done, over the same round-down rule as taskProgress', () => {
    expect(groupProgress([true, false, false])).toEqual({
      done: 1, total: 3, percent: 33, complete: false,
    })
  })

  it('is NULL with no members — "nobody joined this group" is not "nothing is done"', () => {
    expect(groupProgress([])).toEqual({ done: 0, total: 0, percent: null, complete: false })
  })

  it('is complete only when every member is done', () => {
    expect(groupProgress([true, true])).toMatchObject({ percent: 100, complete: true })
    expect(groupProgress([true, false])).toMatchObject({ complete: false })
  })
})
