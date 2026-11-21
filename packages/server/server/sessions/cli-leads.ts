/**
 * `agentop session leads` — the CLI door to the leadership link. It holds NO rule: it calls the same REST route the MCP
 * tool calls (`POST /api/session-leads`), so every refusal (not_leader, not_own, other_project, …) is the server's, in the
 * server's words. Run from inside a managed session it carries that session's proof, so it may only change its OWN leads.
 */
import { readFileSync } from 'node:fs'
import { SESSION_ID_ENV, SESSION_IDENTITY_KEY_FILE, sessionToken } from './session-identity'

export interface LeadsCommand { ref?: string; add: string[]; remove: string[]; json?: boolean }
export interface LeadsEnv { fetch?: typeof fetch; port?: number; env?: Record<string, string | undefined>; readKey?: () => string; log?: (s: string) => void; err?: (s: string) => void }

export async function leadsCommand(cmd: LeadsCommand, o: LeadsEnv = {}): Promise<number> {
  const log = o.log ?? ((s: string) => console.log(s))
  const err = o.err ?? ((s: string) => console.error(s))
  const env = o.env ?? process.env
  const port = o.port ?? (await import('../config')).PORT
  const call = o.fetch ?? fetch
  const base = `http://127.0.0.1:${port}/api/session-leads`
  let res: Response
  try {
    const writing = cmd.add.length > 0 || cmd.remove.length > 0
    if (!writing && !cmd.ref && !env[SESSION_ID_ENV]) {
      res = await call(base, { signal: AbortSignal.timeout(15_000) })
    } else if (!writing && cmd.ref) {
      res = await call(`${base}?ref=${encodeURIComponent(cmd.ref)}`, { signal: AbortSignal.timeout(15_000) })
    } else {
      const id = env[SESSION_ID_ENV]
      let session: { id: string; token: string } | undefined
      if (id) {
        try { session = { id, token: sessionToken(Buffer.from((o.readKey ?? (() => readFileSync(SESSION_IDENTITY_KEY_FILE, 'utf8')))().trim(), 'hex'), id) } } catch { /* no key: the server refuses an unproven sender */ }
      }
      res = await call(base, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...(cmd.ref ? { ref: cmd.ref } : {}), add: cmd.add, remove: cmd.remove, ...(id ? { session: session ?? null } : {}) }),
        signal: AbortSignal.timeout(15_000),
      })
    }
  } catch (e) { err(`could not reach the agentistics server (${e instanceof Error ? e.message : String(e)}); start it and retry`); return 1 }
  const body = await res.json().catch(() => null) as { ok?: boolean; message?: string; code?: string; leaders?: { id: string; title: string; state: string; leads: string[] }[]; leads?: string[]; id?: string; title?: string } | null
  if (!body) { err(`unexpected answer from the server (HTTP ${res.status})`); return 1 }
  if (cmd.json) { log(JSON.stringify(body)); return body.ok === true ? 0 : 1 }
  if (body.ok !== true) { err(`${body.message ?? body.code ?? `HTTP ${res.status}`}${body.code ? ` (${body.code})` : ''}`); return 1 }
  if (body.leaders) {
    if (body.leaders.length === 0) log('No leader leads an extra task.')
    for (const l of body.leaders) log(`${l.id}\t${l.state}\t${l.title}\t${l.leads.join(',')}`)
    return 0
  }
  log(`${body.message ?? ''}${body.id ? ` (${body.id})` : ''}`.trim())
  return 0
}
