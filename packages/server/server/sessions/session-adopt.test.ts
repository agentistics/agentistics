import { describe, expect, test } from 'bun:test'
import type { HarnessSessionFile } from './harness-session-file'
import { planAdoptions } from './session-adopt'

const NOW = '2026-08-15T20:00:00.000Z'

function file(over: Partial<HarnessSessionFile> = {}): HarnessSessionFile {
  return { cwd: '/home/u/proj', sessionId: 'conv-1', name: 'renomeada', ...over }
}

function plan(
  rows: { id: string; status: string }[],
  entries: [string, HarnessSessionFile][] = [],
) {
  return planAdoptions({
    rows,
    byManagedId: new Map(entries),
    harness: 'claude',
    nowIso: NOW,
  })
}

describe('planAdoptions', () => {
  test('takes back a running session whose record is gone', () => {
    expect(plan([{ id: 'a2b569c123', status: 'unregistered' }], [['a2b569c123', file()]])).toEqual([{
      id: 'a2b569c123',
      harness: 'claude',
      cwd: '/home/u/proj',
      createdAt: NOW,
      label: 'renomeada',
      conversationId: 'conv-1',
      conversationLink: 'assigned',
      conversationLinkVia: 'harness-session-file',
    }])
  })

  test('leaves every other status alone — adoption is not reconciliation', () => {
    for (const status of ['running', 'exited', 'lost']) {
      expect(plan([{ id: 'x', status }], [['x', file()]])).toEqual([])
    }
  })

  test('an unregistered row with no harness record is left visible, never invented', () => {
    // No exact link. Filing it would mean guessing a directory, which is the error `repo-facts.ts`
    // exists to have stopped.
    expect(plan([{ id: 'orphan', status: 'unregistered' }])).toEqual([])
  })

  test('a harness record naming no directory is not enough', () => {
    expect(plan([{ id: 'x', status: 'unregistered' }], [['x', file({ cwd: undefined })]])).toEqual([])
    expect(plan([{ id: 'x', status: 'unregistered' }], [['x', file({ cwd: '' })]])).toEqual([])
  })

  test('a DERIVED name is never adopted as a label', () => {
    // `aipe-46` is not a name a person chose, and the registry outlives the process that invented it.
    const [rec] = plan(
      [{ id: 'x', status: 'unregistered' }],
      [['x', file({ name: 'aipe-46', nameSource: 'derived' })]],
    )
    expect(rec?.label).toBeUndefined()
    expect(rec?.cwd).toBe('/home/u/proj')
  })

  test('a record with no conversation id still adopts — the link is the tmux name', () => {
    const [rec] = plan([{ id: 'x', status: 'unregistered' }], [['x', file({ sessionId: undefined })]])
    expect(rec?.conversationId).toBeUndefined()
    expect(rec?.id).toBe('x')
  })

  test('nothing to do yields an empty list, so the caller can skip the write', () => {
    expect(plan([{ id: 'a', status: 'running' }, { id: 'b', status: 'lost' }])).toEqual([])
  })

  test('adopts several at once and only the linked ones', () => {
    const out = plan(
      [
        { id: 'linked', status: 'unregistered' },
        { id: 'orphan', status: 'unregistered' },
        { id: 'alive', status: 'running' },
      ],
      [['linked', file()], ['alive', file()]],
    )
    expect(out.map(r => r.id)).toEqual(['linked'])
  })

  test('createdAt is the moment of adoption, not the harness process start', () => {
    // The harness record's own timestamps describe the process holding the conversation NOW, which
    // after a takeover or a resume is not when the work began.
    const [rec] = plan([{ id: 'x', status: 'unregistered' }], [['x', file({ nameSince: 1 })]])
    expect(rec?.createdAt).toBe(NOW)
  })
})

describe('planAdoptions — a re-created row keeps what its predecessor was filed under (LINK.CROSSTALK bug 2)', () => {
  const predecessor = {
    id: 'old0000001', harness: 'claude' as const, cwd: '/home/u/ws', createdAt: '2026-10-09T10:00:00.000Z',
    conversationId: 'conv-1', parentSessionId: 'parent0001', parentConversationId: 'pconv-1',
    task: 'Engine', taskId: 't-1', subtaskId: 's-1', attemptId: 'a-1', note: 'leader', label: 'LEADER',
    endedAt: '2026-10-09T21:49:00.000Z',
  }

  test('a resumed session whose record was lost keeps parent, task/subtask, note and label', () => {
    const [rec] = planAdoptions({
      rows: [{ id: 'new0000001', status: 'unregistered' }],
      byManagedId: new Map([['new0000001', file({ name: 'agentistics-workspace-58', nameSource: 'derived' })]]),
      registry: [predecessor],
      harness: 'claude',
      nowIso: NOW,
    })
    expect(rec).toMatchObject({
      id: 'new0000001', conversationId: 'conv-1', cwd: '/home/u/proj',
      parentSessionId: 'parent0001', parentConversationId: 'pconv-1',
      task: 'Engine', taskId: 't-1', subtaskId: 's-1', attemptId: 'a-1', note: 'leader', label: 'LEADER',
      conversationLink: 'assigned', conversationLinkVia: 'harness-session-file',
    })
    // The adopted row is alive: the predecessor's end must not travel.
    expect(rec?.endedAt).toBeUndefined()
  })

  test('the NEWEST predecessor of that conversation is the one inherited from', () => {
    const older = { ...predecessor, id: 'old0000000', createdAt: '2026-10-08T10:00:00.000Z', taskId: 't-OLD', parentSessionId: 'p-OLD' }
    const [rec] = planAdoptions({
      rows: [{ id: 'new0000001', status: 'unregistered' }],
      byManagedId: new Map([['new0000001', file()]]),
      registry: [predecessor, older],
      harness: 'claude',
      nowIso: NOW,
    })
    expect(rec?.taskId).toBe('t-1')
    expect(rec?.parentSessionId).toBe('parent0001')
  })

  test('a name the person chose inside the session still beats the predecessor label', () => {
    const [rec] = planAdoptions({
      rows: [{ id: 'new0000001', status: 'unregistered' }],
      byManagedId: new Map([['new0000001', file({ name: 'renomeada' })]]),
      registry: [predecessor],
      harness: 'claude',
      nowIso: NOW,
    })
    expect(rec?.label).toBe('renomeada')
  })

  test('a row of ANOTHER conversation is never inherited from (no guessing by directory)', () => {
    const [rec] = planAdoptions({
      rows: [{ id: 'new0000001', status: 'unregistered' }],
      byManagedId: new Map([['new0000001', file({ sessionId: 'conv-OTHER' })]]),
      registry: [predecessor],
      harness: 'claude',
      nowIso: NOW,
    })
    expect(rec?.taskId).toBeUndefined()
    expect(rec?.parentSessionId).toBeUndefined()
  })
})
