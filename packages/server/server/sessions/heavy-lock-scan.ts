/**
 * heavy-lock-scan.ts — which managed sessions hold or wait on the heavy-job lock, read ONCE per tick.
 *
 * `flock /tmp/agentistics-heavy.lock <job>` forks the job and waits: a flock WITH a child is HOLDING
 * the lock (the job runs), a flock with none is QUEUED behind someone else. One `ps` listing answers
 * every session — the previous reader spawned `ps` per session per observation. PURE: the IO (the `ps`
 * call and the `/proc` environ read) is injected by the one module allowed to spawn, `flows/stalled-host.ts`
 * (`doors.lint` pins who may import `child_process`). The match is the
 * process's own `AGENTOP_MANAGED_ID` (a pane's children inherit it); there is NO cwd fallback, so a
 * flock started from a shell outside any managed pane is attributed to nobody. Linux only (`/proc`):
 * elsewhere, and on any error, the answer is `false` — "cannot tell" never invents activity.
 *
 * `flock --no-fork` replaces itself with the job and leaves no `flock` process to see; not detectable.
 */
export type HeavyLockState = 'waiting' | 'holding'

/** `pid ppid args` lines (what `ps -eo pid=,ppid=,args=` prints) → the flock processes on a heavy/release lane lock. */
export function parseHeavyLockProcs(ps: string): { pid: number; holding: boolean }[] {
  const rows: { pid: number; ppid: number; args: string }[] = []
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3]! })
  }
  const parents = new Set(rows.map(r => r.ppid))
  return rows
    .filter(r => /^(\S*\/)?flock\s.*agentistics-(heavy|release)(\.\d+)?\.lock/.test(r.args))
    .map(r => ({ pid: r.pid, holding: parents.has(r.pid) }))
}

export interface HeavyScanDeps {
  platform: string
  ps(): Promise<string>
  managedIdOf(pid: number): string | null
  now(): number
}

/** The shared answer lives this long: under the engine's 60 s tick and the 5 s fleet poll's reach. */
export const HEAVY_SCAN_TTL_MS = 5_000

export function createHeavyLockScanner(d: HeavyScanDeps, ttlMs = HEAVY_SCAN_TTL_MS) {
  let at = Number.NEGATIVE_INFINITY
  let cached: ReadonlyMap<string, HeavyLockState> = new Map()
  let inflight: Promise<ReadonlyMap<string, HeavyLockState>> | null = null

  async function read(): Promise<ReadonlyMap<string, HeavyLockState>> {
    const out = new Map<string, HeavyLockState>()
    try {
      for (const p of parseHeavyLockProcs(await d.ps())) {
        const id = d.managedIdOf(p.pid)
        if (!id) continue
        if (p.holding || out.get(id) !== 'holding') out.set(id, p.holding ? 'holding' : 'waiting')
      }
    } catch { return new Map() }
    return out
  }

  async function states(): Promise<ReadonlyMap<string, HeavyLockState>> {
    if (d.platform !== 'linux') return cached
    if (d.now() - at < ttlMs) return cached
    inflight ??= read().then(m => { cached = m; at = d.now(); return m }).finally(() => { inflight = null })
    return inflight
  }

  return {
    states,
    async of(id: string): Promise<HeavyLockState | false> { return (await states()).get(id) ?? false },
  }
}
