/**
 * mcpAuth.ts — PURE: how the MCP states are WORDED and which running sessions a new login affects.
 *
 * The server decides the state (it reads it off the harness's own `mcp list`); this decides only the
 * sentence and the colour. The wording is deliberately the harness's own idea of the state, not a
 * friendlier guess: `authenticated` is "signed in" (credentials exist), never "connected", because
 * Codex says the one and not the other; `disconnected` is "not connected" with no reason, because
 * Gemini gives none.
 */

export type McpAuthState =
  | 'connected' | 'authenticated' | 'needs-auth' | 'disconnected' | 'error' | 'disabled' | 'pending' | 'unknown'

export interface McpRow {
  name: string
  target: string
  transport?: 'stdio' | 'http' | 'sse'
  state: McpAuthState
  detail?: string
  canAuthenticate: boolean
  duplicateOf?: string
}

export type McpStatusKind = 'ok' | 'cli-missing' | 'no-mcp-command' | 'failed'

export interface McpHarnessStatus {
  harness: string
  kind: McpStatusKind
  servers: McpRow[]
  untrustedFolder?: boolean
  message?: { pt: string; en: string }
  checkedAt: number
}

export interface McpHarnessOverview {
  id: string
  label: string
  installed: boolean
  canList: boolean
  canAuthenticate: boolean
  note?: { pt: string; en: string }
  measured: string
}

export interface McpAuthView {
  id: string
  harness: string
  server: string
  phase: 'starting' | 'awaiting' | 'finishing' | 'connected' | 'failed' | 'cancelled'
  url?: string
  pasteBack: boolean
  verified?: boolean
  message?: string
}

export type McpTone = 'good' | 'warn' | 'bad' | 'muted'

const STATE: Record<McpAuthState, { pt: string; en: string; tone: McpTone }> = {
  connected: { pt: 'Conectado', en: 'Connected', tone: 'good' },
  authenticated: { pt: 'Conta conectada', en: 'Signed in', tone: 'good' },
  'needs-auth': { pt: 'Precisa autenticar', en: 'Needs authentication', tone: 'warn' },
  disconnected: { pt: 'Não conectado', en: 'Not connected', tone: 'bad' },
  error: { pt: 'Erro', en: 'Error', tone: 'bad' },
  disabled: { pt: 'Desativado', en: 'Disabled', tone: 'muted' },
  pending: { pt: 'Aguardando aprovação', en: 'Awaiting approval', tone: 'warn' },
  unknown: { pt: 'Sem status', en: 'No status reported', tone: 'muted' },
}

export function mcpStateText(s: McpAuthState, pt: boolean): { text: string; tone: McpTone } {
  const e = STATE[s]
  return { text: pt ? e.pt : e.en, tone: e.tone }
}

/** One sentence under a row that says WHY the state reads as it does, where the state alone would mislead. */
export function mcpStateNote(row: Pick<McpRow, 'state' | 'detail' | 'duplicateOf' | 'name'>, harnessLabel: string, pt: boolean): string | null {
  switch (row.state) {
    case 'authenticated':
      return pt
        ? `${harnessLabel} guardou o login deste servidor, mas não diz se ele está respondendo agora.`
        : `${harnessLabel} has this server’s login stored, but does not say whether it is answering right now.`
    case 'disconnected':
      return pt
        ? `${harnessLabel} não diz por que não conectou — pode ser a autenticação ou uma falha do servidor.`
        : `${harnessLabel} does not say why it is not connected — it may be authentication or a server failure.`
    case 'unknown':
      return pt
        ? `${harnessLabel} lista este servidor, mas não informa se ele está funcionando.`
        : `${harnessLabel} lists this server but does not report whether it works.`
    case 'pending':
      return pt ? 'Está num arquivo do repositório e ainda não foi aprovado no Claude Code.' : 'It is in a repository file and has not been approved in Claude Code yet.'
    case 'error':
      return row.detail ?? null
    default:
      return null
  }
}

export function duplicateNote(row: Pick<McpRow, 'duplicateOf' | 'name'>, pt: boolean): string | null {
  if (!row.duplicateOf) return null
  return pt
    ? `Mesmo endereço de "${row.duplicateOf}": são dois logins para o mesmo servidor. Mantenha o que preferir; nada é criado ou removido sozinho.`
    : `Same address as "${row.duplicateOf}": two logins for the same server. Keep whichever you prefer; nothing is created or removed on its own.`
}

// ---- which sessions a new login affects ------------------------------------------------------

export interface SessionLike {
  id: string
  title: string
  harness: string
  state: string
  conversationId?: string
}

export interface ReopenPlan {
  /** Idle at the prompt: ending and resuming them costs no work in flight. */
  reopenable: SessionLike[]
  /** Mid-turn or on a dialog: left alone, said in words. */
  busy: SessionLike[]
}

const RUNNING = new Set(['working', 'waiting', 'waiting-approval'])

/**
 * A running session keeps the MCP tools it started with, so one opened before the login does not see
 * the server. Only sessions of THAT harness are affected. Reopening ends the process and resumes the
 * same conversation, so it is offered only for a session that is idle (`waiting`) and has a conversation
 * to resume — a session mid-turn or sitting on a permission prompt is never interrupted for this.
 */
export function planReopen(rows: readonly SessionLike[], harness: string): ReopenPlan {
  const reopenable: SessionLike[] = []
  const busy: SessionLike[] = []
  for (const r of rows) {
    if (r.harness !== harness || !RUNNING.has(r.state)) continue
    if (r.state === 'waiting' && r.conversationId) reopenable.push(r)
    else busy.push(r)
  }
  return { reopenable, busy }
}

/** Where to send the person for the rest of the setup, after the dialog closes. */
export function mcpAuthDone(view: Pick<McpAuthView, 'phase'>): boolean {
  return view.phase === 'connected' || view.phase === 'failed' || view.phase === 'cancelled'
}
