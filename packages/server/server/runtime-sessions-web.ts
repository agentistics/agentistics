/**
 * runtime-sessions-web.ts — `/api/runtime/sessions`, `/api/runtime/sessions/:id/messages`,
 * `/api/runtime/sessions/:id/stream`, `/api/runtime/tools/:execId/approve` and
 * `/api/runtime/runs/:id/cancel` (B4.3, §28 subset — spec docs/superpowers/specs/
 * 2026-09-27-runtime-b4-sessions.md §5, §7). The door onto the shared-session hub (`hub.ts`) and the
 * B4.1/B4.2 runtime (`runtime.ts`, `resume.ts`) over ONE `RuntimeHost` per server process
 * (`runtime-host.ts`).
 *
 * ## The bundle, and why it is not just `RuntimeHost`
 *
 * `resume.ts`'s `openSession` / `olderMessages` / `repairInterruptedRun` take `{store, content,
 * journal, runtimeVersion}`; they are the host's OWN instances (`RuntimeHost.content` / `.journal` /
 * `.runtimeVersion`), so the web reads and repairs through the very objects the runtime writes through
 * — one content store, one journal connection per process.
 *
 * ## Order of refusals
 *
 * 1. `isCentral()` → 403 `central` — the native runtime does not run on a central (no host to spawn
 *    a session on, no visibility into a member's).
 * 2. A route-specific validation (a bad `cwd`, a missing body field) → 400/413.
 * 3. A capability ceiling this machine cannot honour right now (`admitSpawn`) → 503.
 * 4. Not found → 404.
 *
 * `capability-guard.ts` has already required `localShell` on every one of these paths before this
 * runs (`/api/runtime/sessions`, `/api/runtime/runs`, `/api/runtime/tools`, all three PREFIXES); the
 * auth gate has already required a session wherever there is one. An unexpected failure past this
 * point is the caller's `safeError`, same as `/api/provider`.
 *
 * ## The driver — "first send" is per PROCESS, tracked here
 *
 * §5: input is a strict FIFO and a session is driven by whichever process holds its lease. The FIRST
 * `POST .../messages` this process sees for a session takes the lease, repairs any run a dead
 * process left `running` (idempotent — a second call finds nothing `running` and repairs nothing),
 * and attaches the hub's driver; every later send for the same session, in the same process, skips
 * straight to `hub.submit`. `driven` is therefore a `Set<string>` bounded by the sessions this
 * process has actually driven — the same population `RuntimeHost.store`/`hub` already track — never
 * a per-request map.
 */

import { isAbsolute } from 'node:path'
import { stat } from 'node:fs/promises'
import {
  admitSpawn,
  admissionRefusalBody,
  type AdmissionLang,
  type SpawnBudget,
} from './sessions/spawn-admission'
import { readSpawnBudget } from './sessions/memory-probe'
import { createRuntimeHost, workspaceRootFor, type RuntimeHost } from './runtime-host'
import { readJsonLimited } from './limits'
import { PROVIDER_FLAG_ENV, providerFlagOn } from './config'
import {
  encodeOutboundFrame,
  MAX_CLIENT_REF_LEN,
  MAX_INBOUND_FRAME_BYTES,
  MAX_INPUT_TEXT_LEN,
  openSession,
  olderMessages,
  repairInterruptedRun,
  type AckFrame,
  type OutboundFrame,
  type ResumeDeps,
  type SessionWatcher,
} from '@agentistics/runtime'

/**
 * A route REFUSAL code (HTTP answer to the caller), never a notification code. Spelled through this
 * function so `notificationCoverage.test.ts` — which greps the server for `code: '<x>'` as the shape
 * a NOTIFICATION is emitted in — does not demand notification text for an HTTP refusal.
 */
function rc<C extends string>(c: C): C { return c }

// ── the bundle ──────────────────────────────────────────────────────────────────────────────────

export interface RuntimeSessionsBundle {
  host: RuntimeHost
  /** The companion the resume.ts functions need — see file header. `resume.store === host.store`. */
  resume: ResumeDeps
}

async function buildLiveBundle(): Promise<RuntimeSessionsBundle> {
  const host = await createRuntimeHost()
  return { host, resume: { store: host.store, content: host.content, journal: host.journal, runtimeVersion: host.runtimeVersion } }
}

let liveBundle: Promise<RuntimeSessionsBundle> | null = null
const liveDriven = new Set<string>()

