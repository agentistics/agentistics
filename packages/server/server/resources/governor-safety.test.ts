/**
 * governor-safety.test.ts — the RES.1 governor stops a process ONLY when its owner is gone.
 *
 * Asked for by the release-0410 review: the TUI session reported its isolated preview server and its
 * verification tmux "killed 5 times" overnight. Every shape below is copied from what was actually
 * running on the machine that night (`ps`, `/proc`, that session's own transcript), so this pins the
 * governor against the processes it would really have seen — not against invented ones.
 *
 * Three guarantees, each its own block:
 *  1. NOT EVEN SEEN — a tmux server (isolated or not), a renamed agentop build without a process
 *     card (`tuicheck`), a shell wrapper and a helper script are not classified as agentop's at all,
 *     even when their command line contains the words `agentop server`. Unclassified means it cannot
 *     be killed or alerted on.
 *  2. A LIVE SESSION'S PREVIEW IS NEVER STOPPED — under a throwaway HOME, orphaned (`cmd &`), many
 *     hours old, whatever harness started it: its recorded owner is alive, or no owner is recorded.
 *  3. A STOP NEEDS PROOF THE OWNER IS GONE — the recorded assistant is dead, or its pid now belongs
 *     to a different process (another start time). An orphaned `agentop mcp` is the one stop that
 *     needs no session record: a stdio server reparented to init has no client by construction.
 */
import { describe, expect, test } from 'bun:test'
import { buildInventory, classifyProcess, type ProcEntry } from './inventory'
import { planGovernor } from './governor'
import { harnessOfProcess, ownerFromChain, type ChainLink } from './proc-card'

const MB = 1024 * 1024
const REAL_HOME = '/home/mithrandir'
const RIG = '/tmp/claude-1000/-home-mithrandir-agentistics-engine/a0625d02/scratchpad/tui'

const p = (o: Partial<ProcEntry> & { pid: number; argv: string[] }): ProcEntry => ({
  ppid: 1, exe: null, rssBytes: 200 * MB, swapBytes: 0, cpuPercent: 0, ageSec: 10 * 3600, env: {}, ...o,
})

/** A machine where `liveStarts` are the pids alive right now, with their kernel start times. */
function machine(liveStarts: Record<number, number>) {
  return {
    alive: (pid: number) => pid in liveStarts,
    startOf: (pid: number) => (pid in liveStarts ? liveStarts[pid]! : null),
  }
}

function plan(entries: ProcEntry[], liveStarts: Record<number, number>, governorHome = REAL_HOME) {
  const m = machine(liveStarts)
  const inventory = buildInventory(entries, { selfPid: 999_999, home: governorHome, helpers: new Map(), ...m })
  return { inventory, ...planGovernor({ inventory, helpers: [], nowMs: Date.now() }) }
}

// ── 1. not even seen ──────────────────────────────────────────────────────────────────────────────

