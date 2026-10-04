/**
 * idle-servers.ts — PURE. A second `agentop server` that is running and serving NOTHING.
 *
 * ## The incident this exists for
 *
 * Two `agentop server` processes ran side by side for seventy minutes on a real machine:
 *
 * ```
 * 517      ~/.local/bin/agentop server            ← systemd, holding 47291/47292
 * 3189270  bun packages/server/bin/cli.ts server  ← started by hand from the checkout
 * ```
 *
 * The second could not bind the ports and **kept working anyway**: the file watcher does not depend
 * on a listening socket, so it held 2367 inotify watches and recomputed the whole API response on
 * every transcript write from twelve sessions — 72% of a core and 1.1 GB, serving nobody.
 *
 * Nothing in the product could see it. The conflict model knows `native` versus `docker` and merges
 * the two into one row, and **a compiled binary and `bun run` from a checkout are both native**, so
 * two servers collapsed into one line that said everything was fine. And the runtime probe asks
 * `lsof -sTCP:LISTEN`, which by construction can only ever find the one that WON the port.
 *
 * ## The rule
 *
 * A server process that is not the listener is not a second opinion, it is waste. There is no case
 * where two of them is what somebody wanted: they read the same files, write the same caches and
 * fight over the same port. So it is reported as a fault with the pid, and the pid is the whole
 * point — "something is wrong" that cannot be acted on is a worse message than none.
 *
 * The listener itself is never reported. Nor is THIS process: the cockpit runs inside `agentop`, and
 * a rule that flagged its own pid would report a conflict on every healthy machine.
 */

/** One process claiming to be an agentop server. */
export interface ServerProcess {
  pid: number
  /** The command line, for the report — a user has to be able to tell which one to kill. */
  command: string
}

export interface IdleServers {
  /** Running, not listening, not us. Waste, every one of them. */
  idle: ServerProcess[]
  /** The pid holding the port, when there is one. */
  listener?: number
}

/**
 * Which server processes are doing nothing — PURE.
 *
 * `listening` is the set holding the port (usually one). `self` is this process, excluded because
 * the cockpit is itself an `agentop` and would otherwise report itself forever.
 */
export function idleServers(o: {
  processes: readonly ServerProcess[]
  listening: readonly number[]
  self: number
}): IdleServers {
  const holding = new Set(o.listening)
  const idle = o.processes.filter(p => p.pid !== o.self && !holding.has(p.pid))
  return { idle, ...(o.listening[0] !== undefined ? { listener: o.listening[0] } : {}) }
}

/**
 * Whether a command line is an agentop SERVER — PURE.
 *
 * Matched on the `server` subcommand rather than on the binary's name, because the two forms that
 * collided look nothing alike: `~/.local/bin/agentop server` and
 * `bun packages/server/bin/cli.ts server`. Both end in the verb, and the verb is the thing that
 * makes a process a server.
 *
 * `agentop server` must not match `agentop session`, `agentop check-update`, or a shell whose
 * command line merely CONTAINS the phrase — a `grep agentop server` in someone's pipeline is not a
 * server, and reporting it would train people to ignore this.
 */
export function isServerCommand(command: string): boolean {
  const argv = command.trim().split(/\s+/)
  const i = argv.indexOf('server')
  if (i <= 0) return false

  // `server` must be the program's FIRST argument, not merely a token preceded by a plausible word.
  // Requiring only "the thing before it looks like agentop" matched `grep agentop server`, which is
  // somebody's pipeline and not a server — and one false positive here trains people to ignore the
  // warning, which is the only way this feature can fail.
  const isProgram = (a: string): boolean => /(^|\/)agentop$/.test(a)
  const isScript = (a: string): boolean => /(^|\/)(cli|index)\.(ts|js)$/.test(a)
  const isRuntime = (a: string): boolean => /(^|\/)(bun|node|deno)(\.exe)?$/.test(a)

  // `agentop server`
  if (i === 1 && isProgram(argv[0]!)) return true
  // `bun packages/server/bin/cli.ts server`
  if (i === 2 && isRuntime(argv[0]!) && isScript(argv[1]!)) return true
  return false
}

/**
 * The data directory a process would use, from its own environment — PURE. Mirrors `config.ts`'s
 * rule (`AGENTISTICS_DIR`, else `$HOME/.agentistics`). `null` when the environment does not say.
 */
export function dataDirOfEnv(environ: string): string | null {
  const env = new Map<string, string>()
  for (const kv of environ.split('\0')) {
    const i = kv.indexOf('=')
    if (i > 0) env.set(kv.slice(0, i), kv.slice(i + 1))
  }
  const explicit = env.get('AGENTISTICS_DIR')
  if (explicit) return explicit.replace(/\/+$/, '')
  const home = env.get('HOME')
  return home ? `${home.replace(/\/+$/, '')}/.agentistics` : null
}

/**
 * Which idle servers a "stop extra copies" may signal — PURE. Only those of THIS data dir (another
 * HOME's preview or test server is somebody else's work, and the planLocalStop incident was exactly
 * a stop that reached them), never the lock holder (the one that actually serves), never ourselves.
 */
export function stoppableIdle(o: { idle: readonly number[]; dataDirOf: (pid: number) => string | null; ours: string; lockHolder: number | null; self: number }): number[] {
  const ours = o.ours.replace(/\/+$/, '')
  return o.idle.filter(pid => pid !== o.self && pid !== o.lockHolder && o.dataDirOf(pid) === ours)
}

