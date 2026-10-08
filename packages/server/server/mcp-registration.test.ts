import { expect, test } from 'bun:test'
import { mcpRegistrationDecision } from './mcp-registration'

const base = {
  port: 47291,
  webPort: 47292,
  home: '/home/operator',
  dataDir: '/home/operator/.agentistics',
  defaultHome: '/home/operator',
  defaultDataDir: '/home/operator/.agentistics',
}

test('allows only the canonical default server to register harness MCP', () => {
  expect(mcpRegistrationDecision(base)).toEqual({ allowed: true })
  expect(mcpRegistrationDecision({ ...base, port: 48801 }).allowed).toBe(false)
  expect(mcpRegistrationDecision({ ...base, webPort: 48802 }).allowed).toBe(false)
  expect(mcpRegistrationDecision({ ...base, explicitHome: true }).allowed).toBe(false)
  expect(mcpRegistrationDecision({ ...base, home: '/tmp/preview', defaultHome: '/home/operator' }).allowed).toBe(false)
  expect(mcpRegistrationDecision({ ...base, explicitDataDir: true }).allowed).toBe(false)
  expect(mcpRegistrationDecision({ ...base, dataDir: '/tmp/preview/.agentistics' }).allowed).toBe(false)
})
