/**
 * delivery/cli-principal.ts — who `agentop flow …` is (ENTREGA.GARANTIDA §2.3, CLI adapter).
 *
 *   inside a session whose pane/relay is an ANCESTOR of this process  → `session` (process-tree proof)
 *   `--owner` on an interactive TTY, after the vault's fresh proof       → `owner / vault-credential`
 *   anything else (an exported AGENTOP_MANAGED_ID, a pipe, a script)    → `unattributed`
 *
 * The CLI never gets `legacy-browser`, never takes the owner from a flag VALUE and never from stdin that is a pipe.
 * The environment variable alone proves nothing (`callerHoldsIdentity` is forgeable): the tree does.
 */
import type { RequestPrincipal } from './principal'

export interface CliAuth {
  /** Is `id`'s pane/relay an ancestor of this process? */
  prove(id: string): Promise<boolean>
  /** The fresh vault proof for ONE move, asked at the terminal. true = proven. */
  stepUp(scope: { pieceKey: string; move: string }): Promise<boolean>
  /** stdin AND stdout are terminals. */
  interactive: boolean
}

export async function resolveCliPrincipal(
  env: Record<string, string | undefined>, ownerFlag: boolean, scope: { pieceKey: string; move: string }, auth: CliAuth,
): Promise<{ principal: RequestPrincipal; note?: string }> {
  const id = env.AGENTOP_MANAGED_ID
  if (id && await auth.prove(id).catch(() => false)) return { principal: { kind: 'session', id, via: 'process-tree' } }
  if (ownerFlag) {
    if (!auth.interactive) return { principal: { kind: 'unattributed' }, note: '--owner needs an interactive terminal (the vault password is typed, never piped)' }
    if (await auth.stepUp(scope).catch(() => false)) return { principal: { kind: 'owner', via: 'vault-credential', grantId: 'cli' } }
    return { principal: { kind: 'unattributed' }, note: 'the vault did not accept the proof' }
  }
  return { principal: { kind: 'unattributed' }, ...(id ? { note: 'AGENTOP_MANAGED_ID is set but this process is not running inside that session' } : {}) }
}

/** The real CLI wiring: the tmux backend's pane pids for the tree proof, the vault socket for the step-up. */
export async function realCliAuth(): Promise<CliAuth> {
  return {
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    async prove(id) {
      const [{ callerProof }, { resolveBackend }] = await Promise.all([import('../sessions/session-identity'), import('../sessions/index')])
      const backend = await resolveBackend()
      return (await callerProof(id, async () => (backend as { listPanePids?: () => Promise<Map<string, number>> }).listPanePids?.())) === 'proven'
    },
    async stepUp(scope) {
      const [{ askVault }, { maskedInput }] = await Promise.all([import('../vault/socket'), import('../cli-ui')])
      const ask = async (password?: string) => (await askVault({ op: 'delivery-owner', ...scope, ...(password ? { password } : {}) }, { timeoutMs: 180_000 }))?.reply ?? null
      let r = await ask()
      for (let i = 0; r && !r.ok && (r.code === 'password-required' || r.code === 'password-wrong') && i < 3; i++) {
        if (r.code !== 'password-required') process.stderr.write(String(r.sentence) + '\n')
        const pw = await maskedInput('Vault password / Senha do cofre')
        if (!pw) return false
        r = await ask(pw)
      }
      if (r && !r.ok) process.stderr.write(String(r.sentence) + '\n')
      return Boolean(r?.ok)
    },
  }
}
