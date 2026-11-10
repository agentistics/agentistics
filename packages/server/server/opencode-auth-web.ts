/**
 * opencode-auth-web.ts — `/api/opencode/auth`: the OpenCode provider connections, for Settings.
 *
 *   GET    → which providers hold a credential (ids and types only) + the provider choices
 *   POST   → { provider, key }: save a pasted key under the right provider id
 *   POST /fix → move a Go key that sits under `opencode` to `opencode-go`
 *   DELETE /<provider> → remove that entry
 *
 * It writes a credential file, so `/api/opencode` is a `localShell` prefix in `capability-guard.ts`.
 * The pasted key is read, written and forgotten: it is in no log line, no audit field and no reply.
 */

import { hostWhich } from './host-which'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HOME_DIR } from './config'
import { catalogCliPath } from './model-catalog'
import { readJsonLimited } from './limits'
import {
  OPENCODE_PROVIDERS, catalogProviders, fixMisfiledGoKey, listConnected, readAuth, removeKey, saveKey,
  type OpencodeProvider,
} from './opencode-auth'

async function catalogText(): Promise<string | null> {
  const cache = join(process.env.XDG_CACHE_HOME || join(HOME_DIR, '.cache'), 'opencode', 'models.json')
  try { return await readFile(cache, 'utf8') } catch { return null }
}

const MESSAGES: Record<string, string> = {
  bad_provider: 'Unknown provider.',
  empty: 'Paste the key first.',
  whitespace: 'A key is one word with no spaces — check what was pasted.',
  too_long: 'That is too long to be a key.',
  control: 'The pasted text has hidden characters — copy the key again.',
}

export async function handleOpencodeAuthRequest(req: Request, headers: Record<string, string> = {}): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers })
  const path = new URL(req.url).pathname
  const sub = path.slice('/api/opencode/auth'.length)

  if (sub === '' || sub === '/') {
    if (req.method === 'GET') {
      const doc = await readAuth()
      const extra: OpencodeProvider[] = catalogProviders(await catalogText())
      const labels = new Map(extra.map(p => [p.id, p.label]))
      return json({
        installed: hostWhich('opencode', { PATH: catalogCliPath() }) !== null,
        connected: listConnected(doc, labels),
        providers: [...OPENCODE_PROVIDERS, ...extra],
      })
    }
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
    if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return json({ error: 'Expected application/json' }, 415)
    const body = await readJsonLimited<{ provider?: unknown; key?: unknown }>(req, 8 * 1024)
    if (!body.ok) return json({ error: 'Invalid request' }, body.error === 'too_large' ? 413 : 400)
    const out = await saveKey(body.value?.provider, body.value?.key).catch(() => null)
    if (!out) return json({ error: 'write_failed', message: 'Could not write OpenCode\'s auth file.' }, 500)
    if (!out.ok) return json({ error: out.reason, message: MESSAGES[out.reason] ?? 'Invalid request' }, 400)
    return json({ ok: true, savedAs: out.savedAs, ...(out.movedFrom ? { movedFrom: out.movedFrom } : {}) })
  }

  if (sub === '/fix') {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
    return json({ ok: true, moved: await fixMisfiledGoKey().catch(() => false) })
  }

  const m = /^\/([^/]+)$/.exec(sub)
  if (m && req.method === 'DELETE') {
    let id: string
    try { id = decodeURIComponent(m[1]!) } catch { return json({ error: 'Invalid request' }, 400) }
    const removed = await removeKey(id).catch(() => false)
    return removed ? json({ ok: true }) : json({ error: 'not_found', message: 'That provider is not connected.' }, 404)
  }
  return json({ error: 'Not found' }, 404)
}
