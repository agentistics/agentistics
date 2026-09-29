/**
 * context/agents-md.ts — the `AGENTS.md` a native session is given (B8 §10, H2). PURE: the host reads
 * the files (`runtime-host.ts`'s `readAgentsMd`) and hands the text in; this module decides which
 * directories are asked, in what order, and how much of each survives.
 *
 * **Scope of this module is the READER, not the system prompt.** It produces sections; it does not
 * phrase them. The system prompt's content and language are owner-pending (H1-lean), so nothing here
 * writes a heading, a preamble or a sentence the model would read. A follow-up wires the sections in.
 *
 * Rules, each stated because it is a choice:
 *
 * - **The chain runs from the workspace root DOWN to `cwd`, root first, `cwd` last.** Every directory
 *   on the way is asked, and only those — never a parent of the root (a file above the repository is
 *   not the repository's instructions) and never a sibling.
 * - **Two caps: `AGENTS_MD_FILE_CAP` per file and `AGENTS_MD_TOTAL_CAP` over all of them**, both in
 *   UTF-8 BYTES, because bytes are what a context window and a disk both count in. The total is spent
 *   in reading order, root first — the precedent is Codex's `project_doc_max_bytes`, which fills the
 *   same way — so when the budget runs out it is the DEEPER files that are cut or dropped. Every cut
 *   and every drop is a notice naming the file; nothing is lost in silence.
 * - **A cut lands on a LINE boundary.** Half a line of an instruction can say the opposite of the
 *   whole line. `0x0A` never occurs inside a multi-byte UTF-8 sequence, so cutting at the last newline
 *   inside the budget is also always a valid string. When not one whole line fits, NOTHING of the file
 *   is kept (`dropped-*`) — a fragment of a line is exactly what this rule exists to refuse.
 * - **An empty or whitespace-only file is skipped with no notice.** It says nothing, and a notice for
 *   it would be noise about nothing.
 * - **A refusal the host decided (a symlink resolving outside the workspace, an unreadable file) is
 *   carried through as a notice**, so one list holds everything that did not reach the session.
 * - **Language-free.** Notices are codes plus numbers; a surface renders them.
 */

import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** The one file name read. `CLAUDE.md` / `GEMINI.md` are a `compat` opt-in (B8.2) — not here yet. */
export const AGENTS_MD_FILE = 'AGENTS.md'
/** Per-file ceiling, UTF-8 bytes. */
export const AGENTS_MD_FILE_CAP = 32 * 1024
/** Ceiling over every file together, UTF-8 bytes. */
export const AGENTS_MD_TOTAL_CAP = 64 * 1024

/**
 * Why a file did not reach the session whole.
 * - `cut-file` / `cut-total`: kept in part (the per-file cap / the remaining total budget was binding).
 * - `dropped-file` / `dropped-total`: nothing kept — not one whole line fit that budget, or the total
 *   budget was already spent.
 * - `outside-workspace`: the path resolves outside the workspace root (a symlink); refused UNREAD.
 * - `unreadable` / `not-a-file`: the host could not read it as a regular file.
 * - `cwd-outside-workspace`: `cwd` is not under the workspace root, so no chain exists.
 */
export type AgentsMdNoticeKind =
  | 'cut-file'
  | 'cut-total'
  | 'dropped-file'
  | 'dropped-total'
  | 'outside-workspace'
  | 'unreadable'
  | 'not-a-file'
  | 'cwd-outside-workspace'

export interface AgentsMdNotice {
  kind: AgentsMdNoticeKind
  /** The file (or, for `cwd-outside-workspace`, the cwd) the notice is about. */
  path: string
  /** The file's full size in bytes, when it was read. */
  bytes?: number
  /** How many bytes of it were kept (cuts and drops). */
  keptBytes?: number
}

/** What the host read for ONE directory of the chain. */
export interface AgentsMdRead {
  dir: string
  /** The file's text; absent when there is no file (or it was refused — see `refused`). */
  text?: string
  /**
   * The file's real size in bytes, when the host read only a prefix of a large file. Absent = the
   * byte length of `text`.
   */
  size?: number
  /** A refusal the host decided; the file was NOT read. */
  refused?: 'outside-workspace' | 'unreadable' | 'not-a-file'
}

export interface AgentsMdSection {
  /** The file's path (`<dir>/AGENTS.md`). */
  path: string
  text: string
  /** UTF-8 bytes of `text` as kept. */
  bytes: number
}

export interface AgentsMdResult {
  /** Root first, `cwd` last. */
  sections: AgentsMdSection[]
  /** True when any file was cut or dropped for size. */
  truncated: boolean
  notices: AgentsMdNotice[]
}

export interface AgentsMdCaps {
  file?: number
  total?: number
}

/**
 * The directories asked, root first and `cwd` last. `null` when `cwd` is not the workspace root or
 * under it — the host then reads nothing. Lexical only: symlinks are the host's business (it resolves
 * each FILE and refuses one that lands outside the root).
 */
export function agentsMdChain(workspaceRoot: string, cwd: string): string[] | null {
  const root = resolve(workspaceRoot)
  const here = resolve(cwd)
  const rel = relative(root, here)
  if (rel === '') return [root]
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  const out = [root]
  let cur = root
  for (const part of rel.split(sep)) {
    if (!part) continue
    cur = join(cur, part)
    out.push(cur)
  }
  return out
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8')

/** The longest prefix of `bytes` within `budget` that ends on a newline; empty when none does. */
function cutAtLine(bytes: Uint8Array, budget: number): { text: string; kept: number } {
  for (let i = Math.min(budget, bytes.length) - 1; i >= 0; i--) {
    if (bytes[i] === 0x0a) return { text: decoder.decode(bytes.subarray(0, i + 1)), kept: i + 1 }
  }
  return { text: '', kept: 0 }
}

/** Fold what the host read into the sections a session receives. */
export function collectAgentsMd(reads: readonly AgentsMdRead[], caps: AgentsMdCaps = {}): AgentsMdResult {
  const fileCap = caps.file ?? AGENTS_MD_FILE_CAP
  const totalCap = caps.total ?? AGENTS_MD_TOTAL_CAP
  const sections: AgentsMdSection[] = []
  const notices: AgentsMdNotice[] = []
  let used = 0
  let truncated = false

  for (const r of reads) {
    const path = join(r.dir, AGENTS_MD_FILE)
    if (r.refused) { notices.push({ kind: r.refused, path }); continue }
    if (r.text === undefined || r.text.trim() === '') continue

    const bytes = encoder.encode(r.text)
    const size = r.size ?? bytes.length
    const remaining = totalCap - used
    if (remaining <= 0) {
      notices.push({ kind: 'dropped-total', path, bytes: size, keptBytes: 0 })
      truncated = true
      continue
    }
    const overFile = size > fileCap
    const budget = Math.min(fileCap, remaining)
    if (size <= budget && bytes.length <= budget) {
      sections.push({ path, text: r.text, bytes: bytes.length })
      used += bytes.length
      continue
    }
    const cut = cutAtLine(bytes, budget)
    truncated = true
    // The per-file cap names the outcome only when it was the binding one.
    const byFile = overFile && fileCap <= remaining
    if (cut.text.trim() === '') {
      notices.push({ kind: byFile ? 'dropped-file' : 'dropped-total', path, bytes: size, keptBytes: 0 })
      continue
    }
    notices.push({ kind: byFile ? 'cut-file' : 'cut-total', path, bytes: size, keptBytes: cut.kept })
    sections.push({ path, text: cut.text, bytes: cut.kept })
    used += cut.kept
  }

  return { sections, truncated, notices }
}
