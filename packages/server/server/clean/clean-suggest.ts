/**
 * clean-suggest.ts — at most once a week, say what `agentop clean` would free (PERF.1 step 5).
 *
 * The server looks once a day (first 15 min after boot, unref'd timers); when a week has passed since
 * the last suggestion and at least `MIN_BYTES` can be reclaimed, it raises ONE notification naming the
 * size and the command. It never removes anything itself. The facts are gathered at the lowest CPU and
 * I/O priority, because `du` over every worktree is real disk work.
 */
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fmtBytes, planClean, reclaimable } from './clean-plan'

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
    ? { title: `agentop clean pode liberar ${fmtBytes(bytes)}`, message: `${count} worktree(s) merged ou node_modules parado(s). Rode \`agentop clean\` para ver a lista e confirmar.` }
    : { title: `agentop clean can free ${fmtBytes(bytes)}`, message: `${count} merged worktree(s) or stale node_modules. Run \`agentop clean\` to see the list and confirm.` }
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
      broadcastNotification({ type: 'info', ...suggestionText(r.bytes, r.count, lang) })
    } catch { /* a suggestion is never worth an error */ }
  }
  setTimeout(() => { void check(); setInterval(() => void check(), 86_400_000).unref() }, 15 * 60_000).unref()
}
