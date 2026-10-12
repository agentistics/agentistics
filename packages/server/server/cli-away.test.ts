import { describe, expect, it } from 'bun:test'
import { parseAwayArgs, untilFromArg } from './cli-away'

const now = new Date(2026, 9, 11, 23, 50).getTime()

describe('agentop away arguments', () => {
  it('status by default, off, unknown verb', () => {
    expect(parseAwayArgs([], now)).toEqual({ kind: 'status' })
    expect(parseAwayArgs(['off'], now)).toEqual({ kind: 'set', body: { on: false } })
    expect(parseAwayArgs(['maybe'], now).kind).toBe('error')
  })
  it('on with flags', () => {
    expect(parseAwayArgs(['on', '--until', 'back', '--allow', 'releases,merges', '--workers', '4', '--opus', '1', '--note', 'qa first'], now)).toEqual({
      kind: 'set', body: { on: true, until: null, authorised: ['releases', 'merges'], maxWorkers: 4, topCaps: { claude: 1 }, note: 'qa first' },
    })
    expect(parseAwayArgs(['on', '--allow', 'none'], now)).toMatchObject({ body: { authorised: [] } })
    expect(parseAwayArgs(['on', '--cap', 'codex=1,gemini=0', '--cap', 'claude=2'], now)).toMatchObject({ body: { topCaps: { codex: 1, gemini: 0, claude: 2 } } })
    expect(parseAwayArgs(['on', '--cap', 'chatgpt=1'], now).kind).toBe('error')
    expect(parseAwayArgs(['on', '--cap', 'codex'], now).kind).toBe('error')
    expect(parseAwayArgs(['on', '--until'], now).kind).toBe('error')
  })
  it('session on/off', () => {
    expect(parseAwayArgs(['session', 'abc', 'on'], now)).toEqual({ kind: 'session', body: { target: 'abc', on: true } })
    expect(parseAwayArgs(['session', 'abc', 'off'], now)).toEqual({ kind: 'session', body: { target: 'abc', on: false } })
    expect(parseAwayArgs(['session', 'abc'], now).kind).toBe('error')
  })
  it('until forms', () => {
    expect(Date.parse(untilFromArg('8h', now)!)).toBe(now + 8 * 3_600_000)
    const t = new Date(untilFromArg('09:00', now)!)
    expect([t.getDate(), t.getHours()]).toEqual([12, 9])
    expect(untilFromArg('soon', now)).toBeUndefined()
  })
})
