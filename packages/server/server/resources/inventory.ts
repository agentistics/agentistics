/**
 * resources/inventory.ts — PURE. Which processes on this machine are agentop's, what each one costs,
 * and who it belongs to.
 *
 * ## Why (RES.1, 2026-10-03)
 *
 * Three processes nobody was looking at froze the owner's machine: a cockpit running a binary an
 * upgrade had replaced (1.7 GB RSS + 6.5 GB swap) and two `agentop mcp` whose Claude session had
 * died (parent `/init`) burning 111 % CPU each for 70 minutes. Killing them freed 8 GB. Every one of
 * them was visible in `/proc` the whole time; nothing in agentop read it. This module is the read.
 *
 * ## What counts as agentop's
 *
 * Narrow on purpose — the governor acts on this list, and a process wrongly counted is a process
 * that may be killed:
 *  - the agentop binary itself (exe basename `agentop`, including a deleted one) or the source entry
 *    point (`…/packages/server/bin/cli.ts`), classified by subcommand;
 *  - a REGISTERED helper (`helpers.ts`) — anything agentop or the engine started and declared;
 *  - a heavy job running under `agentop heavy` (`heavy.ts`).
 * An assistant CLI (claude, codex…) is NOT here: it is a session, and the fleet owns it.
 *
 * ## Who owns it
 *
 * A process started from inside an assistant session inherits that session's environment, and Claude
 * Code stamps `CLAUDE_PID` + `CLAUDE_CODE_SESSION_ID` on it (measured on this machine). That is an
 * exact owner: the owner is ALIVE while `CLAUDE_PID` names a running process. A registered helper
 * names its owner explicitly. Everything else has no known owner, which is said as such.
 */

/** What the IO layer read about one process. Bytes, seconds, percent. */
export interface ProcEntry {
  pid: number
  ppid: number
  /** argv, split on NUL. */
  argv: string[]
  /** `readlink /proc/<pid>/exe`, or null when unreadable. May end in ` (deleted)`. */
  exe: string | null
  rssBytes: number | null
  swapBytes: number | null
  /** CPU over the last sampling interval, 0-100 per core (can exceed 100). Null on the first sample. */
  cpuPercent: number | null
  ageSec: number
  /** The few environment variables the owner rule reads; absent when unreadable. */
  env: {
    CLAUDE_PID?: string
    CLAUDE_CODE_SESSION_ID?: string
    TMUX_PANE?: string
    AGENTISTICS_HELPER_ID?: string
    AGENTISTICS_HEAVY_JOB?: string
    HOME?: string
  }
}

export type ProcessKind =
  | 'server'   // agentop server (or bare/start falling through to it, or the source entry)
  | 'cockpit'  // the control center: bare agentop / start / tui with a terminal
  | 'mcp'      // agentop mcp — one assistant's stdio MCP server
  | 'watch'    // agentop watch — the OTel daemon
  | 'cli'      // any other one-shot agentop subcommand
  | 'helper'   // registered through the helper API
  | 'heavy'    // a job under `agentop heavy`

export interface ProcessOwner {
  /** `session` — an assistant session's process (CLAUDE_PID); `pid` — a helper's declared owner pid. */
  kind: 'session' | 'pid'
  pid: number
  sessionId?: string
  alive: boolean
}

export interface AgentopProcess {
  pid: number
  ppid: number
  kind: ProcessKind
  /** A short human label: `agentop mcp`, the helper's name, the heavy command. */
  label: string
  rssBytes: number | null
  swapBytes: number | null
  /** RSS + swap — the figure every budget is checked against (RSS alone hid the incident). */
  usedBytes: number | null
  cpuPercent: number | null
  ageSec: number
  /** The binary behind it was replaced on disk — an old program still running. */
  stale: boolean
  /** Reparented to init: whoever started it is gone. */
  orphan: boolean
  owner: ProcessOwner | null
  /** This is the process answering the request (the governor never acts on itself). */
  self: boolean
  helperId?: string
  /**
   * Runs under a HOME other than this server's — a test or preview instance (`HOME=/tmp/…`), which
   * is how every isolated check in this repo is told to run. `false` when HOME is unreadable: an
   * unknown is never treated as "isolated".
   */
  isolatedHome: boolean
}

/** The subcommands the cockpit runs under; the rest is decided by argv. */
const COCKPIT_COMMANDS = new Set(['start', 'tui'])

/** argv index of the subcommand: after the binary, or after `bun …/cli.ts`. */
function subcommandOf(argv: string[]): { isAgentop: boolean; sub: string | undefined } {
  const first = argv[0] ?? ''
  const base = first.split('/').pop() ?? ''
  if (base === 'agentop' || base.startsWith('agentop.')) return { isAgentop: true, sub: argv[1] }
  const cli = argv.findIndex(a => a.endsWith('packages/server/bin/cli.ts'))
  if (cli >= 0 && /(^|\/)bun$/.test(first)) return { isAgentop: true, sub: argv[cli + 1] }
  return { isAgentop: false, sub: undefined }
}

/**
 * Classify one process, or `null` when it is not agentop's. `helperIds` are the registered helpers'
 * pids → ids, so a registered process is a helper whatever its argv says.
 */
