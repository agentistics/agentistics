/**
 * waitingOnWorkers.test.ts — the cockpit's readers of `waitingOnWorkers`: a leader whose turn ended
 * while its workers still run is not waiting on the person, so no "needs you" reading counts it.
 */
import { describe, expect, test } from 'bun:test'
import { machineLine } from './home'
import { SESSION_DIMENSIONS } from './session-dimensions'
import { attentionOf, sessionNotify } from './session-fleet'
import type { ControlSession } from './types'

const row = (id: string, state: ControlSession['state'], over: Partial<ControlSession> = {}): ControlSession =>
  ({ id, title: id, harness: 'claude', cwd: '/r', project: 'r', state, stateLabel: state, attached: false, actionable: true, ...over } as ControlSession)

const lead = row('lead', 'waiting', { waitingOnWorkers: 2 })
const worker = row('w', 'working', { parentSessionId: 'lead' })
const alone = row('x', 'waiting')

describe('a leader waiting on its workers, in the cockpit', () => {
  test('the home card counts only who needs a person', () => {
    expect(machineLine([lead, worker])).toEqual({ others: 2, need: 0 })
    expect(machineLine([lead, worker, alone])).toEqual({ others: 3, need: 1 })
  })

  test('the header counter and the row dot leave it out; a dialog still counts', () => {
    expect(attentionOf([lead, worker, alone])).toBe(1)
    expect(sessionNotify(lead)).toBe(false)
    expect(sessionNotify(alone)).toBe(true)
    expect(sessionNotify(row('q', 'waiting-approval', { waitingOnWorkers: 1 }))).toBe(true)
  })

  test('grouped by status it does not sit with the sessions waiting on you', () => {
    const keyOf = SESSION_DIMENSIONS.status.keyOf
    expect(keyOf(lead, undefined as never)).not.toBe(keyOf(alone, undefined as never))
    expect(keyOf(alone, undefined as never)).toBe('waiting')
  })
})
