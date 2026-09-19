import { describe, expect, it } from 'bun:test'
import { deliveryHint, suggestDelivery, type SuggestSession, type SuggestTask } from './taskSuggest'

const HERE = '/home/u/repo'

const task = (over: Partial<SuggestTask> = {}): SuggestTask =>
  ({ id: 't1', title: 'ALM board', status: 'in_progress', ...over })

const at = (cwd: string, name?: string): SuggestSession =>
  ({ cwd, ...(name ? { task: name } : {}) })

describe('suggestDelivery', () => {
  it('offers the delivery most of this folder is filed under, and says how many', () => {
    const out = suggestDelivery({
      cwd: HERE,
      sessions: [at(HERE, 'ALM board'), at(HERE, 'ALM board'), at(HERE, 'Mobile')],
      tasks: [task(), task({ id: 't2', title: 'Mobile' })],
    })
    expect(out).toEqual({ taskId: 't1', title: 'ALM board', sameFolder: 2 })
  })

  it('says nothing when no session of this folder is filed anywhere', () => {
    // An empty field is the honest answer. Nothing is blocked by it.
    expect(suggestDelivery({
      cwd: HERE, sessions: [at(HERE), at(HERE)], tasks: [task()],
    })).toBeNull()
  })

  it('says nothing on a tie — a coin flip is not a recommendation', () => {
    expect(suggestDelivery({
      cwd: HERE,
      sessions: [at(HERE, 'ALM board'), at(HERE, 'Mobile')],
      tasks: [task(), task({ id: 't2', title: 'Mobile' })],
    })).toBeNull()
  })

  it('never suggests a finished delivery', () => {
    // Filing new work into a delivered task corrupts the one duration the board exists to measure.
    for (const status of ['done', 'abandoned']) {
      expect(suggestDelivery({
        cwd: HERE, sessions: [at(HERE, 'ALM board'), at(HERE, 'ALM board')],
        tasks: [task({ status })],
      })).toBeNull()
    }
  })

  it('matches the folder EXACTLY — a worktree is not its repository', () => {
    // A prefix match would offer the repo's delivery to a worktree doing something else.
    expect(suggestDelivery({
      cwd: `${HERE}/.claude/worktrees/other`,
      sessions: [at(HERE, 'ALM board'), at(HERE, 'ALM board')],
      tasks: [task()],
    })).toBeNull()
  })

  it('reads two spellings of one folder as one folder', () => {
    const out = suggestDelivery({
      cwd: `${HERE}/`,
      sessions: [at(HERE, 'ALM board'), at(`${HERE}//`, 'ALM board')],
      tasks: [task()],
    })
    expect(out?.sameFolder).toBe(2)
  })

  it('ignores a title no delivery carries any more', () => {
    // Renamed or deleted: it matches nothing rather than resolving to a dangling suggestion.
    expect(suggestDelivery({
      cwd: HERE, sessions: [at(HERE, 'gone'), at(HERE, 'gone')], tasks: [task()],
    })).toBeNull()
  })

  it('counts only this folder, however busy the others are', () => {
    const out = suggestDelivery({
      cwd: HERE,
      sessions: [
        at(HERE, 'ALM board'),
        at('/elsewhere', 'Mobile'), at('/elsewhere', 'Mobile'), at('/elsewhere', 'Mobile'),
      ],
      tasks: [task(), task({ id: 't2', title: 'Mobile' })],
    })
    expect(out).toEqual({ taskId: 't1', title: 'ALM board', sameFolder: 1 })
  })

  it('says nothing without a folder to reason about', () => {
    expect(suggestDelivery({ cwd: '', sessions: [at(HERE, 'ALM board')], tasks: [task()] })).toBeNull()
  })
})

/**
 * THE REPORTED BUG: the "Entrega (opcional)" field must start EMPTY, with no suggestion
 * pre-selected — even when `suggestDelivery` above has a strong, matching answer available. It may
 * only ever be OFFERED as a hint a person clicks.
 */
describe('deliveryHint — the field starts EMPTY, even with a matching suggestion available', () => {
  const suggestion = { taskId: 't1', title: 'ALM board', sameFolder: 3 }

  it('offers the hint while the field is still empty', () => {
    // THE INITIAL STATE: an empty field, a suggestion sitting right there — and it stays a hint,
    // never the field's own value.
    expect(deliveryHint('', suggestion)).toEqual(suggestion)
  })

  it('offers nothing once the field already holds a value — a person\'s own or a caller\'s', () => {
    expect(deliveryHint('Mobile', suggestion)).toBeNull()
    expect(deliveryHint(suggestion.title, suggestion)).toBeNull()
  })

  it('offers nothing when there is no suggestion to offer', () => {
    expect(deliveryHint('', null)).toBeNull()
  })
})