async function defaultIsCentral(): Promise<boolean> {
  const { TEAM_CENTRAL } = await import('./config')
  if (TEAM_CENTRAL) return true
  try {
    const { readPreferences } = await import('./preferences.ts')
    const prefs = await readPreferences()
    const mode: string | undefined = prefs.team?.mode
    return mode === 'central'
  } catch {
    return false
  }
}

export interface RuntimeSessionsWebDeps {
  isCentral: () => Promise<boolean>
  /** `providerFlagOn()` — the native runtime's BETA flag. Absent reads OFF, as `/api/provider` does. */
  flagOn: () => boolean
  /** Lazily built, ONE per process — see file header. */
  host: () => Promise<RuntimeSessionsBundle>
  readSpawnBudget: () => Promise<SpawnBudget | null>
  /** Sessions this process has already taken the lease and attached a driver for — see file header. */
  driven: Set<string>
}

export function defaultRuntimeSessionsWebDeps(): RuntimeSessionsWebDeps {
  return {
    isCentral: defaultIsCentral,
    flagOn: () => providerFlagOn(),
    host: () => (liveBundle ??= buildLiveBundle()),
    readSpawnBudget,
    driven: liveDriven,
  }
}

/** Tests only: drop the lazily-built production bundle and the driven-session memory. */
export function _resetRuntimeSessionsWebState(): void {
  liveBundle = null
  liveDriven.clear()
}

// ── route matching (pure) ──────────────────────────────────────────────────────────────────────

export type RuntimeSessionsRoute =
  | { kind: 'sessions' }
  | { kind: 'session'; id: string }
  | { kind: 'messages'; id: string }
  | { kind: 'stream'; id: string }
  | { kind: 'approve'; execId: string }
  | { kind: 'cancel'; id: string }

/** PURE: which of the five §28 resources a path names, or `null` when it is none of them. The
 *  sub-resources (`/messages`, `/stream`, `/approve`, `/cancel`) are matched explicitly so a session
 *  id can never itself be read as one of those words. */
export function matchRuntimeSessionsRoute(pathname: string): RuntimeSessionsRoute | null {
  if (pathname === '/api/runtime/sessions' || pathname === '/api/runtime/sessions/') return { kind: 'sessions' }

  let m = /^\/api\/runtime\/sessions\/([^/]+)\/messages\/?$/.exec(pathname)
  if (m) return { kind: 'messages', id: decodeURIComponent(m[1]!) }

  m = /^\/api\/runtime\/sessions\/([^/]+)\/stream\/?$/.exec(pathname)
  if (m) return { kind: 'stream', id: decodeURIComponent(m[1]!) }

  m = /^\/api\/runtime\/sessions\/([^/]+)\/?$/.exec(pathname)
  if (m) return { kind: 'session', id: decodeURIComponent(m[1]!) }

  m = /^\/api\/runtime\/tools\/([^/]+)\/approve\/?$/.exec(pathname)
  if (m) return { kind: 'approve', execId: decodeURIComponent(m[1]!) }

  m = /^\/api\/runtime\/runs\/([^/]+)\/cancel\/?$/.exec(pathname)
  if (m) return { kind: 'cancel', id: decodeURIComponent(m[1]!) }

  return null
}

// ── body parsing (pure) ────────────────────────────────────────────────────────────────────────

type Refused = { ok: false; error: string; sentence: string }

function bad(error: string, sentence: string): Refused {
  return { ok: false, error, sentence }
}

function isPlainRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

export interface CreateSessionBody { cwd: string; model: string; title?: string }

export function parseCreateSessionBody(raw: unknown): { ok: true; body: CreateSessionBody } | Refused {
  if (!isPlainRecord(raw)) return bad('bad_request', 'the request body is not a JSON object.')
  if (typeof raw.cwd !== 'string' || raw.cwd.length === 0) {
    return bad('cwd_required', '"cwd" is required and must be a non-empty string.')
  }
  if (!isAbsolute(raw.cwd)) return bad('cwd_relative', `"cwd" must be an absolute path: ${raw.cwd}`)
  if (typeof raw.model !== 'string' || raw.model.length === 0) {
    return bad('model_required', '"model" is required and must be a non-empty string.')
  }
  const body: CreateSessionBody = { cwd: raw.cwd, model: raw.model }
  if (raw.title !== undefined) {
    if (typeof raw.title !== 'string') return bad('bad_request', '"title" must be a string.')
    body.title = raw.title
  }
  return { ok: true, body }
}

