/**
 * sessionArtifacts.ts — PURE: which files the open session has written, from the conversation it
 * is already showing.
 *
 * THIS NEEDS NO SERVER, and that is the design rather than an economy. `ChatTurn.tools` already
 * arrives on every turn as `{ name, detail }`, and `chat-tail.ts`'s `toolDetail` reads named
 * fields in priority order — so for a file tool the `detail` IS the `file_path`. `SessionChat`
 * already polls that payload, so this list is exactly as fresh as the conversation beside it and
 * the two can never disagree by a poll interval.
 *
 * SELECTION IS BY TOOL NAME, NEVER BY THE SHAPE OF `detail`. `toolDetail`'s first key is
 * `command`, so a `Bash` call's detail is a shell line — and "this looks like a path" would put
 * `rm -rf build/` in a list of files somebody is about to click.
 *
 * AND IT IS THE CANONICAL NAME, NOT THE DISPLAYED ONE. A turn carries both: `name` is what the
 * harness itself called the tool (agy's `write_to_file`), which is what the bubble shows because a
 * conversation records what happened; `canonical` is the same tool under the shared vocabulary
 * (`Write`), present only where the two differ. This set is written in the shared vocabulary, so it
 * reads `canonical ?? name` — matching on the displayed name alone would make this panel blind on
 * every harness but Claude, and rewriting the displayed name to suit this set is what put Claude's
 * tool names in an Antigravity session's bubbles.
 *
 * `Read` is excluded. The question this panel answers is what the session PRODUCED; an assistant
 * reading forty files to answer one question would bury the two it wrote.
 */

/**
 * The tools whose `detail` is a file path, in the SHARED vocabulary — see `canonical` above.
 * Read from `chat-tail.ts`'s own priority list.
 */
export const ARTIFACT_TOOLS: ReadonlySet<string> = new Set([
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
])

export interface Artifact {
  /** The absolute path, exactly as the transcript recorded it. */
  path: string
  /** The last segment — what the row is called. */
  name: string
  /** Everything before it, shown dim under the name. */
  dir: string
  /** `new` when the session's FIRST touch was a `Write`; `edited` otherwise. */
  kind: 'new' | 'edited'
  /** How many times this session touched it. */
  touches: number
  /** This is the file of a turn that has not finished — the one being written now. */
  live: boolean
}

interface Turnish {
  tools?: {
    name: string
    /** The shared-vocabulary name, when it differs from the displayed one. */
    canonical?: string
    detail?: string
    writes?: string[]
    opaqueWrite?: boolean
  }[]
  pending?: boolean
}

/**
 * Did this conversation write through commands whose paths cannot be read?
 *
 * An interpreter fed a program on stdin writes files nobody can name from the command line — the
 * server marks those calls rather than guessing at the script's contents. The panel uses this to
 * distinguish "this session wrote nothing" from "this session wrote things I cannot list", which
 * on a session that had produced eighty files was the difference between an honest gap and a
 * confident wrong answer.
 */
export function hasUnlistedWrites(turns: readonly Turnish[]): boolean {
  return turns.some(t => (t?.tools ?? []).some(c => c.opaqueWrite === true))
}

