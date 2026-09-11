import { expect, test, describe } from 'bun:test'
import { GONE_PROJECT_KEY, type ControlSession } from '@agentistics/tui/control/session-fleet'
import { applyManualOrder, asideGroups, showsGroupHeadings } from './fleetGroups'

function row(o: Partial<ControlSession> & { id: string }): ControlSession {
  return {
    title: o.id, harness: 'claude', cwd: '/w', project: 'w',
    searchFields: {} as ControlSession['searchFields'],
    state: 'working', stateLabel: 'working', actionable: true, attached: false,
    ...o,
  } as ControlSession
}

describe('asideGroups — project', () => {
  test('one band per project, named by the project', () => {
    const out = asideGroups([
      row({ id: 'a', project: 'agentistics' }),
      row({ id: 'b', project: 'aipe' }),
      row({ id: 'c', project: 'agentistics' }),
    ], 'project', 'en')
    expect(out.map(g => g.label).sort()).toEqual(['agentistics', 'aipe'])
    expect(out.find(g => g.label === 'agentistics')!.sessions).toHaveLength(2)
  })

  test('the band holding the most urgent session comes first', () => {
    const out = asideGroups([
      row({ id: 'a', project: 'quiet', state: 'working' }),
      row({ id: 'b', project: 'blocked', state: 'waiting-approval' }),
    ], 'project', 'en')
    expect(out[0]!.label).toBe('blocked')
  })

  test('a session with no project gets a band said in WORDS, never a blank heading', () => {
    const en = asideGroups([row({ id: 'a', project: '' })], 'project', 'en')
    const pt = asideGroups([row({ id: 'a', project: '' })], 'project', 'pt')
    expect(en[0]!.label).toBe('No project')
    expect(pt[0]!.label).toBe('Sem projeto')
  })

  test('a directory that is GONE is its own band, not the no-project one', () => {
    const out = asideGroups([
      row({ id: 'a', project: 'x', dirGone: 'the folder is gone' }),
      row({ id: 'b', project: '' }),
    ], 'project', 'en')
    const labels = out.map(g => g.label)
    expect(labels).toContain('Folder is gone')
    expect(labels).toContain('No project')
    expect(new Set(labels).size).toBe(2)
  })

  test('an empty fleet yields no bands', () => {
    expect(asideGroups([], 'project', 'en')).toEqual([])
  })

  test('projectGroup outranks the directory name, and GONE has its own key', () => {
    const out = asideGroups([
      row({ id: 'a', project: 'worktree-x', projectGroup: 'agentistics' }),
      row({ id: 'b', project: 'worktree-y', projectGroup: 'agentistics' }),
    ], 'project', 'en')
    expect(out).toHaveLength(1)
    expect(out[0]!.label).toBe('agentistics')
    expect(out[0]!.key).not.toBe(GONE_PROJECT_KEY)
  })
})

describe('asideGroups — task', () => {
  test('one band per delivery, and an unfiled session gets the same word the row chip uses', () => {
    const out = asideGroups([
      row({ id: 'a', task: 'ALM board' }),
      row({ id: 'b' }),
    ], 'task', 'en')
    expect(out.map(g => g.label).sort()).toEqual(['ALM board', 'No delivery'])
  })

  test('PT names the same unfiled bucket "sem entrega"', () => {
    const out = asideGroups([row({ id: 'a' })], 'task', 'pt')
    expect(out[0]!.label).toBe('Sem entrega')
  })
})

describe('asideGroups — status', () => {
  test('seven raw states are seven distinct groups, never collapsed', () => {
    const out = asideGroups([
      row({ id: 'a', state: 'exited' }),
      row({ id: 'b', state: 'lost' }),
      row({ id: 'c', state: 'closed' }),
    ], 'status', 'en')
    expect(out).toHaveLength(3)
    expect(out.map(g => g.label).sort()).toEqual(['Closed', 'Finished', 'Lost'])
  })

  test('the most urgent state leads', () => {
    const out = asideGroups([
      row({ id: 'a', state: 'working' }),
      row({ id: 'b', state: 'waiting-approval' }),
    ], 'status', 'en')
    expect(out[0]!.label).toBe('Needs approval')
  })

  test('PT labels match the vocabulary used elsewhere in the product', () => {
    const out = asideGroups([row({ id: 'a', state: 'waiting' })], 'status', 'pt')
    expect(out[0]!.label).toBe('Precisa de você')
  })

  test('a session is counted once, under its OWN state — no state absorbs another', () => {
    const out = asideGroups([
      row({ id: 'a', state: 'exited' }),
      row({ id: 'b', state: 'exited' }),
      row({ id: 'c', state: 'lost' }),
    ], 'status', 'en')
    expect(out.find(g => g.label === 'Finished')!.sessions).toHaveLength(2)
    expect(out.find(g => g.label === 'Lost')!.sessions).toHaveLength(1)
  })
})

describe('showsGroupHeadings', () => {
  test('one group draws no heading', () => {
    expect(showsGroupHeadings(asideGroups([
      row({ id: 'a', project: 'agentistics' }),
      row({ id: 'b', project: 'agentistics' }),
    ], 'project', 'en'))).toBe(false)
  })

  test('two groups draw headings', () => {
    expect(showsGroupHeadings(asideGroups([
      row({ id: 'a', project: 'agentistics' }),
      row({ id: 'b', project: 'aipe' }),
    ], 'project', 'en'))).toBe(true)
  })

  test('nothing at all draws no heading', () => {
    expect(showsGroupHeadings([])).toBe(false)
  })
})

describe('applyManualOrder', () => {
  test('empty order leaves the automatic order untouched', () => {
    const groups = asideGroups([
      row({ id: 'a', project: 'quiet', state: 'working' }),
      row({ id: 'b', project: 'blocked', state: 'waiting-approval' }),
    ], 'project', 'en')
    expect(applyManualOrder(groups, [])).toEqual(groups)
  })

  test('known keys come first, in the given order, overriding the automatic one', () => {
    const groups = asideGroups([
      row({ id: 'a', project: 'quiet', state: 'working' }),
      row({ id: 'b', project: 'blocked', state: 'waiting-approval' }),
    ], 'project', 'en')
    // Automatic order puts "blocked" first (waiting-approval outranks working) — manual order
    // overrides it.
    const out = applyManualOrder(groups, ['quiet', 'blocked'])
    expect(out.map(g => g.key)).toEqual(['quiet', 'blocked'])
  })

  test('a key with no group is simply absent — nothing to reconcile', () => {
    const groups = asideGroups([row({ id: 'a', project: 'quiet' })], 'project', 'en')
    const out = applyManualOrder(groups, ['gone-project', 'quiet'])
    expect(out.map(g => g.key)).toEqual(['quiet'])
  })

  test('a group not yet in the manual order is appended after every placed one', () => {
    const groups = asideGroups([
      row({ id: 'a', project: 'x' }),
      row({ id: 'b', project: 'y' }),
      row({ id: 'c', project: 'z' }),
    ], 'project', 'en')
    // Only "z" has been manually placed — "x" and "y" fall in after it.
    const out = applyManualOrder(groups, ['z'])
    expect(out[0]!.key).toBe('z')
    expect(new Set(out.map(g => g.key))).toEqual(new Set(['x', 'y', 'z']))
  })
})
