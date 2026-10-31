/**
 * opencode-limit.ts — is an OpenCode conversation stopped on a USAGE LIMIT right now?
 *
 * Measured live on opencode 1.19.5 (throwaway HOME, free model, 2026-10-31): a session agentistics starts
 * runs over ACP, and on an exhausted free tier ACP carries NOTHING — no update frame, no error, and the
 * assistant message in `opencode.db` stays empty with no `error` while opencode waits ~17 h to retry.
 * The one place the refusal is written is opencode's own log, beside its database, as a main-agent
 * `message="stream error"` line naming the session:
 *
 * ```
 * … level=ERROR … message="stream error" providerID=opencode modelID=glm-5.3-flash-free
 *   session.id=ses_… small=false agent=build mode=primary
 *   error.error="AI_APICallError: Free usage limit reached. Free models work in OpenCode …"
 * ```
 *
 * So the limit is read there, matched with the SAME banner rule a screen is (`LIMIT_RULES.opencode`), and
 * cleared by the store: a later assistant message that produced output is real work after the refusal.
 * A title-agent error (`agent=title`) is a side request and never counts. Reset time: opencode prints
 * none, so none is stated.
 */
import { Database } from 'bun:sqlite'
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { OPENCODE_DB_PATH } from '../config'
import { LIMIT_RULES } from './limit'

export interface OpencodeLimit { at: number; message: string }

const PREFIX = /^(?:AI_[A-Za-z]+Error|Error):\s*/

/** PURE. The newest main-agent limit refusal opencode logged for `sessionId`, or null. */
export function opencodeLimitFromLog(text: string, sessionId: string): OpencodeLimit | null {
  const rule = LIMIT_RULES.opencode
  if (!rule || !sessionId) return null
  const sid = `session.id=${sessionId} `
  let found: OpencodeLimit | null = null
  for (const line of text.split('\n')) {
    if (!line.includes('message="stream error"') || !line.includes(sid) || line.includes('agent=title')) continue
    const ts = /^timestamp=(\S+)/.exec(line)
    const at = ts ? Date.parse(ts[1]!) : NaN
    const m = /error\.error="((?:[^"\\]|\\.)*)"/.exec(line)
    if (!Number.isFinite(at) || !m) continue
    let message = m[1]!.replace(/\\"/g, '"').replace(PREFIX, '').trim()
    const last = /Last error:\s*([\s\S]+)$/.exec(message)
    if (last) message = last[1]!.trim()
    if (!rule.banner.some(re => re.test(message))) continue
    if (!found || at >= found.at) found = { at, message }
  }
  return found
}

const TAIL_BYTES = 256 * 1024

/** IO. The last 256 KB of the newest `*.log` in opencode's log directory, or ''. */
function readLogTail(logDir: string): string {
  try {
    const f = readdirSync(logDir).filter(n => n.endsWith('.log'))
      .map(n => { const p = join(logDir, n); const st = statSync(p); return { p, m: st.mtimeMs, size: st.size } })
      .sort((a, b) => b.m - a.m)[0]
    if (!f) return ''
    const len = Math.min(f.size, TAIL_BYTES)
    const buf = Buffer.alloc(len)
    const fd = openSync(f.p, 'r')
    try { readSync(fd, buf, 0, len, f.size - len) } finally { closeSync(fd) }
    return buf.toString('utf8')
  } catch { return '' }
}

/** IO. Did the session produce output after `at`? (An assistant message created later with output tokens.) */
function workedAfter(dbPath: string, sessionId: string, at: number): boolean {
  if (!existsSync(dbPath)) return false
  let db: Database | undefined
  try {
    db = new Database(dbPath, { readonly: true })
    const rows = db.query<{ data: string }, [string, number]>(
      'SELECT data FROM message WHERE session_id = ? AND time_created > ? ORDER BY time_created DESC LIMIT 20',
    ).all(sessionId, at)
    return rows.some(r => {
      try {
        const d = JSON.parse(r.data) as { role?: string; tokens?: { output?: number } }
        return d.role === 'assistant' && (d.tokens?.output ?? 0) > 0
      } catch { return false }
    })
  } catch { return false } finally { db?.close() }
}

/** IO. The limit in force on `sessionId` now, or null. Never throws. */
export function readOpencodeLimit(sessionId: string, dbPath: string = OPENCODE_DB_PATH): OpencodeLimit | null {
  const hit = opencodeLimitFromLog(readLogTail(join(dirname(dbPath), 'log')), sessionId)
  if (!hit) return null
  return workedAfter(dbPath, sessionId, hit.at) ? null : hit
}
