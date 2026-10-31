import { describe, it, expect } from 'bun:test'
import { spawn } from 'node:child_process'
import { HARNESS_ORDER } from '@agentistics/core'
import { workChildren, readProcTree, usableMcpCommand, HELPER_PROCESSES, type ProcNode } from './work-children'

const n = (pid: number, ppid: number, exe: string | null, argv: string): ProcNode => ({ pid, ppid, exe, argv })
const kids = (r: ReturnType<typeof workChildren>): number[] => (r.checked ? r.children.map((c) => c.pid) : [-1])

// Every tree below was walked read-only from /proc of an IDLE session (no prompt sent) started under
// tmux inside `agentop run --rm`, 2026-10-16; paths redacted to /u. Raw shape: `exe=… argv=…`.
//
// claude 2.1.301: the pane is the claude process itself.
const CLAUDE_IDLE: ProcNode[] = [
  n(100, 1, 'claude', 'claude --session-id x'),
  n(101, 100, 'volta-shim', 'npx -y mongodb-mcp-server@2.1.0 --readOnly'),
  n(102, 101, 'node', 'node /x/mongodb-mcp-server --readOnly'),
  n(103, 100, 'volta-shim', 'npx -y computer-use-mcp@1.8.0'),
  n(104, 103, 'node', 'node /x/computer-use-mcp'),
  n(105, 100, 'python3.13', '/u/serena-agent/bin/python /u/serena start-mcp-server --context ide-assistant'),
  n(106, 100, 'agentop', '/u/.local/bin/agentop mcp'),
]
const MCP = ['npx -y mongodb-mcp-server', 'npx -y computer-use-mcp', '/u/serena-agent/bin/python /u/serena start-mcp-server']

// codex 0.161.0 (model gpt-6.1-sol): pane volta-shim -> node shim -> native codex -> two app-server daemons.
const CODEX = '/u/.bun/install/global/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'
const DAEMON = '/h/.codex/packages/app-server-daemon/releases/0.161.0-x86_64-unknown-linux-musl/bin/codex'
const CODEX_IDLE: ProcNode[] = [
  n(1099018, 1099014, 'node', 'node /u/.bun/bin/codex --model gpt-6.1-sol'),
  n(1099025, 1099018, 'codex', `${CODEX} --model gpt-6.1-sol`),
  n(1099180, 1099025, 'codex', `${DAEMON} app-server --listen unix:// --analytics-default-enabled --managed-daemon`),
  n(1099346, 1099180, 'agentop', '/u/.local/bin/agentop mcp'),
  n(1099272, 1099025, 'codex', `${DAEMON} app-server daemon pid-update-loop`),
]
// gemini 0.64.0: volta-shim -> node -> node(gemini) -> agentop mcp.
const GEMINI_IDLE: ProcNode[] = [
  n(1102825, 1102821, 'node', 'node /u/.bun/bin/gemini'),
  n(1102833, 1102825, 'node', 'node --max-old-space-size=5982 /u/.bun/bin/gemini'),
  n(1103001, 1102833, 'agentop', '/u/.local/bin/agentop mcp'),
]
// copilot 1.0.95: volta-shim -> node -> native copilot (exe reads "(deleted)" after a self-update) -> agentop mcp.
const COPILOT_IDLE: ProcNode[] = [
  n(1106292, 1106288, 'node', 'node /u/.volta/tools/image/packages/@github/copilot/bin/copilot'),
  n(1106299, 1106292, 'copilot', '/u/.volta/tools/image/packages/@github/copilot/lib/node_modules/@github/copilot/node_modules/@github/copilot-linux-x64/copilot'),
  n(1106493, 1106299, 'agentop', '/u/.local/bin/agentop mcp'),
]
// kimi 2.2.0: the pane is the old binary (kimi.bak after a self-update) -> kimi-code -> agentop mcp.
const KIMI_IDLE: ProcNode[] = [
  n(1113226, 1113084, 'kimi', 'kimi-code'),
  n(1113321, 1113226, 'agentop', '/u/.local/bin/agentop mcp'),
]
const RUNNING = (pane: number): ProcNode[] => [n(9000, pane, 'bash', 'bash -c sleep 600'), n(9001, 9000, 'sleep', 'sleep 600')]

