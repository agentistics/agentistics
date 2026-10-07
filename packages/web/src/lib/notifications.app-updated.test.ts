import { describe, expect, test } from 'bun:test'
import { resolveNotification } from './notifications'

describe('app.updated', () => {
  test('fills {version} in the title, with a single v', () => {
    const n = { id: 'x', code: 'app.updated', meta: { version: '2.111.0' }, type: 'success', at: 0, read: false } as unknown as Parameters<typeof resolveNotification>[0]
    expect(resolveNotification(n, 'pt').title).toBe('Agentistics atualizado para v2.111.0')
    expect(resolveNotification(n, 'en').title).toBe('Agentistics updated to v2.111.0')
  })
})
