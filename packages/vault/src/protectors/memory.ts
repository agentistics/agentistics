/**
 * memory.ts — a protector that keeps the wrapped key in THIS PROCESS's memory only.
 *
 * It exists for one reason: a test run must exercise every write path (preferences tokens, the
 * GitHub config, the envelope key) through a real vault without spawning `powershell.exe` or
 * touching a real keychain. The host selects it ONLY under `bun test` (`NODE_ENV=test`, the same
 * signal `data-dir.ts` uses to send the whole data dir to a temporary directory), and never offers it
 * to a user. Anything sealed under it is unreadable by the next process — which is the point.
 */
import type { Lang } from '../sentences'
import type { ProbeResult, Protector, UnwrapResult } from './types'

const store = new Map<string, Uint8Array>()

export function memoryProtector(): Protector {
  return {
    id: 'memory',
    label: (lang: Lang) => lang === 'pt' ? 'a memória deste processo de teste' : 'this test process\'s memory',
    async probe(): Promise<ProbeResult> { return { ok: true } },
    async wrap(dek, kid) {
      store.set(kid, new Uint8Array(dek))
      return { ok: true, record: { type: 'memory', createdAt: new Date().toISOString() } }
    },
    async unwrap(_r, kid): Promise<UnwrapResult> {
      const d = store.get(kid)
      return d ? { ok: true, dek: new Uint8Array(d) } : { ok: false, kind: 'missing', reason: 'the key was held by another process' }
    },
    async remove(_r, kid) { store.delete(kid) },
  }
}

/** Test-only: forget ONE vault's key (simulates the protector losing it). Never all of them: test
 *  files share this process, and another file's vault must keep opening. */
export function __forgetMemoryKey(kid: string): void {
  store.delete(kid)
}