/**
 * WHY THE COUNT OF WRITTEN FILES IS SHORT — the two sentences that qualify it, in order.
 *
 * The aside's header is the only surviving statement of how many files a session wrote (`N files ·
 * M new`), and it undercounts for two unrelated reasons. Both were reported as the panel having
 * missed something it wrote, and both had a surface on the file lists that are gone; this is the
 * ONE place that decides what is said and in which order, so the two facts cannot drift apart or
 * get a third wording somewhere else.
 *
 *  - **`unlisted`** — the session wrote through commands whose paths cannot be read AT ALL (an
 *    interpreter fed a heredoc), so those files are in no count. Composed here, in this panel's own
 *    words, because nothing server-side words it: `hasUnlistedWrites` above is the browser's own
 *    reading of turns it already has. **It may not point at the count**, and said "not in this
 *    count" for a release: the header's `N files` span is drawn only when `artifacts.length > 0`,
 *    and this flag's PRIMARY case is a session that wrote through opaque commands ALONE — exactly
 *    when there is no count beside it and the sentence names something the reader cannot see. The
 *    fact was right and the deixis was wrong, so the sentence now stands on its own.
 *  - **`outside`** — files that ARE counted elsewhere but sit outside the session's own folder, so
 *    the read route refuses them. Passed through **VERBATIM**: the server already worded it
 *    (`fleet-web.ts`'s `listSessionArtifacts`), it holds a COUNT and never the paths, and composing
 *    a second sentence for something the server has already said is how two surfaces come to
 *    disagree about one fact.
 *
 * `unlisted` leads because it is the wider limit — a file it covers is not merely unopenable, it is
 * unnameable — and that is the order the retired list footer printed them in.
 *
 * An empty array is the ordinary case and must draw NOTHING: an absent sentence costs no line.
 */
export function artifactShortfall(
  { unlisted, outside, lang }: { unlisted?: boolean; outside?: string; lang: 'pt' | 'en' },
): string[] {
  const out: string[] = []
  if (unlisted === true) {
    out.push(lang === 'pt'
      ? 'A sessão também escreveu por comandos cujos caminhos não dá para ler; esses arquivos não aparecem aqui, nem contados nem listados.'
      : 'The session also wrote through commands whose paths cannot be read; those files are neither counted nor listed here.')
  }
  // VERBATIM, never reworded — see above.
  if (outside) out.push(outside)
  return out
}

export function artifactsFromTurns(turns: readonly Turnish[]): Artifact[] {
  // Insertion order is the transcript's order, which is what makes "first touch" answerable.
  const seen = new Map<string, { first: string; touches: number; order: number; live: boolean }>()
  let order = 0

  for (const t of turns) {
    for (const call of t?.tools ?? []) {
      // A file the SHELL wrote is a file this session wrote. `writes` is computed server-side by
      // `shell-writes.ts` because `detail` carries only the command's first line, which is almost
      // never the one holding the redirection.
      for (const w of call.writes ?? []) {
        const prevW = seen.get(w)
        if (prevW) { prevW.touches += 1; prevW.order = order++; prevW.live = t?.pending === true }
        else seen.set(w, { first: 'Write', touches: 1, order: order++, live: t?.pending === true })
      }
      if (!ARTIFACT_TOOLS.has(call.canonical ?? call.name)) continue
      const path = call.detail?.trim()
      if (!path) continue
      // `toolDetail` appends an ellipsis past 200 characters. A truncated path names no file, and
      // asking the server for one would be a refusal every time — so it is not offered.
      if (path.endsWith('…')) continue
      const prev = seen.get(path)
      if (prev) {
        prev.touches += 1
        prev.order = order++
        prev.live = t.pending === true
      } else {
        // The CANONICAL name again: `kind` is decided by whether the first touch was a `Write`, so
        // recording agy's own `write_to_file` here would file every file it created as `edited`.
        // Same reading as the `ARTIFACT_TOOLS` test above, and it must not drift from it.
        seen.set(path, {
          first: call.canonical ?? call.name, touches: 1, order: order++, live: t.pending === true,
        })
      }
    }
  }

  return [...seen.entries()]
    .map(([path, v]) => {
      const cut = path.lastIndexOf('/')
      return {
        path,
        name: cut === -1 ? path : path.slice(cut + 1),
        dir: cut === -1 ? '' : path.slice(0, cut),
        kind: v.first === 'Write' ? ('new' as const) : ('edited' as const),
        touches: v.touches,
        live: v.live,
      }
    })
    // Newest first: the thing that just happened is what the panel is opened for.
    .sort((a, b) => (seen.get(b.path)!.order - seen.get(a.path)!.order))
}
