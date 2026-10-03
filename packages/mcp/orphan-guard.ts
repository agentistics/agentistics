/**
 * mcp/orphan-guard.ts — an `agentop mcp` serves ONE assistant over stdio. When that assistant goes away it
 * must go with it. Nothing used to end it: six orphans (parent `/init`, their Claude session killed) spun
 * at ~140 % CPU each and the machine's load average reached 19.
 *
 * Every way a client disappears, handled once:
 * - stdin `end` / `close` / `error` — EOF, or EIO when a terminal's other end is gone;
 * - stdout `error` — EPIPE: nobody reads our answers, so serving is pointless;
 * - SIGHUP (the terminal hung up) and SIGPIPE;
 * - a parent-death watchdog: the parent pid CHANGED (the process was reparented to init) — this one covers a
 *   client that died while something else still held our stdin open.
 *
 * The first thing to fire wins; exit is idempotent. The watchdog is unref'd (it never keeps the process up) and
 * cheap: one `getppid` per tick.
 */
export interface OrphanGuardDeps {
  stdin: { on(ev: string, fn: (...a: unknown[]) => void): unknown }
  stdout: { on(ev: string, fn: (...a: unknown[]) => void): unknown }
  proc: { on(ev: string, fn: (...a: unknown[]) => void): unknown }
  getPpid(): number
  exit(code: number): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
  /** Watchdog period, ms. Default 500: an orphan is gone well inside 2 s, even on a loaded machine. */
  intervalMs?: number
}

export function installOrphanGuard(d: OrphanGuardDeps): () => void {
  const initial = d.getPpid()
  let done = false
  const bye = (): void => { if (done) return; done = true; d.exit(0) }
  for (const ev of ['end', 'close', 'error']) d.stdin.on(ev, bye)
  d.stdout.on('error', bye)
  for (const sig of ['SIGHUP', 'SIGPIPE']) d.proc.on(sig, bye)
  const handle = d.setInterval(() => { if (d.getPpid() !== initial) bye() }, d.intervalMs ?? 500)
  // A timer must never be the reason the process stays up.
  ;(handle as { unref?: () => void } | null)?.unref?.()
  return () => d.clearInterval(handle)
}
