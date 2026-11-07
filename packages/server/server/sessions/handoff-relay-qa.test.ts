import { describe, expect, it } from 'bun:test'
import type { ChatTurn } from '@agentistics/core'
import { flushHandoffRelay } from './handoff-relay-io'
import type { ManagedSession } from './types'

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
})
