import { describe, expect, it, test } from 'bun:test'
import { rowMenuEntries } from './rowMenu'

const verbs = [
  { action: 'rename', label: 'Rename', enabled: true },
  { action: 'interrupt', label: 'Stop the turn', enabled: true },
  { action: 'kill', label: 'End session', enabled: true },
  { action: 'resume', label: 'Reopen', enabled: false, reason: 'No conversation to reopen.' },
  { action: 'note', label: 'Note', enabled: true },
]

describe('rowMenuEntries', () => {
  it('offers rename, stop and reopen, in that order', () => {
    expect(rowMenuEntries(verbs, 'working').map(e => e.action)).toEqual(['rename', 'interrupt', 'resume'])
  })

  it('stops a running turn with interrupt and a stopped one with kill', () => {
    expect(rowMenuEntries(verbs, 'working')[1]!.action).toBe('interrupt')
    expect(rowMenuEntries(verbs, 'waiting')[1]!.action).toBe('kill')
  })

  it('keeps a refused verb, disabled, with its reason — never drops it', () => {
    const resume = rowMenuEntries(verbs, 'working').find(e => e.action === 'resume')!
    expect(resume.enabled).toBe(false)
    expect(resume.reason).toBe('No conversation to reopen.')
  })

  it('omits a verb the row does not carry at all', () => {
    expect(rowMenuEntries([{ action: 'rename', label: 'Rename', enabled: true }], 'lost')
      .map(e => e.action)).toEqual(['rename'])
  })

  it('is empty for a row with no verbs, so the caller can decline to open a menu', () => {
    expect(rowMenuEntries([], 'external')).toEqual([])
  })
})

import { NAY_COPY_ID, NAY_GO_TO, nayRowMenuEntries } from './rowMenu'

describe('nayRowMenuEntries', () => {
  const verbs = [
    { action: 'rename', label: 'Renomear', enabled: true },
    { action: 'kill', label: 'Encerrar', enabled: true },
    { action: 'interrupt', label: 'Interromper', enabled: true },
    { action: 'resume', label: 'Reabrir', enabled: false, reason: 'já está rodando' },
    { action: 'attach', label: 'Anexar', enabled: true },
  ]
  test('a running conversation: rename, END (never interrupt), go to, copy id', () => {
    const e = nayRowMenuEntries(verbs, { running: true, conversationId: 'c1', pt: true })
    expect(e.map(x => x.action)).toEqual(['rename', 'kill', 'link-task', NAY_GO_TO, NAY_COPY_ID])
  })
  test('an ended conversation offers Reopen, with the server verb untouched', () => {
    const e = nayRowMenuEntries(verbs, { running: false, conversationId: 'c1', pt: true })
    expect(e[1]).toEqual(verbs[3]!)
  })
  test('no delete, and a verb the server did not send is not invented', () => {
    const e = nayRowMenuEntries([], { running: true, conversationId: 'c1', pt: false })
    expect(e.map(x => x.action)).toEqual(['link-task', NAY_GO_TO, NAY_COPY_ID])
  })
  test('copy id is refused in words when there is no conversation link', () => {
    const e = nayRowMenuEntries(verbs, { running: true, conversationId: undefined, pt: false })
    const copy = e.find(x => x.action === NAY_COPY_ID)!
    expect(copy.enabled).toBe(false)
    expect(copy.reason).toBeTruthy()
  })
})

describe('taskMenuEntries', () => {
  test('unfiled: a single entry that opens the filing dialog', async () => {
    const { taskMenuEntries } = await import('./rowMenu')
    expect(taskMenuEntries(undefined, true).map(e => [e.action, e.label])).toEqual([['link-task', 'Vincular a uma tarefa…']])
    expect(taskMenuEntries(undefined, false)[0]!.label).toBe('File under a task…')
  })
  test('filed: names the task, then Move and Unlink', async () => {
    const { taskMenuEntries } = await import('./rowMenu')
    const e = taskMenuEntries('Minha tarefa', true)
    expect(e.map(x => x.label)).toEqual(['Tarefa: Minha tarefa', 'Mover…', 'Desvincular'])
    expect(e.map(x => x.action)).toEqual(['link-task', 'link-task', 'unlink-task'])
    expect(e.every(x => x.enabled)).toBe(true)
  })
})
