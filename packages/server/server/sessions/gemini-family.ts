/**
 * gemini-family.ts — PURE. Which chat files are ONE gemini conversation.
 *
 * ## What was measured (gemini 0.63.0, 2026-10-09, throwaway HOME, interactive `--resume <uuid>`)
 *
 * A fresh session writes `chats/session-<YYYY-MM-DDTHH-mm>-<first 8 of the uuid>.jsonl`, whose first
 * line is the HEADER `{sessionId, projectHash, startTime, …}`. **Reopening it does not append to
 * that file.** The new turns go to a NEW file — `session-<minute of the reopen>-<same 8>.jsonl`, or
 * `session-<minute>-<N>-<same 8>.jsonl` when that name is taken (a reopen inside the same minute) —
 * which has NO header line at all; the original receives only `{"$set":{"sessionId":…}}` patches
 * and a `$set.messages` snapshot of the turns it already had. (A headless `-p --resume` was seen
 * appending in place, so a conversation can be ONE file or several, and nothing says which.)
 *
 * So the file whose header names the uuid is not the whole conversation, and the file being written
 * now is not the one that names it. This module is the single place that relates them:
 *
 *  - the SUFFIX (first eight hex characters) is a hint, never proof — two conversations in one
 *    project can share it;
 *  - the HEADER's `sessionId` is the proof, so a headerless file joins a family only when exactly
 *    ONE distinct headed conversation in the same directory carries its suffix. Zero or several is
 *    "cannot tell", and an orphan stays alone — attributing it on a coin flip would put one
 *    conversation's turns under another's name.
 */

export interface ChatFileRef {
  /** The file's basename, with or without `.jsonl`. */
  name: string
  /** The header line's `sessionId`, or `null` when the first line is not a header. */
  headerId: string | null
}

export interface ChatName {
  /** `YYYY-MM-DDTHH-mm` — sorts as time. */
  stamp: string
  /** The collision counter: absent = 0, `-1-` = 1. */
  counter: number
  /** The first eight characters of the conversation's uuid, lowercased. */
  suffix: string
}

const NAME_RE = /^session-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2})(?:-(\d+))?-([0-9a-f]{8})$/i

export function parseChatName(name: string): ChatName | null {
  const m = NAME_RE.exec(name.replace(/\.jsonl$/i, ''))
  if (!m) return null
  return { stamp: m[1]!, counter: m[2] ? Number(m[2]) : 0, suffix: m[3]!.toLowerCase() }
}

/** Oldest first: by minute, then by collision counter. Names that do not parse sort last, by name. */
export function compareChatNames(a: string, b: string): number {
  const pa = parseChatName(a)
  const pb = parseChatName(b)
  if (pa && pb) {
    return pa.stamp < pb.stamp ? -1 : pa.stamp > pb.stamp ? 1 : pa.counter - pb.counter
  }
  if (pa) return -1
  if (pb) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

export interface ChatFamily {
  /** The conversation's uuid when a header named it; `null` for a file nothing could be attached to. */
  id: string | null
  /** Basenames, oldest first. The first is the one whose header named the conversation. */
  members: string[]
}

/**
 * Group the files of ONE project directory into conversations — PURE.
 *
 * Every input appears in exactly one output family, so a caller that walks the result sees each file
 * once. A file that is not a recognisable chat name (`.json` rich chats, anything else) is its own
 * family: the rule above is for the journal naming only.
 */
export function groupGeminiFamilies(files: readonly ChatFileRef[]): ChatFamily[] {
  const headed = new Map<string, string[]>() // lowercased uuid -> member names
  const headerless: string[] = []
  const alone: string[] = []

  for (const f of files) {
    if (!parseChatName(f.name)) { alone.push(f.name); continue }
    if (f.headerId) {
      const key = f.headerId.toLowerCase()
      headed.set(key, [...(headed.get(key) ?? []), f.name])
    } else headerless.push(f.name)
  }

  // Which headed conversations carry each suffix — the attachment is allowed only when it is ONE.
  const bySuffix = new Map<string, Set<string>>()
  for (const [id, names] of headed) {
    for (const n of names) {
      const sfx = parseChatName(n)!.suffix
      bySuffix.set(sfx, (bySuffix.get(sfx) ?? new Set()).add(id))
    }
  }

  const orphans: string[] = []
  for (const n of headerless) {
    const owners = bySuffix.get(parseChatName(n)!.suffix)
    if (owners && owners.size === 1) headed.get([...owners][0]!)!.push(n)
    else orphans.push(n)
  }

  const out: ChatFamily[] = []
  for (const [id, names] of headed) out.push({ id, members: [...names].sort(compareChatNames) })
  for (const n of [...orphans, ...alone]) out.push({ id: null, members: [n] })
  return out
}
