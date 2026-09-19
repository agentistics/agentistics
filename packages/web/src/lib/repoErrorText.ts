/**
 * repoErrorText.ts — PURE. What a repository-explorer failure SAYS, in the reader's language.
 *
 * `repoApi.ts` is deliberately wordless: it carries the server's own already-localized `message`
 * through untouched and never invents one. That leaves exactly two kinds of failure with nothing to
 * show a reader, and this module is the ONE place either is turned into a sentence — the same split
 * `shellBand.ts` already makes for the utility shell, mirrored here on purpose:
 *
 *  - **The PRE-HANDLER GATES.** `index.ts` refuses `/api/fleet/tree*` before `editor-web.ts` can
 *    compose anything, answering `{error: 'editor_disabled'}` (the switch is off) or
 *    `{error: 'fleet_central'}` (a central hosts no sessions of its own). Both carry a CODE and no
 *    prose, so the UI owns the wording. `fleet_central` is covered as well as `editor_disabled`
 *    because the fleet prefix is refused a few lines EARLIER than the editor gate — a central hits
 *    that one first, and a reader there must not be told their switch is off.
 *  - **`unreachable`.** Nothing came back that honours the contract, so there is no server sentence
 *    to show at all. The three causes stay three sentences: "nothing answered", "it is answering,
 *    just not in time" and "something answered and it was not this" send a reader somewhere
 *    different.
 *
 * Everything else — every refusal `editor-web.ts` itself decided — is shown VERBATIM. Re-wording a
 * sentence the server already wrote in the reader's language would be a second source for one fact,
 * and the two would drift.
 *
 * AN UNKNOWN CODE IS SHOWN AS ITSELF, exactly as `shellErrorText` does: a reason nobody can read
 * still beats a blank box, which is the confident-nothing this codebase refuses everywhere.
 */

import type { RepoFailure, RepoLang, RepoUnreachable } from './repoApi'

/** The route-level gates. They carry a code and no sentence, so the sentence is ours. */
const GATE_TEXT: Record<string, { en: string; pt: string }> = {
  // "Studio" and not "repository explorer": this sentence NAMES the screen that turns the feature
  // on, and that screen's own section is called Agentistics Studio. A refusal that sends a reader
  // to Settings → Sessions to look for something that is not written there is a dead end with a
  // direction on it.
  editor_disabled: {
    en: 'The Studio is off on this machine. Turn it on in Settings → Sessions.',
    pt: 'O Studio está desligado nesta máquina. Ligue em Configurações → Sessões.',
  },
  fleet_central: {
    en: 'A central aggregates other machines and hosts none of their sessions, so there is no repository here to open.',
    pt: 'Uma central agrega outras máquinas e não hospeda as sessões delas, então não há repositório aqui para abrir.',
  },
}

const UNREACHABLE_TEXT: Record<RepoUnreachable['cause'], { en: string; pt: string }> = {
  network: {
    en: 'The server did not answer.',
    pt: 'O servidor não respondeu.',
  },
  timeout: {
    en: 'The server is taking too long to answer. It may still be reading this directory.',
    pt: 'O servidor está demorando demais para responder. Talvez ainda esteja lendo este diretório.',
  },
  malformed: {
    en: 'The server answered something this dashboard could not read.',
    pt: 'O servidor respondeu algo que este painel não conseguiu ler.',
  },
}

/**
 * One failure, one sentence.
 *
 * The server's own `message` wins whenever there is one: it was worded by the module that decided
 * the refusal, in the language this request carried, and it names the actual path or limit involved.
 */
export function repoFailureText(failure: RepoFailure, lang: RepoLang): string {
  if (failure.failure === 'unreachable') return UNREACHABLE_TEXT[failure.cause][lang]
  if (typeof failure.message === 'string' && failure.message !== '') return failure.message
  const gate = GATE_TEXT[failure.reason]
  return gate ? gate[lang] : failure.reason
}
