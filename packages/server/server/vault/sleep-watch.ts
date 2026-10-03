/**
 * vault/sleep-watch.ts — lock the human scope when the machine goes to sleep or the screen locks
 * (SECRETS.4 §5.1). BEST-EFFORT, and stated as such:
 *
 *  - Linux with a system bus: logind's `PrepareForSleep(true)` and a session's `Lock` signal, read
 *    from `gdbus monitor --system --dest org.freedesktop.login1` (an OS tool, no addon). WSL usually
 *    has no logind; the watcher then simply does not start, and `status` says so.
 *  - macOS (NSWorkspaceWillSleep) and Windows/WSL (the WMI power event through the bridge) are NOT
 *    wired yet — the presence helpers own those channels (S4.3/S4.4).
 *
 * The idle auto-lock (30 min) does not depend on this: a missed sleep event costs at most that window.
 */
import { existsSync } from 'node:fs'

/** PURE. Is this `gdbus monitor` line a sleep, or a screen lock, worth locking the vault for? */
export function lockSignal(line: string): 'sleep' | 'screen-lock' | null {
  if (/org\.freedesktop\.login1\.Manager\.PrepareForSleep \(true,?\)/.test(line)) return 'sleep'
  if (/org\.freedesktop\.login1\.Session\.Lock \(\)/.test(line)) return 'screen-lock'
  return null
}

export type SleepWatch = { state: 'watching' } | { state: 'unavailable'; reason: string }

let _proc: { kill(): void } | null = null

/** Start once; never throws. `onLock` is called for each sleep / screen-lock signal. */
export function startSleepWatch(onLock: (why: 'sleep' | 'screen-lock') => void): SleepWatch {
  if (_proc) return { state: 'watching' }
  if (process.platform !== 'linux') return { state: 'unavailable', reason: 'not wired on this platform yet' }
  const gdbus = ['/usr/bin/gdbus', '/bin/gdbus'].find(p => existsSync(p))
  if (!gdbus) return { state: 'unavailable', reason: 'gdbus is not installed' }
  if (!existsSync('/run/dbus/system_bus_socket')) return { state: 'unavailable', reason: 'no system bus' }
  try {
    const p = Bun.spawn([gdbus, 'monitor', '--system', '--dest', 'org.freedesktop.login1'], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
    p.unref()
    _proc = p
    void (async () => {
      const dec = new TextDecoder()
      let buf = ''
      const reader = (p.stdout as ReadableStream<Uint8Array>).getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let nl: number
          while ((nl = buf.indexOf('\n')) !== -1) {
            const why = lockSignal(buf.slice(0, nl))
            buf = buf.slice(nl + 1)
            if (why) { try { onLock(why) } catch { /* the lock never throws the watcher out */ } }
          }
        }
      } catch { /* the monitor went away */ }
      _proc = null
    })()
    return { state: 'watching' }
  } catch {
    return { state: 'unavailable', reason: 'gdbus could not be started' }
  }
}

export function stopSleepWatch(): void { try { _proc?.kill() } catch { /* gone */ } _proc = null }
