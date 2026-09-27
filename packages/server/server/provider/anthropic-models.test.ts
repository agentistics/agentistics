import { describe, test, expect } from 'bun:test'
import { listAnthropicModels } from './anthropic-models.ts'
import { createCredentialHandle } from './credential-plan.ts'

describe('listAnthropicModels', () => {
  // UI.4 N-1: Bun forwards `x-api-key` across a cross-origin redirect (it strips only
  // `Authorization`), so a redirect from the model list must never be followed with the key on it.
  test('refuses to follow a redirect with the key attached', async () => {
    let seen: RequestInit | undefined
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      seen = init
      return new Response(JSON.stringify({ data: [{ id: 'claude-x' }] }), { status: 200 })
    }) as unknown as typeof fetch
    const r = await listAnthropicModels({
      credential: createCredentialHandle('anthropic', 'sk-ant-api03-' + 'x'.repeat(90)),
      fetch: fakeFetch,
    })
    expect(r.ok).toBe(true)
    expect(seen?.redirect).toBe('error')
  })
})