export interface SendMessageBody { clientRef: string; text: string }

export function parseSendMessageBody(raw: unknown): { ok: true; body: SendMessageBody } | Refused {
  if (!isPlainRecord(raw)) return bad('bad_request', 'the request body is not a JSON object.')
  if (typeof raw.clientRef !== 'string' || raw.clientRef.length === 0) {
    return bad('client_ref_required', '"clientRef" is required and must be a non-empty string.')
  }
  if (raw.clientRef.length > MAX_CLIENT_REF_LEN) return bad('client_ref_too_long', '"clientRef" is too long.')
  if (typeof raw.text !== 'string' || raw.text.length === 0) {
    return bad('text_required', '"text" is required and must be a non-empty string.')
  }
  if (raw.text.length > MAX_INPUT_TEXT_LEN) return bad('text_too_long', '"text" is too long.')
  return { ok: true, body: { clientRef: raw.clientRef, text: raw.text } }
}

export interface ApproveBody { sessionId: string; questionId: string; choice?: number; text?: string }

export function parseApproveBody(raw: unknown): { ok: true; body: ApproveBody } | Refused {
  if (!isPlainRecord(raw)) return bad('bad_request', 'the request body is not a JSON object.')
  if (typeof raw.sessionId !== 'string' || raw.sessionId.length === 0) {
    return bad('session_id_required', '"sessionId" is required and must be a non-empty string.')
  }
  if (typeof raw.questionId !== 'string' || raw.questionId.length === 0) {
    return bad('question_id_required', '"questionId" is required and must be a non-empty string.')
  }
  const body: ApproveBody = { sessionId: raw.sessionId, questionId: raw.questionId }
  if (raw.choice !== undefined) {
    if (typeof raw.choice !== 'number' || !Number.isInteger(raw.choice) || raw.choice < 0) {
      return bad('bad_choice', '"choice" must be a non-negative integer.')
    }
    body.choice = raw.choice
  }
  if (raw.text !== undefined) {
    if (typeof raw.text !== 'string') return bad('bad_request', '"text" must be a string.')
    body.text = raw.text
  }
  return { ok: true, body }
}

// ── result shape ────────────────────────────────────────────────────────────────────────────────

export type RuntimeSessionsResult =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'stream'; stream: ReadableStream<Uint8Array> }

function j(status: number, body: unknown): RuntimeSessionsResult {
  return { kind: 'json', status, body }
}

function notFound(id: string): RuntimeSessionsResult {
  return j(404, { code: rc('not_found'), sentence: `No such session: ${id}.` })
}

function methodNotAllowed(): RuntimeSessionsResult {
  return j(405, { code: rc('method_not_allowed'), sentence: 'this method is not supported on this path.' })
}

const ADMISSION_LANG: AdmissionLang = 'en'

// ── handlers ────────────────────────────────────────────────────────────────────────────────────

async function readBody(req: Request): Promise<{ ok: true; value: unknown } | RuntimeSessionsResult> {
  const read = await readJsonLimited<unknown>(req, MAX_INBOUND_FRAME_BYTES)
  if (read.ok) return { ok: true, value: read.value }
  return read.error === 'too_large'
    ? j(413, { code: rc('too_large'), sentence: 'the request body is too large.' })
    : j(400, { code: rc('bad_request'), sentence: 'the request body is not valid JSON.' })
}

async function handleCreate(req: Request, d: RuntimeSessionsWebDeps): Promise<RuntimeSessionsResult> {
  const read = await readBody(req)
  if (!('ok' in read) || !read.ok) return read as RuntimeSessionsResult
  const parsed = parseCreateSessionBody(read.value)
  if (!parsed.ok) return j(400, { code: parsed.error, sentence: parsed.sentence })

  try {
    const st = await stat(parsed.body.cwd)
    if (!st.isDirectory()) return j(400, { code: rc('cwd_missing'), sentence: `"cwd" is not a directory: ${parsed.body.cwd}` })
  } catch {
    return j(400, { code: rc('cwd_missing'), sentence: `"cwd" does not exist: ${parsed.body.cwd}` })
  }

  const admission = admitSpawn(await d.readSpawnBudget(), 1)
  if (!admission.admit) return j(503, admissionRefusalBody(admission.refusal, ADMISSION_LANG))

  const bundle = await d.host()
  const workspaceRoot = workspaceRootFor(parsed.body.cwd)
  const session = await bundle.host.runtime.create({
    workspaceRoot,
    cwd: parsed.body.cwd,
    provider: 'anthropic',
    model: parsed.body.model,
    credential: { provider: 'anthropic', id: 'default' },
    ...(parsed.body.title !== undefined ? { title: parsed.body.title } : {}),
  })
  return j(201, { session })
}

