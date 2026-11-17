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
  it('offers rename, stop the turn, end and reopen, in that order, on a working row', () => {
    expect(rowMenuEntries(verbs, 'working').map(e => e.action)).toEqual(['rename', 'interrupt', 'kill', 'resume'])
  })

  it('a working row offers BOTH stops: interrupt the turn AND end the session (SESSAO.MENU-ENCERRAR)', () => {
    const actions = rowMenuEntries(verbs, 'working').map(e => e.action)
    expect(actions).toContain('interrupt')
    expect(actions).toContain('kill')
    expect(rowMenuEntries(verbs, 'waiting').map(e => e.action)).toEqual(['rename', 'kill', 'resume'])
  })

  it('keeps a refused verb, disabled, with its reason — never drops it', () => {
    const resume = rowMenuEntries(verbs, 'working').find(e => e.action === 'resume')!
    expect(resume.enabled).toBe(false)
    expect(resume.reason).toBe('No conversation to reopen.')
  })

  it('offers no Stop on an ended row — Reopen is the verb that applies', () => {
    for (const state of ['exited', 'closed']) {
      expect(rowMenuEntries(verbs, state).map(e => e.action)).toEqual(['rename', 'resume'])
    }
  })

  it('offers Reopen and Remove, never End, for a backend-confirmed lost row', () => {
    const actions = rowMenuEntries([...verbs, { action: 'forget', label: 'Remove from list', enabled: true }], 'lost', [], 123).map(e => e.action)
    expect(actions).toEqual(['rename', 'resume', 'forget'])
  })

  it('keeps Stop on a lost row — its backend may still be running', () => {
    expect(rowMenuEntries(verbs, 'lost').map(e => e.action)).toContain('kill')
  })

  // SESSAO.MENU-ENCERRAR — every LIVE state, on every row kind the server builds, offers End.
  // Before the fix a `working` row swapped End for "stop the turn" (and on a native row that one
  // is disabled), so the menu told the reader to end the session first and gave no way to.
  const nativeWorking = [
    { action: 'rename', label: 'Renomear', enabled: true },
    { action: 'interrupt', label: 'Parar o que está fazendo', enabled: false, reason: 'native' },
    { action: 'kill', label: 'Encerrar sessão', enabled: true },
    { action: 'resume', label: 'Reabrir', enabled: false },
  ]
  const forgetLive = { action: 'forget', label: 'Remover da lista', enabled: false, reason: 'Uma sessão viva fica na lista — encerre-a primeiro.' }
  const cases: Array<[string, readonly { action: string; label: string; enabled: boolean; reason?: string }[], string, number | undefined]> = [
    ['managed working', [...verbs, forgetLive], 'working', undefined],
    ['managed waiting', [...verbs, forgetLive], 'waiting', undefined],
    ['managed waiting-approval', [...verbs, forgetLive], 'waiting-approval', undefined],
    ['managed idle', [...verbs, forgetLive], 'idle', undefined],
    ['managed lost (unread)', verbs, 'lost', undefined],
    ['native working', nativeWorking, 'working', undefined],
    ['native waiting', nativeWorking, 'waiting', undefined],
  ]
  for (const [name, vs, state, endedAt] of cases) {
    it(`offers an ENABLED End on a live row: ${name}`, () => {
      const kill = rowMenuEntries(vs, state, [], endedAt).find(e => e.action === 'kill')
      expect(kill?.enabled).toBe(true)
    })
  }
  it('whenever Remove is refused because the session is live, End is offered beside it', () => {
    for (const state of ['working', 'waiting', 'waiting-approval', 'idle']) {
      const entries = rowMenuEntries([...verbs, forgetLive], state)
      const forget = entries.find(e => e.action === 'forget')!
      expect(forget.enabled).toBe(false)
      expect(entries.find(e => e.action === 'kill')?.enabled).toBe(true)
    }
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

describe('rowMenuEntries — native store verbs', () => {
  test('archive joins the row menu when the row carries it; delete never does (no confirm there)', () => {
    const verbs = [
      { action: 'rename', label: 'Rename', enabled: true },
      { action: 'kill', label: 'End', enabled: false },
      { action: 'resume', label: 'Reopen', enabled: true },
      { action: 'archive', label: 'Archive', enabled: true },
      { action: 'delete', label: 'Delete', enabled: true },
    ]
    const actions = rowMenuEntries(verbs, 'closed').map(e => e.action)
    expect(actions).toEqual(['rename', 'resume', 'archive'])
  })
})

describe('menuMaxHeight', () => {
  test('uses the CSS-px viewport as-is, so a long menu fits at every UI zoom', async () => {
    const { menuMaxHeight } = await import('./rowMenu')
    expect(menuMaxHeight(1000)).toBe(992)
    // zoomGeometry reports innerHeight already divided by the zoom; the menu must not divide again.
    for (const zoom of [0.85, 1, 1.25]) {
      const reported = 1000 / zoom
      const maxH = menuMaxHeight(reported)
      expect(maxH).toBeLessThanOrEqual(reported)
      expect(maxH).toBe(reported - 8)
    }
  })
})
