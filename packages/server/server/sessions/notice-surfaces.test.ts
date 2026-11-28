import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planSessionContext } from '../session-context'
import { liveRowOf } from './task-live-view'
import { lastMessageTo, noteMessageTo, resetLastMessages } from './last-message'
import { restartLastMessages, useLastMessagesFile } from './last-message-file.testing'
import { buildSessionViews, withAfterNotice } from './session-view'
import { lineStatusKind } from '../../../web/src/lib/lineStatus'
import { naySections } from '../../../web/src/lib/nayList'
import { followChipView } from '../../../web/src/components/browser/BrowserFollowChip'

// SESSAO.AVISO-NA-THREAD r2: ONE reading of "this turn follows a notice" on every waiting / "needs you" surface.

describe('the SessionStart hook', () => {
  const s = (over: Record<string, unknown>) => ({ id: 'aaaaaaaa11', status: 'running', cwd: '/r', activity: 'waiting', ...over })
  it('does not say a leader that only read a notice waits on a person', () => {
    const text = planSessionContext({ sessions: [s({ afterNotice: true }) as never, s({ id: 'bbbbbbbb22', activity: 'working' }) as never], cwd: '/r', home: '/h' })
    expect(text).not.toContain('waiting on a person')
    expect(text).toContain('read a notice')
  })
  it('still says it for an ordinary waiting turn', () => {
    const text = planSessionContext({ sessions: [s({}) as never, s({ id: 'bbbbbbbb22', activity: 'working' }) as never], cwd: '/r', home: '/h' })
    expect(text).toContain('waiting on a person')
  })
})

describe('the sidebar icon, the Nay list and the browser chip', () => {
  it('a notice reaction is not "you"', () => {
    expect(lineStatusKind('waiting', null, false, 0, true)).toBe('notice')
    expect(lineStatusKind('waiting', null, false, 0, false)).toBe('you')
    expect(lineStatusKind('waiting-approval', null, false, 0, true)).toBe('approval')
  })
  it('Nay files it under "working", never "waiting"', () => {
    const row = { id: 'n', state: 'waiting', cwd: '/home/u/.agentistics/nay-chat', afterNotice: true as const }
    const sections = naySections([row])
    expect(sections.waiting).toEqual([])
    expect(sections.working.length).toBe(1)
    expect(naySections([{ ...row, afterNotice: undefined as never }]).waiting.length).toBe(1)
  })
  it('the browser chip dot is not the needs-you orange', () => {
    expect(followChipView({ title: 'L', state: 'waiting', afterNotice: true } as never, undefined, 'en').dot).not.toBe('var(--anthropic-orange)')
    expect(followChipView({ title: 'L', state: 'waiting' } as never, undefined, 'en').dot).toBe('var(--anthropic-orange)')
  })
})

describe('the Live board', () => {
  it('carries afterNotice from the fleet row to the leader lane', () => {
    const row = liveRowOf({ id: 'l', title: 'L', harness: 'claude', state: 'waiting', afterNotice: true })
    expect(row.afterNotice).toBe(true)
    expect(liveRowOf({ id: 'l', title: 'L', harness: 'claude', state: 'waiting' }).afterNotice).toBeUndefined()
  })
})

describe('the mark survives a server restart', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'last-msg-')); useLastMessagesFile(join(dir, 'last-messages.json')) })
  afterEach(() => { useLastMessagesFile(null); rmSync(dir, { recursive: true, force: true }) })

  it('a notice is still the newest message after the in-memory copy is dropped', async () => {
    noteMessageTo('lead', 1_000, { from: 'worker', kind: 'notice' })
    await restartLastMessages() // what a restart does
    expect(lastMessageTo('lead')?.kind).toBe('notice')
    const views = withAfterNotice([{ id: 'lead', activity: 'waiting', status: 'running' } as never], id => lastMessageTo(id)?.kind)
    expect(views[0]!.afterNotice).toBe(true)
  })
  it('a later message still lifts it after a restart', async () => {
    noteMessageTo('lead', 1_000, { from: 'worker', kind: 'notice' })
    noteMessageTo('lead', 2_000)
    await restartLastMessages()
    expect(lastMessageTo('lead')?.kind).toBeUndefined()
  })
  it('an unreadable file is "nothing known", not a crash', async () => {
    resetLastMessages()
    await restartLastMessages()
    expect(lastMessageTo('nobody')).toBeUndefined()
    expect(buildSessionViews).toBeDefined()
  })
})
