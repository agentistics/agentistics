/**
 * exec-in-place.ts — replace THIS process with another program (`execve(2)`), Linux/macOS only.
 *
 * RES.1: a cockpit restarting onto an upgraded binary used to SPAWN the new one and wait for it, so
 * the old process — the one that had grown to 1.7 GB RSS + 6.5 GB swap — stayed alive as its parent
 * holding every byte. `execve` keeps the pid, the terminal and the process group (so the shell's job
 * control is undisturbed) and hands every page back to the kernel. Bun has no `exec`, so this goes
 * through libc with `bun:ffi`.
 *
 * Returns only on failure (`false`) — the caller then falls back to spawning. A successful call does
 * not return at all.
 */
import { existsSync } from 'node:fs'

function cString(s: string): Buffer {
  return Buffer.from(`${s}\0`, 'utf8')
}

export async function execInPlace(argv: string[], env: Record<string, string | undefined>): Promise<boolean> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return false
  if (!argv[0] || !existsSync(argv[0])) return false
  try {
    const { dlopen, FFIType, ptr } = await import('bun:ffi')
    const libc = process.platform === 'darwin' ? 'libc.dylib' : 'libc.so.6'
    const { symbols } = dlopen(libc, {
      execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    })
    // Every buffer is kept referenced in `keep` until the call, so nothing is collected under it.
    const keep: Buffer[] = []
    const table = (items: string[]): BigUint64Array => {
      const arr = new BigUint64Array(items.length + 1)
      items.forEach((item, i) => {
        const b = cString(item)
        keep.push(b)
        arr[i] = BigInt(ptr(b))
      })
      arr[items.length] = 0n
      return arr
    }
    const argvTable = table(argv)
    const envTable = table(Object.entries(env).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`))
    const path = cString(argv[0])
    keep.push(path)
    symbols.execve(ptr(path), ptr(argvTable), ptr(envTable))
    return false
  } catch {
    return false
  }
}
