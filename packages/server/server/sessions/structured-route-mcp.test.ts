import { describe, expect, test } from 'bun:test'
import { structuredIntentOf } from './structured-route'

describe('structured Nay MCP selection', () => {
  test('own-agent disabled omits the agentistics MCP', () => {
    expect(structuredIntentOf({ harness: 'claude', origin: 'web' }, { model: undefined, effort: undefined })).not.toHaveProperty('mcp')
  })

  test('enabled sessions retain the existing agentistics MCP attachment', () => {
    expect(structuredIntentOf({ harness: 'claude', origin: 'web' }, {
      model: undefined,
      effort: undefined,
      mcp: { command: 'agentop', args: ['mcp'], env: { AGENTISTICS_API: 'http://localhost:47291' } },
    }).mcp).toEqual([{ name: 'agentistics', command: 'agentop', args: ['mcp'], env: { AGENTISTICS_API: 'http://localhost:47291' } }])
  })
})
