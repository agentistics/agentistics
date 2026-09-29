import { cacheKind, etagMatches, etagOf, staticCacheControl } from './static-cache'
import { join } from 'path'
import { spawn } from 'child_process'
import { stat } from 'fs/promises'
import chokidar from 'chokidar'
import { SESSION_META_DIR, PROJECTS_DIR, STATS_CACHE_FILE, PORT, TEAM_CENTRAL, CODEX_SESSIONS_DIR, GEMINI_DIR, COPILOT_DIR, ANTIGRAVITY_BRAIN_DIR, ANTIGRAVITY_CONVERSATIONS_DIR } from './config'
import { centralManifest, centralHtml } from './central-branding'
import { invalidateCache } from './data'
import { mirrorFile } from './archive'
import { getEnabledAdapters } from './adapters/types'
import { addStoredNotification } from './notifications-store'
import type { NotificationSubject } from './notifications-authority'

export type SseController = ReadableStreamDefaultController<Uint8Array>

export const sseClients = new Set<SseController>()
export const sseEncoder = new TextEncoder()

export function notifySseClients() {
  const payload = sseEncoder.encode('event: change\ndata: {}\n\n')
  for (const ctrl of [...sseClients]) {
    try {
      ctrl.enqueue(payload)
    } catch {
      sseClients.delete(ctrl)
    }
  }
}

/** Push a user-facing notification to all connected SSE clients (toast + bell).
 *  Prefer `code` (localized on the frontend) with optional `meta`; `title`/`message`
 *  are a fallback for pre-localized text. */
export function broadcastNotification(n: {
  type: 'error' | 'warning' | 'info' | 'success'
  code?: string
  meta?: Record<string, unknown>
  title?: string
  message?: string
  /** What this notification is about, for role/team scoping on a central — see
   *  notifications-authority.ts. Omit for a genuinely instance-wide notification. */
  subject?: NotificationSubject
}) {
  // Persist FIRST, and independently of whether anyone is listening: a notification raised while
  // no dashboard is open (or only a phone that is asleep) still belongs in the history. Clients
  // that receive the SSE event below just refetch — they never write it themselves, so the id is
  // the server's and every device dismisses the same row.
  addStoredNotification(n).catch(err => console.error('[notifications] failed to persist', err))
  // The SSE FRAME carries NOTHING about the notification itself — it is a refresh signal only.
  // `sseClients` is a flat, unauthenticated broadcast set with no principal attached (unlike
  // GET /api/notifications, which scopes by `Viewer.entitlement`), so putting `code`/`meta`/
  // `subject` on the wire here would hand every open tab — any signed-in account, any role — the
  // full body of a notification the entitlement check in notifications-authority.ts exists to
  // withhold from it. Every listener (`useNotificationStream.ts`) already just re-fetches the
  // already-scoped `/api/notifications` on this event; it never reads the payload.
  const payload = sseEncoder.encode('event: notification\ndata: {}\n\n')
  for (const ctrl of [...sseClients]) {
    try {
      ctrl.enqueue(payload)
    } catch {
      sseClients.delete(ctrl)
    }
  }
}

let sseDebounce: ReturnType<typeof setTimeout> | null = null

export function triggerSseNotification() {
  invalidateCache()
  if (sseDebounce) clearTimeout(sseDebounce)
  sseDebounce = setTimeout(notifySseClients, 2000)
  // Member push-on-change: local data changed → nudge a debounced push to the central so its
  // aggregate stays fresh while you work. No-op on a central/solo instance.
  import('./team-uploader').then(m => m.notifyDataChanged()).catch(() => {})
}

/** Default noise filter for harness roots. */
const DEFAULT_IGNORED = /(^|[/\\])(\.git|node_modules|plugins|cache|\.tmp|shell_snapshots|skills|memories|log|logs|bin|antigravity|history|ide|pkg)([/\\]|$)/

