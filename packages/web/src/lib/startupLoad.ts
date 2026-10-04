/**
 * startupLoad.ts — the rules for the app's FIRST load, kept pure so they can be tested.
 *
 * The app used to show its boot screen until the server's whole first build finished — tens of
 * seconds on a real machine, on a fresh install and on every restart — and when the server could not
 * be reached (a phone whose computer is asleep, a server that is down) the screen could spin forever,
 * because nothing bounded the requests it was waiting on.
 *
 * Now:
 *   - the app asks for `/api/data?partial=1`, which answers within about a second with whatever the
 *     server has (`partial: true` when its first build is still running), paints it, and keeps
 *     asking — `partialPollMs` — until a full answer arrives;
 *   - every request the boot waits on has a deadline (`fetchWithTimeout`);
 *   - a failure is CLASSIFIED (`classifyLoadError`) so the screen can say what happened in plain
 *     words — "can't reach the server" and "the server had a problem" send a person to different
 *     places — and the load retries on its own (`retryDelayMs`);
 *   - while the boot screen is up, `bootWatchdog` decides when to say "taking longer than usual"
 *     and when to stop waiting and say the server is not answering.
 */

export type LoadErrorKind =
  /** Nothing answered: the server is down, the computer is off, or the network is in between. */
  | 'unreachable'
  /** Something answered the connection but not the request within the deadline. */
  | 'timeout'
  /** The server answered with an error status. */
  | 'server'
  /** The server answered 200 with something that is not this app's data (a proxy page, a captive
   *  portal, a server of a different kind). */
  | 'incompatible'

export interface LoadError { kind: LoadErrorKind; status?: number; detail: string }

/** A thrown fetch/parse error, or an HTTP status, as one of the kinds above. */
export function classifyLoadError(err: unknown, status?: number): LoadError {
  // 502/503/504 come from something IN FRONT of the server (a reverse proxy, `tailscale serve`, the
  // dev proxy) saying it could not reach it — for the person that is "unreachable", not "broken".
  if (status === 502 || status === 503 || status === 504) return { kind: 'unreachable', status, detail: `HTTP ${status}` }
  if (status !== undefined) return { kind: 'server', status, detail: `HTTP ${status}` }
  const name = (err as { name?: string } | null)?.name
  const msg = String((err as { message?: string } | null)?.message ?? err)
  if (name === 'AbortError' || name === 'TimeoutError' || /timed? ?out/i.test(msg)) return { kind: 'timeout', detail: msg }
  if (name === 'SyntaxError' || /not this app's data/.test(msg)) return { kind: 'incompatible', detail: msg }
  // A `fetch` that never reached a server throws a TypeError ("Failed to fetch", "Load failed",
  // "NetworkError when attempting to fetch resource") — the browser does not say more.
  return { kind: 'unreachable', detail: msg }
}

/** How long to wait before asking again for a payload that came back `partial`. Starts fast (the
 *  full build is often a few seconds away) and settles at five seconds. */
export function partialPollMs(attempt: number): number {
  return Math.min(5000, 1000 + attempt * 500)
}

/** How long to wait before retrying a failed first load: 2 s, 4 s, 8 s, then every 15 s. */
export function retryDelayMs(attempt: number): number {
  return Math.min(15_000, 2000 * 2 ** Math.max(0, attempt))
}

/** Deadlines. The first data answer is normally under a second; a server that has not answered in
 *  20 s is reported rather than waited for. */
export const DATA_TIMEOUT_MS = 20_000
export const SMALL_TIMEOUT_MS = 10_000

/** `fetch` with a deadline. AbortController rather than `AbortSignal.timeout`, which older Safari
 *  (the phone case) does not have. */
export async function fetchWithTimeout(url: string, ms: number, init: RequestInit = {}): Promise<Response> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctl.signal })
  } finally {
    clearTimeout(t)
  }
}

export type BootVerdict = 'loading' | 'slow' | 'unreachable'

/**
 * What the boot screen should say, given how long it has been up and what the last `/api/health`
 * probe found. `health` is 'unknown' until a probe has answered or failed.
 *   - under SLOW_AFTER_MS: plain loading;
 *   - the server answers its health check: it is up and working — "slow", never "broken";
 *   - it does not: after UNREACHABLE_AFTER_MS, unreachable (the probe itself has a deadline, so a
 *     request that hangs forever still ends here).
 */
export const SLOW_AFTER_MS = 5000
export const UNREACHABLE_AFTER_MS = 8000
export function bootWatchdog(elapsedMs: number, health: 'ok' | 'down' | 'unknown'): BootVerdict {
  if (health === 'down' && elapsedMs >= UNREACHABLE_AFTER_MS) return 'unreachable'
  if (elapsedMs >= SLOW_AFTER_MS) return 'slow'
  return 'loading'
}

