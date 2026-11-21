import { describe, expect, it } from 'bun:test'
import type { EngineMcpTool } from '@agentistics/engine-api'
import { engineMcpToolsFor } from './engine-mcp-tools'

const t = (o: Partial<EngineMcpTool> = {}): EngineMcpTool => ({
  name: 'agentistics_x_example', description: 'Example', inputSchema: { type: 'object' }, risk: 'R', method: 'GET', path: '/api/engine/x/example', ...o,
})

describe('engineMcpToolsFor', () => {
  it('is empty with no engine', () => { expect(engineMcpToolsFor(undefined)).toEqual([]) })
  it('lists a valid fake engine tool', () => { expect(engineMcpToolsFor([t()]).map(x => x.name)).toEqual(['agentistics_x_example']) })
  it('lists nothing when any tool is invalid', () => {
    expect(engineMcpToolsFor([t(), t({ name: 'agentistics_x_two', path: '/api/tasks' })])).toEqual([])
  })
})
