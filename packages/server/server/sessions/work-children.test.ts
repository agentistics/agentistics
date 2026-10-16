import { describe, it, expect } from 'bun:test'
import { HARNESS_ORDER } from '@agentistics/core'
import { workChildren, HELPER_PROCESSES, type ProcNode } from './work-children'

const n = (pid: number, ppid: number, exe: string, argv: string): ProcNode => ({ pid, ppid, exe, argv })

// Cut from a live idle claude 2.1.301 under tmux, 2026-10-16 (read-only /proc walk): the pane is
// the claude process; every child is an MCP launch or the Bash tool's shell.
const CLAUDE_IDLE: ProcNode[] = [
  n(100, 1, 'claude', 'claude --session-id x'),
  n(101, 100, 'volta-shim', 'npx -y mongodb-mcp-server@2.1.0 --readOnly'),
  n(102, 101, 'node', 'node /x/mongodb-mcp-server --readOnly'),
  n(103, 100, 'volta-shim', 'npx -y computer-use-mcp@1.8.0'),
  n(104, 103, 'node', 'node /x/computer-use-mcp'),
  n(105, 100, 'python3.13', '/u/serena-agent/bin/python /u/serena start-mcp-server --context ide-assistant'),
  n(106, 100, 'agentop', '/home/u/.local/bin/agentop mcp'),
]
const MCP = ['npx -y mongodb-mcp-server', 'npx -y computer-use-mcp', 'serena start-mcp-server']

describe('workChildren', () => {
  it('an idle claude with only MCP servers has no work child (whole MCP subtrees excluded)', () => {
    const r = workChildren(CLAUDE_IDLE, 100, 'claude', { mcpCommands: MCP })
    expect(r).toEqual({ checked: true, children: [] })
  })

  it('agentop mcp is always an MCP launch, without configuration', () => {
    expect(workChildren(CLAUDE_IDLE.slice(0, 1).concat(CLAUDE_IDLE[6]!), 100, 'claude').children).toEqual([])
  })

  it('a running shell (and everything under it) is a work child', () => {
    const t = [...CLAUDE_IDLE, n(200, 100, 'bash', 'bash -c sleep 600'), n(201, 200, 'sleep', 'sleep 600')]
    const r = workChildren(t, 100, 'claude', { mcpCommands: MCP })
    expect(r.children.map((c) => c.pid)).toEqual([200, 201])
  })

  it('the harness own chain is descended through, not counted (codex: shim -> node -> codex)', () => {
    const t = [
      n(1, 0, 'node', 'node /bin/codex'),
      n(2, 1, 'codex', 'codex'),
      n(3, 2, 'bash', 'bash -c make'),
    ]
    const r = workChildren(t, 1, 'codex', { holders: ['node', 'codex'] })
    // codex is unmeasured, so its children are not checked at all
    expect(r).toEqual({ checked: false, children: [] })
  })

  it('holders are skipped but their children still count when the harness is measured', () => {
    const saved = HELPER_PROCESSES.claude
    try {
      const t = [n(1, 0, 'node', 'node x'), n(2, 1, 'claude', 'claude'), n(3, 2, 'bash', 'bash -c make')]
      const r = workChildren(t, 1, 'claude', { holders: ['node', 'claude'] })
      expect(r.children.map((c) => c.pid)).toEqual([3])
    } finally {
      expect(HELPER_PROCESSES.claude).toBe(saved)
    }
  })

  it('a helper matching the harness table is not a work child', () => {
    const table = HELPER_PROCESSES.claude
    expect(table).not.toBeNull()
    const t = [n(1, 0, 'claude', 'claude'), n(2, 1, 'rg', 'rg --version')]
    const r = workChildren(t, 1, 'claude', { helpers: [/^rg /] })
    expect(r.children).toEqual([])
  })

  it('an unmeasured harness reports checked:false and never invents a child', () => {
    const t = [n(1, 0, 'gemini', 'gemini'), n(2, 1, 'bash', 'bash -c x')]
    expect(workChildren(t, 1, 'gemini')).toEqual({ checked: false, children: [] })
  })

  it('an unknown pane pid yields no children, checked as stated by the table', () => {
    expect(workChildren(CLAUDE_IDLE, 999, 'claude').children).toEqual([])
  })
})

describe('HELPER_PROCESSES', () => {
  it('decides every harness (the build forces it) — claude measured, the rest null until observed', () => {
    for (const h of HARNESS_ORDER) expect(h in HELPER_PROCESSES).toBe(true)
    expect(HELPER_PROCESSES.claude).toEqual([])
    for (const h of HARNESS_ORDER) if (h !== 'claude') expect(HELPER_PROCESSES[h]).toBeNull()
  })
})
