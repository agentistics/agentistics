/**
 * active-branch.ts — PURE: which transcript lines belong to a conversation branch claude ABANDONED.
 *
 * claude's rewind ("restore the conversation to the point before…", Esc Esc) does not rewrite the
 * transcript. It is append-only: the next message simply names an OLDER entry as its `parentUuid`,
 * and the turns after that point stay in the file. The chat view read the file top to bottom, so
 * after a rewind it went on showing the abandoned turns — measured on a probe: the web chat read
 * ONE, TWO, THREE, AFTER while the conversation claude was actually in was ONE, AFTER.
 *
 * The naive fix — keep only the chain of `parentUuid` from the newest entry — is WRONG, and was
 * measured to be: in 18 of 25 ordinary transcripts on this machine (no rewind anywhere), claude
 * writes the results of PARALLEL tool calls, and the parallel calls themselves, as siblings off one
 * parent. Only one sibling can be on the chain, so the chain alone hid real tool results.
 *
 * The rule that separates the two: a subtree that leaves the chain is ABANDONED only when it holds a
 * PERSON'S OWN PROMPT. A rewind always does — it goes back to before a prompt, and that prompt and
 * everything after it are left behind. Parallel siblings never do: they are tool traffic inside one
 * turn. Anything this function cannot place — an entry whose ancestry leaves the lines it read —
 * is KEPT: hiding a message is the expensive direction.
 *
 * It reads only the TAIL it is given a budget for, never the whole file: the chat is polled every
 * few seconds and a full parse of a 20 MB transcript each time is the cost this repo has already
 * had to remove once (`transcript-cursor.ts`).
 */

interface Entry {
  line: number
  uuid: string
  parent: string | null
  human: boolean
}

/** A prompt a person typed — not a tool result, not the harness writing under the user's role. */
function isHumanPrompt(e: Record<string, unknown>): boolean {
  if (e.type !== 'user' || e.isMeta === true || e.isCompactSummary === true) return false
  const content = (e.message as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return content.trim() !== ''
  if (!Array.isArray(content)) return false
  return content.some(c => (c as { type?: string }).type === 'text')
    && !content.some(c => (c as { type?: string }).type === 'tool_result')
}

/**
 * The line indices (into `lines`) that belong to an abandoned branch.
 *
 * `budget` bounds how many uuid-bearing entries are parsed, walking back from the end.
 */
export function abandonedBranchLines(lines: readonly string[], budget: number): Set<number> {
  const entries: Entry[] = []
  for (let i = lines.length - 1; i >= 0 && entries.length < budget; i--) {
    const raw = lines[i]
    if (!raw || raw.indexOf('"uuid"') < 0) continue
    let e: Record<string, unknown>
    try { e = JSON.parse(raw) } catch { continue }
    if (typeof e.uuid !== 'string' || e.isSidechain === true) continue
    const parent = typeof e.parentUuid === 'string' ? e.parentUuid
      : typeof e.logicalParentUuid === 'string' ? e.logicalParentUuid : null
    entries.push({ line: i, uuid: e.uuid, parent, human: isHumanPrompt(e) })
  }
  const skip = new Set<number>()
  if (entries.length === 0) return skip
  const byUuid = new Map(entries.map(e => [e.uuid, e]))

  // The active chain, from the newest entry, as far as the parsed tail reaches.
  const onChain = new Set<string>()
  for (let cur: Entry | undefined = entries[0]; cur; cur = cur.parent ? byUuid.get(cur.parent) : undefined) {
    if (onChain.has(cur.uuid)) break
    onChain.add(cur.uuid)
  }

  // Group every off-chain entry under the ROOT of its branch — its highest off-chain ancestor whose
  // parent is on the chain. An ancestry that leaves the parsed tail cannot be placed: kept.
  const rootOf = new Map<string, string | null>()
  const findRoot = (e: Entry): string | null => {
    const known = rootOf.get(e.uuid)
    if (known !== undefined) return known
    let cur = e
    const path: Entry[] = []
    let root: string | null = null
    for (let guard = 0; guard < entries.length; guard++) {
      path.push(cur)
      if (!cur.parent) { root = null; break }
      if (onChain.has(cur.parent)) { root = cur.uuid; break }
      const up = byUuid.get(cur.parent)
      if (!up) { root = null; break }
      const r = rootOf.get(up.uuid)
      if (r !== undefined) { root = r; break }
      cur = up
    }
    for (const p of path) rootOf.set(p.uuid, root)
    return root
  }
  const branches = new Map<string, Entry[]>()
  for (const e of entries) {
    if (onChain.has(e.uuid)) continue
    const root = findRoot(e)
    if (root === null) continue
    branches.set(root, [...(branches.get(root) ?? []), e])
  }
  for (const members of branches.values()) {
    if (!members.some(m => m.human)) continue
    for (const m of members) skip.add(m.line)
  }
  return skip
}
