/**
 * vault/http.ts — the `/api/vault/*` routes Settings → Vault speaks (SECRETS.4 §2.4, §7.1).
 *
 * Moved out of `index.ts` verbatim and extended, so every route can be called by a test with a plain
 * `Request`. It owns NO rule: each route is a thin door onto a `gate.ts` function, and the gate's
 * `VAULT_ACTION_ROWS` decides what each action asks (a code, a gesture, a grant). The capability guard
 * (`/api/vault`, localShell) has already refused an exposed profile and `index.ts` answers 404 on a
 * central BEFORE calling this.
 *
 * What a response may carry: state, metadata, the otpauth URI once, the 24 words once. Both of those
 * travel with `Cache-Control: no-store` and are never logged (nothing here logs a body). The 24 words
 * are never ACCEPTED here — recovery is typed on a terminal (§4.3), so `POST /recover` says where.
 */
import { hostname } from 'node:os'
import { readJsonLimited } from '../limits'
import { originAllowed } from '../cors'
import * as gate from './gate'
import { readVaultView, lockVaultNow } from './inventory'
import { FRESH_BINDING, extendAutoLock, noteVaultActivity, unlockWithGesture, vaultLang, vaultStatus } from './service'
import { isLoopbackAddress } from '../native-bind'
import { uiReply } from './ui-sentence'
import { handlePersonalHttp } from './personal-http'
import { handlePhoneHttp } from './phone-http'

export interface VaultHttpEnv {
  /** CORS headers the host adds to every answer. */
  cors: Record<string, string>
  /** What a 'read' grant is bound to: the HTTP session, or one fixed value on a local profile. */
  session: string
  /** The extra origins this server accepts (AGENTISTICS_ALLOWED_ORIGINS) and whether it is the dev server. */
  origins?: { allowlist: string[]; dev: boolean }
  /** v2.98.1: the TCP peer's address (`server.requestIP`). Absent = unknown = never loopback. */
  peer?: string | null
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
/** Any of these means a proxy stood between the browser and this server — a tunnel, a remote-access relay. */
const PROXY_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'x-original-host']

function hostOf(h: string): string | null {
  try { return new URL(h.includes('://') ? h : `http://${h}`).hostname.toLowerCase() } catch { return null }
}

/**
 * PURE. v2.98.1: did this request come from a page opened ON this computer? ALL of: the TCP peer is a
 * loopback address, the `Host` header names localhost / 127.0.0.1 / [::1], no proxy header is present,
 * and — for an action (`requireOrigin`) — the browser-set `Origin` is loopback too. The LAN fails the
 * peer; a tunnel or a remote-access relay fails the Host (it names the public name) or carries a
 * proxy header; a hostile site in this browser fails the Origin (a browser never lets a page forge it)
 * and DNS rebinding fails the Host. docs/security.md §7b states what this does NOT exclude.
 */
export function loopbackRequest(req: { headers: Headers }, peer: string | null | undefined, opts: { requireOrigin: boolean }): boolean {
  if (!peer || !isLoopbackAddress(peer)) return false
  if (PROXY_HEADERS.some(h => req.headers.has(h))) return false
  const host = hostOf(req.headers.get('host') ?? '')
  if (!host || !LOOPBACK_HOSTS.has(host)) return false
  const origin = req.headers.get('origin')
  if (origin === null) return !opts.requireOrigin
  const o = hostOf(origin)
  return o !== null && LOOPBACK_HOSTS.has(o)
}

/**
 * PURE. May this request drive a vault action? (review M1)
 *
 * The host's CSRF check (csrf.ts) is a cookie-riding defence and waves through any request WITHOUT a
 * cookie — which is every request on the `local` profile, the default. A web page the user has open
 * could then send "simple" POSTs (text/plain, no preflight) to 127.0.0.1 and, blind, freeze the
 * authenticator gate (20 wrong codes), keep the vault from auto-locking, or raise Hello prompts nobody
 * asked for. So every non-GET here, cookie or not, needs BOTH:
 *  - `Content-Type: application/json` — a cross-origin page cannot send it without a CORS preflight,
 *    which this server answers with no Allow-Origin for a foreign origin;
 *  - same-origin provenance: `Sec-Fetch-Site: same-origin` (every current browser sends it), or, from a
 *    browser too old to, an `Origin` that IS this host (or an allowlisted / dev origin, as in cors.ts).
 * A request with neither header is not a page of ours (the CLI speaks over vault.sock) and is refused.
 */
