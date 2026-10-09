import { describe, expect, it } from 'bun:test'
import { agyMcpAddArgv, agyMcpRemoveArgv, ensureAgyMcp, planAgyMcp } from './agy-mcp'

const launch = { command: '/usr/local/bin/agentop', args: ['mcp'] }
const API = 'http://localhost:47291'
const cfg = (entry: unknown) => JSON.stringify({ mcpServers: { agentistics: entry, other: { command: 'x' } } })

describe('planAgyMcp — agy\'s global mcp_config.json (P-20)', () => {
  it('adds when the file is missing, empty or has no entry; leaves an up-to-date one alone', () => {
    expect(planAgyMcp(null, launch, API)).toEqual({ action: 'add' })
    expect(planAgyMcp('', launch, API)).toEqual({ action: 'add' })
    expect(planAgyMcp(JSON.stringify({ mcpServers: { other: {} } }), launch, API)).toEqual({ action: 'add' })
    expect(planAgyMcp(cfg({ command: launch.command, args: launch.args, env: { AGENTISTICS_API: API } }), launch, API)).toEqual({ action: 'none' })
  })

  it('replaces a stale launch or another port; refuses a file it cannot read rather than repairing it', () => {
    expect(planAgyMcp(cfg({ command: 'bun', args: ['run', '/old.ts'], env: { AGENTISTICS_API: API } }), launch, API)).toEqual({ action: 'replace' })
    expect(planAgyMcp(cfg({ command: launch.command, args: launch.args, env: { AGENTISTICS_API: 'http://localhost:9' } }), launch, API)).toEqual({ action: 'replace' })
    expect(planAgyMcp('{ broken', launch, API).action).toBe('refuse')
    expect(planAgyMcp('[1]', launch, API).action).toBe('refuse')
  })

  it('writes through agy\'s own CLI: flags before the name, `--` before the command', () => {
    expect(agyMcpAddArgv(launch, API)).toEqual(['agy', 'mcp', 'add', '--env', `AGENTISTICS_API=${API}`, 'agentistics', '--', '/usr/local/bin/agentop', 'mcp'])
    expect(agyMcpRemoveArgv()).toEqual(['agy', 'mcp', 'remove', 'agentistics'])
  })
})

describe('ensureAgyMcp', () => {
  const base = (text: string | null) => {
    const ran: string[][] = []
    return { ran, deps: { read: async () => text, run: async (a: string[]) => { ran.push(a); return 0 }, may: () => true, installed: () => true, launch: () => launch } }
  }

  it('adds once, removes then adds when stale, does nothing when current', async () => {
    const a = base(null)
    expect((await ensureAgyMcp(47291, a.deps)).action).toBe('add')
    expect(a.ran.map(r => r[2])).toEqual(['add'])
    const b = base(cfg({ command: 'old', args: [] }))
    expect((await ensureAgyMcp(47291, b.deps)).action).toBe('replace')
    expect(b.ran.map(r => r[2])).toEqual(['remove', 'add'])
    const c = base(cfg({ command: launch.command, args: launch.args, env: { AGENTISTICS_API: API } }))
    expect((await ensureAgyMcp(47291, c.deps)).action).toBe('none')
    expect(c.ran).toEqual([])
  })

  it('touches nothing when agy is absent or this is not the default server', async () => {
    const a = base(null)
    expect(await ensureAgyMcp(47291, { ...a.deps, installed: () => false })).toEqual({ action: 'skipped', reason: 'agy is not installed' })
    expect(await ensureAgyMcp(48901, { ...a.deps, may: () => false })).toEqual({ action: 'skipped', reason: 'not the default server' })
    expect(a.ran).toEqual([])
  })
})
