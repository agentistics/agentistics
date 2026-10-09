/**
 * mcp-auth-flow.ts — PURE: the state machine of "Authenticate this MCP server" and the reads it
 * needs off a terminal pane.
 *
 * ## Why a pane
 *
 * Every harness's OAuth login is interactive: `claude mcp login figma` answered "stdin isn't a
 * terminal, so authentication can't be completed here" when run with piped stdio (measured, claude
 * 2.1.295), so the login runs in a real tty — a tmux pane on its own socket — exactly as the
 * Sign in button of Settings → Harnesses does for the harness's own account. The pane prints the
 * authorisation URL; the app reads it off the screen and shows it as a link.
 *
 * ## What counts as DONE
 *
 * Never a phrase scraped from the screen (each CLI words success its own way and changes it). The
 * login command exits and the wrapper prints `[agentop-exit:N]`; exit 0 is only the CLI saying it is
 * finished, so the flow then asks the harness's own `mcp list` what the server's state is now
 * (`settle`). A harness whose list cannot say (Codex reports credentials, not health) is settled on
 * the exit code alone and the flow says it was not verified.
 */

import type { McpAuthState } from './mcp-harness-status'

export const AUTH_TIMEOUT_MS = 10 * 60_000
/** A finished flow stays pollable this long, then its record goes. */
export const AUTH_KEEP_MS = 10 * 60_000

export type AuthPhase = 'starting' | 'awaiting' | 'finishing' | 'connected' | 'failed' | 'cancelled'

export type AuthFailure =
  | 'pane-gone' | 'exit-nonzero' | 'timeout' | 'still-needs-auth' | 'no-tmux' | 'no-cli' | 'spawn-failed'

export interface AuthFlow {
  id: string
  harness: string
  server: string
  phase: AuthPhase
  /** The authorisation URL the person opens. Set once the pane has printed it. */
  url?: string
  /** Whether a pasted redirect URL can be handed back to the CLI (Claude Code's prompt). */
  pasteBack: boolean
  startedAt: number
  endedAt?: number
  failure?: AuthFailure
  /** The CLI's own last words on a failure — URL lines removed (they carry the OAuth state). */
  tail?: string
  /** Exit 0 and the harness's list agreed. `false`: exit 0 only (the list cannot tell). */
  verified?: boolean
}

export function newFlow(o: { id: string; harness: string; server: string; pasteBack: boolean; now: number }): AuthFlow {
  return { id: o.id, harness: o.harness, server: o.server, phase: 'starting', pasteBack: o.pasteBack, startedAt: o.now }
}

export const isTerminal = (p: AuthPhase): boolean => p === 'connected' || p === 'failed' || p === 'cancelled'

// ---- reads off the screen ----------------------------------------------------------------------

/**
 * The authorisation URL: the first `http(s)://` token on the screen. `capture-pane -J` already
 * joins the terminal's soft wraps (the measured Figma URL is ~330 characters across three rows), so
 * a token is a whole URL. Trailing punctuation a sentence could add is trimmed.
 */
export function extractAuthUrl(capture: string): string | null {
  for (const token of capture.split(/\s+/)) {
    const m = /^(https?:\/\/[^\s<>"'`]+)/i.exec(token)
    if (m) return m[1]!.replace(/[.,;:)\]]+$/, '')
  }
  return null
}

export const EXIT_MARKER = '[agentop-exit:'

/** The wrapper's `[agentop-exit:N]` line → N. `null` while the command is still running. */
export function exitCodeOf(capture: string): number | null {
  const m = /\[agentop-exit:(\d+)\]/.exec(capture)
  return m ? Number(m[1]) : null
}

