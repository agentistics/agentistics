/**
 * SEARCHING WHAT WAS SAID — the local half, and the reason it is local.
 *
 * A previous attempt (`3e9f06c`, reverted) put the conversation text on `SessionMeta` as
 * `transcript_text` so the browser could filter it client-side. That is the one place it must
 * never go: `SessionMeta` is what `team-uploader.ts` serialises whole into a member's push, and
 * `redactSessionText` covers `first_prompt`/`title`/`user_label`/`user_note` and nothing else — so
 * up to 200 KB of unredacted conversation crossed the wire to the central, against the standing
 * guarantee that members never push chat. It also did not work: the field was only written when a
 * transcript happened to be re-parsed, so on a real machine 1 session of 140 carried one and a
 * search for `docker` found nothing in a corpus holding it 317 times.
 *
 * So the text is never carried anywhere. It is READ, on the machine that owns it, at the moment
 * someone asks, and only an id comes back. Nothing here reaches the web dashboard or a central.
 *
 * ## Why `grep` and not a read loop
 *
 * Measured on this machine — 912 files, 475 MB under `~/.claude/projects`:
 *
 *   - `grep` through `Bun.spawn`, argv array:  255 ms
 *   - reading every file with `Bun.file().text()` and `.includes()`:  3–5 s
 *
 * Twenty times the cost is the difference between a search that runs while you type and one you
 * wait for, so the read loop is not a simpler alternative — it is a different feature.
 *
 * ## The query is DATA
 *
 * `Bun.spawn` takes an argv ARRAY, so no shell parses anything, and `--` terminates the option
 * list so a query of `-r` is a string to look for rather than a flag to obey. Both are asserted in
 * `transcript-search.test.ts` against the hostile inputs, because "we do not use a shell" is a
 * property that a later refactor to `Bun.$` would quietly remove.
 */

import { basename, relative, sep } from 'node:path'
import type { HarnessId } from '@agentistics/core'
import {
  PROJECTS_DIR, CODEX_SESSIONS_DIR, COPILOT_DIR, KIMI_DIR, ANTIGRAVITY_BRAIN_DIR, GEMINI_DIR,
} from '../config'
import { join } from 'node:path'

/**
 * Where one harness keeps the text of its conversations, and what a file there is called.
 *
 * A `Record<HarnessId, …>` rather than a list, following `spawn-spec.ts` and `rename-spec.ts`: the
 * build fails until a new harness is answered for, instead of it being absent and nobody noticing.
 */
export interface TranscriptSource {
  /** The directory to walk. */
  root: string
  /** The file name pattern inside it — `grep --include`. */
  include: string
}

export const TRANSCRIPT_SOURCES: Record<HarnessId, TranscriptSource | null> = {
  // `<projects>/<encoded-project>/<conversation-id>.jsonl`
  claude: { root: PROJECTS_DIR, include: '*.jsonl' },
  // `<sessions>/YYYY/MM/DD/rollout-<timestamp>-<conversation-id>.jsonl`
  codex: { root: CODEX_SESSIONS_DIR, include: 'rollout-*.jsonl' },
  // `<tmp>/<project>/chats/<file>.jsonl` — the id this product uses is synthetic, `<dir>/<file>`.
  gemini: { root: join(GEMINI_DIR, 'tmp'), include: '*.jsonl' },
  // `<session-state>/<conversation-id>/events.jsonl`
  copilot: { root: join(COPILOT_DIR, 'session-state'), include: 'events.jsonl' },
  // `<brain>/<conversation-id>/.system_generated/logs/transcript_full.jsonl`
  antigravity: { root: ANTIGRAVITY_BRAIN_DIR, include: 'transcript_full.jsonl' },
  // `<sessions>/<workspace>/session_<conversation-id>/agents/<agent>/wire.jsonl`
  kimi: { root: join(KIMI_DIR, 'sessions'), include: 'wire.jsonl' },
  // opencode's store is a single SQLite database, not a directory of text files `grep -r` can walk
  // — and there is no legacy adapter anyway (CLAUDE.md step 4, skipped by scope).
  opencode: null,
}

/**
 * The argv for one harness's search.
 *
 * `-r` walks, `-i` ignores case (the list's own filter does, so this one must too, or the same
 * word finds different rows depending on which scope carried it), `-l` stops at the first hit in a
 * file — nothing here needs to know WHERE in a conversation the word appeared, only that it did —
 * and `-Z` separates the names with NUL so a directory containing a space or a newline still
 * yields one path per record.
 */
export function grepArgv(query: string, root: string, include: string): string[] {
  return ['grep', '-rilZ', `--include=${include}`, '--', query, root]
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/**
 * The conversation a transcript file belongs to, or `null`.
 *
 * Each rule was read off the real layout on disk, not inferred from the others — the six harnesses
 * genuinely disagree about where the id lives. `null` for anything that does not fit: a half-parsed
 * id would be matched against the fleet and silently select the wrong row, which is worse than a
 * file this search cannot attribute.
 */
export function conversationIdFrom(harness: HarnessId, path: string, root: string): string | null {
  const rel = relative(root, path)
  if (rel === '' || rel.startsWith('..')) return null
  const parts = rel.split(sep).filter(Boolean)
  const file = basename(path)

  switch (harness) {
    case 'claude': {
      // `<encoded-project>/<id>.jsonl`
      if (!file.endsWith('.jsonl')) return null
      const id = file.slice(0, -'.jsonl'.length)
      return UUID.test(id) ? id : null
    }
    case 'codex': {
      // `rollout-<timestamp>-<id>.jsonl` — the id is the UUID, wherever the timestamp ends.
      const m = file.match(UUID)
      return m ? m[0] : null
    }
    case 'copilot': {
      // `<id>/events.jsonl`
      return parts.length >= 2 ? parts[parts.length - 2]! : null
    }
    case 'kimi': {
      // `<workspace>/session_<id>/agents/<agent>/wire.jsonl` — fold every agent into its session.
      const dir = parts.find(p => p.startsWith('session_'))
      return dir ? dir.slice('session_'.length) || null : null
    }
    case 'antigravity': {
      // `<id>/.system_generated/logs/transcript_full.jsonl` — the FIRST segment under brain/.
      return parts.length >= 2 ? parts[0]! : null
    }
    case 'gemini': {
      // `<project>/chats/<file>.jsonl` — the adapter's id is `<project>/<file-without-ext>`.
      if (parts.length < 2 || !file.endsWith('.jsonl')) return null
      return `${parts[0]}/${file.slice(0, -'.jsonl'.length)}`
    }
    // Unreachable in practice: TRANSCRIPT_SOURCES.opencode is null, so grepArgv is never built for
    // it. Listed so the switch stays exhaustive rather than relying on a fallthrough.
    case 'opencode':
      return null
  }
}

/**
 * The conversations named by one `grep -Z` run, deduplicated, in the order they were reported.
 *
 * Kimi is why the dedupe is here rather than at the caller: a session's agents are separate files
 * under one session directory, so a word said once can legitimately name the same conversation
 * several times.
 */
export function parseGrepOutput(harness: HarnessId, out: string, root: string): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const path of out.split('\0')) {
    if (!path) continue
    const id = conversationIdFrom(harness, path, root)
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}
