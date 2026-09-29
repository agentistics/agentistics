/**
 * subagent-metrics.ts — the I/O half: find each subagent's own transcript and read it.
 *
 * Claude Code made the `Agent` tool asynchronous on 2026-08-14. The parent's `toolUseResult` stopped
 * carrying the agent's numbers and now names it instead — `agentId` — while the numbers moved into
 * `<project>/<session-id>/subagents/agent-<agentId>.jsonl`. `agent-metrics.ts` marks those
 * invocations UNMEASURED; this module is what makes almost all of them measured again (on the
 * machine this was written against: 440 of 442 async invocations had their transcript on disk).
 *
 * **The `outputFile` the result also names is deliberately NOT used.** It points into the run's
 * scratch directory under `/tmp`, which is cleared on reboot and by the OS — it is the agent's text
 * answer, not its accounting, and it was already gone for every invocation measured here. The
 * durable file is the one this module opens.
 *
 * What cannot be found stays unmeasured. A transcript deleted by Claude's own 30-day cleanup is a
 * fact nobody can recover, and reporting it as zero would be the very defect this fixes.
 */

import { readFile, readdir, stat } from 'fs/promises'
import { dirname, join } from 'path'
import type { AgentInvocation, SessionAgentMetrics } from '@agentistics/core'
import { agentNumbers, claimSessionUsage, summarizeSubagentTranscript, totalsOf, type SubagentSummary } from './subagent-parse'
import { FileVersionCache } from './file-version-cache'
import { describedFrom, parseAgentMeta, planAgentJoin, planSubtrees, type AgentEntry } from './subagent-join'

/**
 * Parsed subagent transcripts, one per FILE, stamped with the version (mtime + size) they were read at.
 *
 * A finished subagent's transcript never changes, and the data walk runs on a 30s cache over a
 * machine that can hold hundreds of them — re-parsing half a megabyte per invocation per build is
 * the storm `git.ts` had to be rescued from. The version stamp means a transcript still being
 * written is re-read rather than frozen at its first reading.
 *
 * Keyed by the file, NOT by file + version: that key added an entry per version of every LIVE
 * transcript and never dropped the superseded ones (measured 80 -> 1024 entries, ~85 MB retained,
 * over 60 builds) — one of the two leaks behind the OOM of 2026-09-26. See `file-version-cache.ts`.
 *
 * The cap: this machine holds 613 `subagents/agent-*.jsonl` transcripts (counted 2026-09-26), a
 * build reads only the ones behind an unmeasured invocation (80 here), and Claude's own 30-day
 * cleanup keeps the population from growing without end. 2048 is over three times this machine's
 * whole set, so a finished transcript is still parsed once, and it turns "grows for as long as the
 * server runs" into a ceiling — at the ~83 KB per entry measured above, roughly 170 MB at worst.
 * Past it the least recently read is dropped, which costs one re-parse, never a wrong number.
 */
const SUBAGENT_CACHE_CAP = 2048
const CACHE = new FileVersionCache<SubagentSummary>(SUBAGENT_CACHE_CAP)

/** How many parsed transcripts are held. Exported for the test that bounds it. */
export function subagentCacheSize(): number {
  return CACHE.size
}

async function summaryFor(file: string): Promise<SubagentSummary | null> {
  let version: string
  try {
    const st = await stat(file)
    version = `${st.mtimeMs}\0${st.size}`
  } catch {
    return null
  }
  const hit = CACHE.get(file, version)
  if (hit) return hit

  let content: string
  try { content = await readFile(file, 'utf-8') } catch { return null }

  const summary = summarizeSubagentTranscript(content.split('\n'))
  CACHE.set(file, version, summary)
  return summary
}

/**
 * Every transcript in one `subagents/` directory, with the meta that names it.
 *
 * The directory is the authoritative record of which agents EXISTED — the parent transcript only
 * says how each was launched, and it does not always say even that. A meta that is missing or
 * unreadable yields `null` rather than dropping the transcript: a file we cannot describe is still
 * a file, and `planAgentJoin` can still pair it by `agentId`.
 */
