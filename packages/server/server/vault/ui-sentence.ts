/**
 * vault/ui-sentence.ts — PURE. What a vault sentence says when it reaches a PAGE (v2.98.1).
 *
 * Owner rule: users never run commands. The vault's sentences are written once and shared by the
 * terminal (`agentop vault …`, where "run `agentop vault recover`" is the right answer) and the page,
 * where it is not — the page has a button for each of those things. So every reply `/api/vault*`
 * sends goes through `uiReply`: a refusal whose code has a page-specific wording is replaced whole,
 * and any other sentence has each command it names swapped for the page's own control, plus an
 * `action` the page turns into a button. The ONE command that survives is `agentop vault setup-code`:
 * it is the deliberate fallback for a first setup from outside this computer, or on a machine with no
 * Windows Hello or security key (docs/security.md §7b).
 */
export type UiLang = 'en' | 'pt'
export type UiAction = 'recover' | 'unlock' | 'enroll' | 'disable-presence'

const CONTROL: Record<UiAction, { pt: string; en: string }> = {
  recover: { pt: '“Recuperar com as 24 palavras”, nesta página', en: '"Recover with the 24 words", on this page' },
  unlock: { pt: '“Destrancar”, nesta página', en: '"Unlock", on this page' },
  enroll: { pt: 'a configuração nesta página', en: 'the setup on this page' },
  'disable-presence': { pt: '“Desligar a confirmação pessoal”, nesta página', en: '"Turn personal confirmation off", on this page' },
}

/** Refusals whose terminal wording does not survive a mechanical swap — said again, whole, for the page. */
const BY_CODE: Record<string, { pt: string; en: string; action?: UiAction }> = {
  'presence-needs-recovery-words': {
    pt: 'Ligar a confirmação pessoal troca a chave do cofre, e a chave de recuperação precisa acompanhar. Crie palavras de recuperação novas agora — as antigas deixam de funcionar. Nada foi alterado.',
    en: 'Turning personal confirmation on replaces the vault key, and the recovery key has to follow it. Make new recovery words now — your old words will stop working. Nothing was changed.',
  },
  'recovery-tty-only': {
    pt: 'O cofre está em modo de recuperação. Termine a configuração nesta página, no próprio computador, na mesma janela em que digitou as 24 palavras.',
    en: 'The vault is in recovery mode. Finish the setup on this page, on this computer, in the same window where you typed the 24 words.',
    action: 'recover',
  },
  'recovery-required': {
    pt: 'Esta é a máquina principal: desligar a confirmação pessoal exige as suas 24 palavras. Digite-as nesta página, no próprio computador.',
    en: 'This is the main machine: turning personal confirmation off needs your 24 words. Type them on this page, on this computer.',
    action: 'disable-presence',
  },
  'reset-needs-unlock': {
    pt: 'O cofre está trancado. Destranque-o primeiro nesta página: apagar o cofre pede o seu código e a confirmação pessoal.',
    en: 'The vault is locked. Unlock it first on this page: resetting it asks for your code and your personal confirmation.',
    action: 'unlock',
  },
  'no-pending-unlock': {
    pt: 'Nenhum desbloqueio está esperando um código (passaram-se 120 segundos?). Use “Destrancar” de novo.',
    en: 'No unlock is waiting for a code (did 120 seconds pass?). Use "Unlock" again.',
    action: 'unlock',
  },
  'needs-authenticator': {
    pt: 'Configure o autenticador antes da confirmação pessoal — a configuração nesta página faz os dois, na ordem certa.',
    en: 'Set up the authenticator before personal confirmation — the setup on this page does both, in the right order.',
    action: 'enroll',
  },
}

/** The verb before a command, and the "with your 24 words" after `recover`, go with it. */
const SWAPS: { re: RegExp; action: UiAction }[] = [
  { re: /(\b[Rr]ode |\b[Rr]un )?`agentop vault recover`( com suas 24 palavras| with your 24 words)?/g, action: 'recover' },
  { re: /(\b[Rr]ode |\b[Rr]un )?`agentop vault unlock`/g, action: 'unlock' },
  { re: /(\b[Rr]ode |\b[Rr]un )?`agentop vault enroll[^`]*`/g, action: 'enroll' },
  { re: /(\b[Rr]ode |\b[Rr]un )?`agentop vault disable-presence`/g, action: 'disable-presence' },
]

/** Any `agentop …` command still in a sentence after the swaps (setup-code is the deliberate exception). */
export const COMMAND_RE = /`agentop (?!vault setup-code)[^`]*`/

export function uiSentence(sentence: string, lang: UiLang, code?: string): { sentence: string; action?: UiAction } {
  const whole = code ? BY_CODE[code] : undefined
  if (whole) return { sentence: whole[lang], ...(whole.action ? { action: whole.action } : {}) }
  let action: UiAction | undefined
  let out = sentence
  for (const s of SWAPS) {
    out = out.replace(s.re, (_m, verb: string | undefined) => {
      action ??= s.action
      const ctl = CONTROL[s.action][lang]
      if (!verb) return ctl
      return `${verb[0] === verb[0]!.toUpperCase() ? 'Use' : 'use'} ${ctl}`
    })
  }
  // Terminal words left orphaned by the swap ("type them in a terminal (…)") never reach the page.
  out = out.replace(/ (num|em um) terminal( desta máquina| nesta máquina)?/g, '').replace(/ (in|on) a terminal( on this machine)?/g, '')
  return { sentence: out, ...(action ? { action } : {}) }
}

/**
 * Every JSON body `/api/vault*` sends goes through here: each `sentence` / `error` string, at the top
 * level and one level down (the locked view's `view.sentence`), is made page-safe, and the first
 * `action` found is set on the body so the page can draw its button.
 */
export function uiReply(body: Record<string, unknown>, lang: UiLang): Record<string, unknown> {
  let action: UiAction | undefined
  const fix = (o: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...o }
    for (const k of ['sentence', 'error'] as const) {
      if (typeof out[k] === 'string') {
        const u = uiSentence(out[k] as string, lang, typeof out.code === 'string' ? out.code : undefined)
        out[k] = u.sentence
        action ??= u.action
      }
    }
    return out
  }
  const top = fix(body)
  for (const [k, v] of Object.entries(top)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) top[k] = fix(v as Record<string, unknown>)
  }
  if (action && top.action === undefined) top.action = action
  return top
}
