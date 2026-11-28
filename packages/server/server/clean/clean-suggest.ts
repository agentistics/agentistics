/**
 * clean-suggest.ts — at most once a week, say what `agentop clean` would free (PERF.1 step 5).
 *
 * The server looks once a day (first 15 min after boot, unref'd timers); when a week has passed since
 * the last suggestion and at least `MIN_BYTES` can be reclaimed, it raises ONE notification naming the
 * size and the command. It never removes anything itself. The facts are gathered at the lowest CPU and
 * I/O priority, because `du` over every worktree is real disk work.
 */
import { readFileSync } from 'node:fs'
import { stat, statfs, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DiskVolume } from './disk-ceiling'
import { fmtBytes, planClean, reclaimable } from './clean-plan'
import { HOME_DIR, MANAGED_SESSIONS_FILE } from '../config'
import { durableWrite } from '../durable-file'
import { checkDiskCeiling, type DiskWatchDeps, type DiskWatchState } from './disk-watch'
import { isWsl } from './disk-ceiling'

export const WEEK_MS = 7 * 86_400_000
export const MIN_BYTES = 1024 ** 3

/** PURE: should a suggestion be raised now? */
export function shouldSuggest(o: { lastAt: number | null; nowMs: number; bytes: number }): boolean {
  if (o.bytes < MIN_BYTES) return false
  return o.lastAt === null || o.nowMs - o.lastAt >= WEEK_MS
}

/** PURE: may the (costly) facts be gathered at all — only once the week is up. */
export function weekIsUp(lastAt: number | null, nowMs: number): boolean {
  return lastAt === null || nowMs - lastAt >= WEEK_MS
}

export function suggestionText(bytes: number, count: number, lang: 'en' | 'pt'): { title: string; message: string } {
  return lang === 'pt'
    ? { title: `Há espaço para liberar ${fmtBytes(bytes)}`, message: `${count} item(ns) concluído(s) ou parado(s) podem ser removido(s). Veja a lista e confirme o que deseja limpar.` }
    : { title: `You can free ${fmtBytes(bytes)}`, message: `${count} completed or idle item(s) can be removed. See the list and confirm what you want to clean.` }
}

// ─── DISCO.WORKTREES: the disk floor, carried out (decisions in disk-watch.ts / disk-ceiling.ts) ────

/** Bound on one leader's delivery (the same budget as the account notice). */
const SEND_TIMEOUT_MS = 8_000
const diskStateFile = () => join(dirname(MANAGED_SESSIONS_FILE), 'clean-disk.json')

/** The fullest of the filesystems holding the given directories (one reading per device). */
async function fullestVolume(paths: readonly string[]): Promise<DiskVolume | null> {
  const seen = new Set<number>()
  let worst: DiskVolume | null = null
  for (const path of paths) {
    try {
      const dev = (await stat(path)).dev
      if (seen.has(dev)) continue
      seen.add(dev)
      const fs = await statfs(path)
      const v = { path, freeBytes: fs.bavail * fs.bsize, totalBytes: fs.blocks * fs.bsize }
      if (v.totalBytes > 0 && (!worst || v.freeBytes / v.totalBytes < worst.freeBytes / worst.totalBytes)) worst = v
    } catch { /* gone or unreadable: not a reading */ }
  }
  return worst
}

export const diskDeps: DiskWatchDeps = {
  async volume() {
    const { cleanRepos } = await import('../cli-clean')
    const repos = await cleanRepos([], { lowPriority: true }).catch(() => [])
    return fullestVolume(repos.length ? repos : [HOME_DIR])
  },
  async config() {
    const { readPreferences } = await import('../preferences')
    return (await readPreferences()).diskCeiling
  },
  async freeable() {
    const { cleanRepos, collectCleanFacts } = await import('../cli-clean')
    return reclaimable(planClean(await collectCleanFacts(await cleanRepos([]), { lowPriority: true }), Date.now()))
  },
  async rows() {
    const { liveRows, awaySessionRunning } = await import('../away')
    return (await liveRows()).map(r => ({ id: r.id, ...(r.conversationId ? { conversationId: r.conversationId } : {}), running: awaySessionRunning(r) }))
  },
  async roleOf(id, conversationId) {
    const { storedRoleFor } = await import('../sessions/session-roles')
    return storedRoleFor([conversationId, id])
  },
  async send(id, text) {
    const { runFleetAction } = await import('../sessions/fleet-web')
    let t: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<{ ok: boolean }>(resolve => { t = setTimeout(() => resolve({ ok: false }), SEND_TIMEOUT_MS) })
    const sent = runFleetAction('en', { action: 'prompt', id, text: `[from agentistics · disco]\n${text}` }).then(o => ({ ok: o.ok }), () => ({ ok: false }))
    return Promise.race([sent, timeout]).finally(() => clearTimeout(t))
  },
  notify(code, meta) {
    void import('../sse').then(m => m.broadcastNotification({ type: 'warning', code, meta }))
  },
  async readState() {
    try {
      const v = JSON.parse(readFileSync(diskStateFile(), 'utf8')) as Partial<DiskWatchState>
      return { lastNoticeMs: typeof v.lastNoticeMs === 'number' ? v.lastNoticeMs : null, wslSaid: v.wslSaid === true }
    } catch { return { lastNoticeMs: null, wslSaid: false } }
  },
  writeState: state => durableWrite(diskStateFile(), JSON.stringify(state), 0o600),
  async lang() {
    const { readPreferences } = await import('../preferences')
    return (await readPreferences()).lang === 'pt' ? 'pt' : 'en'
  },
  wsl() {
    let version = ''
    try { version = readFileSync('/proc/version', 'utf8') } catch { /* not Linux */ }
    return isWsl(version, process.env)
  },
  now: () => Date.now(),
}

export function startDiskCeilingWatch(): void {
  const check = () => void checkDiskCeiling(diskDeps).catch(e => console.warn('[clean] disk check failed:', String(e)))
  setTimeout(() => { check(); setInterval(check, 3_600_000).unref() }, 5 * 60_000).unref()
}

export function startCleanSuggestions(dataDir: string, lang: 'en' | 'pt' = 'en'): void {
  const file = join(dataDir, 'clean-suggestion.json')
  const lastAt = (): number | null => { try { return Number(JSON.parse(readFileSync(file, 'utf8')).at) || null } catch { return null } }
  const check = async () => {
    try {
      if (!weekIsUp(lastAt(), Date.now())) return
      const { cleanRepos, collectCleanFacts } = await import('../cli-clean')
      const facts = await collectCleanFacts(await cleanRepos([]), { lowPriority: true })
      const r = reclaimable(planClean(facts, Date.now()))
      // The look itself is recorded, so a machine with little to free is not re-scanned daily.
      await writeFile(file, JSON.stringify({ at: Date.now(), bytes: r.bytes, count: r.count }), { mode: 0o600 })
      if (!shouldSuggest({ lastAt: null, nowMs: Date.now(), bytes: r.bytes })) return
      const { broadcastNotification } = await import('../sse')
      broadcastNotification({ type: 'info', code: 'clean.suggestion', meta: { bytes: r.bytes, count: r.count } })
    } catch { /* a suggestion is never worth an error */ }
  }
  setTimeout(() => { void check(); setInterval(() => void check(), 86_400_000).unref() }, 15 * 60_000).unref()
}