export function classifyProcess(e: ProcEntry, helperPids: ReadonlyMap<number, string>): { kind: ProcessKind; label: string; helperId?: string } | null {
  // Registered by pid, or a child of a registered helper (the id is inherited in its environment).
  const helperId = helperPids.get(e.pid) ?? e.env.AGENTISTICS_HELPER_ID
  if (helperId) return { kind: 'helper', label: e.argv.slice(0, 3).join(' '), helperId }
  if (e.env.AGENTISTICS_HEAVY_JOB) return { kind: 'heavy', label: e.argv.slice(0, 4).join(' ') }
  const { isAgentop, sub } = subcommandOf(e.argv)
  // The exe is the deciding fact when argv was rewritten: a deleted `agentop.bak` is still agentop.
  const exeBase = (e.exe ?? '').replace(/ \(deleted\)$/, '').split('/').pop() ?? ''
  if (!isAgentop && !exeBase.startsWith('agentop')) return null
  const label = `agentop${sub ? ` ${sub}` : ''}`
  if (sub === 'mcp') return { kind: 'mcp', label }
  if (sub === 'server') return { kind: 'server', label }
  if (sub === 'watch') return { kind: 'watch', label }
  if (sub === undefined || COCKPIT_COMMANDS.has(sub)) return { kind: 'cockpit', label: sub ? label : 'agentop' }
  return { kind: 'cli', label }
}

export interface InventoryContext {
  selfPid: number
  /** This server's own HOME; a process under another HOME is an isolated (test/preview) instance. */
  home?: string
  /** Where throwaway HOMEs live (`/tmp`, `/var/tmp`, the OS temp dir). See `isThrowawayHome`. */
  tempRoots?: readonly string[]
  /** Is this pid alive right now? */
  alive: (pid: number) => boolean
  /** Registered helpers' pids → their ids and declared owner pids. */
  helpers: ReadonlyMap<number, { id: string; ownerPid?: number; ownerSessionId?: string }>
}

/** The temp roots a throwaway HOME is made under, by default. */
export const DEFAULT_TEMP_ROOTS: readonly string[] = ['/tmp/', '/var/tmp/', '/dev/shm/']

/**
 * Is this a THROWAWAY HOME — a test or preview instance — PURE.
 *
 * Two conditions, and the second is the one that matters. "A HOME other than mine" alone is
 * RELATIVE: found in the release-0410 smoke, a preview server running under `/tmp/…/home` saw the
 * user's REAL HOME as "another HOME", so its governor would have treated the user's own orphaned
 * main server (a `nohup agentop server &`) as a test leftover and stopped it. A throwaway HOME is one
 * made under a temp root; the user's real HOME never is, whoever is asking.
 */
export function isThrowawayHome(home: string | undefined, selfHome: string | undefined, roots: readonly string[] = DEFAULT_TEMP_ROOTS): boolean {
  if (!home || !selfHome || home === selfHome) return false
  const h = home.endsWith('/') ? home : `${home}/`
  return roots.some(r => h.startsWith(r.endsWith('/') ? r : `${r}/`))
}

/** Build the inventory — PURE over what was read. Sorted by memory, biggest first. */
export function buildInventory(entries: ProcEntry[], ctx: InventoryContext): AgentopProcess[] {
  const helperPids = new Map([...ctx.helpers].map(([pid, h]) => [pid, h.id] as const))
  const out: AgentopProcess[] = []
  for (const e of entries) {
    const c = classifyProcess(e, helperPids)
    if (!c) continue
    const helper = ctx.helpers.get(e.pid)
    let owner: ProcessOwner | null = null
    if (c.kind === 'mcp') {
      // An MCP server's owner is the assistant that spawned it — its PARENT. Orphaned = owner gone.
      owner = e.ppid === 1 ? null : { kind: 'pid', pid: e.ppid, alive: ctx.alive(e.ppid) }
    } else if (helper?.ownerPid) {
      owner = { kind: 'pid', pid: helper.ownerPid, alive: ctx.alive(helper.ownerPid), ...(helper.ownerSessionId ? { sessionId: helper.ownerSessionId } : {}) }
    } else {
      const claudePid = Number(e.env.CLAUDE_PID)
      if (Number.isInteger(claudePid) && claudePid > 0) {
        owner = {
          kind: 'session', pid: claudePid, alive: ctx.alive(claudePid),
          ...(e.env.CLAUDE_CODE_SESSION_ID ? { sessionId: e.env.CLAUDE_CODE_SESSION_ID } : {}),
        }
      }
    }
    out.push({
      pid: e.pid,
      ppid: e.ppid,
      kind: c.kind,
      label: c.label,
      rssBytes: e.rssBytes,
      swapBytes: e.swapBytes,
      usedBytes: e.rssBytes === null ? null : e.rssBytes + (e.swapBytes ?? 0),
      cpuPercent: e.cpuPercent,
      ageSec: e.ageSec,
      stale: e.exe !== null && e.exe.endsWith(' (deleted)'),
      orphan: e.ppid === 1,
      owner,
      self: e.pid === ctx.selfPid,
      isolatedHome: isThrowawayHome(e.env.HOME, ctx.home, ctx.tempRoots),
      ...(c.helperId ? { helperId: c.helperId } : {}),
    })
  }
  return out.sort((a, b) => (b.usedBytes ?? 0) - (a.usedBytes ?? 0))
}
