import { describe, expect, test } from 'bun:test'
import { NAY_CALL_IDLE, callStateOf, callSurfaceOf, nayCallFace, naySessionForCall } from './nayCall'
import type { EngineSurfaceInfo } from './engineSurfaces'

const call: EngineSurfaceInfo = { id: 'voice-call', placement: 'composer', icon: 'phone', label: { pt: 'Ligar', en: 'Call' }, module: '/api/engine/x/voice/m.js' }
const other: EngineSurfaceInfo = { id: 'sparkle', placement: 'composer', icon: 'sparkles', label: { pt: 'X', en: 'X' }, module: '/api/engine/x/s/m.js' }
const rail: EngineSurfaceInfo = { id: 'calls', placement: 'rail', icon: 'phone', label: { pt: 'Ligações', en: 'Calls' }, module: '/api/engine/x/calls/m.js' }

describe('callSurfaceOf', () => {
  test('is the composer surface with the phone icon', () => {
    expect(callSurfaceOf([other, rail, call])?.id).toBe('voice-call')
  })
  test('no voice (community build, kill switch, engine without voice) means no surface, so no button', () => {
    expect(callSurfaceOf([])).toBeNull()
    expect(callSurfaceOf([other, rail])).toBeNull()
  })
})

describe('callStateOf / nayCallFace', () => {
  test('idle without a mounted call surface', () => {
    expect(callStateOf(call, [])).toEqual(NAY_CALL_IDLE)
    expect(callStateOf(null, [{ surface: { id: 'voice-call' }, sessionId: 's', parked: false, indicator: null }])).toEqual(NAY_CALL_IDLE)
  })
  test('reads the same mounted surface the top-bar pill reads (parked or on screen)', () => {
    const st = callStateOf(call, [{ surface: { id: 'voice-call' }, sessionId: 'nay-1', parked: true, indicator: { since: 1234 } }])
    expect(st).toEqual({ active: true, parked: true, sessionId: 'nay-1', since: 1234 })
  })
  test('the face reads "Ligar para a Nay" idle and "Voltar à ligação" during a call, pt and en', () => {
    expect(nayCallFace(NAY_CALL_IDLE, 'pt').label).toBe('Ligar para a Nay')
    expect(nayCallFace(NAY_CALL_IDLE, 'en').label).toBe('Call Nay')
    const on = { active: true, parked: false, sessionId: 's', since: null }
    expect(nayCallFace(on, 'pt')).toMatchObject({ label: 'Voltar à ligação', tone: 'active' })
    expect(nayCallFace(on, 'en').label).toBe('Back to the call')
  })
})

describe('naySessionForCall', () => {
  const nay = '/home/u/.agentistics/nay-chat'
  const rows = [
    { id: 'old', cwd: nay, state: 'exited', startedAt: 1 },
    { id: 'busy', cwd: nay, state: 'working', startedAt: 5 },
    { id: 'wait', cwd: nay, state: 'waiting', startedAt: 3 },
    { id: 'plain', cwd: '/work/repo', state: 'waiting', startedAt: 9 },
  ]
  test('prefers the conversation open in the dock when alive', () => {
    expect(naySessionForCall(rows, 'busy')).toBe('busy')
  })
  test('else the newest alive Nay conversation, waiting first; never an ordinary session or an ended one', () => {
    expect(naySessionForCall(rows, null)).toBe('wait')
    expect(naySessionForCall(rows, 'old')).toBe('wait')
  })
  test('none alive means the caller starts one', () => {
    expect(naySessionForCall([rows[0]!, rows[3]!], null)).toBeNull()
  })
})
