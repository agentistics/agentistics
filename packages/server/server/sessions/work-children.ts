/**
 * "Is this session running a command?" — pure (ATOMIC SPAWN spec §2.4).
 *
 * `retire` needs the pane to be quiet, and activity alone is not enough (Claude reads `waiting`
 * while a `run_in_background` shell still runs). Children alone are not enough either: every
 * harness keeps MCP servers as children. So the WORK children of a pane are its descendants minus
 *   (1) the harness's own CHAIN — the shim/node/native processes between the pane and the harness
 *       proper, identified by executable name (`holders`) or by an argv anchored at the start
 *       (`HARNESS_CHAIN`) — and only while walking straight down from the pane through chain nodes;
 *       a `node build.js` under a counted `bash` is work even though `node` is a shim name;
 *   (2) the DIRECT children of the pane or of a chain node that are an MCP launch (`agentop mcp`, or
 *       an anchored match of a configured `command + args`) or match the harness's
 *       `HELPER_PROCESSES`, with everything under them (an `npx` shim has a `node` below it). MCP
 *       servers are spawned by the harness, never by a shell, so nothing deeper is ever excluded: a
 *       Bash tool command whose text merely MENTIONS an MCP server is work.
 *
 * `HELPER_PROCESSES` is `Record<HarnessId, RegExp[] | null>`: `null` is "nobody has watched an idle
 * session of this harness", and then children are NOT checked — the result says `checked: false`
 * (with a reason) so the retire answer can say "child processes not checked for <harness>" instead of
 * claiming quiet. The same holds when `/proc` cannot be read: unknown is never "quiet". An entry is
 * filled only from a live idle session, with the CLI version and date, like `attention-rules.ts`.
 *
 * The tree itself is read by `readProcTree` (IO) over `childrenOf`/`exeName` — the walkers
 * `process-conversation.ts` already owns; there is no second children parser.
 */
import { readFile, readdir } from 'node:fs/promises'
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

/**
 * Patterns matched against the argv of a direct child of the pane/chain. `[]` = measured, nothing but
 * MCP launches and the chain; `null` = not measured.
 */
export const HELPER_PROCESSES: Record<HarnessId, RegExp[] | null> = {
  // claude 2.1.301, 2026-10-16: five idle sessions under tmux (read-only /proc walk). Every child
  // was an MCP launch (`npx -y …-mcp`+node below it, a python serena, `agentop mcp`); no
  // ripgrep/LSP/indexer helper was ever resident while idle. The only non-MCP child seen was the
  // Bash tool's `bash -c` of a command that was RUNNING — a real work child.
  claude: [],
  // codex 0.161.0, 2026-10-16, idle in a throwaway (HOME with only auth.json + config.toml copied):
  // volta-shim(pane) -> node shim -> native codex -> two `codex app-server …` daemons (one runs
  // `agentop mcp`). The daemons are the harness's own helpers.
  codex: [/^\S*\/codex app-server(\s|$)/],
  // gemini 0.64.0, 2026-10-16, idle in a trusted folder: volta-shim -> node -> node(gemini) -> `agentop mcp`.
  gemini: [],
  // copilot 1.0.95, 2026-10-16, idle at its start screen: volta-shim -> node -> native copilot -> `agentop mcp`.
  copilot: [],
  // antigravity: its first run stops at the colour-scheme onboarding with a bare HOME and the idle
  // tree of a configured session has not been watched. Fill from a live idle agy.
  antigravity: null,
  // kimi 2.2.0, 2026-10-16, idle: kimi(.bak, self-updated) -> kimi-code -> `agentop mcp`.
  kimi: [],
  opencode: null,
}

/** The harness's own process chain below the pane (see the header). */
export interface HarnessChain {
  /** Executable basenames (`/proc/<pid>/exe`, ` (deleted)` stripped) that are the harness itself. */
  readonly exes: readonly string[]
  /** Argv patterns anchored at the start, for chain links whose exe is a generic `node`. */
  readonly argv: readonly RegExp[]
}

export const HARNESS_CHAIN: Record<HarnessId, HarnessChain | null> = {
  claude: { exes: ['claude'], argv: [] },
  codex: { exes: ['codex'], argv: [/^(\S*\/)?node (\S*\/)?codex(\s|$)/] },
  gemini: { exes: [], argv: [/^(\S*\/)?node (--\S+ )*(\S*\/)?gemini(\s|$)/] },
  copilot: { exes: ['copilot'], argv: [/^(\S*\/)?node (\S*\/)?copilot(\/\S*)?(\s|$)/] },
  antigravity: null,
  kimi: { exes: ['kimi', 'kimi.bak', 'kimi-code'], argv: [] },
  opencode: null,
}

export interface WorkChildrenOptions {
  /** Executable basenames that are the harness's own chain; defaults to `HARNESS_CHAIN`. */
  readonly holders?: readonly string[]
  /** Chain argv patterns; defaults to `HARNESS_CHAIN`. */
  readonly chainArgv?: readonly RegExp[]
  /**
   * MCP launch command lines the harness is configured with (`command + args`). Matched ANCHORED at
   * the start of the argv (followed by end, a space or an `@version`), and only on direct children of
   * the pane/chain. A bare interpreter (`node`, `python`, `docker` …) is refused: it would hide
   * every process of that kind.
   */
  readonly mcpCommands?: readonly string[]
  /** Extra helper patterns, ADDED to the harness's `HELPER_PROCESSES` entry (never replacing it). */
  readonly helpers?: readonly RegExp[]
}

export type WorkChildrenResult =
  | { readonly checked: false; readonly reason: 'unmeasured' | 'unreadable' }
  | { readonly checked: true; readonly children: ProcNode[] }

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ash'])