describe('1. the rig is not agentop as far as the governor can tell', () => {
  const none = new Map<number, string>()
  const rig: ProcEntry[] = [
    // the verification tmux, both forms the session used that night
    p({ pid: 101, argv: ['tmux', '-L', 'tuie2e', 'new-session', '-d', '-s', 'w80', `bash ${RIG}/run.sh w80 80 30 ${RIG}/bin/tuicheck code`], exe: '/usr/bin/tmux', env: { HOME: REAL_HOME } }),
    p({ pid: 102, argv: ['tmux', '-S', '/tmp/claude-1000/tx8e/drive', 'new-session', '-d', '-s', 'srv', `cd ${RIG}/ws && env -u TMUX HOME=${RIG}/home PORT=48491 ${RIG}/bin/tuicheck server > ${RIG}/srv.log 2>&1; sleep 600`], exe: '/usr/bin/tmux', env: { HOME: REAL_HOME } }),
    // a tmux server whose stored command line literally contains "agentop server"
    p({ pid: 103, argv: ['tmux', '-L', 'probe', 'new-session', '-d', 'env HOME=/tmp/p ./release/agentop server'], exe: '/usr/bin/tmux', env: { HOME: REAL_HOME } }),
    p({ pid: 104, argv: ['tmux', '-L', 'probe', 'new-session', '-d', './release/agentop'], exe: '/usr/bin/tmux', env: { HOME: REAL_HOME } }),
    // the renamed agentop build (no process card: built from a tree without RES.1)
    p({ pid: 105, argv: [`${RIG}/bin/tuicheck`, 'server'], exe: `${RIG}/bin/tuicheck`, env: { HOME: `${RIG}/home` } }),
    p({ pid: 106, argv: [`${RIG}/bin/tuicheck`, 'code'], exe: `${RIG}/bin/tuicheck`, env: { HOME: `${RIG}/home` } }),
    // shell wrappers and helper scripts
    p({ pid: 107, argv: ['bash', '-c', `cd ${RIG} && env HOME=${RIG}/home ${RIG}/bin/tuicheck server; sleep 600`], exe: '/usr/bin/bash' }),
    p({ pid: 108, argv: ['bash', '-c', 'PORT=48491 ./release/agentop server'], exe: '/usr/bin/bash' }),
    p({ pid: 109, argv: ['bun', 'fake-ollama.ts'], exe: '/home/u/.volta/tools/image/packages/bun/bin/bun.exe' }),
    p({ pid: 110, argv: ['sleep', '600'], exe: '/usr/bin/sleep' }),
  ]

  test('none of them is classified', () => {
    for (const e of rig) expect(classifyProcess(e, none)).toBeNull()
  })

  test('so none of them is killed or alerted on — not by a real-HOME governor, not by a preview one', () => {
    for (const home of [REAL_HOME, '/tmp/claude-1000/release-preview/home']) {
      const r = plan(rig, {}, home)   // every owner dead, the worst case
      expect(r.inventory).toEqual([])
      expect(r.kills).toEqual([])
      expect(r.alerts).toEqual([])
    }
  })
})

// ── 2. a live session's preview is never stopped ─────────────────────────────────────────────────

describe("2. a live session's preview or test server is never stopped", () => {
  const preview = (o: Partial<ProcEntry>): ProcEntry => p({
    pid: 200, argv: ['/tmp/rel/agentop', 'server'], exe: '/tmp/rel/agentop', env: { HOME: '/tmp/rel/home' }, ...o,
  })

  test('owned by a live Claude session (card owner, same start time), orphaned and 10 h old', () => {
    const r = plan([preview({ cardOwner: { pid: 4242, starttime: 777, harness: 'claude' } })], { 4242: 777 })
    expect(r.kills).toEqual([])
  })

  test('owned by a live CODEX / GEMINI / AGY session — no CLAUDE_PID anywhere', () => {
    for (const harness of ['codex', 'gemini', 'antigravity', 'kimi', 'copilot']) {
      const r = plan([preview({ cardOwner: { pid: 5150, starttime: 31, harness } })], { 5150: 31 })
      expect(r.kills).toEqual([])
    }
  })

  test('owned through CLAUDE_PID only (a tmux pane inherits it), owner alive', () => {
    const r = plan([preview({ env: { HOME: '/tmp/rel/home', CLAUDE_PID: '4242' } })], { 4242: 1 })
    expect(r.kills).toEqual([])
  })

  test('NO owner on record at all (a pane under a tmux server, a user shell): never stopped, however old', () => {
    const r = plan([preview({ ageSec: 72 * 3600 })], {})
    expect(r.kills).toEqual([])
  })

  test('the cockpit and the CLI of such a preview are left alone the same way', () => {
    const r = plan([
      preview({ pid: 201, argv: ['/tmp/rel/agentop'], cardOwner: { pid: 4242, starttime: 777, harness: 'claude' } }),
      preview({ pid: 202, argv: ['/tmp/rel/agentop', 'session', 'ls'] }),
    ], { 4242: 777 })
    expect(r.kills).toEqual([])
  })

  test('the real HOME is never a leftover, even orphaned, ownerless and old, seen from a preview governor', () => {
    const r = plan([p({ pid: 300, argv: ['/home/u/.local/bin/agentop', 'server'], env: { HOME: REAL_HOME } })], {}, '/tmp/rel/home')
    expect(r.kills).toEqual([])
  })
})

// ── 3. a stop needs proof the owner is gone ──────────────────────────────────────────────────────