describe('workChildren — measured idle trees are quiet, a running command is not', () => {
  const cases: [string, ProcNode[], number, Parameters<typeof workChildren>[2]][] = [
    ['claude', CLAUDE_IDLE, 100, 'claude'],
    ['codex', CODEX_IDLE, 1099014, 'codex'],
    ['gemini', GEMINI_IDLE, 1102821, 'gemini'],
    ['copilot', COPILOT_IDLE, 1106288, 'copilot'],
    ['kimi', KIMI_IDLE, 1113084, 'kimi'],
  ]
  for (const [name, tree, pane, h] of cases) {
    it(`${name}: idle -> checked, no work child`, () => {
      expect(workChildren(tree, pane, h, { mcpCommands: MCP })).toEqual({ checked: true, children: [] })
    })
    it(`${name}: a command run by the harness (and its subtree) is work`, () => {
      // Under the innermost chain node, as a Bash tool would.
      const parent = name === 'claude' ? 100 : name === 'gemini' ? 1102833 : name === 'kimi' ? 1113226 : name === 'copilot' ? 1106299 : 1099025
      const r = workChildren([...tree, ...RUNNING(parent)], pane, h, { mcpCommands: MCP })
      expect(kids(r)).toEqual([9000, 9001])
    })
  }

  it('agentop mcp is an MCP launch without configuration', () => {
    expect(kids(workChildren([CLAUDE_IDLE[0]!, CLAUDE_IDLE[6]!], 1, 'claude'))).toEqual([])
    expect(kids(workChildren(CLAUDE_IDLE.slice(0, 1).concat(CLAUDE_IDLE[6]!), 100, 'claude'))).toEqual([])
  })
})

describe('workChildren — MCP exclusion (H2)', () => {
  const pane = [n(100, 1, 'claude', 'claude')]
  it('a Bash command that merely mentions an MCP server counts', () => {
    const t = [...pane, n(200, 100, 'bash', `bash -c -l eval 'npx -y mongodb-mcp-server --help'`)]
    expect(kids(workChildren(t, 100, 'claude', { mcpCommands: MCP }))).toEqual([200])
  })
  it('an MCP-looking argv deeper than the harness counts (a shell never spawns an MCP server)', () => {
    const t = [...pane, n(200, 100, 'bash', 'bash -c x'), n(201, 200, 'volta-shim', 'npx -y mongodb-mcp-server --readOnly'), n(202, 200, 'agentop', '/u/agentop mcp')]
    expect(kids(workChildren(t, 100, 'claude', { mcpCommands: MCP }))).toEqual([200, 201, 202])
  })
  it('a configured command with an @version suffix matches; a different package does not', () => {
    const t = [...pane, n(1, 100, 'x', 'npx -y mongodb-mcp-server@2.1.0 --a'), n(2, 100, 'x', 'npx -y mongodb-mcp-server-evil')]
    expect(kids(workChildren(t, 100, 'claude', { mcpCommands: MCP }))).toEqual([2])
  })
  it('a bare interpreter entry is refused and hides nothing', () => {
    const t = [...pane, n(200, 100, 'bash', 'node build.js')]
    expect(kids(workChildren(t, 100, 'claude', { mcpCommands: ['node'] }))).toEqual([200])
    expect(usableMcpCommand('node')).toBe(false)
    expect(usableMcpCommand('python3.13')).toBe(false)
    expect(usableMcpCommand('docker')).toBe(false)
    expect(usableMcpCommand('uvx')).toBe(false)
    expect(usableMcpCommand('npx -y x')).toBe(true)
    expect(usableMcpCommand('serena')).toBe(true)
  })
})

