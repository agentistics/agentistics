import { join, dirname } from 'path'
import { mkdir, copyFile, writeFile, readFile } from 'fs/promises'
import {
  ARCHIVE_ENABLED,
  ARCHIVE_PROJECTS_DIR,
  ARCHIVE_SESSION_META_DIR,
  ARCHIVE_STATS_DIR,
  PROJECTS_DIR,
  SESSION_META_DIR,
  STATS_CACHE_FILE,
} from './config'
import { createLimiter, safeReadDir, safeStat } from './utils'
import { getArchiveMode } from './preferences'

const copyLimit = createLimiter(20)

/** The raw-transcript mirror runs only in 'full' mode (and only when the env
 *  kill-switch allows it). 'consolidate'/'off'/unset never copy raw files. */
export async function archiveEnabled(): Promise<boolean> {
  if (!ARCHIVE_ENABLED) return false
  return (await getArchiveMode()) === 'full'
}

/** Copy src → dest only when the archive copy is missing or stale.
 *  JSONL transcripts are append-only, so a larger size or newer mtime means
 *  there is new content to mirror. */
async function copyIfNewer(src: string, dest: string): Promise<boolean> {
  const srcStat = await safeStat(src)
  if (!srcStat?.isFile()) return false
  const destStat = await safeStat(dest)
  const upToDate =
    destStat != null &&
    destStat.size >= srcStat.size &&
    destStat.mtimeMs >= srcStat.mtimeMs
  if (upToDate) return false
  await copyLimit(async () => {
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(src, dest)
  })
  return true
}

/** Maps a live source path to its archive destination. Returns null for paths
 *  outside the mirrored trees (the stats-cache is snapshotted separately). */
function archiveDestFor(src: string): string | null {
  if (src.startsWith(PROJECTS_DIR)) {
    return join(ARCHIVE_PROJECTS_DIR, src.slice(PROJECTS_DIR.length))
  }
  if (src.startsWith(SESSION_META_DIR)) {
    return join(ARCHIVE_SESSION_META_DIR, src.slice(SESSION_META_DIR.length))
  }
  return null
}

/** Mirror a single changed file into the archive. Called by the file watcher. */
/**
 * `archiveEnabled` for the watcher's hot path. The watcher calls `mirrorFile` on EVERY file event,
 * and each call read and parsed preferences.json from disk to learn the archive mode — with sessions
 * writing, ~12 % of a core measured (PERF.1 step 1). The answer is held for a few seconds: turning
 * 'full' on runs a `fullSync()` of its own (the preferences route), and a mirror copied for a few
 * seconds after it is turned off is a copy nobody reads.
 */
const MIRROR_MODE_TTL_MS = 5_000
let _mirrorMode: { enabled: boolean; at: number } | null = null
async function mirrorEnabled(): Promise<boolean> {
  if (_mirrorMode && Date.now() - _mirrorMode.at < MIRROR_MODE_TTL_MS) return _mirrorMode.enabled
  const enabled = await archiveEnabled()
  _mirrorMode = { enabled, at: Date.now() }
  return enabled
}

export async function mirrorFile(src: string): Promise<void> {
  if (!(await mirrorEnabled())) return
  if (src === STATS_CACHE_FILE) {
    await snapshotStatsCache()
    return
  }
  const dest = archiveDestFor(src)
  if (!dest) return
  try {
    await copyIfNewer(src, dest)
  } catch {
    /* best-effort mirror — never break the live path */
  }
}

async function walkCopy(srcDir: string, destDir: string): Promise<number> {
  const entries = await safeReadDir(srcDir)
  const counts = await Promise.all(
    entries.map(async entry => {
      const srcPath = join(srcDir, entry)
      const st = await safeStat(srcPath)
      if (!st) return 0
      if (st.isDirectory()) return walkCopy(srcPath, join(destDir, entry))
      if (st.isFile()) return (await copyIfNewer(srcPath, join(destDir, entry))) ? 1 : 0
      return 0
    })
  )
  return counts.reduce((a, b) => a + b, 0)
}

/** Write a dated snapshot of the stats-cache (one per day, last-write wins) plus
 *  a `latest.json`. Aggregates survive Claude's cleanup, but snapshots let us
 *  recover any history that disappears (see mergeArchivedStatsCache in data.ts). */
export async function snapshotStatsCache(): Promise<void> {
  if (!(await archiveEnabled())) return
  try {
    const content = await readFile(STATS_CACHE_FILE, 'utf-8')
    const parsed = JSON.parse(content) as { lastComputedDate?: string }
    const day = parsed.lastComputedDate || new Date().toISOString().slice(0, 10)
    await mkdir(ARCHIVE_STATS_DIR, { recursive: true })
    await writeFile(join(ARCHIVE_STATS_DIR, `snapshot-${day}.json`), content)
    await writeFile(join(ARCHIVE_STATS_DIR, 'latest.json'), content)
  } catch {
    /* stats-cache missing or unreadable — skip */
  }
}

/** Full mirror of all source trees into the archive. Runs on server startup so
 *  everything currently on disk is preserved before the next Claude cleanup. */
export async function fullSync(): Promise<void> {
  if (!(await archiveEnabled())) return
  try {
    const [projects, metas] = await Promise.all([
      walkCopy(PROJECTS_DIR, ARCHIVE_PROJECTS_DIR),
      walkCopy(SESSION_META_DIR, ARCHIVE_SESSION_META_DIR),
    ])
    await snapshotStatsCache()
    if (projects + metas > 0) {
      console.log(`[archive] mirrored ${projects} transcript + ${metas} session-meta file(s) → ${ARCHIVE_PROJECTS_DIR}`)
    }
  } catch (err) {
    console.warn('[archive] full sync failed:', String(err))
  }
}
