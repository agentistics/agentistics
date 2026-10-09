import { cacheKind, etagMatches, etagOf, staticCacheControl } from './static-cache'
import { join } from 'path'
import { spawn } from 'child_process'
import { stat } from 'fs/promises'
import { watch as fsWatch, statSync } from 'fs'
import { watchedEvent, WATCH_DEPTH } from './watch-filter'
import chokidar from 'chokidar'
import { SESSION_META_DIR, PROJECTS_DIR, STATS_CACHE_FILE, PORT, TEAM_CENTRAL, CODEX_SESSIONS_DIR, GEMINI_DIR, COPILOT_DIR, ANTIGRAVITY_BRAIN_DIR, ANTIGRAVITY_CONVERSATIONS_DIR, KIMI_DIR } from './config'
import { featureOn, type HarnessId } from '@agentistics/core'
import { harnessOfPath, noteTranscriptActivity } from './sessions/transcript-activity'
import { centralManifest, centralHtml } from './central-branding'
import { invalidateCache, rebuildNow, useWatcherDrivenRefresh } from './data'
import { createRebuildScheduler } from './rebuild-scheduler'
import { mirrorFile } from './archive'
import { getEnabledAdapters } from './adapters/types'
import { addStoredNotification } from './notifications-store'
import type { NotificationSubject } from './notifications-authority'

export type SseController = ReadableStreamDefaultController<Uint8Array>

export const sseClients = new Set<SseController>()
export const sseEncoder = new TextEncoder()

