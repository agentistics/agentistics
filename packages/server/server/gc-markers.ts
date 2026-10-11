/**
 * gc-markers.ts — `agentop server` runs JavaScriptCore with TWO parallel GC markers (PERF.IDLE).
 *
 * WHAT WAS MEASURED (2026-10-11, bun 1.3.14, 8-core WSL2): a bare `Bun.serve` that allocates ANYTHING
 * once a second — one empty array — costs ~1.0 % of a core; the same process allocating nothing costs
 * ~0.1 %. The cost does not grow with what is allocated (one array and a thousand objects measure the
 * same): it is a fixed price per collection cycle, paid by the seven `HeapHelper` marker threads JSC
 * starts on an 8-core machine, which wake for every cycle and spin on `sched_yield` waiting for
 * marking work a small idle heap does not have (a full strace of the idle server: ~250 `sched_yield`
 * a second outside any burst, all on those threads). With `BUN_JSC_numberOfGCMarkers=1` the same
 * process measures ~0.15 %. On the engine-map fleet (N=10, five simulated web clients, 60 s):
 *
 *   markers   idle CPU   5 clients CPU   RSS
 *   default    1.3 %        11.9 %       ~210 MB
 *   1          0.6 %         4.2 %       ~340 MB   (collects later: +130 MB resident)
 *   2          0.9 %         5.3 %       ~210 MB
 *
 * Two keeps the memory the server always had and most of the saving; one would buy another 0.3 %
 * with a third more RSS, on machines where memory is what runs out first.
 *
 * A server that is idle is exactly the case where parallel marking buys nothing; one that is busy
 * still marks CONCURRENTLY with its own collector thread, it just does not fan the work out. The
 * engine-map bench checks the price (send → echo, write → shown, switch first frame) on every run.
 *
 * JSC reads its options ONCE, when the VM starts, from `BUN_JSC_*` in the environment, and `bun:jsc`
 * has no setter — so the server re-executes ITSELF (execve: same pid, same fds, nothing claimed yet)
 * with the variable set, before it touches the data dir, a port or the vault. `AGENTISTICS_GC_REEXEC=1`
 * marks the new image as ours: it stops a second re-exec, and tells the new image to take BOTH variables
 * back out of its environment at once (`forgetReexecEnv`) and installs the spawn guard
 * (`spawn-env.ts`) — the option is read already, and everything the server starts (tmux and every
 * session in it, the harnesses, MCPs, a `bun test` run inside a session) would otherwise inherit it.
 *
 * Overrides: a `BUN_JSC_numberOfGCMarkers` the person set is left alone; `AGENTISTICS_GC_MARKERS=<n>`
 * picks another count, `AGENTISTICS_GC_MARKERS=0` leaves the runtime's default (and skips the re-exec).
 */

import { installSpawnEnvGuard } from './spawn-env'

export const GC_MARKERS_ENV = 'BUN_JSC_numberOfGCMarkers'
/** Set only on the re-executed image: "the GC variable is ours, take it back out". */
export const GC_REEXEC_ENV = 'AGENTISTICS_GC_REEXEC'
export const DEFAULT_GC_MARKERS = 2

/** PURE: the marker count to re-exec with, or `null` to start as we are. */
export function gcMarkersPlan(env: Record<string, string | undefined>, platform: string): number | null {
  if (platform !== 'linux' && platform !== 'darwin') return null
  if (env[GC_REEXEC_ENV] !== undefined || env[GC_MARKERS_ENV] !== undefined) return null
  const raw = env.AGENTISTICS_GC_MARKERS
  if (raw === undefined || raw === '') return DEFAULT_GC_MARKERS
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) return null
  return n
}

/**
 * PURE: the argv to re-execute this very invocation. From source the script and the runtime's own
 * flags (`--cpu-prof`, …) come along; a compiled binary is its own script. `null` when there is no
 * executable to name.
 */
export function selfArgv(o: { execPath: string; argv: readonly string[]; execArgv: readonly string[] }): string[] | null {
  if (!o.execPath) return null
  const script = o.argv[1]
  const fromSource = !!script && !script.startsWith('/$bunfs/') && (script.endsWith('.ts') || script.endsWith('.js'))
  return fromSource
    ? [o.execPath, ...o.execArgv, script, ...o.argv.slice(2)]
    : [o.execPath, ...o.argv.slice(2)]
}

/**
 * On the re-executed image: delete the two variables the re-exec put there (the runtime has read its
 * option already), so no child inherits them. A `BUN_JSC_numberOfGCMarkers` the person set themselves
 * never carries the marker, and is left alone. Returns whether this was the re-executed image.
 */
export function forgetReexecEnv(env: Record<string, string | undefined>): boolean {
  if (env[GC_REEXEC_ENV] !== '1') return false
  delete env[GC_REEXEC_ENV]
  delete env[GC_MARKERS_ENV]
  return true
}

/**
 * Re-execute this process with the marker count set. Returns only when it could NOT (no C library,
 * execve refused): the server then simply starts with the runtime's default, which is what it always
 * did — never a reason not to serve.
 */
export async function reexecWithGcMarkers(): Promise<void> {
  if (forgetReexecEnv(process.env)) {
    // `process.env` is not what a child inherits — see spawn-env.ts.
    installSpawnEnvGuard([GC_MARKERS_ENV, GC_REEXEC_ENV])
    return
  }
  const n = gcMarkersPlan(process.env, process.platform)
  if (n === null) return
  const argv = selfArgv({ execPath: process.execPath, argv: process.argv, execArgv: process.execArgv })
  if (!argv) return
  try {
    const { dlopen, FFIType, ptr } = await import('bun:ffi')
    const lib = dlopen(process.platform === 'linux' ? 'libc.so.6' : '/usr/lib/libSystem.B.dylib', {
      execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    } as const)
    const env = { ...process.env, [GC_MARKERS_ENV]: String(n), [GC_REEXEC_ENV]: '1' }
    // NUL-terminated strings, then a NULL-terminated array of pointers to them. The buffers stay
    // referenced until execve either replaces the process or returns.
    const cstr = (s: string) => Buffer.from(`${s}\0`, 'utf8')
    const argvBufs = argv.map(cstr)
    const envBufs = Object.entries(env).filter(([, v]) => v !== undefined).map(([k, v]) => cstr(`${k}=${v}`))
    const table = (bufs: Buffer[]) => {
      const t = new BigUint64Array(bufs.length + 1)
      bufs.forEach((b, i) => { t[i] = BigInt(ptr(b)) })
      return t
    }
    const argvTable = table(argvBufs)
    const envTable = table(envBufs)
    lib.symbols.execve(ptr(argvBufs[0]!), ptr(argvTable), ptr(envTable))
    console.warn(`[startup] could not re-execute with ${GC_MARKERS_ENV}=${n} — running with the runtime's default GC markers`)
  } catch {
    // No FFI, no libc: the default it is.
  }
}
