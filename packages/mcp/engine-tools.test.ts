import { describe, expect, it } from 'bun:test'
import { AGENT_TOOL_POLICY, engineToolPolicy } from '@agentistics/core'
import type { EngineMcpTool } from '@agentistics/engine-api'
import { createEngineTools } from './engine-tools'
import { riskOf } from './agent-audit'

const tool = (o: Partial<EngineMcpTool> = {}): EngineMcpTool => ({
  name: 'agentistics_x_example', description: 'Example', inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  risk: 'R', method: 'GET', path: '/api/engine/x/example', ...o,
})

function fake(tools: EngineMcpTool[] | 'down') {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url.endsWith('/api/engine/mcp-tools')) {
      if (tools === 'down') throw new Error('refused')
      return Response.json({ tools })
    }
    if (url.includes('/boom')) return new Response('nope: bad input', { status: 422 })
    return Response.json({ ok: true, echoed: url })
  }
  return { calls, et: createEngineTools({ api: 'http://x', fetch }) }
}

describe('engine tools in the MCP', () => {
  it('lists the declared tools, and nothing when the fetch fails', async () => {
    expect((await fake([tool()]).et.mcpTools()).map(t => t.name)).toEqual(['agentistics_x_example'])
    expect(await fake('down').et.mcpTools()).toEqual([])
  })
  it('lists nothing when the engine declares an invalid tool', async () => {
    expect(await fake([tool({ path: '/api/tasks' })]).et.mcpTools()).toEqual([])
  })
  it('a GET call reaches the declared route with the args as the query', async () => {
    const { et, calls } = fake([tool()])
    const r = await et.call('agentistics_x_example', { q: 'a b' }, undefined)
    expect(calls.at(-1)!.url).toBe('http://x/api/engine/x/example?q=a+b')
    expect(JSON.parse(r!.content[0]!.text).ok).toBe(true)
  })
  it('a POST call sends the args as JSON with the session proof', async () => {
    const { et, calls } = fake([tool({ name: 'agentistics_x_act', risk: 'W', method: 'POST', path: '/api/engine/x/act' })])
    await et.call('agentistics_x_act', { n: 1 }, { id: 's1', token: 't' })
    const last = calls.at(-1)!
    expect(last.url).toBe('http://x/api/engine/x/act')
    expect(JSON.parse(String(last.init!.body))).toEqual({ n: 1, session: { id: 's1', token: 't' } })
  })
  it('a session the model passes in the args never replaces the environment proof', async () => {
    const { et, calls } = fake([tool({ name: 'agentistics_x_act', risk: 'W', method: 'POST', path: '/api/engine/x/act' })])
    await et.call('agentistics_x_act', { n: 1, session: { id: 'other', token: 'forged' } }, { id: 's1', token: 't' })
    expect(JSON.parse(String(calls.at(-1)!.init!.body))).toEqual({ n: 1, session: { id: 's1', token: 't' } })
    await et.call('agentistics_x_act', { n: 2, session: { id: 'other', token: 'forged' } }, undefined)
    expect(JSON.parse(String(calls.at(-1)!.init!.body))).toEqual({ n: 2 })
  })
  it('an engine that never answers the list gives no extra tools instead of hanging', async () => {
    const hang = (_u: string, init?: RequestInit) => new Promise<Response>((_, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))
    })
    const et = createEngineTools({ api: 'http://x', fetch: hang, listTimeoutMs: 20 })
    expect(await et.mcpTools()).toEqual([])
  })
  it('a call to an engine that never answers fails instead of hanging', async () => {
    const hang = (url: string, init?: RequestInit) => url.endsWith('/api/engine/mcp-tools')
      ? Promise.resolve(Response.json({ tools: [tool()] }))
      : new Promise<Response>((_, rej) => { init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))) })
    const et = createEngineTools({ api: 'http://x', fetch: hang, callTimeoutMs: 20 })
    await expect(et.call('agentistics_x_example', {}, undefined)).rejects.toThrow('aborted')
  })
  it('an HTTP error becomes an error carrying the server sentence', async () => {
    const { et } = fake([tool({ name: 'agentistics_x_boom', method: 'POST', path: '/api/engine/x/boom' })])
    await expect(et.call('agentistics_x_boom', {}, undefined)).rejects.toThrow('HTTP 422 nope: bad input')
  })
  it('ignores static names and refuses an undeclared engine name', async () => {
    const { et } = fake([tool()])
    expect(await et.call('agentistics_tasks', {}, undefined)).toBeUndefined()
    await expect(et.call('agentistics_x_other', {}, undefined)).rejects.toThrow('Unknown tool')
  })
  it('policy and audit follow the declared risk', async () => {
    expect(engineToolPolicy(tool()).risk).toBe('R')
    expect(engineToolPolicy(tool({ risk: 'W', method: 'POST' })).risk).toBe('W')
    const { et } = fake([tool(), tool({ name: 'agentistics_x_act', risk: 'W', method: 'POST', path: '/api/engine/x/act' })])
    await et.list()
    expect(riskOf('agentistics_x_example')).toBe('R')
    expect(riskOf('agentistics_x_act')).toBe('W')
    expect(Object.keys(AGENT_TOOL_POLICY).some(n => n.startsWith('agentistics_x_'))).toBe(false)
  })
})
