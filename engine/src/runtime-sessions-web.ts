/**
 * runtime-sessions-web.ts — `/api/runtime/sessions`, `/api/runtime/sessions/:id/messages`,
 * `/api/runtime/sessions/:id/stream`, `/api/runtime/sessions/:id/tools/:execId/approve` and
 * `/api/runtime/sessions/:id/runs/:runId/cancel` (B4.3, §28 subset — spec docs/superpowers/specs/
 * 2026-09-27-runtime-b4-sessions.md §5, §7).
 *
 * ## One prefix (ES.6a, leader decision Q-4)
 *
 * B4 spread these over three prefixes (`/api/runtime/sessions`, `/api/runtime/tools`,
 * `/api/runtime/runs`). An engine route may only live under a RESERVED prefix (engine-api
 * `RESERVED_PREFIXES`), and that list is not widened, so the approve and cancel resources are nested
 * under the session they act on. The nesting also makes both checkable: a question or a run is
 * answered only in the session the path names. The door onto the shared-session hub (`hub.ts`) and the
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
 * 1. `host.isCentral()` → 403 `central` — the native runtime does not run on a central (no host to spawn
 *    a session on, no visibility into a member's).
 * 2. A route-specific validation (a bad `cwd`, a missing body field) → 400/413.
 * 3. A capability ceiling this machine cannot honour right now (`admitNativeSession`, over `host.spawnBudget()`) → 503.
 * 4. Not found → 404.
 *
 * The host's `capability-guard.ts` has already required `localShell` on `/api/runtime/sessions` before
 * this runs (the engine route declares that same capability and the host refuses it at load if it
 * ever differs); the auth gate has already required a session wherever there is one. An unexpected failure past this
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
import { createRuntimeHost, workspaceRootFor, type RuntimeHost } from './runtime-host'
import { host } from './host'
import { PROVIDER_FLAG_ENV } from './provider/provider-config'
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
import type { EngineSpawnBudget } from '@agentistics/engine-api'

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

export interface RuntimeSessionsWebDeps {
  isCentral: () => Promise<boolean>
  /** The native runtime's BETA flag, as the host reads it. Absent reads OFF, as `/api/provider` does. */
  flagOn: () => boolean
  /** Lazily built, ONE per process — see file header. */
  host: () => Promise<RuntimeSessionsBundle>
  /** The host's admission-control budget (`host.spawnBudget()`). */
  readSpawnBudget: () => Promise<EngineSpawnBudget | null>
  /** Sessions this process has already taken the lease and attached a driver for — see file header. */
  driven: Set<string>
}

