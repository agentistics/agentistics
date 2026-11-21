import { describe, expect, it } from 'bun:test'
import { checkEngine, mcpToolRefusals, type EngineMcpTool } from './index'

const ok: EngineMcpTool = {
  name: 'agentistics_x_example', description: 'An example.', inputSchema: { type: 'object', properties: {} },
  risk: 'R', method: 'GET', path: '/api/engine/x/example',
}

describe('mcpToolRefusals', () => {
  it('accepts a valid tool and an absent list', () => {
    expect(mcpToolRefusals([ok])).toEqual([])
    expect(mcpToolRefusals(undefined)).toEqual([])
  })
  it('refuses a bad name', () => {
    for (const name of ['agentistics_example', 'agentistics_x_A', 'agentistics_x_a', 'agentistics_x_' + 'a'.repeat(41), '']) {
      expect(mcpToolRefusals([{ ...ok, name }]).map(r => r.reason)).toEqual(['bad-name'])
    }
  })
  it('refuses a path outside the engine prefix or with tricks', () => {
    for (const path of ['/api/tasks', '/api/engine/x/', '/api/engine/x/../tasks', '/api/engine/x/a%2e', '/api/engine/x/a?b=1', 'http://evil/api/engine/x/a']) {
      expect(mcpToolRefusals([{ ...ok, path }]).map(r => r.reason)).toEqual(['bad-path'])
    }
  })
  it('refuses duplicates, bad risk, method, schema, description', () => {
    expect(mcpToolRefusals([ok, ok]).map(r => r.reason)).toEqual(['duplicate-name'])
    expect(mcpToolRefusals([{ ...ok, risk: 'D' as never }]).map(r => r.reason)).toEqual(['bad-risk'])
    expect(mcpToolRefusals([{ ...ok, method: 'DELETE' as never }]).map(r => r.reason)).toEqual(['bad-method'])
    expect(mcpToolRefusals([{ ...ok, inputSchema: [] as never }]).map(r => r.reason)).toEqual(['bad-schema'])
    expect(mcpToolRefusals([{ ...ok, description: ' ' }]).map(r => r.reason)).toEqual(['bad-description'])
  })
})

describe('checkEngine and mcp tools', () => {
  const base = (tools: EngineMcpTool[], routes: { prefix: string; capability: 'localShell' }[]) => ({
    manifest: { apiVersion: '1.30.0', mcpTools: tools } as never,
    routes: routes as never,
    commands: [],
  })
  const cap = () => 'localShell' as const
  it('refuses tools with no /api/engine/x route', () => {
    const r = checkEngine(base([ok], []), '1.30.0', cap)
    expect(r).toContainEqual({ kind: 'mcp-tool-no-route' })
  })
  it('reports each refused tool and passes a valid one', () => {
    const route = [{ prefix: '/api/engine/x', capability: 'localShell' as const }]
    expect(checkEngine(base([ok], route), '1.30.0', cap)).toEqual([])
    expect(checkEngine(base([{ ...ok, name: 'bad' }], route), '1.30.0', cap)).toContainEqual({ kind: 'mcp-tool', name: 'bad', reason: 'bad-name' })
  })
})