export async function notifySseClients() {
  if (sseClients.size === 0) return
  let event = 'event: change\ndata: {}\n\n'
  if (!TEAM_CENTRAL && featureOn('adapter-chat')) {
    try {
      const [{ buildApiResponse }, { patchDataBuild }] = await Promise.all([import('./data'), import('./data-patch')])
      const patch = patchDataBuild(await buildApiResponse())
      if (patch) event = `event: data-patch\ndata: ${JSON.stringify(patch)}\n\nevent: change\ndata: ${JSON.stringify({ revision: patch.revision })}\n\n`
    } catch { /* A client can recover through its ordinary data GET. */ }
  }
  const payload = sseEncoder.encode(event)
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

// PERF.1: a change REBUILDS the data, and clients hear `change` only once the new data exists — not
// two seconds after the write, when their refetch was answered from the stale cache and the fresh
// build that followed was never announced (every dashboard sat one change behind).
const rebuilds = createRebuildScheduler({
  build: rebuildNow,
  onRebuilt: notifySseClients,
  debounceMs: 300,
  // Idle time after a build, 4x its duration, 5–10 s: the rebuild storm (rebuild-scheduler.ts).
  // PERF.1 step 1: the floor was 2 s when a build took 1–2 s, so 4x the build set the pace (~5–8 s
  // between builds). Builds now take ~0.1–0.3 s and the 2 s floor became the pace: ~28 builds a minute
  // with three sessions writing — cheap each, ~8 % of a core together. 5 s keeps the dashboard as fresh
  // as it was (and as fresh as its own 5 s fleet poll) at under half the builds.
  minGapMs: 5000,
  maxGapMs: 10_000,
  loadFactor: 4,
})

let rebuildOnChange = false
let sseDebounce: ReturnType<typeof setTimeout> | null = null

/**
 * Turned on by the SERVER at boot: only a process that serves `/api/data` rebuilds it eagerly. Other
 * callers of `triggerSseNotification` (the team modules, their tests, the CLI) keep the cheap path —
 * mark the cache stale, nudge listeners — rather than starting a full build in the background.
 */
export function enableRebuildOnChange(): void { rebuildOnChange = true; useWatcherDrivenRefresh() }

export function triggerSseNotification() {
  if (rebuildOnChange) rebuilds.changed()
  else {
    invalidateCache()
    if (sseDebounce) clearTimeout(sseDebounce)
    sseDebounce = setTimeout(notifySseClients, 2000)
  }
  // Member push-on-change: local data changed → nudge a debounced push to the central so its
  // aggregate stays fresh while you work. No-op on a central/solo instance.
  import('./team-uploader').then(m => m.notifyDataChanged()).catch(() => {})
}

/** Default noise filter for harness roots. */
const DEFAULT_IGNORED = /(^|[/\\])(\.git|node_modules|plugins|cache|\.tmp|shell_snapshots|skills|memories|log|logs|bin|antigravity|history|ide|pkg)([/\\]|$)/

/**
 * Each harness's SESSION directory — the only part of its data root worth watching. NOT the whole
 * root (adapter.dataRoot): roots like ~/.codex hold .tmp plugin clones, an 18MB sqlite log and caches,
 * and watching them recursively saturates the watcher and starves the request handler.
 *
 * A `Record<HarnessId, …>` so a harness added later has to say, rather than being absent by omission
 * — kimi WAS absent by omission (P-30): its writes refreshed nothing, so its metrics and its
 * first-sighting link waited for some other harness to trigger a rebuild. claude is watched above
 * through its own two directories; opencode has no adapter here and keeps every session in one
 * SQLite file, which this per-directory watch has nothing to say about.
 */
const HARNESS_SESSION_DIRS: Record<HarnessId, string | null> = {
  claude: null,
  codex: CODEX_SESSIONS_DIR,
  gemini: join(GEMINI_DIR, 'tmp'),
  copilot: join(COPILOT_DIR, 'session-state'),
  antigravity: ANTIGRAVITY_BRAIN_DIR,
  kimi: join(KIMI_DIR, 'sessions'),
  opencode: null,
}

/** Mirror a new/changed source file into the archive, then tell the rebuild scheduler. */
function onSourceChange(path: string | undefined, isWrite: boolean): void {
  // Mirror new/changed source files into the archive before notifying clients,
  // so deleted-by-cleanup history is preserved as it is written.
  if (typeof path === 'string' && isWrite) void mirrorFile(path)
  // Tell whoever links conversations that this harness is writing RIGHT NOW: kimi holds its session
  // files open only while it writes, so this is the moment its process can be caught naming its
  // conversation (`transcript-activity.ts`, `process-transcript.ts`).
  if (typeof path === 'string') {
    const harness = harnessOfPath(path, HARNESS_SESSION_DIRS)
    if (harness) noteTranscriptActivity(harness)
  }
  triggerSseNotification()
}

/**
 * A session directory watched with ONE native recursive `fs.watch` (see watch-filter.ts for why not
 * chokidar: it re-lists the whole directory on every event, ~21 % of a core with three sessions
 * writing). Returns false when the native watch cannot be had — not running on Bun, the directory is
 * not there yet, or the OS refused (inotify limits) — and the caller falls back to chokidar.
 */
function watchNative(dir: string, ignored: RegExp): boolean {
  if (!process.versions.bun) return false
  try {
    if (!statSync(dir).isDirectory()) return false
    const w = fsWatch(dir, { recursive: true, persistent: true }, (event, file) => {
      const rel = typeof file === 'string' ? file : file == null ? null : String(file)
      if (!watchedEvent(rel, ignored, WATCH_DEPTH)) return
      // `rename` is a create or a delete; mirroring a path that is gone is a no-op in `mirrorFile`.
      onSourceChange(rel ? join(dir, rel) : undefined, true)
    })
    w.on('error', (err: unknown) => console.warn(`[watcher] Could not watch ${dir}:`, String(err)))
    console.log(`[watcher] Watching ${dir} (native, recursive)`)
    return true
  } catch (err) {
    console.warn(`[watcher] Native watch of ${dir} unavailable (${String(err)}); using chokidar`)
    return false
  }
}

export async function setupFileWatcher() {
  const watch = (dir: string, ignored: RegExp = DEFAULT_IGNORED, native = false) => {
    if (native && watchNative(dir, ignored)) return
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
    watcher.on('all', (event: string, path: string) => onSourceChange(path, event === 'add' || event === 'change'))
    watcher.on('error', (err: unknown) => {
      console.warn(`[watcher] Could not watch ${dir}:`, String(err))
    })
    console.log(`[watcher] Watching ${dir}`)
  }

  // Claude core paths
  // The session DIRECTORIES natively; the single stats file stays on chokidar, which survives the
  // file being replaced by a rename.
  watch(SESSION_META_DIR, DEFAULT_IGNORED, true)
  watch(PROJECTS_DIR, DEFAULT_IGNORED, true)
  watch(STATS_CACHE_FILE)

  // Additional harnesses: watch ONLY each harness's session directory (`HARNESS_SESSION_DIRS`).
  // Inside brain/<conversation-id>/ only .git / node_modules noise is worth skipping.
  const ANTIGRAVITY_IGNORED = /(^|[/\\])(\.git|node_modules)([/\\]|$)/
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
        // Antigravity stays on chokidar: its conversation folders can hold whole repositories
        // (`.git`, `node_modules`), and a recursive native watch would add a watch per directory
        // in them, where chokidar never descends into an ignored tree.
        if (adapter.id === 'antigravity') watch(dir, ANTIGRAVITY_IGNORED)
        else watch(dir, DEFAULT_IGNORED, true)
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
