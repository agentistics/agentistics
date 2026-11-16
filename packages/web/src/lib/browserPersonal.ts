/**
 * browserPersonal.ts — the pure rules of the PERSON'S OWN browser panel (NAVEGADOR S10, spec §3.2, prototype
 * B1) and its one door to the server: `POST /api/browser/personal/<action>` (S2), read back over the same
 * `/api/browser/stream?owner=personal` the session card uses. The personal browser has no padlock: it is
 * the person's, so its screen takes their input from the first frame (`lock: 'none'`).
 */
import type { StatusLiveRow } from './browserCard'

/** The personal browser's live row in a `/api/browser/status` answer, or null. Malformed input reads as none. */
export function personalBrowserOf(status: unknown): StatusLiveRow | null {
  const live = status && typeof status === 'object' ? (status as { live?: unknown }).live : null
  if (!Array.isArray(live)) return null
  for (const row of live) {
    const o = row && typeof row === 'object' ? (row as { owner?: unknown }).owner : null
    if (o && typeof o === 'object' && (o as { kind?: unknown }).kind === 'personal') {
      const r = row as StatusLiveRow
      if (r.phase === 'stopping') return null
      return { owner: r.owner, phase: String(r.phase), tabs: Array.isArray(r.tabs) ? r.tabs : [] }
    }
  }
  return null
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const LOCAL = /^(localhost|127(\.\d{1,3}){3}|\[::1\])(:\d+)?([/?#]|$)/i
const HOSTLIKE = /^[^\s/?#]+\.[^\s/?#]{2,}([:/?#]|$)/

export type AddressResult = { ok: true; url: string } | { ok: false; sentence: string }

/**
 * What the person typed → the URL to open. A scheme is kept (the server refuses the dangerous ones with its
 * own sentence); `localhost`/loopback gets `http://` (dev servers have no certificate), a host-looking text
 * `https://`. Anything else (no dot, spaces) is not an address — it is said so, never turned into a search
 * the person did not ask for.
 */
export function normalizeAddress(input: string, pt: boolean): AddressResult {
  const t = input.trim()
  if (!t) return { ok: false, sentence: pt ? 'Digite um endereço.' : 'Type an address.' }
  if (SCHEME.test(t) && !/^[^/]*:\d+([/?#]|$)/.test(t) && !/^localhost:/i.test(t)) return { ok: true, url: t }
  if (LOCAL.test(t)) return { ok: true, url: `http://${t}` }
  if (HOSTLIKE.test(t)) return { ok: true, url: `https://${t}` }
  return { ok: false, sentence: pt ? 'Isso não parece um endereço (por exemplo, exemplo.com/pagina).' : 'That does not look like an address (for example, example.com/page).' }
}

export type PersonalOutcome = { ok: true } | { ok: false; sentence: string }

export type PersonalAction = 'navigate' | 'back' | 'forward' | 'reload' | 'tab_new' | 'tab_select' | 'tab_close' | 'close'

/** The server's refusal, in words (a blocked URL, no Chromium here, the switch off…). */
export function personalFailure(status: number, body: unknown, pt: boolean): string {
  const b = body && typeof body === 'object' ? body as { sentence?: unknown; error?: unknown } : {}
  if (typeof b.sentence === 'string' && b.sentence.trim()) return b.sentence
  if (status === 403 || status === 404) return pt ? 'O navegador não está disponível neste perfil ou foi desligado.' : 'The browser is not available in this profile or was turned off.'
  return pt ? 'Não foi possível usar o navegador agora.' : 'Could not use the browser right now.'
}

export type PostFn = (url: string, body: unknown) => Promise<{ status: number; body: unknown }>

const defaultPost: PostFn = async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => null) }
}

/** One verb of the person's own browser. A 200 `{ok:false}` (blocked URL, stale tab) is a refusal in words. */
export async function personalAct(action: PersonalAction, args: Record<string, unknown>, pt: boolean, post: PostFn = defaultPost): Promise<PersonalOutcome> {
  try {
    const r = await post(`/api/browser/personal/${action}`, args)
    const ok = r.status < 400 && !(r.body && typeof r.body === 'object' && (r.body as { ok?: unknown }).ok === false)
    return ok ? { ok: true } : { ok: false, sentence: personalFailure(r.status, r.body, pt) }
  } catch {
    return { ok: false, sentence: pt ? 'O servidor não respondeu.' : 'The server did not answer.' }
  }
}
