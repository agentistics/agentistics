/**
 * accountSwitchNotice.ts — PURE. The words an automatic account switch may show a person, shared by the server (which
 * writes the notice) and the dashboard (which re-renders it in the viewer's language).
 *
 * Two rules, both from QA: an id is never shown (a session or account nobody named is said in words), and the reason a
 * switch failed is never passed through. The raw text (paths, "spawn claude ENOENT", a CLI's stderr) goes to the server
 * log and the episode ledger; the notice gets one of the closed sentences below.
 */
import { HARNESS_LABELS } from './types'

type Lang = 'en' | 'pt'

export type SwitchFailureKind =
  | 'harness_missing' | 'login' | 'account_off' | 'account_gone' | 'accounts_disabled' | 'no_conversation'
  | 'unsupported' | 'same_account' | 'session_gone' | 'could_not_end' | 'copy' | 'start_failed' | 'storage' | 'unknown'

/** What became of the session: closed and not given back, running again on the previous account, or nothing to claim. */
export type SwitchOutcome = 'ended' | 'kept' | 'unsaid'

const SENTENCES: Record<SwitchFailureKind, Record<Lang, string>> = {
  harness_missing: { pt: 'O assistente não está instalado ou não foi encontrado nesta máquina.', en: 'The assistant is not installed or could not be found on this machine.' },
  login: { pt: 'O login da conta de destino expirou ou foi recusado: entre nela de novo.', en: 'The login of the target account expired or was refused: sign in to it again.' },
  account_off: { pt: 'A conta de destino está desligada para agentes.', en: 'The target account is off for agents.' },
  account_gone: { pt: 'A conta de destino não está mais registrada.', en: 'The target account is no longer registered.' },
  accounts_disabled: { pt: 'Várias contas não estão ativadas nesta máquina.', en: 'Multiple accounts are not enabled on this machine.' },
  no_conversation: { pt: 'A conversa desta sessão não foi encontrada para ser levada à outra conta.', en: "This session's conversation was not found, so it could not be carried to the other account." },
  unsupported: { pt: 'Este assistente não permite trocar de conta no meio da sessão.', en: 'This assistant does not allow switching accounts mid-session.' },
  same_account: { pt: 'A sessão já está na conta de destino.', en: 'The session is already on the target account.' },
  session_gone: { pt: 'A sessão não está mais disponível nesta máquina.', en: 'The session is no longer available on this machine.' },
  could_not_end: { pt: 'Não foi possível encerrar a sessão para trocar de conta. Nada mudou.', en: 'The session could not be ended to switch accounts. Nothing changed.' },
  copy: { pt: 'Não foi possível copiar a conversa para a outra conta.', en: 'The conversation could not be copied to the other account.' },
  start_failed: { pt: 'A sessão não conseguiu iniciar na outra conta (os detalhes estão no log do servidor).', en: 'The session could not start on the other account (details are in the server log).' },
  storage: { pt: 'Não foi possível ler ou gravar os dados do agentistics (os detalhes estão no log do servidor).', en: 'The agentistics data could not be read or written (details are in the server log).' },
  unknown: { pt: 'Não deu para concluir a troca (os detalhes estão no log do servidor).', en: 'The switch could not be completed (details are in the server log).' },
}

/** Refusal codes of the switch (`SwitchRefusal`): exact, so they win over reading the sentence. */
const BY_CODE: Record<string, SwitchFailureKind> = {
  accounts_disabled: 'accounts_disabled', unknown_account: 'account_gone', account_retired: 'account_gone',
  account_unavailable: 'account_off', account_signed_out: 'login', harness_unavailable: 'harness_missing',
  no_transcript: 'no_conversation', no_conversation: 'no_conversation', switch_unsupported: 'unsupported',
  same_account: 'same_account', no_target: 'session_gone', not_running_here: 'session_gone',
}

/** Ordered: a start failure whose stderr names a missing binary or a refused login is that, not "did not start". */
const BY_TEXT: ReadonlyArray<readonly [RegExp, SwitchFailureKind]> = [
  [/command not found|spawn \S+ ENOENT|not on the server's PATH|not installed|não está instalado/i, 'harness_missing'],
  [/\blog ?in\b|\/login|logged out|signed out|expired|expirad|unauthorized|\b401\b|authenticat|credential/i, 'login'],
  [/could not be ended|não foi possível encerrar/i, 'could_not_end'],
  [/could not be copied|não foi possível copiar/i, 'copy'],
  [/exited as soon|terminou assim que|did not start|não iniciou|could not start/i, 'start_failed'],
  [/\b(ENOENT|EACCES|EPERM|EIO|EROFS|ENOSPC|EMFILE)\b|JSON|unreadable|corrupt/i, 'storage'],
]

export function switchFailureKind(o: { code?: string; message?: string }): SwitchFailureKind {
  const coded = o.code ? BY_CODE[o.code] : undefined
  if (coded) return coded
  const m = o.message ?? ''
  return BY_TEXT.find(([re]) => re.test(m))?.[1] ?? 'unknown'
}

/** The whole reason sentence; only a session that really was ended is ever told to be reopened. */
export function switchFailureSentence(lang: Lang, kind: string | undefined, outcome: string | undefined): string {
  const why = (SENTENCES[kind as SwitchFailureKind] ?? SENTENCES.unknown)[lang]
  if (outcome === 'ended') {
    return `${why} ${lang === 'pt' ? 'A sessão foi encerrada; a conversa está guardada: use Reabrir.' : 'The session was ended; the conversation is kept: use Reopen.'}`
  }
  if (outcome === 'kept') return `${why} ${lang === 'pt' ? 'Ela continua na conta de antes.' : 'It carries on with its previous account.'}`
  return why
}

/** The subject of a notice. `name` is what the person (or the harness) called the session; empty when nobody did. */
export function noticeSubject(lang: Lang, name: string | undefined, harness?: string): string {
  const n = name?.trim()
  if (n) return lang === 'pt' ? `A sessão ${n}` : `Session ${n}`
  const h = harness ? (HARNESS_LABELS as Record<string, string | undefined>)[harness] : undefined
  if (!h) return lang === 'pt' ? 'Uma sessão' : 'A session'
  return lang === 'pt' ? `Uma sessão do ${h}` : `A ${h} session`
}

/** An account nobody named. */
export const accountName = (lang: Lang, name: string | undefined): string => name?.trim() || (lang === 'pt' ? '(sem nome)' : '(unnamed)')
