import { describe, expect, it } from 'bun:test'
import {
  conversationHeldBy,
  conversationsInUse,
  duplicateConversations,
  staleSelfHolder,
  type ClaimingSession,
} from './conversation-claim'

/**
 * The real pairs, from `~/.agentistics/managed-sessions.json` on 2026-08-14.
 *
 * Five conversations were each recorded against two to four NOT-ENDED rows. Reading two of the
 * screens side by side showed identical text — one conversation, two assistants typing into it — and
 * Claude Code itself was printing "another Claude Code on this machine already has Remote Control
 * for this conversation". The pair below is kept verbatim because the DIRECTORIES are the tell: they
 * differ, so nothing matched these two rows by directory. Both carried the same recorded
 * conversation id, which is exactly the evidence this module is built on.
 */
const TWINS: ClaimingSession[] = [
  {
    id: '44d649269a',
    kind: 'managed',
    alive: true,
    conversationId: 'cd118e71-3708-420e-8c7f-c578cf59900f',
    label: 'Avaliar armazenamento de dados em SQLite local',
  },
  {
    id: '1da098e5cb',
    kind: 'managed',
    alive: true,
    conversationId: 'cd118e71-3708-420e-8c7f-c578cf59900f',
    label: 'Possivel implementacao de SQLite no agentistics local',
  },
]

describe('conversationsInUse', () => {
  it('names the live session driving a conversation', () => {
    const held = conversationsInUse([
      { id: 'a', kind: 'managed', alive: true, conversationId: 'c1', label: 'the auth work' },
    ])
    expect(held.get('c1')).toEqual({ id: 'a', label: 'the auth work', kind: 'managed' })
  })

  it('ignores a session that is not alive, however well recorded', () => {
    // THE rule that keeps this a lock rather than a wall. The harness leaves its record behind when
    // the process goes — 53 files on this machine against about a dozen live ones — so counting a
    // record as a claim would refuse to reopen anything that had ever run, which is every row the
    // reopen verb exists for.
    const held = conversationsInUse([{ id: 'a', kind: 'managed', alive: false, conversationId: 'c1' }])
    expect(held.size).toBe(0)
  })

  it('ignores a live session whose conversation is unknown', () => {
    // Absent is "we do not know", never "it holds nothing" — but there is nothing to lock either,
    // and inventing a claim from a directory guess is what `conversation-claim.ts` refuses to do.
    expect(conversationsInUse([{ id: 'a', kind: 'managed', alive: true }]).size).toBe(0)
  })

  it('falls back to the id when a session has no name, so a refusal always names something', () => {
    const held = conversationsInUse([{ id: 'a', kind: 'managed', alive: true, conversationId: 'c1' }])
    expect(held.get('c1')?.label).toBe('a')
    const blank = conversationsInUse([{ id: 'b', kind: 'managed', alive: true, conversationId: 'c2', label: '  ' }])
    expect(blank.get('c2')?.label).toBe('b')
  })

  it('names ONE holder even when the fleet already has twins', () => {
    // The point is to send someone to a session they can look at, not to enumerate a mess.
    const held = conversationsInUse(TWINS)
    expect(held.size).toBe(1)
    expect(held.get('cd118e71-3708-420e-8c7f-c578cf59900f')?.id).toBe('44d649269a')
  })
})

describe('conversationHeldBy', () => {
  const held = conversationsInUse([{ id: 'a', kind: 'managed', alive: true, conversationId: 'c1', label: 'A' }])

  it('reports the holder', () => {
    expect(conversationHeldBy(held, 'c1')?.id).toBe('a')
  })

  it('says nothing about a conversation nobody has', () => {
    expect(conversationHeldBy(held, 'c2')).toBeUndefined()
    expect(conversationHeldBy(held, undefined)).toBeUndefined()
  })

  it('never refuses a row on account of ITSELF', () => {
    // Reopening a row onto its own conversation is the ordinary gesture. It is normally not alive at
    // that point, but a finished row can keep a lingering backend pane — and a lock that refuses the
    // very thing it exists to protect is a lock people learn to work around.
    expect(conversationHeldBy(held, 'c1', 'a')).toBeUndefined()
  })
})

describe('duplicateConversations', () => {
  it('finds the pair that was actually on this machine', () => {
    const dupes = duplicateConversations(TWINS)
    expect(dupes).toHaveLength(1)
    expect(dupes[0]!.conversationId).toBe('cd118e71-3708-420e-8c7f-c578cf59900f')
    expect(dupes[0]!.holders.map(h => h.id)).toEqual(['44d649269a', '1da098e5cb'])
  })

  it('reports nothing when every conversation has one live session', () => {
    expect(duplicateConversations([
      { id: 'a', kind: 'managed', alive: true, conversationId: 'c1' },
      { id: 'b', kind: 'managed', alive: true, conversationId: 'c2' },
    ])).toEqual([])
  })

  it('does not count a dead twin as a twin', () => {
    // Two ROWS on one conversation is a tidy-up; two LIVE rows is lost work. Only the second is a
    // finding, and calling the first one would make the report noise nobody reads.
    expect(duplicateConversations([
      { id: 'a', kind: 'managed', alive: true, conversationId: 'c1' },
      { id: 'b', kind: 'managed', alive: false, conversationId: 'c1' },
    ])).toEqual([])
  })

  it('is ordered by conversation, so two reads agree', () => {
    const dupes = duplicateConversations([
      { id: 'a', kind: 'managed', alive: true, conversationId: 'z' },
      { id: 'b', kind: 'managed', alive: true, conversationId: 'z' },
      { id: 'c', kind: 'managed', alive: true, conversationId: 'm' },
      { id: 'd', kind: 'managed', alive: true, conversationId: 'm' },
    ])
    expect(dupes.map(d => d.conversationId)).toEqual(['m', 'z'])
  })
})