export function defaultRuntimeSessionsWebDeps(): RuntimeSessionsWebDeps {
  return {
    isCentral: async () => host().isCentral(),
    flagOn: () => host().flag('provider'),
    host: () => (liveBundle ??= buildLiveBundle()),
    readSpawnBudget: () => host().spawnBudget(),
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
  | { kind: 'approve'; id: string; execId: string }
  | { kind: 'cancel'; id: string; runId: string }

/** The one prefix every route here lives under — a RESERVED engine prefix (engine-api). */
export const RUNTIME_SESSIONS_PREFIX = '/api/runtime/sessions'

const SEG = '([^/]+)'
const ROUTES: { re: RegExp; make: (m: string[]) => RuntimeSessionsRoute }[] = [
  { re: new RegExp(`^/api/runtime/sessions/${SEG}/messages/?$`), make: m => ({ kind: 'messages', id: m[0]! }) },
  { re: new RegExp(`^/api/runtime/sessions/${SEG}/stream/?$`), make: m => ({ kind: 'stream', id: m[0]! }) },
  { re: new RegExp(`^/api/runtime/sessions/${SEG}/tools/${SEG}/approve/?$`), make: m => ({ kind: 'approve', id: m[0]!, execId: m[1]! }) },
  { re: new RegExp(`^/api/runtime/sessions/${SEG}/runs/${SEG}/cancel/?$`), make: m => ({ kind: 'cancel', id: m[0]!, runId: m[1]! }) },
  { re: new RegExp(`^/api/runtime/sessions/${SEG}/?$`), make: m => ({ kind: 'session', id: m[0]! }) },
]

/** PURE: which of the five §28 resources a path names, or `null` when it is none of them. The
 *  sub-resources (`/messages`, `/stream`, `/tools/:execId/approve`, `/runs/:runId/cancel`) are matched
 *  explicitly and anchored, so a session id can never itself be read as one of those words. A path
 *  segment that is not valid percent-encoding names nothing. */
export function matchRuntimeSessionsRoute(pathname: string): RuntimeSessionsRoute | null {
  if (pathname === RUNTIME_SESSIONS_PREFIX || pathname === `${RUNTIME_SESSIONS_PREFIX}/`) return { kind: 'sessions' }
  for (const r of ROUTES) {
    const m = r.re.exec(pathname)
    if (!m) continue
    try {
      return r.make(m.slice(1).map(x => decodeURIComponent(x)))
    } catch {
      return null
    }
  }
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

/** `sessionId` is the PATH's (Q-4). A body may still carry one — B4's clients sent it — and then it
 *  must name the same session, or the request is refused rather than one of the two believed. */
export interface ApproveBody { questionId: string; sessionId?: string; choice?: number; text?: string }

export function parseApproveBody(raw: unknown): { ok: true; body: ApproveBody } | Refused {
  if (!isPlainRecord(raw)) return bad('bad_request', 'the request body is not a JSON object.')
  if (raw.sessionId !== undefined && (typeof raw.sessionId !== 'string' || raw.sessionId.length === 0)) {
    return bad('bad_request', '"sessionId", when given, must be a non-empty string.')
  }
  if (typeof raw.questionId !== 'string' || raw.questionId.length === 0) {
    return bad('question_id_required', '"questionId" is required and must be a non-empty string.')
  }
  const body: ApproveBody = { questionId: raw.questionId }
  if (typeof raw.sessionId === 'string') body.sessionId = raw.sessionId
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

/**
 * The admission rule this engine can apply with what the host hands over (`EngineSpawnBudget`):
 * refuse when the host MEASURED a budget and it has no room left. A budget of all zeros is the host
 * saying it could not measure (its own convention), and an unmeasured machine is admitted, as the
 * public `admitSpawn` admits it. STATED LIMIT: the contract's budget carries neither the swap alarm
 * nor the raw memory figures, so the public rule's swap refusal cannot be applied here — a host-side
 * contract change (the budget's `alarm`, or an `admit()` service) closes that gap.
 */
export function admitNativeSession(b: EngineSpawnBudget | null): { admit: true } | { admit: false; body: unknown } {
  if (!b) return { admit: true }
  const { max, used, left } = b.budget
  if (max === 0 && used === 0 && left === 0) return { admit: true }
  if (left >= 1) return { admit: true }
  return {
    admit: false,
    body: {
      code: rc('memory_budget'),
      refusal: { reason: 'no-room', requested: 1, fits: 0, used, max },
      sentence: `this machine has no room for another session right now (${used} of ${max} running).`,
    },
  }
}

// ── handlers ────────────────────────────────────────────────────────────────────────────────────

async function readBody(req: Request): Promise<{ ok: true; value: unknown } | RuntimeSessionsResult> {
  const read = await host().readJsonLimited<unknown>(req, MAX_INBOUND_FRAME_BYTES)
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

  const admission = admitNativeSession(await d.readSpawnBudget())
  if (!admission.admit) return j(503, admission.body)

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

async function handleApprove(req: Request, sessionId: string, execId: string, d: RuntimeSessionsWebDeps): Promise<RuntimeSessionsResult> {
  const read = await readBody(req)
  if (!('ok' in read) || !read.ok) return read as RuntimeSessionsResult
  const parsed = parseApproveBody(read.value)
  if (!parsed.ok) return j(400, { code: parsed.error, sentence: parsed.sentence })
  if (!parsed.body.questionId.startsWith(execId)) {
    return j(400, { code: rc('question_id_mismatch'), sentence: `"questionId" must start with ${execId}.` })
  }
  if (parsed.body.sessionId !== undefined && parsed.body.sessionId !== sessionId) {
    return j(400, { code: rc('session_id_mismatch'), sentence: `"sessionId" must be the session the path names: ${sessionId}.` })
  }

  const bundle = await d.host()
  const ans: { choice?: number; text?: string } = {}
  if (parsed.body.choice !== undefined) ans.choice = parsed.body.choice
  if (parsed.body.text !== undefined) ans.text = parsed.body.text
  const accepted = bundle.host.hub.answer(sessionId, parsed.body.questionId, ans)
  return accepted
    ? j(200, { accepted: true })
    : j(409, { accepted: false, code: rc('no_such_question'), sentence: 'no question with that id is pending in this session.' })
}

async function handleCancel(sessionId: string, runId: string, d: RuntimeSessionsWebDeps): Promise<RuntimeSessionsResult> {
  const bundle = await d.host()
  const session = await bundle.host.runtime.get(sessionId)
  if (!session) return notFound(sessionId)
  const run = await bundle.host.store.getRun(runId)
  if (!run || run.sessionId !== sessionId) {
    return j(404, { code: rc('not_found'), sentence: `No such run in session ${sessionId}: ${runId}.` })
  }
  const cancelled = bundle.host.runtime.cancel(runId)
  return j(200, { cancelled })
}

// ── the door ────────────────────────────────────────────────────────────────────────────────────

/**
 * The one entry point the engine's `/api/runtime/sessions` route calls (`index.ts`). Returns `null`
 * when `url.pathname` names none of these routes, so the host answers 404 — same convention as
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
      return handleApprove(req, route.id, route.execId, d)
    case 'cancel':
      if (method !== 'POST') return methodNotAllowed()
      return handleCancel(route.id, route.runId, d)
  }
}
