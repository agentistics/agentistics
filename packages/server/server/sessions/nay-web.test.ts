import { describe, expect, test } from 'bun:test'
import { startNaySession, type NaySpawnDeps } from './nay-web'
import { NAY_CHAT_DIR } from '../chat-tty'

function deps(over: Partial<NaySpawnDeps> = {}) {
  const calls: { spawned?: unknown; filed?: string } = {}
  const d: NaySpawnDeps = {
    ensureDir: async () => {},
    spawn: (async (_lang, body) => { calls.spawned = body; return { ok: true, message: 'started', id: 'm1' } }) as NaySpawnDeps['spawn'],
    model: async () => '',
    keyOf: async id => `conv-of-${id}`,
    file: async key => { calls.filed = key },
    now: () => new Date(2026, 8, 29, 14, 5),
    ...over,
  }
  return { d, calls }
}

describe('startNaySession', () => {
  test('starts claude in Nay\'s own directory and files it by its conversation key', async () => {
    const { d, calls } = deps()
    const out = await startNaySession('pt', d)
    expect(out).toMatchObject({ ok: true, id: 'm1' })
    expect(calls.spawned).toEqual({ harness: 'claude', cwd: NAY_CHAT_DIR, label: 'Nay · 29/09 14:05' })
    expect(calls.filed).toBe('conv-of-m1')
  })

  test('the model chosen in Settings -> Chat is passed on; none means the CLI default', async () => {
    const { d, calls } = deps({ model: async () => 'claude-opus-5-5' })
    await startNaySession('en', d)
    expect(calls.spawned).toMatchObject({ model: 'claude-opus-5-5' })
  })

  test('a refused start is returned as is and files nothing', async () => {
    const { d, calls } = deps({ spawn: (async () => ({ ok: false, message: 'no' })) as NaySpawnDeps['spawn'] })
    expect(await startNaySession('en', d)).toEqual({ ok: false, message: 'no' })
    expect(calls.filed).toBeUndefined()
  })

  test('a filing failure never turns a started session into a failure', async () => {
    const { d } = deps({ file: async () => { throw new Error('disk') } })
    expect((await startNaySession('en', d)).ok).toBe(true)
  })
})
