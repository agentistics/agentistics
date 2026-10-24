import { describe, expect, test } from 'bun:test'
import {
  currentLeaderId, namesParent, planHandoffReparent, planLeaderRoot, planTeamMove, rootIfLeader, ROOT_PATCH, spawnParentLink,
  type TeamRow,
} from './team-links'
import { completeLeaderHandoff, teamOp } from './team-links-io'
import { sessionOwningChain, callerSessionFromTree } from './session-identity'
import type { ManagedSession } from './types'

const row = (id: string, extra: Partial<ManagedSession> = {}): ManagedSession =>
  ({ id, harness: 'claude', cwd: '/r', createdAt: '2026-10-24T00:00:00Z', ...extra }) as ManagedSession

describe('spawn: every session a leader starts is its child, except a leader', () => {
  const link = { parentSessionId: 'L', parentConversationId: 'cL' }
  test('a worker (or an unspecified role) keeps the link', () => {
    expect(spawnParentLink('worker', link)).toEqual(link)
    expect(spawnParentLink(undefined, link)).toEqual(link)
  })
  test('a leader (--role leader, a --handoff successor) is born at the root', () => {
    expect(spawnParentLink('leader', link)).toEqual({})
  })
  test('a reopened leader sheds the parent its predecessor row carried', () => {
    const led: { id: string; parentSessionId?: string; parentConversationId?: string } = { id: 'x', parentSessionId: 'L', parentConversationId: 'cL' }
    expect(rootIfLeader(led, 'leader')).toEqual({ id: 'x' })
    const w = { id: 'x', parentSessionId: 'L' }
    expect(rootIfLeader(w, 'worker')).toBe(w)
  })
})

describe('a predecessor that handed off files new workers under its successor', () => {
  test('follows handoffTo, and through a reopen of the successor', () => {
    const rows: TeamRow[] = [
      { id: 'L1', handoffTo: 'L2' },
      { id: 'L2', conversationId: 'c2', endedAt: 'x' },
      { id: 'L2b', conversationId: 'c2' },
    ]
    expect(currentLeaderId(rows, 'L1')).toBe('L2b')
    expect(currentLeaderId(rows, 'nobody')).toBe('nobody')
    expect(currentLeaderId([{ id: 'A', handoffTo: 'B' }, { id: 'B', handoffTo: 'A' }], 'A')).toBe('B')
  })
})

describe('hand-off moves the whole team to the successor', () => {
  test('children by id and by conversation move; the successor is cleared to the root', () => {
    const rows: TeamRow[] = [
      { id: 'old', conversationId: 'c-old' },
      { id: 'new', parentSessionId: 'old' },
      { id: 'w1', parentSessionId: 'old' },
      { id: 'w2', parentSessionId: 'gone', parentConversationId: 'c-old' },
      { id: 'w3', parentSessionId: 'old', endedAt: '2026' },
      { id: 'other', parentSessionId: 'someone' },
    ]
    const p = planHandoffReparent(rows, rows[0]!, { id: 'new', conversationId: 'c-new' })
    expect(p.children.sort()).toEqual(['w1', 'w2', 'w3'])
    expect(p.childPatch).toEqual({ parentSessionId: 'new', parentConversationId: 'c-new' })
    expect(p.successorPatch).toEqual(ROOT_PATCH)
  })
  test('a successor already at the root needs no patch', () => {
    expect(planHandoffReparent([{ id: 'old' }, { id: 'new' }], { id: 'old' }, { id: 'new' }).successorPatch).toBeUndefined()
  })

  test('completeLeaderHandoff: links, re-parents (persisted), roots the successor, retires the predecessor', async () => {
    const store = new Map<string, ManagedSession>([
      ['old', row('old', { conversationId: 'c-old', retire: undefined })],
      ['new', row('new', { conversationId: 'c-new', parentSessionId: 'old' })],
      ['w1', row('w1', { parentSessionId: 'old' })],
      ['w2', row('w2', { parentConversationId: 'c-old' })],
    ])
    const apply = (id: string, p: Record<string, unknown>) => {
      const cur = store.get(id); if (!cur) return false
      const next = { ...cur, ...p } as Record<string, unknown>
      for (const [k, v] of Object.entries(p)) if (v === null) delete next[k]
      store.set(id, next as unknown as ManagedSession); return true
    }
    const linked: string[] = []
    const out = await completeLeaderHandoff('old', 'new', undefined, 1, {
      read: async () => [...store.values()],
      patch: async (id, p) => apply(id, p as Record<string, unknown>),
      patchMany: async (ids, p) => ids.filter(id => apply(id, p as Record<string, unknown>)).length,
      recordLink: async (a, b) => { linked.push(`${a}->${b}`) },
      now: () => Date.parse('2026-10-24T12:00:00Z'),
    })
    expect(linked).toEqual(['old->new'])
    expect(out).toEqual({ moved: 2, retireRequested: true })
    expect(store.get('w1')!.parentSessionId).toBe('new')
    expect(store.get('w2')!.parentSessionId).toBe('new')
    expect(store.get('w2')!.parentConversationId).toBe('c-new')
    expect(store.get('new')!.parentSessionId).toBeUndefined()
    expect(store.get('old')!.retire?.successorId).toBe('new')
    expect(store.get('old')!.parentSessionId).toBeUndefined()
  })

  test('an already-ended predecessor is not asked to retire', async () => {
    const rows = [row('old', { endedAt: '2026' }), row('new')]
    const out = await completeLeaderHandoff('old', 'new', undefined, undefined, {
      read: async () => rows, patch: async () => true, patchMany: async () => 0, recordLink: async () => {}, now: Date.now,
    })
    expect(out.retireRequested).toBe(false)
  })
})