export function vaultRequestAllowed(
  req: { method: string; headers: Headers }, host: string, origins: { allowlist: string[]; dev: boolean } = { allowlist: [], dev: false },
): { ok: true } | { ok: false; code: 'not-json' | 'not-same-origin' } {
  const m = req.method.toUpperCase()
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return { ok: true }
  const ct = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (ct !== 'application/json') return { ok: false, code: 'not-json' }
  const site = req.headers.get('sec-fetch-site')
  if (site !== null) return site === 'same-origin' ? { ok: true } : { ok: false, code: 'not-same-origin' }
  const origin = req.headers.get('origin')
  if (origin && (origin === `http://${host}` || origin === `https://${host}` || originAllowed(origin, origins.allowlist, origins.dev))) return { ok: true }
  return { ok: false, code: 'not-same-origin' }
}

const statusOf = (code: unknown): number => (code === 'stepup-required' ? 401 : code === 'bad-request' ? 400 : 403)

/** v2.98.1: the ONE way a vault JSON body leaves this module — every sentence made page-safe (ui-sentence.ts). */
function send(body: Record<string, unknown>, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(uiReply(body, vaultLang() === 'pt' ? 'pt' : 'en')), { status, headers })
}

/** Answers a `/api/vault*` request, or `null` for a path that is not one of ours. */
export async function handleVaultHttp(req: Request, url: URL, env: VaultHttpEnv): Promise<Response | null> {
  const json = { ...env.cors, 'Content-Type': 'application/json' }
  const noStore = { ...json, 'Cache-Control': 'no-store' }
  const grant = req.headers.get('x-vault-grant')
  // Review H2: the single-use proof the reply to this page's own unlock carried (memory only, like the grant).
  const fresh = req.headers.get('x-vault-fresh')
  // Namespaced so no cookie value can ever read as the local CLI's channel ('socket', gate.ts).
  const session = `http:${env.session}`
  const path = url.pathname
  if (!path.startsWith('/api/vault')) return null
  const allowed = vaultRequestAllowed(req, url.host, env.origins)
  if (!allowed.ok) {
    await req.body?.cancel().catch(() => {})
    const pt = vaultLang() === 'pt'
    return send({
      ok: false, code: allowed.code,
      sentence: pt ? 'Esta ação do cofre só pode vir do painel do agentop nesta máquina.' : 'This vault action can only come from the agentop dashboard on this machine.',
    }, 403, noStore)
  }
  const body = async (): Promise<Record<string, unknown>> => {
    const r = await readJsonLimited<Record<string, unknown>>(req, 4096)
    return r.ok && r.value && typeof r.value === 'object' ? r.value : {}
  }
  const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
  const codeOf = (b: Record<string, unknown>): string | undefined => (str(b.code, 16) ? b.code : undefined)
  const reply = (r: { ok: boolean } & Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    send({ ...r, ...extra }, r.ok ? 200 : statusOf(r.code), noStore)
  // v2.98.1: whether THIS request is a page on this computer (actions need the browser's Origin too).
  const loopback = loopbackRequest(req, env.peer, { requireOrigin: req.method !== 'GET' })
  const bad = () => reply({ ok: false, code: 'bad-request', sentence: vaultLang() === 'pt' ? 'Requisição inválida.' : 'Bad request.' })

  if (path === '/api/vault' && req.method === 'GET') {
    // The inventory only after a step-up (`list`); the state alone is always readable.
    const s = await vaultStatus()
    if (s.state !== 'open') return send({ ...(await readVaultView([], async () => [], session, loopback)), locked: true }, 200, noStore)
    const g = await gate.requireVaultStepUp('list', { grant, session, loopback })
    if (!g.ok) {
      return send({
        needsStepUp: true, code: g.code, sentence: g.sentence, state: s.state, lockedBy: s.lockedBy ?? null,
        // What the screen needs to draw the step-up prompt itself — facts only, never an inventory.
        view: { ...(await readVaultView([], async () => [], session, loopback)), locked: false },
      }, statusOf(g.code), noStore)
    }
    return send({ ...(await readVaultView(undefined, undefined, session, loopback)) }, 200, noStore)
  }
  if (path === '/api/vault/stepup' && req.method === 'POST') {
    const b = await body()
    if (!str(b.code, 16)) return bad()
    return reply(await gate.stepUpForRead(b.code, session))
  }
  if (path === '/api/vault/extend' && req.method === 'POST') {
    const b = await body()
    const g = await gate.requireVaultStepUp('extend-open', { session, grant, loopback, code: codeOf(b) })
    if (!g.ok) return reply(g)
    const left = extendAutoLock()
    if (left === null) return reply({ ok: false, code: String('locked'), sentence: vaultLang() === 'pt' ? 'O cofre já está trancado.' : 'The vault is already locked.' })
    return reply({ ok: true, autoLockInMs: left })
  }
  if (path === '/api/vault/lock' && req.method === 'POST') {
    const b = await body()
    const r = await lockVaultNow({ grant, session, code: codeOf(b) })
    return send(r.ok ? { ok: true, vault: await readVaultView([], async () => [], session, loopback) } : { error: r.error, code: r.code, sentence: r.error }, r.ok ? 200 : statusOf(r.code), noStore)
  }
  if (path === '/api/vault/unlock' && req.method === 'POST') {
    // Raises the gesture IN THE SERVICE; the code follows on /unlock/code (§2.2). VAULT.PERSONAL §10:
    // NEVER from another device — a Hello prompt on an empty desk is a prompt someone else can answer,
    // or no one. A phone opens with its own passkey or device key (/api/vault/phone/unlock).
    if (!loopback) {
      await req.body?.cancel().catch(() => {})
      return reply({ ok: false, code: 'unlock-not-here', sentence: vaultLang() === 'pt'
        ? 'Daqui não dá para usar o Windows Hello do computador. Abra o cofre com a digital deste celular ou com o código (se o computador permitir).'
        : 'This device cannot use the computer\'s Windows Hello. Open the vault with this phone\'s biometrics, or with the code if the computer allows it.' })
    }
    // Review H2: the page may declare the ONE action this unlock is for (`personal-grant:<sid>`); the reply
    // then carries a single-use proof for exactly that action, this session — and nobody else's request.
    const b = await body()
    const binding = typeof b.for === 'string' && FRESH_BINDING.test(b.for) ? b.for : null
    const u = await unlockWithGesture(undefined, binding ? { session, binding } : undefined)
    return reply(u.ok ? { ok: true, state: u.state, ...(u.fresh ? { fresh: u.fresh } : {}) } : u)
  }
  if (path === '/api/vault/unlock/code' && req.method === 'POST') {
    const b = await body()
    if (!str(b.code, 16)) return bad()
    // Owner 2026-10-03: the code that completes the unlock IS the step-up — it hands back the
    // 5-minute 'read' grant, so the list right behind the unlock never asks for a second code.
    const r = await gate.completeUnlock(b.code)
    return reply(r.ok ? { ok: true, grant: gate.mintGrant(session, 'read') } : r)
  }
  if (path === '/api/vault/auto-lock' && req.method === 'POST') {
    const b = await body()
    return reply(await gate.setAutoLockMinutes(b.minutes, { grant, session, code: codeOf(b) }))
  }
  if (path === '/api/vault/unlock-policy' && req.method === 'POST') {
    // Owner decision 2026-10-02: changing what an unlock asks costs the code AND the gesture, fresh.
    const b = await body()
    return reply(await gate.setUnlockPolicy({ mode: b.mode, hours: b.hours }, { grant, session, code: codeOf(b) }))
  }
  if (path === '/api/vault/auth-policy' && req.method === 'POST') {
    // Owner decision 2026-10-06: which proof each kind of action asks. The new policy is parsed (a
    // critical kind can never be "nothing") and the change is gated by the CURRENT 'settings' choice.
    const b = await body()
    return reply(await gate.setAuthPolicy(b.policy, { grant, session, loopback, code: codeOf(b) }))
  }
  if (path === '/api/vault/activity' && req.method === 'POST') {
    // The dashboard's input heartbeat (§5.1): human interaction resets the idle clock.
    noteVaultActivity()
    return send({ ok: true }, 200, noStore)
  }

  // ── SECRETS.4 §7.1: the enrolment wizard and the sections' actions ────────────────────────────

  if (path === '/api/vault/setup-code' && req.method === 'POST') {
    // The wizard's FIRST step on a page's first enrolment: the setup code is spent here, before any
    // gesture, and the proof is held for this session for the rest of the wizard.
    const b = await body()
    if (!str(b.setupCode, 16)) return bad()
    return reply(await gate.acceptSetupCode({ session, loopback, setupCode: b.setupCode }))
  }
  if (path === '/api/vault/authenticator/begin' && req.method === 'POST') {
    // Re-enrolment is gated by the OLD code inside `beginAuthenticator`; the URI is served once.
    const b = await body()
    const label = typeof b.label === 'string' && /^[\w .@-]{1,64}$/.test(b.label) ? b.label : (hostname().replace(/[^\w.-]/g, '') || 'this machine').slice(0, 64)
    const r = await gate.beginAuthenticator({ code: codeOf(b), session, loopback, ...(str(b.setupCode, 16) ? { setupCode: b.setupCode } : {}) }, label)
    return reply(r.ok ? { ok: true, uri: r.uri, secret: r.secret } : r)
  }
  if (path === '/api/vault/authenticator/confirm' && req.method === 'POST') {
    const b = await body()
    if (!str(b.code, 16)) return bad()
    const r = await gate.confirmAuthenticator(b.code, { session })
    // The code just verified (with the vault open) is the step-up: hand back the 5-minute 'read' grant.
    return reply(r.ok ? { ok: true, grant: gate.mintGrant(session, 'read') } : r)
  }
  if (path === '/api/vault/recovery/begin' && req.method === 'POST') {
    // The FIRST recovery key needs only the open vault; a rotation is gated (code + gesture).
    const b = await body()
    const r = await gate.beginRecoveryKey({ code: codeOf(b), session, loopback, ...(str(b.setupCode, 16) ? { setupCode: b.setupCode } : {}) })
    return reply(r.ok ? { ok: true, words: r.words, positions: r.positions } : r)
  }
  if (path === '/api/vault/recovery/confirm' && req.method === 'POST') {
    const b = await body()
    if (!Array.isArray(b.typed) || b.typed.length !== 3 || !b.typed.every(w => str(w, 16))) return bad()
    return reply(await gate.confirmRecoveryKey(b.typed as string[], { session }))
  }
  if (path === '/api/vault/recover' && req.method === 'POST') {
    // v2.98.1: the 24 words from a page ON this computer only. Refused BEFORE the body is read when the
    // request is not loopback, so the words never even reach this process from the network. They are
    // never logged and never echoed; their entropy is zeroed inside recoverWithWords.
    if (!loopback) { await req.body?.cancel().catch(() => {}); return reply(await gate.recoverFromPage('', { session, loopback })) }
    const b = await body()
    if (!str(b.words, 400)) return bad()
    const r = await gate.recoverFromPage(b.words, { session, loopback })
    b.words = ''
    return reply(r.ok ? { ok: true, todo: r.todo } : r)
  }
  if (path === '/api/vault/local-proof' && req.method === 'POST') {
    const r = await gate.proveLocalHuman({ session, loopback })
    return reply(r.ok ? { ok: true, kind: r.kind } : r)
  }
  if (path === '/api/vault/presence/probe' && req.method === 'POST') {
    const b = await body()
    if (b.protector !== 'hello' && b.protector !== 'fido2') return bad()
    return reply(await gate.probePresence(b.protector, { code: codeOf(b), session, loopback }))
  }
  if (path === '/api/vault/presence/progress' && req.method === 'GET') {
    // Polled by the page while its probe / enrolment request is in flight: "confirmation i of n".
    return send({ ok: true, progress: gate.gestureProgress({ session }) }, 200, noStore)
  }
  if (path === '/api/vault/presence/enroll' && req.method === 'POST') {
    const b = await body()
    if (b.protector !== 'hello' && b.protector !== 'fido2') return bad()
    // The 24 words are never accepted here; a page may only choose NEW words (leader decision 2).
    const r = await gate.enrolPresence(b.protector, { code: codeOf(b), session, loopback, ...(b.replaceRecovery === true ? { replaceRecovery: true } : {}) })
    return reply(r.ok ? { ok: true, removed: r.removed, recoveryOwed: r.recoveryOwed, ...('held' in r && r.held ? { held: true } : {}) } : r)
  }
  if (path === '/api/vault/presence/disable' && req.method === 'POST') {
    const b = await body()
    // v2.98.1: the main machine's 24 words may come from a page ON this computer (never from elsewhere).
    const words = loopback && str(b.words, 400) ? b.words : undefined
    const r = await gate.disablePresence({ code: codeOf(b), session, loopback }, words)
    return reply(r.ok ? { ok: true, replacedBy: r.replacedBy } : r)
  }
  if (path === '/api/vault/credentials' && req.method === 'GET') {
    const r = await gate.listCredentials({ grant, session, loopback })
    return reply(r)
  }
  // VAULT.PERSONAL: answered through THIS module's `reply` (the one JSON exit, page filter included).
  const phoneRoute = await handlePhoneHttp({ req, path, url, session, grant, loopback, reply })
  if (phoneRoute) return phoneRoute
  const personal = await handlePersonalHttp({ req, path, url, session, grant, fresh, loopback, reply })
  if (personal) return personal
  return null
}