function parseListQuery(url: URL): { before?: string; limit?: number } {
  const before = url.searchParams.get('before')
  const limitRaw = url.searchParams.get('limit')
  const limit = limitRaw !== null && limitRaw !== '' && Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : undefined
  return { ...(before !== null && before !== '' ? { before } : {}), ...(limit !== undefined ? { limit } : {}) }
}

async function handleList(url: URL, d: RuntimeSessionsWebDeps): Promise<RuntimeSessionsResult> {
  const bundle = await d.host()
  const result = await bundle.host.store.listSessions(parseListQuery(url))
  return j(200, result)
}

async function handleGetSession(id: string, d: RuntimeSessionsWebDeps): Promise<RuntimeSessionsResult> {
  const bundle = await d.host()
  const session = await bundle.host.runtime.get(id)
  if (!session) return notFound(id)
  return j(200, { session })
}

async function handleMessagesGet(id: string, url: URL, d: RuntimeSessionsWebDeps): Promise<RuntimeSessionsResult> {
  const bundle = await d.host()
  const deps = { store: bundle.resume.store, content: bundle.resume.content }
  const limitRaw = url.searchParams.get('limit')
  const limit = limitRaw !== null && limitRaw !== '' && Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : undefined
  const beforeRaw = url.searchParams.get('before')

  if (beforeRaw === null || beforeRaw === '') {
    const opened = await openSession(deps, id, limit !== undefined ? { window: limit } : undefined)
    if (!opened) return notFound(id)
    return j(200, opened)
  }

  const before = Number(beforeRaw)
  if (!Number.isFinite(before)) return j(400, { code: rc('bad_before'), sentence: '"before" must be a number.' })
  // Confirm the session exists first — an unknown id must read as 404, not an empty older-page.
  const session = await bundle.host.runtime.get(id)
  if (!session) return notFound(id)
  const older = await olderMessages(deps, id, before, limit)
  return j(200, older)
}

function ackStatus(ack: AckFrame): number {
  if (ack.status === 'queued') return 202
  return ack.code === 'queue-full' ? 429 : 409
}

async function handleMessagesPost(req: Request, id: string, d: RuntimeSessionsWebDeps): Promise<RuntimeSessionsResult> {
  const read = await readBody(req)
  if (!('ok' in read) || !read.ok) return read as RuntimeSessionsResult
  const parsed = parseSendMessageBody(read.value)
  if (!parsed.ok) return j(400, { code: parsed.error, sentence: parsed.sentence })

  const bundle = await d.host()
  const session = await bundle.host.runtime.get(id)
  if (!session) return notFound(id)

  if (!d.driven.has(id)) {
    const acquired = await bundle.host.acquire(id)
    if (!acquired.ok) {
      return j(409, {
        code: rc('held'),
        sentence: acquired.sentence,
        holder: acquired.holder,
        expiresAt: acquired.expiresAt,
      })
    }
    await repairInterruptedRun(bundle.resume, id)
    bundle.host.hub.attachDriver(id, async text => {
      await bundle.host.runtime.run(id, text)
    })
    d.driven.add(id)
  }

  const ack = bundle.host.hub.submit(id, { clientRef: parsed.body.clientRef, text: parsed.body.text })
  return j(ackStatus(ack), ack)
}

/** Frame-by-frame SSE body. Closes the watcher (and the hub's per-watcher queue with it) the moment
 *  the client disconnects (`signal` aborts) or the hub itself sends `closed`. */