/** The last few lines the CLI wrote, minus the wrapper's marker and any URL (state/PKCE material). */
export function failureTail(capture: string, max = 4): string {
  const lines = capture.split(/\r?\n/).map(l => l.trim())
    .filter(l => l && !l.includes(EXIT_MARKER) && !/https?:\/\//i.test(l))
  return lines.slice(-max).join('\n').slice(0, 600)
}

/**
 * Is this pasted text the redirect URL a browser was sent to? It is TYPED INTO a process, so it is
 * accepted only if it is a loopback `http(s)` URL with a query carrying `code=` or `error=` — a
 * single line, bounded. Anything else would be arbitrary text sent to a CLI on the person's behalf.
 */
export function validRedirectPaste(s: string): boolean {
  const t = s.trim()
  if (t.length === 0 || t.length > 4096 || /[\r\n\0]/.test(t)) return false
  let u: URL
  try { u = new URL(t) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname)) return false
  return u.searchParams.has('code') || u.searchParams.has('error')
}

// ---- the transitions ---------------------------------------------------------------------------

export interface PaneObservation {
  now: number
  /** The pane's screen (`capture-pane -J`), or `null` when the pane no longer exists. */
  capture: string | null
}

/** One poll of the pane. Pure: the caller does the IO and re-lists when this says `finishing`. */
export function advance(flow: AuthFlow, obs: PaneObservation): AuthFlow {
  if (isTerminal(flow.phase) || flow.phase === 'finishing') return flow
  const stamp = (f: Partial<AuthFlow>): AuthFlow => ({ ...flow, ...f })
  if (obs.capture === null) return stamp({ phase: 'failed', failure: 'pane-gone', endedAt: obs.now })
  const code = exitCodeOf(obs.capture)
  if (code === 0) return stamp({ phase: 'finishing' })
  if (code !== null) {
    return stamp({ phase: 'failed', failure: 'exit-nonzero', tail: failureTail(obs.capture), endedAt: obs.now })
  }
  if (obs.now - flow.startedAt > AUTH_TIMEOUT_MS) {
    return stamp({ phase: 'failed', failure: 'timeout', endedAt: obs.now })
  }
  if (flow.phase === 'starting') {
    const url = extractAuthUrl(obs.capture)
    if (url) return stamp({ phase: 'awaiting', url })
  }
  return flow
}

/**
 * After the CLI exited 0: what does the harness say now? `state === null` means its list could not
 * be read or cannot report (Codex, Gemini) — then the exit code is all there is, said as such.
 */
export function settle(flow: AuthFlow, state: McpAuthState | 'absent' | null, now: number): AuthFlow {
  if (flow.phase !== 'finishing') return flow
  if (state === 'needs-auth') {
    return { ...flow, phase: 'failed', failure: 'still-needs-auth', endedAt: now }
  }
  const verified = state === 'connected' || state === 'authenticated'
  return { ...flow, phase: 'connected', verified, endedAt: now }
}

export function cancelled(flow: AuthFlow, now: number): AuthFlow {
  return isTerminal(flow.phase) ? flow : { ...flow, phase: 'cancelled', endedAt: now }
}

// ---- the sentences the route says (the CLI's own lines are passed through, never reworded) -----

export function failureText(f: AuthFailure, lang: 'pt' | 'en', tail?: string): string {
  const pt = lang === 'pt'
  const base: Record<AuthFailure, string> = {
    'pane-gone': pt ? 'O terminal da autenticação fechou antes de terminar. Tente de novo.' : 'The sign-in terminal closed before it finished. Try again.',
    'exit-nonzero': pt ? 'A autenticação não terminou.' : 'The sign-in did not finish.',
    timeout: pt ? 'Demorou demais (10 minutos) e foi cancelada. Tente de novo.' : 'It took too long (10 minutes) and was cancelled. Try again.',
    'still-needs-auth': pt ? 'O comando terminou, mas o servidor ainda diz que precisa de autenticação. Tente de novo.' : 'The command finished, but the server still says it needs authentication. Try again.',
    'no-tmux': pt ? 'Não consegui abrir um terminal aqui (o tmux não está instalado), e a autenticação precisa de um.' : 'I could not open a terminal here (tmux is not installed), and the sign-in needs one.',
    'no-cli': pt ? 'O comando deste assistente não está nesta máquina.' : "This assistant's command is not on this machine.",
    'spawn-failed': pt ? 'Não consegui iniciar a autenticação.' : 'I could not start the sign-in.',
  }
  return tail ? `${base[f]} ${tail}` : base[f]
}
