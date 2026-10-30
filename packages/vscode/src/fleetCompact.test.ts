import { expect, test } from 'bun:test'
import { AgentopClient } from './api'

test('extension fallback expands compact verbs and loads ended rows', async () => {
  const original = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input))
    return urls.length === 1 || urls.length === 3
      ? Response.json({ sessions: [{ id: 'live', harness: 'claude', verbKey: 0 }], verbCatalog: [[{ action: 'prompt', enabled: true }]], closed: { total: 1, sent: 0 } })
      : Response.json({ sessions: [{ id: 'ended', verbKey: 0 }], verbCatalog: [[{ action: 'resume', enabled: true }]], total: 1 })
  }) as unknown as typeof fetch
  try {
    const result = await new AgentopClient('http://localhost:12345', 'en').fleet()
    expect(urls[0]).toContain('format=compact-v1')
    expect(urls[1]).toContain('/api/fleet/closed')
    expect(result.payload?.sessions.map(r => r.id)).toEqual(['live', 'ended'])
    expect(result.payload?.sessions[1]?.verbs[0]?.action).toBe('resume')
  } finally { globalThis.fetch = original }
})

test('extension fallback accepts legacy server response', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ sessions: [{ id: 'old', verbs: [] }], rows: [{ id: 'old' }] })) as unknown as typeof fetch
  try { expect((await new AgentopClient('http://localhost:12345', 'en').fleet()).payload?.sessions[0]?.id).toBe('old') }
  finally { globalThis.fetch = original }
})
