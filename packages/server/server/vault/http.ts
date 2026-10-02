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
import * as gate from './gate'
import { readVaultView, lockVaultNow } from './inventory'
import { noteVaultActivity, unlockWithGesture, vaultLang, vaultStatus } from './service'

export interface VaultHttpEnv {
  /** CORS headers the host adds to every answer. */
  cors: Record<string, string>
  /** What a 'read' grant is bound to: the HTTP session, or one fixed value on a local profile. */
  session: string
}

const statusOf = (code: unknown): number => (code === 'stepup-required' ? 401 : code === 'bad-request' ? 400 : 403)

/** Answers a `/api/vault*` request, or `null` for a path that is not one of ours. */
export async function handleVaultHttp(req: Request, url: URL, env: VaultHttpEnv): Promise<Response | null> {
  const json = { ...env.cors, 'Content-Type': 'application/json' }
  const noStore = { ...json, 'Cache-Control': 'no-store' }
  const grant = req.headers.get('x-vault-grant')
  const session = env.session
  const path = url.pathname
  const body = async (): Promise<Record<string, unknown>> => {
    const r = await readJsonLimited<Record<string, unknown>>(req, 4096)
    return r.ok && r.value && typeof r.value === 'object' ? r.value : {}
  }
  const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
  const codeOf = (b: Record<string, unknown>): string | undefined => (str(b.code, 16) ? b.code : undefined)
  const reply = (r: { ok: boolean } & Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ ...r, ...extra }), { status: r.ok ? 200 : statusOf(r.code), headers: noStore })
  const bad = () => reply({ ok: false, code: 'bad-request', sentence: vaultLang() === 'pt' ? 'Requisição inválida.' : 'Bad request.' })

  if (path === '/api/vault' && req.method === 'GET') {
    // The inventory only after a step-up (`list`); the state alone is always readable.
    const s = await vaultStatus()
    if (s.state !== 'open') return new Response(JSON.stringify({ ...(await readVaultView([], async () => [])), locked: true }), { headers: noStore })
    const g = await gate.requireVaultStepUp('list', { grant, session })
    if (!g.ok) {
      return new Response(JSON.stringify({
        needsStepUp: true, code: g.code, sentence: g.sentence, state: s.state, lockedBy: s.lockedBy ?? null,
        // What the screen needs to draw the step-up prompt itself — facts only, never an inventory.
        view: { ...(await readVaultView([], async () => [])), locked: false },
      }), { status: statusOf(g.code), headers: noStore })
    }
    return new Response(JSON.stringify(await readVaultView()), { headers: noStore })
  }
  if (path === '/api/vault/stepup' && req.method === 'POST') {
    const b = await body()
    if (!str(b.code, 16)) return bad()
    return reply(await gate.stepUpForRead(b.code, session))
  }
  if (path === '/api/vault/lock' && req.method === 'POST') {
    const b = await body()
    const r = await lockVaultNow({ grant, session, code: codeOf(b) })
    return new Response(JSON.stringify(r.ok ? { ok: true, vault: await readVaultView([], async () => []) } : { error: r.error, code: r.code, sentence: r.error }), { status: r.ok ? 200 : statusOf(r.code), headers: noStore })
  }
  if (path === '/api/vault/unlock' && req.method === 'POST') {
    // Raises the gesture IN THE SERVICE; the code follows on /unlock/code (§2.2).
    const u = await unlockWithGesture()
    return reply(u.ok ? { ok: true, state: u.state } : u)
  }
  if (path === '/api/vault/unlock/code' && req.method === 'POST') {
    const b = await body()
    if (!str(b.code, 16)) return bad()
    return reply(await gate.completeUnlock(b.code))
  }
  if (path === '/api/vault/auto-lock' && req.method === 'POST') {
    const b = await body()
    return reply(await gate.setAutoLockMinutes(b.minutes, { grant, session, code: codeOf(b) }))
  }
  if (path === '/api/vault/activity' && req.method === 'POST') {
    // The dashboard's input heartbeat (§5.1): human interaction resets the idle clock.
    noteVaultActivity()
    return new Response(JSON.stringify({ ok: true }), { headers: noStore })
  }

  // ── SECRETS.4 §7.1: the enrolment wizard and the sections' actions ────────────────────────────

  if (path === '/api/vault/authenticator/begin' && req.method === 'POST') {
    // Re-enrolment is gated by the OLD code inside `beginAuthenticator`; the URI is served once.
    const b = await body()
    const label = typeof b.label === 'string' && /^[\w .@-]{1,64}$/.test(b.label) ? b.label : (hostname().replace(/[^\w.-]/g, '') || 'this machine').slice(0, 64)
    const r = await gate.beginAuthenticator({ code: codeOf(b), session }, label)
    return reply(r.ok ? { ok: true, uri: r.uri, secret: r.secret } : r)
  }
  if (path === '/api/vault/authenticator/confirm' && req.method === 'POST') {
    const b = await body()
    if (!str(b.code1, 16) || !str(b.code2, 16)) return bad()
    return reply(await gate.confirmAuthenticator(b.code1, b.code2))
  }
  if (path === '/api/vault/recovery/begin' && req.method === 'POST') {
    // The FIRST recovery key needs only the open vault; a rotation is gated (code + gesture).
    const b = await body()
    const r = await gate.beginRecoveryKey({ code: codeOf(b), session })
    return reply(r.ok ? { ok: true, words: r.words, positions: r.positions } : r)
  }
  if (path === '/api/vault/recovery/confirm' && req.method === 'POST') {
    const b = await body()
    if (!Array.isArray(b.typed) || b.typed.length !== 3 || !b.typed.every(w => str(w, 16))) return bad()
    return reply(await gate.confirmRecoveryKey(b.typed as string[]))
  }
  if (path === '/api/vault/recover' && req.method === 'POST') {
    // §4.3: the 24 words are typed on a terminal, never into a web form. The page hands off.
    await req.body?.cancel().catch(() => {})
    return reply({
      ok: false, code: 'recover-tty-only',
      sentence: vaultLang() === 'pt'
        ? 'A chave de recuperação é digitada só em um terminal, nesta máquina: rode `agentop vault recover`. Ela nunca é digitada em uma página.'
        : 'The recovery key is typed only on a terminal, on this machine: run `agentop vault recover`. It is never typed into a page.',
    })
  }
  if (path === '/api/vault/presence/enroll' && req.method === 'POST') {
    const b = await body()
    if (b.protector !== 'hello' && b.protector !== 'fido2') return bad()
    const r = await gate.enrolPresence(b.protector, { code: codeOf(b), session })
    return reply(r.ok ? { ok: true, removed: r.removed } : r)
  }
  if (path === '/api/vault/presence/disable' && req.method === 'POST') {
    // Never takes the 24 words: on the owner's machine it refuses and points at the terminal verb.
    const b = await body()
    const r = await gate.disablePresence({ code: codeOf(b), session })
    return reply(r.ok ? { ok: true, replacedBy: r.replacedBy } : r)
  }
  if (path === '/api/vault/credentials' && req.method === 'GET') {
    const r = await gate.listCredentials({ grant, session })
    return reply(r)
  }
  return null
}
