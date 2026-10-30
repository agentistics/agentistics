/**
 * gemini-chat.ts — PURE. Gemini's conversation, read from its own chat journal.
 *
 * ## Why this exists now and did not before
 *
 * `harness-transcript.ts` carried `gemini: null` with a reason, and the reason was a LINK fact
 * rather than a format one: a reader is only ever offered a `conversationId`, and gemini then had no
 * `assignId` and no id-taking `resume` (it has both since F0.2 — the header UUID is resolved by
 * `resolveGeminiTranscript` beside the synthetic id described below).
 *
 * What changed is that the link arrived from the other side. `planFirstSightingClaims` deliberately
 * includes gemini, and the id it claims is the SYNTHETIC one this product already keys the store on
 * — `${dirName}/${fileBase}` — which names a file directly:
 * `~/.gemini/tmp/<dirName>/chats/<fileBase>.jsonl`. So the id a gemini row now carries is not a
 * UUID that resolves to nothing; it is the path, in the only form this product ever knew it by.
 *
 * ## The journal, measured rather than assumed
 *
 * Captured 2026-09-08 from gemini 0.55.x. One JSON document per line:
 *
 *  - a HEADER — `{sessionId, projectHash, startTime, lastUpdated, kind}`;
 *  - a SEED — `{"$set":{"messages":[…]}}`, written once near the top and EMPTY for a fresh session
 *    (it repeats earlier turns for a resumed one);
 *  - the TURNS, appended each as their own top-level record
 *    `{id, timestamp, type, content, model?}`;
 *  - PATCHES — `{"$set":{"lastUpdated":…}}` after every turn, which are bookkeeping and not turns.
 *
 * The appended records are the part `gemini-parse.ts` was missing, and missing them is why 27 of
 * 34 chat files on this machine parsed to nothing at all. This module reads BOTH sources through
 * one `id`-keyed gate, because a resumed session carries the same turn in each.
 *
 * ## What is NOT a turn
 *
 * `info` and `error` are the harness talking about itself; they are dropped rather than attributed
 * to a speaker, the same way `antigravity-chat.ts` refuses to draw a `SYSTEM_MESSAGE` as a message.
 * And gemini writes a `<session_context>` bootstrap block under the USER role, which is not
 * something the person said — every other reader here applies the same rule to its own harness's
 * injected entry, and showing it would open every session on a wall of context nobody typed.
 */

import type { ChatTurn } from '@agentistics/core'
import { parseGeminiShell } from './bash-mode'
import { canonicalTool } from '../harness-activity'
import { commandSummary } from './shell-writes'

/** The bootstrap block gemini writes under the user role on startup. Not a person talking. */
const SESSION_CONTEXT = /^<session_context>/
/** Entries the harness or agentistics typed under the user role: notes, never the person (HANDOFF.RELAY). */
const INJECTED = /^(?:<system-reminder>|<task-notification>|<local-command|<agentistics-context>|<agent-message(?:\s|>)|\[from agentistics\b)/i

/** Gemini's own message types, mapped onto the two roles a turn can have. `null` = not a turn. */
function roleOf(type: unknown): ChatTurn['role'] | null {
  if (type === 'user') return 'user'
  // `model` is the older name for the same thing and is accepted, so a transcript written by an
  // earlier gemini still reads. Anything else — `info`, `error`, or a type nobody has seen — is
  // NOT given a speaker: inventing one is the expensive direction in a record of what was said.
  if (type === 'gemini' || type === 'model') return 'assistant'
  return null
}

/** The text of one message, whichever of the two shapes it uses. */
function textOf(msg: Record<string, unknown>): string {
  const content = msg.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => (part && typeof part === 'object' ? String((part as { text?: unknown }).text ?? '') : ''))
      .join('')
  }
  return ''
}

/** Gemini stores structured args on the tool call, beside its explicit status. */
function toolDetailOf(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const input = args as Record<string, unknown>
  for (const key of ['command', 'file_path', 'path', 'dir_path', 'pattern', 'query', 'url']) {
    const value = input[key]
    if (typeof value !== 'string' || !value.trim()) continue
    if (key === 'command') return commandSummary(value)
    const line = value.trim().split('\n')[0]!
    return line.length > 200 ? `${line.slice(0, 200)}…` : line
  }
  return undefined
}

/**
 * The conversation, oldest first, capped at `max` turns FROM THE END.
 *
 * Takes the file's lines rather than its bytes so `readTailWindow` can hand it the tail of a long
 * journal without this module knowing anything about files — the same shape `parseCopilotChat`
 * takes, and for the same reason.
 *
 * Never throws: a line that will not parse costs that line and nothing else.
 */
export function parseGeminiChatTurns(lines: readonly string[], max: number): ChatTurn[] {
  const turns: ChatTurn[] = []
  // Spans BOTH sources. A resumed session's seed repeats turns that then arrive again as their own
  // lines, and showing a turn twice reads as the assistant repeating itself.
  const seen = new Set<string>()

  const take = (raw: unknown): void => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    const msg = raw as Record<string, unknown>
    const id = typeof msg.id === 'string' ? msg.id : undefined
    if (id !== undefined) {
      if (seen.has(id)) return
      seen.add(id)
    }
    const role = roleOf(msg.type)
    if (!role) return
    const text = textOf(msg).trim()
    const tools: NonNullable<ChatTurn['tools']> = []
    if (role === 'assistant' && Array.isArray(msg.toolCalls)) {
      for (const raw of msg.toolCalls) {
        if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !raw.name) continue
        const canonical = canonicalTool('gemini', raw.name)
        const detail = toolDetailOf(raw.args)
        tools.push({
          name: raw.name,
          ...(canonical !== raw.name ? { canonical } : {}),
          ...(detail ? { detail } : {}),
          ...(raw.status === 'error' ? { failed: true } : {}),
        })
      }
    }
    if (!text && tools.length === 0) return
    if (role === 'user' && SESSION_CONTEXT.test(text)) return
    // A `!` the person ran in the CLI: one entry holding the command AND what it printed.
    const shell = role === 'user' ? parseGeminiShell(text) : null
    const injected = role === 'user' && INJECTED.test(text)
    turns.push({
      role,
      ...(tools.length > 0 ? { tools } : {}),
      text: shell ? `!${shell.command}` : text,
      ...(injected ? { system: 'an injected note' } : {}),
      ...(shell ? { shell } : {}),
      ...(typeof msg.timestamp === 'string' && msg.timestamp ? { at: msg.timestamp } : {}),
    })
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const obj = parsed as Record<string, unknown>

    // The seed. Its `messages` are turns; every other `$set` is a patch of the session's own
    // fields, and a `lastUpdated` is not something anybody said.
    const set = obj.$set
    if (set !== undefined) {
      const seeded = (set as { messages?: unknown })?.messages
      if (Array.isArray(seeded)) for (const m of seeded) take(m)
      continue
    }

    // The header carries no `type`, so it is skipped by `roleOf` anyway; the explicit check keeps
    // that an intention rather than a side effect.
    if (obj.sessionId !== undefined && obj.type === undefined) continue

    take(obj)
  }

  return max >= 0 && turns.length > max ? turns.slice(turns.length - max) : turns
}
