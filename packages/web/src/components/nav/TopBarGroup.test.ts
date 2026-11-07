import { describe, expect, test } from 'bun:test'
import { groupAccented, groupRows, liveStateLine, type GroupFacts } from './topBarGroupModel'

const base: GroupFacts = {
  pt: false, hasHardware: true, host: true, awayActive: false, vault: 'locked', liveWorking: 0, liveWaiting: 0,
  callsSurface: { id: 'calls', label: 'Calls', beta: true }, callActive: false,
}
const ids = (f: GroupFacts) => groupRows(f).map(r => r.id)

describe('topBarGroupModel', () => {
  test('all five rows when everything is available', () => {
    expect(ids(base)).toEqual(['hardware', 'autonomous', 'vault', 'live', 'calls'])
  })
  test('with no voice the Calls row disappears (kill switch AGENTISTICS_VOICE)', () => {
    expect(ids({ ...base, callsSurface: null })).toEqual(['hardware', 'autonomous', 'vault', 'live'])
  })
  test('on a central the host-only rows are absent; Hardware only where a handler exists', () => {
    expect(ids({ ...base, host: false, hasHardware: false })).toEqual(['calls'])
    expect(ids({ ...base, host: false, hasHardware: false, callsSurface: null })).toEqual([])
  })
  test('the Calls row keeps its beta mark and its surface', () => {
    const calls = groupRows(base).find(r => r.id === 'calls')!
    expect(calls.beta).toBe(true)
    expect(calls.surfaceId).toBe('calls')
  })
  test('the button is accented only on real activity — never by vault state or hardware', () => {
    expect(groupAccented(groupRows(base))).toBe(false)
    expect(groupAccented(groupRows({ ...base, vault: 'open' }))).toBe(false)
    expect(groupAccented(groupRows({ ...base, awayActive: true }))).toBe(true)
    expect(groupAccented(groupRows({ ...base, liveWorking: 2 }))).toBe(true)
    expect(groupAccented(groupRows({ ...base, liveWaiting: 1 }))).toBe(true)
    expect(groupAccented(groupRows({ ...base, callActive: true }))).toBe(true)
  })
  test('each state is one real line, in both languages', () => {
    expect(liveStateLine(0, 0, true)).toBe('sem atividade')
    expect(liveStateLine(2, 1, false)).toBe('1 waiting on you · 2 working')
    const away = groupRows({ ...base, pt: true, awayActive: true, awayUntil: 'até 18h' }).find(r => r.id === 'autonomous')!
    expect(away.state).toBe('até 18h')
    expect(groupRows({ ...base, pt: true }).find(r => r.id === 'vault')!.state).toBe('trancado')
  })
})