describe('a session declared leader leaves its parent\'s team', () => {
  test('planLeaderRoot', () => {
    expect(planLeaderRoot({ id: 'x', parentSessionId: 'L' })).toEqual(ROOT_PATCH)
    expect(planLeaderRoot({ id: 'x', parentConversationId: 'cL' })).toEqual(ROOT_PATCH)
    expect(planLeaderRoot({ id: 'x' })).toBeUndefined()
    expect(planLeaderRoot(undefined)).toBeUndefined()
  })
})

describe('manual: unlink / move to a leader\'s team', () => {
  const rows: TeamRow[] = [
    { id: 'L1', conversationId: 'c1' }, { id: 'L2' }, { id: 'w', parentSessionId: 'L1' }, { id: 'o' },
  ]
  const isLeader = (r: TeamRow) => r.id.startsWith('L')
  test('unlink', () => {
    expect(planTeamMove(rows, 'w', undefined, isLeader)).toEqual({ ok: true, id: 'w', patch: ROOT_PATCH })
    expect(planTeamMove(rows, 'o', undefined, isLeader)).toEqual({ ok: false, code: 'no_leader' })
  })
  test('move an orphan or a member into a leader\'s team', () => {
    expect(planTeamMove(rows, 'o', 'L1', isLeader)).toEqual({ ok: true, id: 'o', patch: { parentSessionId: 'L1', parentConversationId: 'c1' } })
    expect(planTeamMove(rows, 'w', 'L2', isLeader)).toEqual({ ok: true, id: 'w', patch: { parentSessionId: 'L2', parentConversationId: null } })
  })
  test('refusals', () => {
    expect(planTeamMove(rows, 'w', 'L1', isLeader)).toEqual({ ok: false, code: 'already_there' })
    expect(planTeamMove(rows, 'w', 'o', isLeader)).toEqual({ ok: false, code: 'not_a_leader' })
    expect(planTeamMove(rows, 'L2', 'L1', isLeader)).toEqual({ ok: false, code: 'is_leader' })
    expect(planTeamMove(rows, 'L1', 'L1', isLeader)).toEqual({ ok: false, code: 'same_session' })
    expect(planTeamMove(rows, 'x', 'L1', isLeader)).toEqual({ ok: false, code: 'no_such_session' })
    expect(planTeamMove(rows, 'w', 'Lx', isLeader)).toEqual({ ok: false, code: 'no_such_leader' })
  })
  test('namesParent never counts a row as its own child', () => {
    expect(namesParent({ id: 'a', parentSessionId: 'a' }, { id: 'a' })).toBe(false)
  })
})

describe('POST /api/session-team (teamOp)', () => {
  const base = () => new Map<string, ManagedSession>([
    ['L', row('L', { label: '[ LEADER ] - Motor' })], ['w', row('w', { parentSessionId: 'L' })], ['o', row('o')],
  ])
  const deps = (store: Map<string, ManagedSession>) => ({
    isLeader: (r: TeamRow) => r.id === 'L',
    read: async () => [...store.values()],
    patch: async (id: string, patch: object) => {
      const p = patch as Record<string, unknown>
      const cur = store.get(id)!; const next = { ...cur, ...p } as Record<string, unknown>
      for (const [k, v] of Object.entries(p)) if (v === null) delete next[k]
      store.set(id, next as unknown as ManagedSession); return true
    },
  })
  test('moves an orphan in, and takes a member out — persisted', async () => {
    const store = base()
    expect((await teamOp({ id: 'o', leader: 'L' }, deps(store))).status).toBe(200)
    expect(store.get('o')!.parentSessionId).toBe('L')
    const out = await teamOp({ id: 'w', leader: null, lang: 'pt' }, deps(store))
    expect(out.reply).toMatchObject({ ok: true, leader: null })
    expect(store.get('w')!.parentSessionId).toBeUndefined()
  })
  test('a session proof is refused: only the person moves sessions between teams', async () => {
    expect((await teamOp({ id: 'o', leader: 'L', session: { id: 'x', token: 'y' } }, deps(base()))).status).toBe(403)
  })
  test('refusals carry a code and a sentence', async () => {
    const out = await teamOp({ id: 'L', leader: 'L' }, deps(base()))
    expect(out.status).toBe(409)
    expect(out.reply).toMatchObject({ ok: false, code: 'same_session' })
    expect((await teamOp({}, deps(base()))).status).toBe(400)
    expect((await teamOp({ id: 'nope' }, deps(base()))).status).toBe(404)
  })
})

describe('a spawn that lost AGENTOP_MANAGED_ID still finds its parent from the process tree', () => {
  test('nearest owning ancestor wins', () => {
    const anchors = new Map([['outer', [10]], ['inner', [20]]])
    expect(sessionOwningChain([30, 20, 10, 1], anchors)).toBe('inner')
    expect(sessionOwningChain([30, 5], anchors)).toBeUndefined()
  })
  test('callerSessionFromTree reads pane pids and structured relays', async () => {
    const parents: Record<number, number> = { 300: 200, 200: 100, 100: 1 }
    const found = await callerSessionFromTree(
      async () => new Map([['agentop-lead', 100]]),
      async () => ['agentop-lead', 'agentop-web'],
      { pid: 300, parentOf: p => parents[p], managedPids: id => (id === 'agentop-web' ? [200] : []) },
    )
    expect(found).toBe('agentop-web')
    expect(await callerSessionFromTree(async () => new Map(), async () => [], { pid: 300, parentOf: p => parents[p] })).toBeUndefined()
  })
})
