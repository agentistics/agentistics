/**
 * vault/hardening.ts — making the service's memory private BEFORE the first unwrap (SECRETS.4 §5.3).
 *
 *   Linux / WSL   prctl(PR_SET_DUMPABLE, 0), verified with PR_GET_DUMPABLE == 0
 *                 setrlimit(RLIMIT_CORE, {0, 0}), verified with getrlimit
 *                 /proc/sys/kernel/yama/ptrace_scope READ and reported (absent on the WSL kernel)
 *   macOS         ptrace(PT_DENY_ATTACH) and setrlimit(RLIMIT_CORE, 0)
 *   Windows       nothing from here — §5.4: a same-user process can read the service's memory and
 *                 Windows offers no per-process equivalent; reported as `limited`, stated, not faked
 *
 * Why non-dumpable is the real defence on WSL: the kernel is built WITHOUT Yama, so same-user ptrace
 * is allowed by default; with dumpable = 0 the kernel's ptrace_may_access demands CAP_SYS_PTRACE to
 * attach or to read /proc/<pid>/mem, Yama or not. WSL's core_pattern pipes a core to the Windows side
 * (`|/wsl-capture-crash …`); dumpable = 0 plus RLIMIT_CORE = 0 means no core is produced at all.
 *
 * `applyHardening` is PURE over an injected `Libc`, so a failing prctl is testable; `loadLibc` is the
 * `bun:ffi` edge — FFI into the C library, not a compiled addon (SECRETS.0 §2.7(5) is not revisited).
 * A step that fails, or that cannot be VERIFIED, fails the whole thing: `hardening-failed` keeps the
 * human scope (and the runner scope) closed in this process.
 */
import { readFileSync } from 'node:fs'

export interface Libc {
  /** prctl(PR_SET_DUMPABLE, 0) → 0 on success */
  setNotDumpable(): number
  /** prctl(PR_GET_DUMPABLE) → 0 | 1 | 2, or -1 */
  getDumpable(): number
  /** setrlimit(RLIMIT_CORE, {0,0}) → 0 on success */
  setNoCore(): number
  /** getrlimit(RLIMIT_CORE) → [soft, hard], or null */
  getCoreLimit(): [bigint, bigint] | null
  /** macOS: ptrace(PT_DENY_ATTACH, 0, 0, 0) → 0 on success */
  denyAttach?(): number
}

export type HardeningPlatform = 'linux' | 'darwin' | 'win32' | 'other'
/** What /proc/sys/kernel/yama/ptrace_scope said: its value, or `absent` (no Yama — the WSL kernel). */
export type YamaScope = '0' | '1' | '2' | '3' | 'absent' | 'unreadable'

export interface HardeningReport {
  /** `ok` = every step applied AND verified; `limited` = this OS offers no such step (stated); `failed`. */
  state: 'ok' | 'limited' | 'failed'
  /** non-dumpable (Linux) / deny-attach (macOS) verified; null where the OS has no such step. */
  private: boolean | null
  coreDumps: 'off' | 'on' | null
  yama: YamaScope | null
  /** Why `failed` (or what `limited` lacks), in plain words, no secret. */
  reason: string | null
}

/** PURE. Read what ptrace_scope says (the reader is injected). */
export function yamaScope(read: () => string | null): YamaScope {
  let v: string | null
  try { v = read() } catch { return 'unreadable' }
  if (v === null) return 'absent'
  const t = v.trim()
  return t === '0' || t === '1' || t === '2' || t === '3' ? t : 'unreadable'
}

/** PURE over `libc`. Apply and VERIFY each step; the first one that does not hold fails the whole. */
export function applyHardening(platform: HardeningPlatform, libc: Libc | { error: string }, readYama: () => string | null): HardeningReport {
  if (platform === 'win32' || platform === 'other') {
    return { state: 'limited', private: null, coreDumps: null, yama: null, reason: platform === 'win32' ? 'windows-same-user' : 'unsupported-platform' }
  }
  if ('error' in libc) return { state: 'failed', private: false, coreDumps: null, yama: null, reason: `the C library could not be reached (${libc.error})` }
  const yama = platform === 'linux' ? yamaScope(readYama) : null
  const fail = (reason: string, priv: boolean, core: 'off' | 'on' | null): HardeningReport => ({ state: 'failed', private: priv, coreDumps: core, yama, reason })

  // Core dumps first: a process that is about to become private must not be able to dump either way.
  let rc: number
  try { rc = libc.setNoCore() } catch { rc = -1 }
  if (rc !== 0) return fail('setrlimit(RLIMIT_CORE, 0) was refused', false, 'on')
  const lim = (() => { try { return libc.getCoreLimit() } catch { return null } })()
  if (!lim || lim[0] !== 0n || lim[1] !== 0n) return fail('the core-dump limit did not read back as 0', false, 'on')

  if (platform === 'linux') {
    try { rc = libc.setNotDumpable() } catch { rc = -1 }
    if (rc !== 0) return fail('prctl(PR_SET_DUMPABLE, 0) was refused', false, 'off')
    let d: number
    try { d = libc.getDumpable() } catch { d = -1 }
    if (d !== 0) return fail('the process still reads as dumpable after prctl', false, 'off')
    return { state: 'ok', private: true, coreDumps: 'off', yama, reason: null }
  }
  // darwin
  try { rc = libc.denyAttach ? libc.denyAttach() : -1 } catch { rc = -1 }
  if (rc !== 0) return fail('ptrace(PT_DENY_ATTACH) was refused', false, 'off')
  return { state: 'ok', private: true, coreDumps: 'off', yama: null, reason: null }
}

