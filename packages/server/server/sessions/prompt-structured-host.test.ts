import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createControlHost } from '../cli-start'
import { __setSessionBackendForTest } from './index'
import { __setHarnessAgentsReaderForTest } from './harness-agents-io'
import { addSession, removeSession } from './registry'
import { messageStatus, resetMessageRateLimit, sendSessionMessage } from './session-message'
import type { SessionBackend } from './types'

const filed: string[] = []
let savedUpdateCheck: string | undefined
beforeAll(() => {
  __setHarnessAgentsReaderForTest(async () => [])
  savedUpdateCheck = process.env.AGENTISTICS_NO_UPDATE_CHECK
  process.env.AGENTISTICS_NO_UPDATE_CHECK = '1'
})
afterAll(() => {
  __setHarnessAgentsReaderForTest(null)
  if (savedUpdateCheck === undefined) delete process.env.AGENTISTICS_NO_UPDATE_CHECK
  else process.env.AGENTISTICS_NO_UPDATE_CHECK = savedUpdateCheck
})
afterEach(async () => {
  __setSessionBackendForTest(null)
  resetMessageRateLimit()
  for (const id of filed.splice(0)) await removeSession(id)
})

// Run inside agentop run --rm: the host uses that run's isolated registry, never the owner's.
async function target(harness: 'claude' | 'codex', state: 'busy' | 'approval' | 'gone' | 'unrecoverable' = 'busy') {
  const id = `msg-confirm-${crypto.randomUUID()}`
  filed.push(id)
  await addSession({ id, harness, cwd: process.cwd(), createdAt: new Date().toISOString() })
  let adopted = false
  const calls: string[] = []
  const backend = {
    id: 'tmux', unavailable: async () => undefined,
    list: async () => [{ id, alive: state !== 'gone', createdMs: 1, attached: false }],
    isStructured: () => true,
    chatOf: () => adopted ? { chat: {}, conversationId: 'conv' } : undefined,
    activityOf: () => 'working',
    attentionOf: () => adopted && state === 'approval' ? { requestId: 'permission' } : null,
    async reattach() { calls.push('recover'); adopted = state !== 'unrecoverable' },
    async capture() { throw new Error('a structured session has no tmux pane') },
    async sendText(_id: string, text: string) { calls.push(text); return true },
    async sendTextReliable() { throw new Error('Codex TUI paste must never address a structured driver') },
  } as unknown as SessionBackend
  __setSessionBackendForTest(backend)
  const host = createControlHost('en', { async suspend<T>(_fn: () => Promise<T>): Promise<T> { throw new Error('no terminal') } })
  const send = () => sendSessionMessage('leader', { to: id, kind: 'question', body: 'status?' }, {
    rows: async () => [{ id, title: 'Worker' }],
    prompt: (to, text) => host.promptSession!(to, text),
    senderTask: async () => ({}), comment: async () => ({ ok: true }), now: () => 1000,
  })
  return { calls, send }
}

describe('session-message to a CLI-born structured worker (H2)', () => {
  for (const harness of ['claude', 'codex'] as const) {
    test(`${harness}: recover the missing local driver before sending to a busy worker`, async () => {
      const t = await target(harness)
      const reply = await t.send()
      expect(messageStatus(reply)).toBe(200)
      expect(reply).toMatchObject({ ok: true, delivered: true })
      expect(t.calls).toEqual(['recover', '[from session leader · question]\nstatus?'])
    })
    test(`${harness}: read recovered attention before typing; preserve target_blocked`, async () => {
      const t = await target(harness, 'approval')
      const reply = await t.send()
      expect(messageStatus(reply)).toBe(409)
      expect(reply).toMatchObject({ ok: false, code: 'target_blocked' })
      expect(t.calls).toEqual(['recover'])
    })
    test(`${harness}: a gone worker stays not_delivered without recovery or typing`, async () => {
      const t = await target(harness, 'gone')
      expect(await t.send()).toMatchObject({ ok: false, code: 'not_delivered' })
      expect(t.calls).toEqual([])
    })
    test(`${harness}: a relay without a recoverable driver never falls through to tmux`, async () => {
      const t = await target(harness, 'unrecoverable')
      expect(await t.send()).toMatchObject({ ok: false, code: 'not_delivered' })
      expect(t.calls).toEqual(['recover'])
    })
  }
})
