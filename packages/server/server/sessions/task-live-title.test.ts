import { describe, expect, test } from 'bun:test'
import { ownerRequestDisplayTitle } from './task-live'

describe('owner request display titles', () => {
  const body = 'Skills de PoC (upx-briefing → upx-pocker) — reestruturar e melhorar'
  for (const priority of ['high priority', 'urgent priority', 'medium priority', 'low priority']) {
    test(`strips English ${priority}`, () => expect(ownerRequestDisplayTitle(`Owner's request: ${body} [${priority}] · p-6259c08947ba`, 'Task')).toEqual({ title: body, kind: 'owner-request' }))
  }
  for (const priority of ['urgente', 'alta', 'média', 'baixa']) {
    test(`strips Portuguese prioridade ${priority}`, () => expect(ownerRequestDisplayTitle(`Pedido do dono: ${body} [prioridade ${priority}] · p-6259c08947ba`, 'Task')).toEqual({ title: body, kind: 'owner-request' }))
  }
  test('leaves ordinary subtasks untouched', () => expect(ownerRequestDisplayTitle('Implementar a tela', 'Task')).toEqual({ title: 'Implementar a tela' }))
  test('falls back when the request remainder is empty', () => expect(ownerRequestDisplayTitle("Owner's request: [high priority] · p-6259c08947ba", 'Stored request title')).toEqual({ title: 'Stored request title', kind: 'owner-request' }))
})
