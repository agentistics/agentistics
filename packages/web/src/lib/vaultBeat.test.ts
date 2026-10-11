import { describe, expect, test } from 'bun:test'
import { pageBeat } from './vaultBeat'

const mk = (codes: Array<string | true>) => {
  const calls: string[] = []
  let i = 0
  return {
    calls,
    deps: {
      heartbeat: async () => { calls.push('beat'); const c = codes[i++]; return { json: c === true ? { ok: true } : { code: c } } },
      armHeartbeat: async () => { calls.push('arm'); return { json: { ok: true } } },
    },
  }
}

describe('pageBeat', () => {
  test('an untrusted (scripted) event does nothing', async () => {
    const m = mk([true])
    expect(await pageBeat({ isTrusted: false }, m.deps)).toBe('ignored')
    expect(m.calls).toEqual([])
  })
  test('re-arms only on activity-token, then beats again', async () => {
    const m = mk(['activity-token', true])
    expect(await pageBeat({ isTrusted: true }, m.deps)).toBe('rearmed')
    expect(m.calls).toEqual(['beat', 'arm', 'beat'])
  })
  for (const code of ['activity-too-soon', 'vault-locked', 'activity-gesture', 'activity-grant'])
    test(`never arms on ${code}`, async () => {
      const m = mk([code])
      expect(await pageBeat({ isTrusted: true }, m.deps)).toBe('beat')
      expect(m.calls).toEqual(['beat'])
    })
  test('a refused arm does not beat again', async () => {
    const calls: string[] = []
    const r = await pageBeat({ isTrusted: true }, {
      heartbeat: async () => { calls.push('beat'); return { json: { code: 'activity-token' } } },
      armHeartbeat: async () => { calls.push('arm'); return { json: { ok: false, code: 'activity-grant' } } },
    })
    expect(r).toBe('arm-refused'); expect(calls).toEqual(['beat', 'arm'])
  })
})