describe('3. a stop happens only on proof the owner is gone', () => {
  const leftover = (o: Partial<ProcEntry>): ProcEntry => p({
    pid: 400, argv: ['/tmp/x/agentop'], exe: '/tmp/x/agentop', env: { HOME: '/tmp/x/home' }, ...o,
  })

  test('the recorded owner is dead → stopped', () => {
    const r = plan([leftover({ cardOwner: { pid: 4242, starttime: 777, harness: 'claude' } })], {})
    expect(r.kills.map(k => [k.pid, k.reason])).toEqual([[400, 'test-leftover']])
  })

  test("the owner's pid was RECYCLED by another process (different start time) → stopped", () => {
    const r = plan([leftover({ cardOwner: { pid: 4242, starttime: 777, harness: 'claude' } })], { 4242: 99_999 })
    expect(r.kills.map(k => k.pid)).toEqual([400])
  })

  test('CLAUDE_PID dead → stopped; CLAUDE_PID alive → kept', () => {
    expect(plan([leftover({ env: { HOME: '/tmp/x/home', CLAUDE_PID: '4242' } })], {}).kills.map(k => k.pid)).toEqual([400])
    expect(plan([leftover({ env: { HOME: '/tmp/x/home', CLAUDE_PID: '4242' } })], { 4242: 1 }).kills).toEqual([])
  })

  test('an orphaned agentop mcp (reparented to init: no client) is stopped; one with a live parent is not', () => {
    const r = plan([
      p({ pid: 500, ppid: 1, argv: ['agentop', 'mcp'], exe: '/home/u/.local/bin/agentop.bak (deleted)' }),
      p({ pid: 501, ppid: 4242, argv: ['agentop', 'mcp'], exe: '/home/u/.local/bin/agentop.bak (deleted)' }),
    ], { 4242: 1 })
    expect(r.kills.map(k => [k.pid, k.reason])).toEqual([[500, 'orphan-mcp']])
  })
})

// ── the owner record itself ───────────────────────────────────────────────────────────────────────

describe('the process card names the owning assistant, for every harness', () => {
  test('harnessOfProcess', () => {
    expect(harnessOfProcess('claude', ['claude', '--session-id', 'x'])).toBe('claude')
    expect(harnessOfProcess('2.1.288', ['/home/u/.local/share/claude/versions/2.1.288'])).toBe('claude')
    expect(harnessOfProcess('node', ['node', '/home/u/.bun/install/global/node_modules/@openai/codex/bin/codex.js'])).toBe('codex')
    expect(harnessOfProcess('node', ['node', '/usr/lib/node_modules/@google/gemini-cli/dist/index.js'])).toBe('gemini')
    expect(harnessOfProcess('agy', ['agy'])).toBe('antigravity')
    expect(harnessOfProcess('tmux: server', ['tmux', '-L', 'tuie2e'])).toBeNull()
    expect(harnessOfProcess('bash', ['bash', '-c', 'claude -p hi'])).toBeNull()
  })

  test('ownerFromChain walks up to the nearest assistant, skipping itself, and stops at init', () => {
    const chain: Record<number, ChainLink> = {
      900: { pid: 900, ppid: 800, starttime: 9, comm: 'agentop', argv: ['/tmp/rel/agentop', 'server'] },
      800: { pid: 800, ppid: 700, starttime: 8, comm: 'bash', argv: ['bash', '-c', '…'] },
      700: { pid: 700, ppid: 1, starttime: 7, comm: 'node', argv: ['node', '/x/node_modules/@openai/codex/bin/codex.js'] },
    }
    expect(ownerFromChain(900, pid => chain[pid] ?? null)).toEqual({ pid: 700, starttime: 7, harness: 'codex' })
    // a pane under a tmux server: the chain reaches the tmux server, then init — no owner
    const pane: Record<number, ChainLink> = {
      910: { pid: 910, ppid: 905, starttime: 9, comm: 'tuicheck', argv: ['tuicheck', 'server'] },
      905: { pid: 905, ppid: 1, starttime: 5, comm: 'tmux: server', argv: ['tmux', '-L', 'tuie2e'] },
    }
    expect(ownerFromChain(910, pid => pane[pid] ?? null)).toBeNull()
  })
})
