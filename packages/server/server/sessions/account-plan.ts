/** PURE (multi-account) — kept import-light because cli-start.ts reads it on every spawn. */

/**
 * PURE. Applies an account to a planned spawn: the root's env always; for a login session the plan is
 * replaced by the login command alone (no agentistics context, no prompt, no conversation id — the
 * person is signing in, not talking). Mutates and returns `plan`.
 */
export function applyAccountToPlan<P extends { argv: string[]; env?: Record<string, string> }>(
  plan: P, account: { env: Record<string, string>; loginArgv?: string[] },
): P {
  const target = plan as P & Record<string, unknown>
  target.env = { ...(plan.env ?? {}), ...account.env }
  if (account.loginArgv) {
    target.argv = [...account.loginArgv]
    for (const k of ['contextFile', 'contextExtraFiles', 'contextVia', 'initialPrompt', 'conversationId', 'modeNeedsProtocol']) delete target[k]
  }
  return plan
}
