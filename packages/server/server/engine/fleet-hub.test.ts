/**
 * fleet-hub.test.ts — what the host hands an engine as `fleet` (engine-api 1.4): confirmed
 * transitions only, nothing while nobody listens, no text, and the answer route's choice carried on
 * the transition that ends the wait.
 */
import { describe, expect, test } from 'bun:test'
import { ENGINE_API_VERSION, apiCompatible, type FleetTransition } from '@agentistics/engine-api'
import { ANSWER_NOTE_TTL_MS, createFleetHub, dialogOf, MAX_ANSWER_NOTES, type FleetHubRow } from './fleet-hub'
import { hostServices } from './load'

const row = (activity: FleetHubRow['activity'], over: Partial<FleetHubRow> = {}): FleetHubRow => ({
  id: 'm-1', harness: 'claude', conversationId: 'conv-1', activity, ...over,
})

function listen(hub = createFleetHub({ warn: () => {} })) {
  const got: FleetTransition[] = []
  const off = hub.subscribe(t => { got.push(t) })
  return { hub, got, off }
}

describe('the fleet hub — confirmed transitions only', () => {
  test('a first sighting is never a transition; a change counts only once seen on two consecutive polls', () => {
    const { hub, got } = listen()
    hub.observe([row('working')], 0)
    hub.observe([row('working')], 5_000) // confirmed: the belief, not a change
    expect(got).toEqual([])
    hub.observe([row('waiting-approval')], 10_000) // one frame: a flicker so far
    expect(got).toEqual([])
    hub.observe([row('waiting-approval')], 15_000) // held: confirmed
    expect(got).toEqual([{
      managedId: 'm-1', harness: 'claude', conversationId: 'conv-1', from: 'working', to: 'waiting-approval',
      at: new Date(15_000).toISOString(),
    }])
  })

  test('a one-frame repaint writes nothing — working, (blip) waiting-approval, working', () => {
    const { hub, got } = listen()
    hub.observe([row('working')], 0); hub.observe([row('working')], 1)
    hub.observe([row('waiting-approval')], 2)
    hub.observe([row('working')], 3); hub.observe([row('working')], 4)
    expect(got).toEqual([])
  })

  test('nobody listening: nothing is planned, and the first poll after a subscribe is a seed', () => {
    const hub = createFleetHub({ warn: () => {} })
    hub.observe([row('working')], 0); hub.observe([row('working')], 1)
    const { got } = listen(hub)
    hub.observe([row('waiting-approval')], 2); hub.observe([row('waiting-approval')], 3)
    expect(got).toEqual([]) // its earlier belief was never kept: this is a first confirmation
    hub.observe([row('working')], 4); hub.observe([row('working')], 5)
    expect(got.map(t => `${t.from}→${t.to}`)).toEqual(['waiting-approval→working'])
  })

  test('the dialog travels as counts — never a label — and the conversation only when the row has the exact link', () => {
    const { hub, got } = listen()
    const options = [{ label: 'Yes SECRET-1' }, { label: 'No SECRET-2' }, { label: 'Type something' }]
    hub.observe([row('working', { conversationId: undefined })], 0)
    hub.observe([row('working', { conversationId: undefined })], 1)
    hub.observe([row('waiting-approval', { conversationId: undefined, dialogOptions: options })], 2)
    hub.observe([row('waiting-approval', { conversationId: undefined, dialogOptions: options })], 3)
    expect(got).toHaveLength(1)
    expect(got[0]!.conversationId).toBeUndefined()
    expect(got[0]!.dialog).toEqual(dialogOf(row('waiting-approval', { dialogOptions: options })))
    expect(got[0]!.dialog!.optionCount).toBe(3)
    expect(JSON.stringify(got)).not.toContain('SECRET')
  })

  test('an unreadable dialog says nothing about options', () => {
    expect(dialogOf(row('waiting-approval', { dialogUnreadable: { reason: 'x' }, dialogOptions: [{ label: 'a' }] }))).toBeUndefined()
    expect(dialogOf(row('waiting-approval', { dialogOptions: [] }))).toBeUndefined()
  })

  test('answeredHere: the route\'s choice rides the transition OUT of waiting-approval, once', () => {
    const { hub, got } = listen()
    hub.observe([row('waiting-approval')], 0); hub.observe([row('waiting-approval')], 1)
    hub.noteAnswered('m-1', 2, 2)
    hub.observe([row('working')], 3); hub.observe([row('working')], 4)
    expect(got.at(-1)).toMatchObject({ from: 'waiting-approval', to: 'working', answeredHere: { choice: 2 } })
    hub.observe([row('waiting-approval')], 5); hub.observe([row('waiting-approval')], 6)
    hub.observe([row('working')], 7); hub.observe([row('working')], 8)
    expect(got.at(-1)!.answeredHere).toBeUndefined() // consumed
  })

  test('answer notes are bounded: expired after the TTL, never more than the cap', () => {
    const { hub, got } = listen()
    hub.observe([row('waiting-approval')], 0); hub.observe([row('waiting-approval')], 1)
    hub.noteAnswered('m-1', 1, 2)
    hub.observe([row('working')], 2 + ANSWER_NOTE_TTL_MS + 1); hub.observe([row('working')], 3 + ANSWER_NOTE_TTL_MS + 1)
    expect(got.at(-1)!.answeredHere).toBeUndefined()
    for (let i = 0; i < MAX_ANSWER_NOTES * 2; i++) hub.noteAnswered(`x-${i}`, 1, 0)
    hub.noteAnswered('m-2', 0) // not a 1-based index: ignored
    expect(MAX_ANSWER_NOTES).toBeGreaterThan(0)
  })

  test('a subscriber that throws is logged; the others still receive; unsubscribe stops delivery', () => {
    const warns: string[] = []
    const hub = createFleetHub({ warn: m => { warns.push(m) } })
    hub.subscribe(() => { throw new Error('boom') })
    const { got, off } = listen(hub)
    hub.observe([row('working')], 0); hub.observe([row('working')], 1)
    hub.observe([row('exited')], 2); hub.observe([row('exited')], 3)
    expect(got).toHaveLength(1)
    expect(warns).toHaveLength(1)
    off()
    expect(hub.subscribers()).toBe(1)
  })
})

describe('the host speaks 1.4', () => {
  test('ENGINE_API_VERSION speaks 1.4 or later, and a 1.3 engine still loads on it', () => {
    // A 1.4 engine (fleet, apiVersion, live) must load on this host, whatever later minor it speaks.
    expect(apiCompatible(ENGINE_API_VERSION, '1.4.0')).toBe(true)
    expect(apiCompatible(ENGINE_API_VERSION, '1.3.0')).toBe(true)
  })

  test('hostServices() names its contract version, offers the fleet, and answers the live flag from the journal flags', async () => {
    const h = await hostServices()
    expect(h.apiVersion).toBe(ENGINE_API_VERSION)
    expect(typeof h.fleet?.subscribe).toBe('function')
    const unsubscribe = h.fleet!.subscribe(() => {})
    unsubscribe()
    // The test environment sets neither AGENTISTICS_JOURNAL nor AGENTISTICS_JOURNAL_LIVE.
    expect(h.flag('live')).toBe(false)
  })
})
