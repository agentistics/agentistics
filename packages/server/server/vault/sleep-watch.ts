/**
 * vault/sleep-watch.ts — lock the human scope when the machine goes to sleep or the screen locks
 * (SECRETS.4 §5.1). BEST-EFFORT, and stated as such:
 *
 *  - Linux with a system bus: logind's `PrepareForSleep(true)` and a session's `Lock` signal, read
 *    from `gdbus monitor --system --dest org.freedesktop.login1` (an OS tool, no addon). WSL usually
 *    has no logind; the watcher then simply does not start, and `status` says so.
 *  - Windows host (VAULT.UI2, owner 2026-10-04): from WSL a `powershell.exe` child subscribes to
 *    `SystemEvents.SessionSwitch` (Win+L, user switch, logoff, remote disconnect) and
 *    `PowerModeChanged` (suspend). WHAT IT CANNOT SEE, said plainly: a lock with no `powershell.exe`
 *    reachable (interop disabled), and a suspend that happens while WSL itself is frozen — the event is
 *    then handled on resume, which `Date` jumps reveal to the idle auto-lock (30 min) as the backstop.
 *  - macOS (NSWorkspaceWillSleep) is NOT wired yet — the presence helpers own that channel.
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

/** PURE. One line of the Windows watcher's output → what to lock for. The script prints exactly these words. */
export function windowsLockSignal(line: string): 'sleep' | 'screen-lock' | null {
  const w = line.trim()
  if (w === 'SUSPEND') return 'sleep'
  if (w === 'LOCK' || w === 'LOGOFF' || w === 'REMOTE-DISCONNECT' || w === 'USER-SWITCH') return 'screen-lock'
  return null
}

/** The PowerShell the watcher runs: SessionSwitch + PowerModeChanged → one word per line. */
export const WINDOWS_WATCH_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  "Register-ObjectEvent ([Microsoft.Win32.SystemEvents]) SessionSwitch -Action { $r = $Event.SourceEventArgs.Reason.ToString(); $m = @{SessionLock='LOCK';SessionLogoff='LOGOFF';RemoteDisconnect='REMOTE-DISCONNECT';ConsoleDisconnect='USER-SWITCH'}[$r]; if ($m) { [Console]::Out.WriteLine($m); [Console]::Out.Flush() } } | Out-Null",
  "Register-ObjectEvent ([Microsoft.Win32.SystemEvents]) PowerModeChanged -Action { if ($Event.SourceEventArgs.Mode.ToString() -eq 'Suspend') { [Console]::Out.WriteLine('SUSPEND'); [Console]::Out.Flush() } } | Out-Null",
  "[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()",
  'while ($true) { Wait-Event -Timeout 3600 | Out-Null }',
].join('; ')

function isWsl(): boolean {
  try { return /microsoft/i.test(require('node:fs').readFileSync('/proc/version', 'utf8')) } catch { return false }
}
const POWERSHELL = ['/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe']

export type SleepWatch = { state: 'watching' } | { state: 'unavailable'; reason: string }

let _proc: { kill(): void } | null = null
let _winProc: { kill(): void } | null = null

/** Start once; never throws. `onLock` is called for each sleep / screen-lock signal. */
export function startSleepWatch(onLock: (why: 'sleep' | 'screen-lock') => void): SleepWatch {
  const win = startWindowsWatch(onLock)
  const lin = startLinuxWatch(onLock)
  return lin.state === 'watching' ? lin : win.state === 'watching' ? win : lin
}

function startWindowsWatch(onLock: (why: 'sleep' | 'screen-lock') => void): SleepWatch {
  if (_winProc) return { state: 'watching' }
  if (process.platform !== 'linux' || !isWsl()) return { state: 'unavailable', reason: 'not a Windows host' }
  const ps = POWERSHELL.find(p => existsSync(p))
  if (!ps) return { state: 'unavailable', reason: 'powershell.exe is not reachable from WSL' }
  try {
    const p = Bun.spawn([ps, '-NoProfile', '-NonInteractive', '-Command', WINDOWS_WATCH_SCRIPT], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
    p.unref()
    _winProc = p
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
            const why = windowsLockSignal(buf.slice(0, nl))
            buf = buf.slice(nl + 1)
            if (why) { try { onLock(why) } catch { /* never throws the watcher out */ } }
          }
        }
      } catch { /* the child went away */ }
      _winProc = null
    })()
    return { state: 'watching' }
  } catch {
    return { state: 'unavailable', reason: 'powershell.exe could not be started' }
  }
}

function startLinuxWatch(onLock: (why: 'sleep' | 'screen-lock') => void): SleepWatch {
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

export function stopSleepWatch(): void { try { _proc?.kill() } catch { /* gone */ } _proc = null; try { _winProc?.kill() } catch { /* gone */ } _winProc = null }