export async function setupFileWatcher() {
  const watch = (dir: string, ignored: RegExp = DEFAULT_IGNORED) => {
    const watcher = chokidar.watch(dir, {
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      // Depth cap + ignore noisy trees. Harness roots like ~/.claude and ~/.codex
      // contain huge plugin caches, temp git clones, sqlite logs and snapshots that
      // would saturate the watcher (and throw EINVAL) if traversed.
      depth: 6,
      ignored: (p: string) => ignored.test(p) || /\.sqlite/.test(p),
    })
    watcher.on('all', (event: string, path: string) => {
      // Mirror new/changed source files into the archive before notifying clients,
      // so deleted-by-cleanup history is preserved as it is written.
      if (typeof path === 'string' && (event === 'add' || event === 'change')) {
        void mirrorFile(path)
      }
      triggerSseNotification()
    })
    watcher.on('error', (err: unknown) => {
      console.warn(`[watcher] Could not watch ${dir}:`, String(err))
    })
    console.log(`[watcher] Watching ${dir}`)
  }

  // Claude core paths
  watch(SESSION_META_DIR)
  watch(PROJECTS_DIR)
  watch(STATS_CACHE_FILE)

  // Additional harnesses: watch ONLY each harness's session directory — NOT its
  // whole data root (adapter.dataRoot). Roots like ~/.codex contain .tmp plugin
  // clones, an 18MB sqlite log, caches, etc.; watching them recursively saturates
  // chokidar and starves the request handler. Claude is already covered above.
  // Inside brain/<conversation-id>/ only .git / node_modules noise is worth skipping.
  const ANTIGRAVITY_IGNORED = /(^|[/\\])(\.git|node_modules)([/\\]|$)/
  const HARNESS_SESSION_DIRS: Partial<Record<string, string>> = {
    codex: CODEX_SESSIONS_DIR,
    gemini: join(GEMINI_DIR, 'tmp'),
    copilot: join(COPILOT_DIR, 'session-state'),
    antigravity: ANTIGRAVITY_BRAIN_DIR,
  }
  try {
    const adapters = await getEnabledAdapters()
    const seen = new Set<string>([SESSION_META_DIR, PROJECTS_DIR, STATS_CACHE_FILE])
    for (const adapter of adapters) {
      const dir = HARNESS_SESSION_DIRS[adapter.id]
      if (!dir || seen.has(dir)) continue
      seen.add(dir)
      try {
        await stat(dir)
        // Antigravity's transcripts live in .system_generated/logs/, which the default
        // filter's `logs` rule would drop — watch that tree with a narrower filter.
        watch(dir, adapter.id === 'antigravity' ? ANTIGRAVITY_IGNORED : DEFAULT_IGNORED)
        if (adapter.id === 'antigravity') {
          // Antigravity's tokens / model / cost live ONLY in conversations/<id>.db, in a
          // different tree from the transcripts. Without this, a turn that only updates
          // gen_metadata (no new transcript step) never refreshes the dashboard.
          // The `-wal`/`-shm` sidecars agy itself writes are ignored: they change constantly and
          // carry no data we read (we open the DBs immutable).
          try {
            await stat(ANTIGRAVITY_CONVERSATIONS_DIR)
            if (!seen.has(ANTIGRAVITY_CONVERSATIONS_DIR)) {
              seen.add(ANTIGRAVITY_CONVERSATIONS_DIR)
              watch(ANTIGRAVITY_CONVERSATIONS_DIR, /(-wal|-shm|-journal)$/)
            }
          } catch {
            console.log(`[watcher] Skipping ${ANTIGRAVITY_CONVERSATIONS_DIR} (not found)`)
          }
        }
      } catch {
        // Directory doesn't exist yet — skip; data.ts re-scans on every request.
        console.log(`[watcher] Skipping ${dir} (not found)`)
      }
    }
  } catch (err) {
    console.warn('[watcher] Could not resolve harness adapters:', String(err))
  }
}

