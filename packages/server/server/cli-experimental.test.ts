import { describe, expect, test } from 'bun:test'
import { resolveExperimental } from '@agentistics/core'
import { runExperimental, statusLines } from './cli-experimental'

describe('agentop experimental status wording', () => {
  test('says when an explicit variable overrides the preference', () => {
    const rows = resolveExperimental(true, { AGENTISTICS_JOURNAL: '0' })
    const text = statusLines(true, rows, 'en').join('\n')
    expect(text).toContain('kept off by AGENTISTICS_JOURNAL=0')
    expect(text).toContain('turned on by the preference')
  })
  test('off by default, in Portuguese', () => {
    const text = statusLines(undefined, resolveExperimental(undefined, {}), 'pt').join('\n')
    expect(text).toContain('DESLIGADOS')
    expect(text).toContain('desligado por padrão')
  })
})

describe('enable/disable never restart for no change (fix/kill-no-restart, 2026-10-04 02:58)', () => {
  // The incident: `agentop experimental enable` ran by accident (a backquoted command inside a
  // double-quoted shell string) on a machine where it was ALREADY enabled, and bounced the
  // production server through systemd. Every collaborator is injected: no real unit is ever touched.
  function harness(o: { pref?: boolean; live?: boolean | null }) {
    const calls = { restart: 0, write: 0 }
    const out: string[] = []
    const deps = {
      lang: async () => 'en' as const,
      readPrefs: async () => ({ ...(o.pref !== undefined ? { experimental: o.pref } : {}) }),
      writePrefs: async () => { calls.write++ },
      restart: async () => { calls.restart++; return { state: 'restarted' as const, message: '' } },
      askServer: async () => (o.live === null || o.live === undefined ? null : { enabled: o.live, features: [] }),
      waitForState: async () => true,
      log: (l: string) => out.push(l), error: (l: string) => out.push(`!${l}`),
    }
    return { deps, calls, out }
  }

  test('already enabled: nothing is written, nothing is restarted, and it says so', async () => {
    const h = harness({ pref: true, live: true })
    expect(await runExperimental(['enable'], h.deps)).toBe(0)
    expect(h.calls).toEqual({ restart: 0, write: 0 })
    expect(h.out.join('\n')).toContain('already enabled: nothing changed, so nothing was restarted')
  })

  test('already disabled (absent = off): disable restarts nothing', async () => {
    const h = harness({ live: null })
    expect(await runExperimental(['disable'], h.deps)).toBe(0)
    expect(h.calls.restart).toBe(0)
  })

  test('the preference matches but the running server disagrees: it is SAID, never auto-restarted', async () => {
    const h = harness({ pref: true, live: false })
    expect(await runExperimental(['enable'], h.deps)).toBe(0)
    expect(h.calls.restart).toBe(0)
    expect(h.out.join('\n')).toContain('agentop restart server')
  })

  test('a real change still persists and restarts, as before', async () => {
    const h = harness({ pref: false, live: false })
    expect(await runExperimental(['enable'], h.deps)).toBe(0)
    expect(h.calls).toEqual({ restart: 1, write: 1 })
  })
})