async function entriesIn(dir: string): Promise<AgentEntry[]> {
  let names: string[]
  try { names = await readdir(dir) } catch { return [] }

  const entries: AgentEntry[] = []
  for (const name of names) {
    const agentId = /^agent-(.+)\.jsonl$/.exec(name)?.[1]
    if (!agentId) continue
    const text = await readFile(join(dir, `agent-${agentId}.meta.json`), 'utf-8').catch(() => '')
    entries.push({ agentId, meta: text ? parseAgentMeta(text) : null })
  }
  return entries
}

/**
 * Fill in every UNMEASURED invocation whose transcript this machine still has.
 *
 * The pairing is `subagent-join.ts`'s, and it is the whole point: keying only on
 * `toolUseResult.agentId` left an interrupted call, a launch the parent never answered and a
 * background forked skill permanently unmeasured, although all three had a full transcript beside
 * the session. The meta's own `toolUseId` is the link back in exactly those cases.
 *
 * Total: a session with no `subagents/` directory, an unreadable file or an invocation nothing on
 * disk can serve comes back exactly as it went in — `unmeasured`, which a surface renders N/A,
 * never a zero. A transcript the join leaves UNCLAIMED adds no row: the invocation list is the
 * parent's, and a conversation fork is not an agent this conversation dispatched (issue #384).
 *
 * `mainUsageIds` are the message ids the MAIN transcript already counted. A forked subagent opens
 * with the parent's launching response under its original id, so without them one billed response
 * is counted twice — once in the session, once in the invocation. See `claimSessionUsage`. A caller
 * that has none passes nothing and gets the file-to-file dedupe alone.
 */
export async function enrichFromSubagentTranscripts(
  metrics: SessionAgentMetrics,
  transcriptPath: string,
  sessionId: string,
  mainUsageIds: { has(id: string): boolean } = new Set<string>(),
): Promise<SessionAgentMetrics> {
  if (!metrics.invocations.some(i => i.unmeasured)) return metrics

  const dir = join(dirname(transcriptPath), sessionId, 'subagents')
  const entries = await entriesIn(dir)
  if (entries.length === 0) return metrics

  const plan = planAgentJoin(metrics.invocations, entries)
  const metaOf = new Map(entries.map(e => [e.agentId, e.meta]))

  // Every transcript of the directory is read — through the per-file memo, so each costs one parse
  // per version of that file. The walk needs each file's own `childAgentIds` before it can know
  // which files hang under which root, and the ownership below needs every file that counts.
  const summaries = new Map<string, SubagentSummary>()
  for (const e of entries) {
    const summary = await summaryFor(join(dir, `agent-${e.agentId}.jsonl`))
    if (summary) summaries.set(e.agentId, summary)
  }
  const named = new Map([...summaries].map(([id, s]) => [id, s.childAgentIds]))

  // Only the invocations this pass will MEASURE are roots: an invocation that already has numbers
  // (the pre-async `toolUseResult`) keeps them, and its transcript takes no part here.
  const roots: string[] = []
  for (const { invocation, agentId } of plan.reads) {
    if (invocation.unmeasured && agentId && summaries.has(agentId)) roots.push(agentId)
  }
  const subtrees = planSubtrees(roots, entries.filter(e => summaries.has(e.agentId)), named)

  // ONE dedupe across the session: the main transcript's ids first, then one owner per id across
  // every file of every subtree. Recomputed on every call and never memoized — it depends on the
  // main transcript's id set, which grows on a live session, and on files that change on their own.
  const members = [...subtrees.values()].flatMap(list =>
    list.map(m => ({ agentId: m.agentId, depth: m.depth, summary: summaries.get(m.agentId)! })))
  const owned = claimSessionUsage(mainUsageIds, members)
  const counted = (id: string): SubagentSummary => ({ ...summaries.get(id)!, usage: owned.get(id) ?? [] })

  const invocations: AgentInvocation[] = []
  let changed = false

  for (const { invocation, agentId } of plan.reads) {
    const tree = agentId ? subtrees.get(agentId) : undefined
    if (!invocation.unmeasured || !agentId || !tree) { invocations.push(invocation); continue }

    const root = counted(agentId)
    const descendants = tree.slice(1).map(m => counted(m.agentId))
    const { unmeasured: _dropped, ...rest } = describedFrom(invocation, metaOf.get(agentId) ?? null)
    invocations.push({ ...rest, agentId, ...agentNumbers(root, descendants) })
    changed = true
  }

  return changed ? totalsOf(invocations) : metrics
}
