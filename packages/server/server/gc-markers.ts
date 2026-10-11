/**
 * gc-markers.ts — `agentop server` runs JavaScriptCore with ONE parallel GC marker (PERF.IDLE).
 *
 * WHAT WAS MEASURED (2026-10-11, bun 1.3.14, 8-core WSL2): a bare `Bun.serve` that allocates ANYTHING
 * once a second — one empty array — costs ~1.0 % of a core; the same process allocating nothing costs
 * ~0.1 %. The cost does not grow with what is allocated (one array and a thousand objects measure the
 * same): it is a fixed price per collection cycle, paid by the seven `HeapHelper` marker threads JSC
 * starts on an 8-core machine, which wake for every cycle and spin on `sched_yield` waiting for
 * marking work a small idle heap does not have (a full strace of the idle server: ~250 `sched_yield`
 * a second outside any burst, all on those threads). With `BUN_JSC_numberOfGCMarkers=1` the same
 * process measures ~0.15 %, and the idle server at N=10 went from ~1.7 % to ~1.0 %.
 *
 * A server that is idle is exactly the case where parallel marking buys nothing; one that is busy
 * still marks CONCURRENTLY with its own collector thread, it just does not fan the work out. The
 * engine-map bench checks the price (send → echo, write → shown, switch first frame) on every run.
 *
 * JSC reads its options ONCE, when the VM starts, from `BUN_JSC_*` in the environment, and `bun:jsc`
 * has no setter — so the server re-executes ITSELF (execve: same pid, same fds, nothing claimed yet)
 * with the variable set, before it touches the data dir, a port or the vault. The variable in the new
 * environment is what stops it from doing so twice.
 *
 * Overrides: a `BUN_JSC_numberOfGCMarkers` the person set is left alone; `AGENTISTICS_GC_MARKERS=<n>`
 * picks another count, `AGENTISTICS_GC_MARKERS=0` leaves the runtime's default (and skips the re-exec).
 */

export const GC_MARKERS_ENV = 'BUN_JSC_numberOfGCMarkers'
export const DEFAULT_GC_MARKERS = 1

/** PURE: the marker count to re-exec with, or `null` to start as we are. */
export function gcMarkersPlan(env: Record<string, string | undefined>, platform: string): number | null {
  if (platform !== 'linux' && platform !== 'darwin') return null
  if (env[GC_MARKERS_ENV] !== undefined) return null
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
 * Re-execute this process with the marker count set. Returns only when it could NOT (no C library,
 * execve refused): the server then simply starts with the runtime's default, which is what it always
 * did — never a reason not to serve.
 */
export async function reexecWithGcMarkers(): Promise<void> {
  const n = gcMarkersPlan(process.env, process.platform)
  if (n === null) return
  const argv = selfArgv({ execPath: process.execPath, argv: process.argv, execArgv: process.execArgv })
  if (!argv) return
  try {
    const { dlopen, FFIType, ptr } = await import('bun:ffi')
    const lib = dlopen(process.platform === 'linux' ? 'libc.so.6' : '/usr/lib/libSystem.B.dylib', {
      execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    } as const)
    const env = { ...process.env, [GC_MARKERS_ENV]: String(n) }
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
