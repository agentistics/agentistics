import { describe, expect, test } from 'bun:test'
import { terminateAndConfirm } from './terminate'

const mk = (diesOn: 'SIGTERM' | 'SIGKILL' | 'never') => {
  let dead = false
  const sent: string[] = []
  return {
    sent,
    d: {
      kill: (_p: number, s: NodeJS.Signals | 0) => { sent.push(String(s)); if (s === diesOn) dead = true },
      alive: () => !dead,
      sleep: async () => {},
      graceMs: 300, pollMs: 100,
    },
  }
}

describe('terminateAndConfirm', () => {
  test('SIGTERM is enough', async () => {
    const m = mk('SIGTERM')
    expect(await terminateAndConfirm(1, m.d)).toEqual({ ended: true, signal: 'SIGTERM' })
    expect(m.sent).toEqual(['SIGTERM'])
  })
  test('a process that ignores SIGTERM is SIGKILLed', async () => {
    const m = mk('SIGKILL')
    expect(await terminateAndConfirm(1, m.d)).toEqual({ ended: true, signal: 'SIGKILL' })
    expect(m.sent).toEqual(['SIGTERM', 'SIGKILL'])
  })
  test('one that survives both is reported NOT ended', async () => {
    const m = mk('never')
    expect((await terminateAndConfirm(1, m.d)).ended).toBe(false)
  })
})
