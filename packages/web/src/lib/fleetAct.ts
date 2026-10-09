/**
 * fleetAct.ts — PURE: what a verb's answer means to the browser.
 *
 * `POST /api/fleet/act` answers `{ ok, message }` and, for a verb that CREATED something, the new
 * session's `id`. That id is not decoration: a reopen mints a new row and retires the one it was
 * asked about, so a caller that does not follow it leaves the reader on a dead session with a
 * success message over it.
 *
 * That is what happened. `FleetState['act']` DECLARED `id?: string` in its return and the
 * implementation built `{ ok, message }` — the id was dropped on the floor. TypeScript cannot catch
 * it: the property is optional, and an object that simply lacks an optional property is assignable.
 * The reopen worked every time, spawned the session, and the UI stood still — reported as "nao ta
 * sendo possivel reabrir pela ui sessoes que estao off". Measured: the server answered
 * `{"ok":true,"message":"started ACESSIBILIDADE VINI in the background.","id":"aeb12129c4"}` and the
 * URL never moved.
 *
 * So the parse is a FUNCTION with a test rather than an object literal inside a callback. The rule
 * it exists to hold: **every field the answer carries is carried on**, and a field is dropped only
 * where dropping it is written down.
 */

export interface FleetActResult {
  ok: boolean
  /** Already localized by the machine that ran the verb. Never composed here. */
  message: string
  /** The session a verb CREATED, when it created one. */
  id?: string
  /** EXT.OPEN: the write needs a YES first — `message` is the question. */
  confirm?: boolean
  failure?: 'prompt' | 'ended' | 'unconfirmed'
}

/** The sentence for an answer that carried none — a network error, or a body that is not ours. */
export function actFallbackMessage(lang: 'pt' | 'en'): string {
  return lang === 'pt' ? 'A ação não pôde ser executada.' : 'The action could not be run.'
}

/**
 * Read one `/api/fleet/act` answer.
 *
 * `json` is whatever came back, including `null` for a body that could not be parsed. The id is
 * kept only when it is a non-empty string: an `id` of `null` or `0` from some future version must
 * not become a route this app navigates to.
 */
export function parseActResult(json: unknown, lang: 'pt' | 'en'): FleetActResult {
  const o = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>
  const message = typeof o.message === 'string' && o.message !== ''
    ? o.message
    : actFallbackMessage(lang)
  const id = typeof o.id === 'string' && o.id.trim() !== '' ? o.id : undefined
  const failure = o.failure === 'prompt' || o.failure === 'ended' || o.failure === 'unconfirmed' ? o.failure : undefined
  return { ok: o.ok === true, message, ...(id ? { id } : {}), ...(o.confirm === true ? { confirm: true } : {}), ...(failure ? { failure } : {}) }
}

/**
 * A send that timed out is not a send that failed. Before the red sentence, look for the message in
 * the session's own conversation for a few seconds: if it is there, it went.
 */
export const SENT_CHECK_ATTEMPTS = 4
export const SENT_CHECK_INTERVAL_MS = 1_500

/** Does `text` appear among the user turns? Whitespace-normalised, so wrapping cannot hide it. */
export function textInUserTurns(
  turns: readonly { role?: string; text?: string }[],
  text: string,
): boolean {
  const norm = (v: string) => v.replace(/\s+/g, ' ').trim()
  const want = norm(text)
  if (!want) return false
  return turns.some(t => t.role === 'user' && typeof t.text === 'string' && norm(t.text).includes(want))
}

/**
 * Ask `check` up to `attempts` times, `intervalMs` apart; `true` as soon as the message is seen.
 * A throwing check counts as "not seen yet" — it must never turn into the answer.
 */
export async function confirmSendLanded(
  check: () => Promise<boolean>,
  opts: { attempts?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? SENT_CHECK_ATTEMPTS
  const wait = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await wait(opts.intervalMs ?? SENT_CHECK_INTERVAL_MS)
    try { if (await check()) return true } catch { /* not seen yet */ }
  }
  return false
}

/** Calm, accurate wording for a send nobody could confirm — the composer offers Retry beside it. */
export function sendUnconfirmedMessage(lang: 'pt' | 'en'): string {
  return lang === 'pt'
    ? 'Não consegui confirmar que a mensagem chegou. Use "Tentar de novo" se ela não aparecer na conversa.'
    : 'Could not confirm the message arrived. Use "Retry" if it does not show up in the conversation.'
}
