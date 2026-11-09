import { describe, expect, it } from 'bun:test'
import type { ChatTurn } from '@agentistics/core'
import { captureHandoffRelay, flushHandoffRelay, recordHandoffLink } from './handoff-relay-io'
import type { ManagedSession } from './types'
import type { patchSession } from './registry'

const t = (role: 'user' | 'assistant', text: string, min: number): ChatTurn =>
  ({ role, text, at: new Date(Date.UTC(2026, 9, 16, 14, min)).toISOString() })
const row = (o: Partial<ManagedSession>): ManagedSession => ({ id: 'prev', conversationId: 'c1', harness: 'claude', cwd: '/x', createdAt: new Date(Date.UTC(2026, 9, 16, 14, 0)).toISOString(), ...o } as ManagedSession)

describe('QA fluxo-pedido-fila — request registration must never block relay delivery', () => {
  it('a throwing request registration (flows could not be enabled) still forwards the owner message to the successor', async () => {
    const turns = [t('user', 'e o motor?', 10)]
    const registry = [row({ handoffTo: 'next', handoffRelayedAt: new Date(Date.UTC(2026, 9, 16, 14, 1)).toISOString() }), row({ id: 'next', conversationId: 'c2' })]
    const sent: string[] = []
    const result = await flushHandoffRelay(registry[0]!, registry, async to => { sent.push(to); return true }, {
      read: async () => ({ turns }),
      patch: async () => true,
      ownerMessages: async () => { throw new Error('mandatory owner-request flow pedido-do-dono could not be enabled') },
    }).catch(() => ({ ok: false, delivered: false, threw: true }))
    expect(sent).toEqual(['next'])
    expect(result).toMatchObject({ delivered: true })
  })

  it('failed registration and failed send keep the cursor for a later delivery attempt', async () => {
    const parent = row({ handoffTo: 'next', handoffRelayedAt: t('user', '', 1).at })
    const patches: unknown[] = []
    const result = await flushHandoffRelay(parent, [parent, row({ id: 'next' })], async () => false, {
      read: async () => ({ turns: [t('user', 'still owed', 10)] }),
      patch: async (_id, patch) => { patches.push(patch); return true },
      ownerMessages: async () => { throw new Error('flows unavailable') },
    })
    expect(result).toMatchObject({ ok: false, delivered: false, reason: 'send-failed' })
    expect(patches).toEqual([])
  })

  it('failed briefing registration preserves its cursor and forwards only subsequent owner turns', async () => {
    const parent = row({})
    const child = row({ id: 'next', conversationId: 'c2' })
    const turns = [t('user', 'already in briefing', 10), t('assistant', 'answer in briefing', 11)]
    const captured = await captureHandoffRelay(parent, async () => ({ turns }))
    await recordHandoffLink(parent.id, child.id, captured, undefined, {
      patch: async (id, patch) => { Object.assign(id === parent.id ? parent : child, patch); return true },
      ownerMessages: async () => { throw new Error('flows unavailable') },
    })
    expect(parent.handoffRelayedAt).toBe(turns[1]!.at)
    const sent: string[] = []
    const io = {
      read: async () => ({ turns }),
      patch: async (_id: string, patch: Parameters<typeof patchSession>[1]) => { Object.assign(parent, patch); return true },
      ownerMessages: async () => { throw new Error('flows unavailable') },
    }
    const send = async (_to: string, text: string) => { sent.push(text); return true }
    expect(await flushHandoffRelay(parent, [parent, child], send, io)).toMatchObject({ delivered: false })
    expect(sent).toEqual([])
    turns.push(t('user', 'new owner request', 12))
    expect(await flushHandoffRelay(parent, [parent, child], send, io)).toMatchObject({ delivered: true })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('new owner request')
    expect(sent[0]).not.toContain('already in briefing')
    expect(parent.handoffRelayedAt).toBe(turns[2]!.at)
    expect(await flushHandoffRelay(parent, [parent, child], send, io)).toMatchObject({ delivered: false })
    expect(sent).toHaveLength(1)
  })
})
