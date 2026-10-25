import { isServerProcess } from './shared-snapshot'

/** Server diagnostics, once per key for the process lifetime. Keep only keys, never transcript
 * content. Evicting old keys would make a busy poller repeat the same warnings forever. */
export class RefusalLog {
  private readonly seen = new Set<string>()

  warn(key: string, message: string): void {
    // A CLI read must neither print nor consume the server's diagnostic.
    if (!isServerProcess() || this.seen.has(key)) return
    this.seen.add(key)
    console.warn(message)
  }

  /** Tests only. Production keeps the keys even after a session leaves. */
  clear(): void { this.seen.clear() }
}
