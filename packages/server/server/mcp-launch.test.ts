import { describe, expect, test } from 'bun:test'
import { isAgentisticsMcp, mcpLaunch, sameMcpLaunch, staleAgentisticsMcps } from './mcp-launch'

describe('mcpLaunch — what an assistant runs to start the agentistics MCP', () => {
  test('an installed binary launches ITSELF, never a script that only exists in a clone', () => {
    // The reported failure: the registration named `/$bunfs/root/.../agentistics-mcp.ts`, which is
    // inside the binary's virtual filesystem, so the MCP never started on anyone else's machine.
    expect(mcpLaunch({
      scriptPath: '/$bunfs/root/packages/mcp/agentistics-mcp.ts',
      scriptExists: false,
      execPath: '/home/u/.local/bin/agentop',
    })).toEqual({ command: '/home/u/.local/bin/agentop', args: ['mcp'] })
  })

  test('a checkout keeps running the source it is editing', () => {
    expect(mcpLaunch({ scriptPath: '/repo/packages/mcp/agentistics-mcp.ts', scriptExists: true, execPath: '/usr/bin/bun' }))
      .toEqual({ command: 'bun', args: ['run', '/repo/packages/mcp/agentistics-mcp.ts'] })
  })
})

describe('sameMcpLaunch — is the registration already right?', () => {
  const want = { command: '/home/u/.local/bin/agentop', args: ['mcp'] }
  test('the old script registration is NOT the same, so it gets replaced', () => {
    expect(sameMcpLaunch({ command: 'bun', args: ['run', '/$bunfs/root/packages/mcp/agentistics-mcp.ts'] }, want)).toBe(false)
  })
  test('an exact match is left alone', () => {
    expect(sameMcpLaunch({ command: '/home/u/.local/bin/agentop', args: ['mcp'] }, want)).toBe(true)
  })
  test('absent or malformed entries are not a match', () => {
    expect(sameMcpLaunch(undefined, want)).toBe(false)
    expect(sameMcpLaunch({ command: want.command, args: 'mcp' }, want)).toBe(false)
    expect(sameMcpLaunch({ command: want.command, args: ['mcp', 'x'] }, want)).toBe(false)
  })
})

describe('staleAgentisticsMcps — every copy that is not the canonical one', () => {
  const canonical = { command: '/home/u/.local/bin/agentop', args: ['mcp'], env: { AGENTISTICS_API: 'http://localhost:47291' } }

  test('an npm-installed older copy under another name is stale', () => {
    // The reported case: an assistant registered the npm package by hand, a version without the
    // task-board tools, and it kept answering across every restart.
    const json = { mcpServers: {
      agentistics: canonical,
      'agentistics-mcp': { command: 'npx', args: ['-y', '@agentistics/mcp'] },
    } }
    expect(staleAgentisticsMcps(json)).toEqual([{ scope: 'user', name: 'agentistics-mcp' }])
  })

  test('a LOCAL-scope copy is stale even under the canonical name — local outranks user', () => {
    const json = { mcpServers: { agentistics: canonical }, projects: {
      '/home/u/repo': { mcpServers: { agentistics: { command: 'bun', args: ['run', '/old/packages/mcp/agentistics-mcp.ts'] } } },
    } }
    expect(staleAgentisticsMcps(json)).toEqual([{ scope: 'local', name: 'agentistics', project: '/home/u/repo' }])
  })

  test('somebody else\'s servers are never listed', () => {
    const json = { mcpServers: {
      agentistics: canonical,
      MongoDB: { command: 'npx', args: ['-y', 'mongodb-mcp-server@2.1.0', '--readOnly'] },
      playwright: { command: 'npx', args: ['@playwright/mcp@0.0.79'] },
    }, projects: { '/p': { mcpServers: { web: { type: 'http' } } } } }
    expect(staleAgentisticsMcps(json)).toEqual([])
    expect(staleAgentisticsMcps(null)).toEqual([])
    expect(staleAgentisticsMcps({ mcpServers: 'junk' })).toEqual([])
  })

  test('recognises every way the agentistics MCP has been launched', () => {
    expect(isAgentisticsMcp({ command: 'bun', args: ['run', '/r/packages/mcp/agentistics-mcp.ts'] })).toBe(true)
    expect(isAgentisticsMcp({ command: 'npx', args: ['-y', '@agentistics/mcp@2.1.0'] })).toBe(true)
    expect(isAgentisticsMcp({ command: '/usr/local/bin/agentop', args: ['mcp'] })).toBe(true)
    expect(isAgentisticsMcp({ command: 'node', args: ['x.js'], env: { AGENTISTICS_API: 'http://localhost:1' } })).toBe(true)
    expect(isAgentisticsMcp({ command: '/usr/local/bin/agentop', args: ['server'] })).toBe(false)
  })
})
