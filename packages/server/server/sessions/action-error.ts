import type { CliLang } from '../cli-lang'

/** A failure whose message IS the answer (e.g. "a reopen is already in progress"): passed through, never hidden. */
export class SessionNotice extends Error {}

/** Keep internal failures in the diagnostics; every surface gets the same localized sentence. */
export function sessionActionError(lang: CliLang, action: string, id: string, error: unknown): { ok: false; message: string } {
  if (error instanceof SessionNotice) return { ok: false, message: error.message }
  console.error(`[sessions] ${action} failed for ${id}:`, error)
  const message = action === 'resume'
    ? lang === 'pt'
      ? 'Não foi possível reabrir esta sessão por uma falha interna. Tente novamente.'
      : 'Could not reopen this session because of an internal failure. Try again.'
    : lang === 'pt'
      ? 'Não foi possível concluir esta ação da sessão por uma falha interna. Tente novamente.'
      : 'Could not complete this session action because of an internal failure. Try again.'
  return { ok: false, message }
}
