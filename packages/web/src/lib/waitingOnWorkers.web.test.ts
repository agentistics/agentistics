import { describe, expect, it } from 'bun:test'
import { attentionCount } from '../components/nav/AttentionDot'
import { summaryCounts } from './asideSummary'
import { teamSummary, waitingIds } from './asideTabs'
import { lineStatusKind, lineStatusText } from './lineStatus'
import { fleetActivityStates, staleClockRows } from './sessionNotifications'
import { asideGroups } from './fleetGroups'
import { summarizeFleet } from './fleetSummary'
import { ownerActivity, waitsOnPerson } from './sessionWaiting'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { railFolderCounts } from './railLayout'
import { naySections } from './nayList'
import { followChipView } from '../components/browser/BrowserFollowChip'

const lead = { id: 'lead', state: 'waiting' as const, waitingOnWorkers: 2, title: 'Prontuario' }
const worker = { id: 'f7', state: 'working' as const, title: 'F7' }
const alone = { id: 'x', state: 'waiting' as const, title: 'X' }

describe('the sidebar icon', () => {
  it('is the workers kind with the count, until the workers stop', () => {
    expect(lineStatusKind('waiting', null, false, 2)).toBe('workers')
    expect(lineStatusKind('waiting', null, false, 0)).toBe('you')
    expect(lineStatusText('workers', '3 min', true, 2)).toBe('esperando 2 workers há 3 min')
    expect(lineStatusText('workers', 'now', false, 1)).toBe('waiting on 1 worker now')
  })

  it('a dialog or its own running work wins', () => {
    expect(lineStatusKind('waiting-approval', null, false, 2)).toBe('approval')
    expect(lineStatusKind('waiting', 'task', false, 2)).toBe('task')
    expect(lineStatusKind('working', null, false, 2)).toBe('writing')
  })
})

describe('needs-you counters', () => {
  const rows = [lead, worker, alone]
  it('leave the waiting leader out everywhere', () => {
    expect(attentionCount(rows)).toBe(1)
    expect(summaryCounts(rows).needs).toBe(1)
    expect(waitingIds(rows)).toEqual(new Set(['x']))
    expect(teamSummary([lead], true)).toBe('1 na equipe')
    expect(railFolderCounts(rows, 0).waiting).toBe(1)
  })

  it('put it with the working ones in the Nay tab, and calm in the browser chip', () => {
    expect(naySections([{ ...lead, cwd: '/x/.agentistics/nay-chat' }]).waiting).toEqual([])
    expect(followChipView(lead, undefined, 'pt')).toEqual({ text: 'Prontuario · esperando workers', dot: 'var(--text-tertiary)' })
  })

  it('notify nothing for it, and something once it is only waiting', () => {
    expect(fleetActivityStates([lead])).toEqual({ lead: 'idle' })
    expect(fleetActivityStates([{ ...lead, waitingOnWorkers: undefined }])).toEqual({ lead: 'waiting' })
  })

  it('run no "not opened for a while" clock for it', () => {
    expect(staleClockRows([lead, alone]).map(r => r.state)).toEqual(['idle', 'waiting'])
    expect(staleClockRows([{ ...lead, state: 'waiting-approval' as const }])[0]!.state).toBe('waiting-approval')
  })

  it('count it out of the fleet card, and give it its own status group', () => {
    const control = (r: { id: string; state: ControlSession['state']; waitingOnWorkers?: number; title: string }) =>
      ({ cwd: '/r', project: 'r', harness: 'claude', stateLabel: r.state, attached: false, actionable: true, ...r }) as ControlSession
    const fleet = [control(lead), control(worker), control(alone)]
    expect(summarizeFleet(fleet, 0).waiting).toBe(1)
    const groups = asideGroups(fleet, 'status', 'pt')
    const groupOf = (id: string) => groups.find(g => g.sessions.some(s => s.id === id))!
    expect(groupOf('lead').key).toBe('waiting-workers')
    expect(groupOf('lead').label).toBe('Esperando workers')
    expect(groupOf('x').key).toBe('waiting')
    expect(asideGroups(fleet, 'status', 'en').find(g => g.key === 'waiting-workers')!.label).toBe('Waiting on workers')
  })
})

describe('the session list\'s "waiting" shortcut', () => {
  it('reads the fleet row, not the bare activity', () => {
    expect(waitsOnPerson('waiting', { state: 'waiting', waitingOnWorkers: 1 })).toBe(false)
    expect(ownerActivity('waiting', { state: 'waiting', waitingOnWorkers: 1 })).toBe('idle')
    expect(waitsOnPerson('waiting', { state: 'waiting' })).toBe(true)
    expect(waitsOnPerson('waiting', undefined)).toBe(true)
    expect(waitsOnPerson('waiting-approval', { state: 'waiting-approval', waitingOnWorkers: 1 })).toBe(true)
    expect(waitsOnPerson('working', undefined)).toBe(false)
  })
})