describe('workChildren — unmeasured and unknown are never quiet (M1, M2)', () => {
  it('an unmeasured harness stays checked:false even when helpers are passed', () => {
    const t = [n(1, 0, 'gemini', 'gemini'), n(2, 1, 'bash', 'bash -c x')]
    expect(workChildren(t, 1, 'antigravity')).toEqual({ checked: false, reason: 'unmeasured' })
    expect(workChildren(t, 1, 'antigravity', { helpers: [] })).toEqual({ checked: false, reason: 'unmeasured' })
  })
  it('helpers ADD to the table instead of replacing it', () => {
    const t = [n(1, 100, 'rg', 'rg --version'), n(2, 100, 'daemon', '/x/codex app-server daemon')]
    expect(kids(workChildren(t, 100, 'claude', { helpers: [/^rg /] }))).toEqual([2])
    expect(kids(workChildren(t, 100, 'codex', { helpers: [/^rg /] }))).toEqual([2])
  })
  it('an unreadable /proc (null tree) is checked:false, not quiet', () => {
    expect(workChildren(null, 100, 'claude')).toEqual({ checked: false, reason: 'unreadable' })
  })
  it('a known pane with nothing under it is quiet', () => {
    expect(workChildren([], 999, 'claude')).toEqual({ checked: true, children: [] })
  })
})

describe('workChildren — the harness chain (M3)', () => {
  it('a shim above the holder is not counted, so codex can retire', () => {
    const t = [n(2, 1, 'volta-shim', 'codex'), n(3, 2, 'node', 'node /u/.bun/bin/codex'), n(4, 3, 'codex', '/x/codex')]
    expect(kids(workChildren(t, 1, 'codex'))).toEqual([])
  })
  it('a holder-named exe below a counted bash is still counted', () => {
    const t = [n(2, 1, 'codex', '/x/codex'), n(3, 2, 'bash', 'bash -c make'), n(4, 3, 'codex', 'codex exec x')]
    expect(kids(workChildren(t, 1, 'codex'))).toEqual([3, 4])
  })
  it('an exec-replaced `node build.js` directly under a gemini chain is work (only gemini itself is chain)', () => {
    const t = [...GEMINI_IDLE, n(500, 1102833, 'node', 'node build.js')]
    expect(kids(workChildren(t, 1102821, 'gemini'))).toEqual([500])
  })
  it('codex: a command under the app-server daemon is work (N1; shape from the idle tree, live command not yet measured)', () => {
    const t = [...CODEX_IDLE, n(7000, 1099180, 'bash', 'bash -lc sleep 600'), n(7001, 7000, 'sleep', 'sleep 600')]
    expect(kids(workChildren(t, 1099014, 'codex', { mcpCommands: MCP }))).toEqual([7000, 7001])
  })
  it('codex -> bun test -> codex exec counts `bun test` (N2: chain rules stop at the first holder)', () => {
    const t = [n(2, 1, 'codex', '/x/codex'), n(3, 2, 'bun', 'bun test'), n(4, 3, 'codex', '/x/codex exec x')]
    expect(kids(workChildren(t, 1, 'codex'))).toEqual([3, 4])
    const t2 = [n(2, 1, 'codex', '/x/codex'), n(3, 2, 'node', 'node /u/.bun/bin/codex exec x')]
    expect(kids(workChildren(t2, 1, 'codex'))).toEqual([3])
  })
  it('gemini installed as node …/@google/gemini-cli/dist/index.js is chain (N3)', () => {
    const t = [n(2, 1, 'node', 'node /u/lib/node_modules/@google/gemini-cli/dist/index.js'), n(3, 2, 'agentop', '/u/agentop mcp')]
    expect(kids(workChildren(t, 1, 'gemini'))).toEqual([])
  })
  it('L1: a pane that IS the holder seeds underHolder — claude(pane) -> bun test -> claude -p counts `bun test`', () => {
    const t = [n(100, 1, 'claude', 'claude'), n(200, 100, 'bun', 'bun test'), n(201, 200, 'claude', 'claude -p x')]
    expect(kids(workChildren(t, 100, 'claude'))).toEqual([200, 201])
    // The live tree (`readProcTree`) holds descendants only: the pane's exe comes from the caller.
    const live = t.slice(1)
    expect(kids(workChildren(live, 100, 'claude', { paneExe: 'claude' }))).toEqual([200, 201])
    // kimi's pane is a holder too.
    const k = [n(201, 100, 'bun', 'bun test'), n(202, 201, 'kimi', 'kimi -p x')]
    expect(kids(workChildren(k, 100, 'kimi', { paneExe: 'kimi' }))).toEqual([201, 202])
    // A pane that is a shim (codex) is unchanged: the shim chain down to the first holder is not work.
    const c = [n(3, 1, 'node', 'node /u/.bun/bin/codex'), n(4, 3, 'codex', '/x/codex')]
    expect(kids(workChildren(c, 1, 'codex', { paneExe: 'volta-shim' }))).toEqual([])
  })
  it('L2: only an @google/gemini-cli/ install path is chain — a clone being built is work', () => {
    const t = [...GEMINI_IDLE, n(500, 1102833, 'node', 'node /u/src/gemini-cli/scripts/build.js')]
    expect(kids(workChildren(t, 1102821, 'gemini'))).toEqual([500])
    const own = [n(2, 1, 'node', 'node /u/lib/node_modules/@google/gemini-cli/dist/index.js')]
    expect(kids(workChildren(own, 1, 'gemini'))).toEqual([])
  })
  it('caller-supplied holders override the table', () => {
    const t = [n(2, 1, 'myshim', 'x'), n(3, 2, 'claude', 'claude'), n(4, 3, 'bash', 'bash -c make')]
    expect(kids(workChildren(t, 1, 'claude', { holders: ['claude'] }))).toEqual([4])
  })
})

