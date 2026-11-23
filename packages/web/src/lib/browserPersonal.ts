/**
 * browserPersonal.ts — the pure rules of the PERSON'S OWN browser panel (NAVEGADOR S10, spec §3.2, prototype
 * B1) and its one door to the server: `POST /api/browser/personal/<action>` (S2), read back over the same
 * `/api/browser/stream?owner=personal` the session card uses. The personal browser has no padlock: it is
 * the person's, so its screen takes their input from the first frame (`lock: 'none'`).
 */
import type { StatusLiveRow } from './browserCard'
import { clearPersonalGrant, personalGrantHeaders, unlockSentence } from './personalGrant'

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

/** `tab`: the tab a verb acted on or opened (`tab_new` answers the new tab's id). `needsUnlock`: the owner's grant is missing or no longer valid. */
export type PersonalOutcome = { ok: true; tab?: string; restored?: number; wasStopped?: boolean } | { ok: false; sentence: string; needsUnlock?: boolean }

export type PersonalAction = 'navigate' | 'back' | 'forward' | 'reload' | 'tab_new' | 'tab_select' | 'tab_close' | 'close' | 'minimize' | 'open'

/** Server refusal codes the panel knows, said in Portuguese (the server's own sentences are English). */
function ptSentenceFor(error: unknown, reason: unknown): string | null {
  switch (error) {
    case 'blocked':
      return reason === 'scheme' ? 'Recusado: esse tipo de endereço (file:, chrome:, devtools:…) nunca é carregado. As outras portas de localhost (o seu servidor de desenvolvimento) são permitidas.'
        : reason === 'agentistics-port' ? 'Recusado: esse endereço aponta para a porta do próprio agentistics. As outras portas de localhost (o seu servidor de desenvolvimento) são permitidas.'
        : reason === 'debug-port' ? 'Recusado: esse endereço aponta para a porta de depuração de outro navegador. As outras portas de localhost (o seu servidor de desenvolvimento) são permitidas.'
        : 'Recusado: esse endereço não é válido.'
    case 'personal_proof_required': return unlockSentence(true)
    case 'session_cannot_drive_personal': return 'Uma sessão não pode usar o navegador da pessoa; as ferramentas dela alcançam só o navegador da própria sessão.'
    case 'caller_unidentified': return 'Não foi possível confirmar que o pedido vem da pessoa (e não de uma sessão). Use a tela do agentistics.'
    case 'browser_disabled': return 'O navegador está desligado nesta máquina (Ajustes).'
    default: return null
  }
}

/** The server's refusal, in words (a blocked URL, no Chromium here, the switch off…). */
export function personalFailure(status: number, body: unknown, pt: boolean): string {
  const b = body && typeof body === 'object' ? body as { sentence?: unknown; error?: unknown; reason?: unknown } : {}
  if (pt) {
    const known = ptSentenceFor(b.error, b.reason)
    if (known) return known
  }
  if (b.error === 'personal_proof_required') return unlockSentence(pt)
  if (typeof b.sentence === 'string' && b.sentence.trim()) return b.sentence
  if (status === 403 || status === 404) return pt ? 'O navegador não está disponível neste perfil ou foi desligado.' : 'The browser is not available in this profile or was turned off.'
  return pt ? 'Não foi possível usar o navegador agora.' : 'Could not use the browser right now.'
}

export type PostFn = (url: string, body: unknown) => Promise<{ status: number; body: unknown }>

const defaultPost: PostFn = async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...personalGrantHeaders() }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => null) }
}

/** One verb of the person's own browser. A 200 `{ok:false}` (blocked URL, stale tab) is a refusal in words. */
export async function personalAct(action: PersonalAction, args: Record<string, unknown>, pt: boolean, post: PostFn = defaultPost): Promise<PersonalOutcome> {
  try {
    const r = await post(`/api/browser/personal/${action}`, args)
    const ok = r.status < 400 && !(r.body && typeof r.body === 'object' && (r.body as { ok?: unknown }).ok === false)
    if (ok) {
      const b = r.body && typeof r.body === 'object' ? r.body as { tab?: unknown; restored?: unknown; wasStopped?: unknown } : {}
      return {
        ok: true,
        ...(typeof b.tab === 'string' ? { tab: b.tab } : {}),
        ...(typeof b.restored === 'number' ? { restored: b.restored } : {}),
        ...(typeof b.wasStopped === 'boolean' ? { wasStopped: b.wasStopped } : {}),
      }
    }
    // The server no longer knows this grant (it restarted, expired, was revoked): forget it, so the panel asks again.
    if (r.body && typeof r.body === 'object' && (r.body as { error?: unknown }).error === 'personal_proof_required') { clearPersonalGrant(); return { ok: false, sentence: personalFailure(r.status, r.body, pt), needsUnlock: true } }
    return { ok: false, sentence: personalFailure(r.status, r.body, pt) }
  } catch {
    return { ok: false, sentence: pt ? 'O servidor não respondeu.' : 'The server did not answer.' }
  }
}

/** "Minimizar navegador": the component goes, Chromium and its tabs keep running (idle ones are stopped after 30 min, tab list kept). */
export function minimizePersonalBrowser(pt: boolean, post?: PostFn): Promise<PersonalOutcome> {
  return personalAct('minimize', {}, pt, post)
}

/** "Fechar navegador": every tab closed and the Chromium stopped; the tab list is gone. */
export function closePersonalBrowser(pt: boolean, post?: PostFn): Promise<PersonalOutcome> {
  return personalAct('close', {}, pt, post)
}

/** Said to the person when their tabs came back after the browser had been stopped while minimized. */
export function restoredSentence(restored: number, pt: boolean): string {
  return pt
    ? `O navegador estava minimizado há muito tempo e foi parado para liberar memória. Reabri ${restored} ${restored === 1 ? 'aba' : 'abas'} (as páginas foram recarregadas).`
    : `The browser had been minimized for a long time and was stopped to free memory. I reopened ${restored} ${restored === 1 ? 'tab' : 'tabs'} (the pages were reloaded).`
}