export function maybeSpawnWatcher() {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return

  const watcherPath = join(import.meta.dir, '..', 'watcher.ts')
  console.log('[server] OTEL_EXPORTER_OTLP_ENDPOINT is set — spawning watcher daemon...')

  const child = spawn('bun', ['run', watcherPath], {
    stdio: 'inherit',
    env: process.env,
  })

  child.on('error', (err) => {
    console.error('[watcher] Failed to spawn:', err.message)
  })

  child.on('exit', (code, signal) => {
    const expectedSignal = signal === 'SIGTERM' || signal === 'SIGINT'
    if (code !== 0 || (signal !== null && !expectedSignal)) {
      console.warn(`[watcher] OTel watcher daemon exited unexpectedly (code=${code} signal=${signal}). OTel metrics export has stopped.`)
    }
  })

  const killChild = () => {
    process.removeListener('exit', killChild)
    process.removeListener('SIGINT', killChild)
    process.removeListener('SIGTERM', killChild)
    if (!child.killed) child.kill()
  }
  process.once('exit', killChild)
  process.once('SIGINT', killChild)
  process.once('SIGTERM', killChild)

  // If the child exits naturally, clean up the process-level handlers too
  child.on('exit', () => {
    process.removeListener('exit', killChild)
    process.removeListener('SIGINT', killChild)
    process.removeListener('SIGTERM', killChild)
  })
}

const SERVE_STATIC = process.env.SERVE_STATIC === '1'

// embeddedDist is only available after `bun run build:assets` (binary mode).
// In dev mode (SERVE_STATIC is never set), this import is skipped entirely.
const embeddedDist: Record<string, { content: string; encoding: string; contentType: string }> =
  SERVE_STATIC
    ? (await import('./embedded-dist.generated.ts')).embeddedDist
    : {}

export { SERVE_STATIC }

export function serveStatic(pathname: string, ifNoneMatch?: string | null): Response | null {
  if (!SERVE_STATIC) return null
  const asset = embeddedDist[pathname]
  if (!asset) return null
  let body =
    asset.encoding === 'base64'
      ? Buffer.from(asset.content, 'base64')
      : asset.content
  // A central serves the same bundle as a machine, so its installed PWA was identical in the
  // dock — same icon, same name. Re-brand the two files the browser reads for that identity as
  // they go out; the mode is only known at runtime, so it cannot be baked into the build.
  if (TEAM_CENTRAL && (pathname === '/manifest.webmanifest' || pathname === '/index.html')) {
    // Read through WHICHEVER encoding the embedder chose. `.webmanifest` was not on its text-
    // extension list, so it arrived here base64-encoded and a `typeof body === 'string'` guard
    // skipped the rewrite in silence — the central installed with the machine's icon anyway.
    const text = typeof body === 'string' ? body : body.toString('utf-8')
    body = pathname === '/index.html' ? centralHtml(text) : centralManifest(text)
  }
  // What a browser may keep is decided by `static-cache.ts`: the shell never, hashed assets and
  // fonts for a year, and everything whose URL stays put while its artwork changes (icons,
  // favicons, logos) is revalidated — a year-long lifetime there pinned a rebranded logo, and an
  // installed PWA's icon, to whichever version the browser saw first.
  const kind = cacheKind(pathname)
  const extraHeaders: Record<string, string> = pathname === '/sw.js'
    ? { 'Service-Worker-Allowed': '/' }
    : {}
  const headers: Record<string, string> = {
    'Content-Type': asset.contentType, 'Cache-Control': staticCacheControl(pathname), ...extraHeaders,
  }
  if (kind === 'revalidate') {
    const etag = etagOf(body)
    headers['ETag'] = etag
    if (etagMatches(ifNoneMatch, etag)) return new Response(null, { status: 304, headers })
  }
  return new Response(body, { status: 200, headers })
}