describe('HELPER_PROCESSES', () => {
  it('decides every harness (the build forces it) — measured ones are arrays, the rest null', () => {
    for (const h of HARNESS_ORDER) expect(h in HELPER_PROCESSES).toBe(true)
    for (const h of ['claude', 'codex', 'gemini', 'copilot', 'kimi', 'opencode'] as const) expect(Array.isArray(HELPER_PROCESSES[h])).toBe(true)
    expect(HELPER_PROCESSES.antigravity).toBeNull()
  })
})

describe('readProcTree (real /proc)', () => {
  it('sees a child of this process, and nothing of a gone pid', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' })
    try {
      await new Promise((r) => setTimeout(r, 100))
      const t = await readProcTree(process.pid)
      expect(t).not.toBeNull()
      const sleep = t!.find((p) => p.pid === child.pid)
      expect(sleep?.argv).toBe('sleep 30')
      expect(sleep?.ppid).toBe(process.pid)
    } finally {
      child.kill()
    }
    expect(await readProcTree(2 ** 22 - 3)).toEqual([])
  })
  it('a zombie grandchild is not a work child', async () => {
    // sh forks `true`, then execs sleep, which never waits: `true` stays a zombie child of sleep.
    const child = spawn('sh', ['-c', 'true & exec sleep 30'], { stdio: 'ignore' })
    try {
      let zombie = 0
      for (let i = 0; i < 40 && !zombie; i++) {
        await new Promise((r) => setTimeout(r, 50))
        try {
          const ids = (await Bun.file(`/proc/${child.pid}/task/${child.pid}/children`).text()).trim().split(/\s+/).filter(Boolean)
          zombie = Number(ids[0] ?? 0)
        } catch { /* not ready */ }
      }
      expect(zombie).toBeGreaterThan(0) // the zombie really exists, so the assertion below can fail
      const t = await readProcTree(process.pid)
      expect(t!.some((p) => p.pid === child.pid)).toBe(true)
      expect(t!.some((p) => p.pid === zombie)).toBe(false)
    } finally {
      child.kill()
    }
  })
})
