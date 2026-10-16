/**
 * "Is this session running a command?" — pure (ATOMIC SPAWN spec §2.4).
 *
 * `retire` needs the pane to be quiet, and activity alone is not enough (Claude reads `waiting`
 * while a `run_in_background` shell still runs). Children alone are not enough either: every
 * harness keeps MCP servers as children. So the WORK children of a pane are its descendants minus
 *   (1) the harness's own process chain (`holders`, as `process-transcript.ts` measures them),
 *   (2) any MCP launch — `agentop mcp`, or a command line the harness was configured with — together
 *       with everything under it (an `npx` shim has a `node` below it),
 *   (3) the per-harness `HELPER_PROCESSES` table.
 *
 * `HELPER_PROCESSES` is `Record<HarnessId, RegExp[] | null>`: `null` is "nobody has watched an idle
 * session of this harness", and then children are NOT checked — the result says `checked: false` so
 * the retire answer can say "child processes not checked for <harness>" instead of claiming quiet.
 * An entry is filled only from a live idle session, with the CLI version and date, like
 * `attention-rules.ts`.
 *
 * The tree itself is read by `readProcTree` (IO) over `childrenOf`/`exeName` — the walkers
 * `process-conversation.ts` already owns; there is no second `/proc` parser.
 */
import { readFile } from 'node:fs/promises'
import type { HarnessId } from '@agentistics/core'
import { childrenOf, exeName } from './process-conversation'

export interface ProcNode {
  readonly pid: number
  readonly ppid: number
  /** Executable basename (`/proc/<pid>/exe`), null when unreadable. */
  readonly exe: string | null
  /** The space-joined argv. */
  readonly argv: string
}

/** Patterns matched against a process's argv. `[]` = measured, nothing but MCP/holders; `null` = not measured. */
export const HELPER_PROCESSES: Record<HarnessId, RegExp[] | null> = {
  // claude 2.1.301, 2026-10-16: five idle sessions under tmux (read-only /proc walk). Every child
  // was an MCP launch (`npx -y …-mcp`+node below it, a python serena, `agentop mcp`); no
  // ripgrep/LSP/indexer helper was ever resident while idle. The only non-MCP child seen was the
  // Bash tool's `bash -c` of a command that was RUNNING — a real work child.
  claude: [],
  // Not measured: no idle codex/gemini/copilot/antigravity/kimi session existed on this machine on
  // 2026-10-16. Fill each from a live idle session (CLI version + date) before relying on it.
  codex: null,
  gemini: null,
  copilot: null,
  antigravity: null,
  kimi: null,
  opencode: null,
}

export interface WorkChildrenOptions {
  /** Executable basenames that are the harness's own chain (descended through, never counted). */
  readonly holders?: readonly string[]
  /** MCP launch command lines (substring match) the harness is configured with. */
  readonly mcpCommands?: readonly string[]
  /** Extra helper patterns; defaults to the harness's `HELPER_PROCESSES` entry. */
  readonly helpers?: readonly RegExp[]
}

export interface WorkChildrenResult {
  /** False when the harness is unmeasured: `children` is then empty and means "unknown", not "none". */
  readonly checked: boolean
  readonly children: ProcNode[]
}

const AGENTOP_MCP = /(^|\/)agentop mcp(\s|$)/

export function workChildren(
  tree: readonly ProcNode[],
  panePid: number,
  harness: HarnessId,
  opts: WorkChildrenOptions = {},
): WorkChildrenResult {
  const table = opts.helpers ?? HELPER_PROCESSES[harness]
  if (table === null || table === undefined) return { checked: false, children: [] }
  const byParent = new Map<number, ProcNode[]>()
  for (const p of tree) {
    const l = byParent.get(p.ppid)
    if (l) l.push(p)
    else byParent.set(p.ppid, [p])
  }
  const holders = opts.holders ?? []
  const mcp = opts.mcpCommands ?? []
  const isMcp = (p: ProcNode): boolean => AGENTOP_MCP.test(p.argv) || mcp.some((m) => m !== '' && p.argv.includes(m))
  const out: ProcNode[] = []
  const walk = (pid: number, excluded: boolean): void => {
    for (const c of byParent.get(pid) ?? []) {
      const skip = excluded || isMcp(c) || table.some((re) => re.test(c.argv))
      const isHolder = !skip && c.exe !== null && holders.includes(c.exe)
      if (!skip && !isHolder) out.push(c)
      walk(c.pid, skip)
    }
  }
  walk(panePid, false)
  return { checked: true, children: out }
}

/** Reads the descendants of `panePid` from `/proc` (empty when not Linux or the pid is gone). */
export async function readProcTree(panePid: number, maxDepth = 8): Promise<ProcNode[]> {
  const out: ProcNode[] = []
  const walk = async (pid: number, depth: number): Promise<void> => {
    if (depth >= maxDepth) return
    for (const c of await childrenOf(pid)) {
      let argv = ''
      try {
        argv = (await readFile(`/proc/${c}/cmdline`, 'utf-8')).split('\0').filter(Boolean).join(' ')
      } catch {
      }
      out.push({ pid: c, ppid: pid, exe: await exeName(c), argv })
      await walk(c, depth + 1)
    }
  }
  await walk(panePid, 0)
  return out
}
