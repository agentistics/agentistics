import { describe, expect, it } from 'bun:test'
import { effectiveEvidenceScope, evidenceGroups, evidenceSides, filterEvidence, sessionHandle, type EvidenceItem } from './evidence'

const item = (o: Partial<EvidenceItem>): EvidenceItem => ({
  name: 'a.png', path: '/h/.agentistics/attachments/1-a.png', origin: 'sessions', taskId: 't1', subtaskId: null,
  sessionId: 'agentop-3f5f21a8b0', author: 'x', createdAt: '2026-10-02T10:00:00Z', taskTitle: 'Task one', ...o,
})

describe('evidence', () => {
  const items = [
    item({}), item({ name: 'b.mp4', path: '/p/b.mp4' }),
    item({ origin: 'mine', sessionId: 'conv', createdAt: '2026-10-02T11:00:00Z', name: 'm.png', path: '/p/m.png' }),
    item({ taskId: 't2', taskTitle: 'Task two', name: 'c.pdf', path: '/p/c.pdf' }),
  ]
  it('counts sides and falls back when a side is empty', () => {
    const s = evidenceSides(items)
    expect(s).toEqual({ mine: 1, sessions: 3 })
    expect(effectiveEvidenceScope('mine', { mine: 0, sessions: 2 })).toBe('all')
    expect(effectiveEvidenceScope('mine', s)).toBe('mine')
  })
  it('filters by origin and task', () => {
    expect(filterEvidence(items, 'mine', null)).toHaveLength(1)
    expect(filterEvidence(items, 'all', 't2')).toHaveLength(1)
    expect(filterEvidence(items, 'sessions', 't1')).toHaveLength(2)
  })
  it('groups one session moment together, headed by task, naming the session; serves any kind by path', () => {
    const g = evidenceGroups(items, false)
    const t1 = g.filter(x => x.taskTitle === 'Task one')
    expect(t1.map(x => x.files.length).sort()).toEqual([1, 2])
    expect(t1.find(x => x.files.length === 2)!.text).toBe('session 3f5f21a8')
    expect(g.find(x => x.taskTitle === 'Task one' && x.text === 'sent by you')).toBeDefined()
    const vid = g.flatMap(x => x.files).find(f => f.name === 'b.mp4')!
    expect(vid.kind).toBe('video')
    expect(vid.url).toBe('/api/fleet/attachment?path=%2Fp%2Fb.mp4')
    expect(g.map(x => x.index)).toEqual(g.map((_, i) => i))
  })
  it('handles a missing session', () => { expect(sessionHandle(null)).toBe('') })
})