export interface StartupStripState {
  partial: boolean
  partialReason?: 'quick' | 'snapshot'
  deferredRepos?: number
  /** 0..1 of the server's project scan, when it has reported one. */
  projects?: number
}

/** The one line shown above the page while the data is still arriving; null when there is nothing
 *  to say. It never blocks anything: the page beside it is usable. */
export function startupStripText(s: StartupStripState, lang: 'pt' | 'en'): string | null {
  const pt = lang === 'pt'
  if (s.partial) {
    const pct = s.projects !== undefined && s.projects > 0 && s.projects < 1 ? ` — ${Math.floor(s.projects * 100)}%` : ''
    if (s.partialReason === 'snapshot') {
      return pt ? `Mostrando os dados da última vez — atualizando${pct}…` : `Showing your data from last time — refreshing${pct}…`
    }
    return pt
      ? `Ainda carregando projetos, sessões e repositórios${pct}. Pode usar o app enquanto isso.`
      : `Still loading projects, sessions and repositories${pct}. You can use the app meanwhile.`
  }
  if (s.deferredRepos && s.deferredRepos > 0) {
    const n = s.deferredRepos
    return pt
      ? `${n} ${n === 1 ? 'repositório está' : 'repositórios estão'} demorando para responder; os números de git ${n === 1 ? 'dele aparecem' : 'deles aparecem'} quando ${n === 1 ? 'ele terminar' : 'terminarem'}.`
      : `${n} ${n === 1 ? 'repository is' : 'repositories are'} slow to read; ${n === 1 ? 'its' : 'their'} git figures appear when ${n === 1 ? 'it finishes' : 'they finish'}.`
  }
  return null
}

/** The headline and the explanation for each failure, in words a non-technical person can act on. */
export function loadErrorText(e: LoadError, lang: 'pt' | 'en', origin: string): { title: string; body: string } {
  const pt = lang === 'pt'
  switch (e.kind) {
    case 'unreachable':
      return pt
        ? { title: 'Não foi possível falar com o agentistics', body: `O servidor em ${origin} não está respondendo. Verifique se o computador que roda o agentistics está ligado e na mesma rede — num celular, ele precisa estar acordado.` }
        : { title: "Can't reach agentistics", body: `The server at ${origin} isn't answering. Check that the computer running agentistics is on and on the same network — from a phone, it needs to be awake.` }
    case 'timeout':
      return pt
        ? { title: 'O servidor está demorando demais', body: 'Ele respondeu à conexão, mas não terminou de enviar seus dados a tempo. Isso costuma passar sozinho em instantes.' }
        : { title: 'The server is taking too long', body: "It answered the connection but didn't finish sending your data in time. This usually clears up on its own in a moment." }
    case 'server':
      return pt
        ? { title: 'O servidor teve um problema ao carregar seus dados', body: `Ele respondeu com um erro (${e.detail}). Tentar de novo costuma resolver; se continuar, reinicie o agentistics.` }
        : { title: 'The server had a problem loading your data', body: `It answered with an error (${e.detail}). Trying again usually fixes it; if it keeps happening, restart agentistics.` }
    case 'incompatible':
      return pt
        ? { title: 'Este endereço não respondeu como o agentistics', body: `O que respondeu em ${origin} não parece ser o servidor do agentistics (ou é de outra versão). Confira o endereço ou atualize o agentistics.` }
        : { title: "This address didn't answer like agentistics", body: `Whatever answered at ${origin} doesn't look like the agentistics server (or it is a different version). Check the address or update agentistics.` }
  }
}

/** Whether a fresh answer should replace what is on screen. Everything does, except the server's
 *  QUICK subset arriving over a FULL payload (a server restarted while the page stayed open): that
 *  would empty the project and session lists for the few seconds until its build lands. A snapshot is
 *  full-shaped and is accepted; the poll that follows brings the fresh build either way. */
export function acceptPayload(current: { partial?: boolean } | null, fresh: { partial?: boolean; partialReason?: string }): boolean {
  if (!current) return true
  return !(fresh.partial && fresh.partialReason === 'quick' && !current.partial)
}

/** The liveness probe: while data is on screen, ask `/api/health` this often with this deadline, so a
 *  stopped server is noticed in about 4 s instead of at the next 30 s data refresh. */
export const LIVENESS_MS = 2000
export const LIVENESS_TIMEOUT_MS = 2000

/** What one probe result means given whether the page already says the server is down. A failure
 *  marks it down; an answer after that means it is back and the data should be refreshed NOW. */
export function livenessStep(down: boolean, answered: boolean): 'mark-offline' | 'recover' | 'none' {
  if (!answered) return down ? 'none' : 'mark-offline'
  return down ? 'recover' : 'none'
}
