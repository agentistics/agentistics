import type { CliLang } from '../cli-lang'

/** A failure whose message IS the answer (e.g. "a reopen is already in progress"): passed through, never hidden. */
export class SessionNotice extends Error {
  /** `message` is English; `pt` is the same sentence for a Portuguese surface; `action` is what the surface can OFFER next. */
  constructor(message: string, readonly pt?: string, readonly action?: SessionNoticeAction) { super(message) }
}

/** What a notice can offer the person to do about it — data only; a surface turns it into a button it already has. */
export type SessionNoticeAction = { kind: 'update-harness'; harness: string; need: string }

/** Keep internal failures in the diagnostics; every surface gets the same localized sentence. */
export function sessionActionError(lang: CliLang, action: string, id: string, error: unknown): { ok: false; message: string; action?: SessionNoticeAction } {
  if (error instanceof SessionNotice) {
    return { ok: false, message: lang === 'pt' && error.pt ? error.pt : error.message, ...(error.action ? { action: error.action } : {}) }
  }
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