const PR_GET_DUMPABLE = 3
const PR_SET_DUMPABLE = 4
const RLIMIT_CORE = 4
const PT_DENY_ATTACH = 31

/** The `bun:ffi` edge. Never throws: a library that will not load is `{error}`. */
export async function loadLibc(platform: HardeningPlatform): Promise<Libc | { error: string }> {
  if (platform !== 'linux' && platform !== 'darwin') return { error: 'no C library step on this platform' }
  try {
    const { dlopen, FFIType, ptr } = await import('bun:ffi')
    const name = platform === 'linux' ? 'libc.so.6' : '/usr/lib/libSystem.B.dylib'
    const lib = dlopen(name, {
      prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
      setrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      getrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      ...(platform === 'darwin' ? { ptrace: { args: [FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 } } : {}),
    } as const)
    const s = lib.symbols as unknown as Record<string, (...a: unknown[]) => number>
    return {
      setNotDumpable: () => s.prctl!(PR_SET_DUMPABLE, 0n, 0n, 0n, 0n),
      getDumpable: () => s.prctl!(PR_GET_DUMPABLE, 0n, 0n, 0n, 0n),
      setNoCore: () => {
        // struct rlimit { rlim_t cur; rlim_t max } — two 64-bit counts on every 64-bit Linux/macOS.
        const r = new BigUint64Array([0n, 0n])
        return s.setrlimit!(RLIMIT_CORE, ptr(r))
      },
      getCoreLimit: () => {
        const r = new BigUint64Array([1n, 1n])
        return s.getrlimit!(RLIMIT_CORE, ptr(r)) === 0 ? [r[0]!, r[1]!] : null
      },
      ...(platform === 'darwin' ? { denyAttach: () => s.ptrace!(PT_DENY_ATTACH, 0, null, 0) } : {}),
    }
  } catch (err) {
    return { error: (err as Error)?.message?.split('\n')[0]?.slice(0, 120) ?? 'dlopen failed' }
  }
}

export function readYamaFile(): string | null {
  try { return readFileSync('/proc/sys/kernel/yama/ptrace_scope', 'utf8') } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw err
  }
}

/**
 * PURE. What the service log (and `agentop vault status`) says about hardening, EN/PT. Silent when
 * everything held and Yama is on; the absent-Yama line is said because it is the WSL reality and the
 * reason non-dumpable carries the weight (§5.3).
 */
export function hardeningLines(h: HardeningReport, lang: 'en' | 'pt'): string[] {
  const pt = lang === 'pt'
  if (h.state === 'failed') return [] // the vault's own `hardening-failed` sentence says it where it matters
  if (h.state === 'limited') {
    return [h.reason === 'windows-same-user'
      ? (pt ? 'Windows: outro programa rodando como você pode ler a memória do serviço enquanto o cofre está aberto (o Windows não tem um equivalente por processo); a presença mantém a chave fora da memória enquanto trancado.'
        : 'Windows: another program running as you can read the service\'s memory while the vault is open (Windows has no per-process equivalent); presence keeps the key out of memory while it is locked.')
      : (pt ? 'Nesta plataforma o Agentistics não consegue tornar a própria memória privada.' : 'On this platform Agentistics cannot make its own memory private.')]
  }
  if (h.yama === 'absent' || h.yama === '0') {
    return [pt ? `A proteção de ptrace do Yama está ${h.yama === 'absent' ? 'ausente neste kernel' : 'desligada'}; o Agentistics se apoia em ser não-despejável (memória privada, sem core dumps).`
      : `Yama ptrace protection is ${h.yama === 'absent' ? 'absent on this kernel' : 'off'}; Agentistics relies on being non-dumpable (private memory, no core dumps).`]
  }
  return []
}