describe('what KIND of thing holds a conversation', () => {
  // The distinction that turns a dead end into a gesture. A managed row is somewhere you can go —
  // it has a pane, `o` attaches to it, and "open it there" is an instruction. A loose process is
  // not: an assistant started by hand has no pane, and the refusal named its DIRECTORY, which is
  // not a place. That row was visible and completely inert, which is what was reported.
  it('carries the kind and the pid through to the holder', () => {
    const held = conversationsInUse([
      { id: 'external:claude:/repo:1', kind: 'process', pid: 4242, alive: true, conversationId: 'c1', label: '/repo' },
    ])
    expect(held.get('c1')).toEqual({
      id: 'external:claude:/repo:1', label: '/repo', kind: 'process', pid: 4242,
    })
  })

  it('leaves the pid ABSENT on a managed row', () => {
    // A managed session is ended through the backend by session id, never by signalling a pid. A
    // pid on this side would invite exactly the wrong kind of kill.
    const held = conversationsInUse([
      { id: 'row', kind: 'managed', alive: true, conversationId: 'c1', label: 'the auth work' },
    ])
    expect(held.get('c1')).not.toHaveProperty('pid')
  })

  it('reports a pid-less process holder rather than inventing one', () => {
    // `/proc` can report a process whose pid could not be read. The caller must refuse there — it
    // cannot end what it cannot name, and spawning beside it creates the twin the lock exists for.
    const held = conversationsInUse([
      { id: 'external:claude:/repo:1', kind: 'process', alive: true, conversationId: 'c1' },
    ])
    expect(held.get('c1')?.kind).toBe('process')
    expect(held.get('c1')?.pid).toBeUndefined()
  })

  it('still lets the FIRST live holder win, whatever kind it is', () => {
    // The map names ONE session to act on, not a census of the mess.
    const held = conversationsInUse([
      { id: 'row', kind: 'managed', alive: true, conversationId: 'c1', label: 'the row' },
      { id: 'proc', kind: 'process', pid: 9, alive: true, conversationId: 'c1', label: '/repo' },
    ])
    expect(held.get('c1')?.id).toBe('row')
    expect(held.size).toBe(1)
  })
})

describe('staleSelfHolder — REABRIR.OPENCODE, a pinned ended row is its own holder', () => {
  // Owner, 2026-11-02: an OpenCode leader under "Encerradas → Dormindo" answered Reabrir with "that
  // conversation is already open in <itself>" — its backend entry outlived the assistant.
  const self = { id: 'oc00000001', label: '[ LÍDER ] - Brainstormg descricao de reuniao', kind: 'managed' as const }
  it('the requested row holding its own conversation after it ENDED is stale — reopen it', () => {
    expect(staleSelfHolder(self, 'oc00000001', { endedAt: '2026-11-02T13:42:00.000Z' }, true)).toBe(true)
  })
  it('endedAt alone is not proof: a relay that may still run (a CLI-owned one) is reused', () => {
    expect(staleSelfHolder(self, 'oc00000001', { endedAt: '2026-11-02T13:42:00.000Z' }, undefined)).toBe(false)
    expect(staleSelfHolder(self, 'oc00000001', { endedAt: '2026-11-02T13:42:00.000Z' }, false)).toBe(false)
  })
  it('a live row (no endedAt) stays idempotent: open it there', () => {
    expect(staleSelfHolder(self, 'oc00000001', {}, true)).toBe(false)
  })
  it('another row, or a foreign process, is a real holder', () => {
    expect(staleSelfHolder({ ...self, id: 'twin000001' }, 'oc00000001', { endedAt: 'x' }, true)).toBe(false)
    expect(staleSelfHolder({ ...self, kind: 'process', pid: 9 }, 'oc00000001', { endedAt: 'x' }, true)).toBe(false)
  })
  it('nothing replaced (a closed/external conversation) is never this case', () => {
    expect(staleSelfHolder(self, undefined, { endedAt: 'x' }, true)).toBe(false)
    expect(staleSelfHolder(undefined, 'oc00000001', { endedAt: 'x' }, true)).toBe(false)
  })
  it('end to end over the claims: an ended row whose backend still lists it holds itself until ended', () => {
    const held = conversationsInUse([{ id: 'oc00000001', kind: 'managed', alive: true, conversationId: 'ses_x', label: self.label }])
    const holder = conversationHeldBy(held, 'ses_x')
    expect(holder?.id).toBe('oc00000001')
    expect(staleSelfHolder(holder, 'oc00000001', { endedAt: '2026-11-02T13:42:00.000Z' }, true)).toBe(true)
  })
})
