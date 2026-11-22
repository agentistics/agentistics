/**
 * errors.ts — client-safe error rendering.
 *
 * OWASP A10 (Mishandling of Exceptional Conditions): an internal message tells an attacker the
 * filesystem layout, the database topology, and which code path they reached. The client gets a
 * generic code plus a random correlation ref; the operator greps the log for that ref.
 *
 * Verbose mode echoes the real message and is only for the `local` exposure profile.
 */
import { randomBytes } from 'node:crypto'

export function safeError(
  err: unknown,
  opts: { verbose: boolean },
): { status?: number; body: { error: string; ref: string; code?: string; sentence?: string; sentencePt?: string }; logLine: string } {
  const message = err instanceof Error ? err.message : String(err)
  const ref = randomBytes(6).toString('hex')
  // Keep the error renderer independent of file-lock/writer capabilities. GuardBusy's stable wire identity is enough.
  if (err instanceof Error && 'code' in err && err.code === 'guard_busy' && 'status' in err && err.status === 409) return {
    status: 409,
    body: { error: 'guard_busy', code: 'guard_busy', ref, sentence: err.message, sentencePt: 'outro processo do agentop está escrevendo no quadro; tente de novo' },
    logLine: `[error ${ref}] ${message}`,
  }
  return {
    body: { error: opts.verbose ? message : 'internal_error', ref },
    logLine: `[error ${ref}] ${message}`,
  }
}
