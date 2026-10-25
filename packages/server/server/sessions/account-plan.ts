import type { HarnessId } from '@agentistics/core'
import { ISOLATION_ENV } from '../account-isolation'

/** PURE (multi-account) — kept import-light because cli-start.ts reads it on every spawn. */

/**
 * PURE. Applies an account to a planned spawn: the root's env always; for a login session the plan is
 * replaced by the login command alone (no agentistics context, no prompt, no conversation id — the
 * person is signing in, not talking). Mutates and returns `plan`.
 */
export function applyAccountToPlan<P extends { argv: string[]; env?: Record<string, string>; unsetEnv?: string[] }>(
  plan: P, account: { env: Record<string, string>; loginArgv?: string[] },
): P {
  const target = plan as P & Record<string, unknown>
  target.env = { ...(plan.env ?? {}), ...account.env }
  if (plan.unsetEnv) {
    const remaining = plan.unsetEnv.filter(key => !(key in account.env))
    if (remaining.length) plan.unsetEnv = remaining
    else delete plan.unsetEnv
  }
  if (account.loginArgv) {
    target.argv = [...account.loginArgv]
    for (const k of ['contextFile', 'contextExtraFiles', 'contextVia', 'initialPrompt', 'conversationId', 'modeNeedsProtocol']) delete target[k]
  }
  return plan
}

/** Carry only account isolation when a structured session continues in a terminal. */
export function resumeAccountEnvironment(
  plan: { env?: Record<string, string> },
  source: { env?: Record<string, string>; unsetEnv?: readonly string[] },
  harness: HarnessId,
): { env?: Record<string, string>; unsetEnv?: string[] } {
  const isolation = ISOLATION_ENV[harness]
  const root = isolation ? source.env?.[isolation] : undefined
  const env = { ...(plan.env ?? {}), ...(isolation && root ? { [isolation]: root } : {}) }
  return {
    ...(Object.keys(env).length ? { env } : {}),
    ...(isolation && source.unsetEnv?.includes(isolation) ? { unsetEnv: [isolation] } : {}),
  }
}