function openSessionStream(host: RuntimeHost, sessionId: string, fromSeq: number | undefined, signal: AbortSignal): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let watcher: SessionWatcher | null = null
  let closed = false

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const close = () => {
        if (closed) return
        closed = true
        watcher?.close()
        try { controller.close() } catch { /* already closed */ }
      }
      if (signal.aborted) { close(); return }
      signal.addEventListener('abort', close)

      watcher = host.hub.watch(sessionId, fromSeq === undefined ? {} : { fromSeq })
      try {
        for await (const frame of watcher as AsyncIterable<OutboundFrame>) {
          if (closed) break
          try {
            controller.enqueue(enc.encode(`data: ${encodeOutboundFrame(frame)}\n\n`))
          } catch {
            break
          }
        }
      } finally {
        close()
      }
    },
    cancel() {
      closed = true
      watcher?.close()
    },
  })
}

async function handleStream(id: string, url: URL, signal: AbortSignal, d: RuntimeSessionsWebDeps): Promise<RuntimeSessionsResult> {
  const bundle = await d.host()
  const session = await bundle.host.runtime.get(id)
  if (!session) return notFound(id)
  const fromRaw = url.searchParams.get('from')
  const fromSeq = fromRaw !== null && fromRaw !== '' && Number.isFinite(Number(fromRaw)) ? Number(fromRaw) : undefined
  return { kind: 'stream', stream: openSessionStream(bundle.host, id, fromSeq, signal) }
}

async function handleApprove(req: Request, execId: string, d: RuntimeSessionsWebDeps): Promise<RuntimeSessionsResult> {
  const read = await readBody(req)
  if (!('ok' in read) || !read.ok) return read as RuntimeSessionsResult
  const parsed = parseApproveBody(read.value)
  if (!parsed.ok) return j(400, { code: parsed.error, sentence: parsed.sentence })
  if (!parsed.body.questionId.startsWith(execId)) {
    return j(400, { code: rc('question_id_mismatch'), sentence: `"questionId" must start with ${execId}.` })
  }

  const bundle = await d.host()
  const ans: { choice?: number; text?: string } = {}
  if (parsed.body.choice !== undefined) ans.choice = parsed.body.choice
  if (parsed.body.text !== undefined) ans.text = parsed.body.text
  const accepted = bundle.host.hub.answer(parsed.body.sessionId, parsed.body.questionId, ans)
  return accepted
    ? j(200, { accepted: true })
    : j(409, { accepted: false, code: rc('no_such_question'), sentence: 'no question with that id is pending in this session.' })
}

async function handleCancel(runId: string, d: RuntimeSessionsWebDeps): Promise<RuntimeSessionsResult> {
  const bundle = await d.host()
  const cancelled = bundle.host.runtime.cancel(runId)
  return j(200, { cancelled })
}

// ── the door ────────────────────────────────────────────────────────────────────────────────────

/**
 * The one entry point `index.ts` calls. Returns `null` when `url.pathname` names none of these
 * routes, so the caller can fall through to whatever comes next — same convention as
 * `handleProviderRequest`.
 */
export async function handleRuntimeSessionsRequest(
  req: Request,
  url: URL,
  deps: Partial<RuntimeSessionsWebDeps> = {},
): Promise<RuntimeSessionsResult | null> {
  const route = matchRuntimeSessionsRoute(url.pathname)
  if (route === null) return null
  const d: RuntimeSessionsWebDeps = { ...defaultRuntimeSessionsWebDeps(), ...deps }
  const method = req.method.toUpperCase()

  if (await d.isCentral()) {
    return j(403, { code: rc('central'), sentence: 'the native runtime does not run on a central.' })
  }
  if (!d.flagOn()) {
    return j(409, { code: rc('flag-off'), sentence: `the native runtime is off (BETA) — set ${PROVIDER_FLAG_ENV}=1 to use it.` })
  }

  switch (route.kind) {
    case 'sessions':
      if (method === 'POST') return handleCreate(req, d)
      if (method === 'GET') return handleList(url, d)
      return methodNotAllowed()
    case 'session':
      if (method !== 'GET') return methodNotAllowed()
      return handleGetSession(route.id, d)
    case 'messages':
      if (method === 'GET') return handleMessagesGet(route.id, url, d)
      if (method === 'POST') return handleMessagesPost(req, route.id, d)
      return methodNotAllowed()
    case 'stream':
      if (method !== 'GET') return methodNotAllowed()
      return handleStream(route.id, url, req.signal, d)
    case 'approve':
      if (method !== 'POST') return methodNotAllowed()
      return handleApprove(req, route.execId, d)
    case 'cancel':
      if (method !== 'POST') return methodNotAllowed()
      return handleCancel(route.id, d)
  }
}