const AGENTOP_MCP = /^(\S*\/)?agentop mcp(\s|$)/

const BARE_INTERPRETERS = new Set([
  'node', 'nodejs', 'bun', 'bunx', 'npx', 'npm', 'pnpm', 'yarn', 'deno', 'python', 'python3', 'uv', 'uvx',
  'pipx', 'docker', 'podman', 'sh', 'bash', 'zsh', 'dash', 'java', 'ruby', 'perl', 'go', 'cargo', 'dotnet', 'env',
])

/** True when the entry names a program with arguments or a path, not just an interpreter. */
export function usableMcpCommand(m: string): boolean {
  const t = m.trim().split(/\s+/)
  if (t.length === 0 || t[0] === '') return false
  if (t.length === 1) return !BARE_INTERPRETERS.has(t[0]!.replace(/^.*\//, '').replace(/[\d.]+$/, ''))
  return true
}

function matchesMcp(argv: string, m: string): boolean {
  const a = argv.replace(/\s+/g, ' ').trim()
  const c = m.replace(/\s+/g, ' ').trim()
  if (!a.startsWith(c)) return false
  const next = a.charAt(c.length)
  return next === '' || next === ' ' || next === '@'
}

/**
 * `tree` is the descendants of `panePid` (`readProcTree`), or `null` when `/proc` could not be read —
 * which is "unknown", not "quiet".
 */
export function workChildren(
  tree: readonly ProcNode[] | null,
  panePid: number,
  harness: HarnessId,
  opts: WorkChildrenOptions = {},
): WorkChildrenResult {
  const base = HELPER_PROCESSES[harness]
  if (base === null || base === undefined) return { checked: false, reason: 'unmeasured' }
  if (tree === null) return { checked: false, reason: 'unreadable' }
  const table = [...base, ...(opts.helpers ?? [])]
  const chain = HARNESS_CHAIN[harness]
  const holders = opts.holders ?? chain?.exes ?? []
  const chainArgv = opts.chainArgv ?? chain?.argv ?? []
  const mcp = (opts.mcpCommands ?? []).filter(usableMcpCommand)
  const byParent = new Map<number, ProcNode[]>()
  for (const p of tree) {
    const l = byParent.get(p.ppid)
    if (l) l.push(p)
    else byParent.set(p.ppid, [p])
  }
  const isHolder = (p: ProcNode): boolean => p.exe !== null && holders.includes(p.exe)
  // A non-holder is still chain when a holder sits below it (`volta-shim -> node -> codex`) — unless
  // it is a shell: a shell that launches a holder-named program is running a command.
  const holderBelow = (pid: number): boolean =>
    (byParent.get(pid) ?? []).some((c) => isHolder(c) || (!SHELLS.has(c.exe ?? '') && holderBelow(c.pid)))
  const isExcluded = (p: ProcNode): boolean =>
    AGENTOP_MCP.test(p.argv) || mcp.some((m) => matchesMcp(p.argv, m)) || table.some((re) => re.test(p.argv))
  const out: ProcNode[] = []
  const walk = (pid: number, inChain: boolean): void => {
    for (const c of byParent.get(pid) ?? []) {
      if (inChain) {
        if (isExcluded(c)) continue // the whole subtree: an npx shim has a node below it
        if (isHolder(c) || chainArgv.some((re) => re.test(c.argv)) || (!SHELLS.has(c.exe ?? '') && holderBelow(c.pid))) {
          walk(c.pid, true)
          continue
        }
      }
      out.push(c)
      walk(c.pid, false)
    }
  }
  walk(panePid, true)
  return { checked: true, children: out }
}

/** `ppid` and state out of `/proc/<pid>/stat` (the comm field may contain spaces and parentheses). */
function parseStat(text: string): { state: string; ppid: number } | null {
  const i = text.lastIndexOf(')')
  if (i < 0) return null
  const f = text.slice(i + 2).split(' ')
  const ppid = Number(f[1])
  return f[0] && Number.isInteger(ppid) ? { state: f[0], ppid } : null
}

/**
 * Reads the descendants of `panePid` from `/proc`. `[]` when the pane is gone; `null` when the tree
 * CANNOT be read (not Linux, no permission, a kernel without `children`) — "unknown", never "none".
 * A process that exits mid-walk, a zombie, or a pid reused since it was listed is dropped.
 */
export async function readProcTree(panePid: number, maxDepth = 8): Promise<ProcNode[] | null> {
  if (process.platform !== 'linux') return null
  try {
    await readdir(`/proc/${panePid}/task`)
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' && (await procIsReadable()) ? [] : null
  }
  try {
    await readFile(`/proc/${panePid}/task/${panePid}/children`, 'utf-8')
  } catch {
    return null
  }
  const out: ProcNode[] = []
  const walk = async (pid: number, depth: number): Promise<void> => {
    if (depth >= maxDepth) return
    for (const c of await childrenOf(pid)) {
      let stat: { state: string; ppid: number } | null
      let argv: string
      try {
        stat = parseStat(await readFile(`/proc/${c}/stat`, 'utf-8'))
        argv = (await readFile(`/proc/${c}/cmdline`, 'utf-8')).split('\0').filter(Boolean).join(' ')
      } catch {
        continue // exited between the listing and the read
      }
      if (!stat || stat.state === 'Z' || stat.ppid !== pid) continue
      out.push({ pid: c, ppid: pid, exe: await exeName(c), argv })
      await walk(c, depth + 1)
    }
  }
  await walk(panePid, 0)
  return out
}

/** `/proc` is mounted and lists our own process (so an ENOENT on another pid means it is gone). */
async function procIsReadable(): Promise<boolean> {
  try {
    await readdir(`/proc/${process.pid}/task`)
    return true
  } catch {
    return false
  }
}
