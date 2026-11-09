/**
 * pending-prompts.ts — a message handed to a session and not yet visible in its transcript.
 *
 * Reported: "quando eu envio uma mensagem pelo celular a mensagem não aparece em todos os
 * dispositivos… diferentes dispositivos, mesmo acessando a mesma aplicação, não estão
 * sincronizados". And then the worse half: "se eu fechar a aplicação e abrir de novo a mensagem
 * vira um fantasma e não dá pra saber se foi perdida ou está em fila".
 *
 * Both come from the same place. The queued message was a BROWSER fact — an echo held in the tab
 * that sent it — so a second device had no way to learn about it, and the tab that did know lost
 * the one thing that made it readable on a reload: when it was sent. A message you cannot tell
 * apart from a lost one is worse than either.
 *
 * So the queue moves to the server, which is the only party every device already agrees with. Two
 * consequences, and both are the point:
 *
 *  - **every device shows it**, because they all poll the same list;
 *  - **it carries `at`**, so any of them can say how long it has been waiting instead of showing a
 *    bubble with no age.
 *
 * It is persisted under the server data directory. A restart must not turn a delivered-but-not-yet-
 * echoed message into a ghost, and the queue is bounded and retired as soon as the transcript accounts
 * for it. The file is deliberately a small implementation detail rather than part of the task book.
 *
 * RETIRING IS `pendingEchoes`, from `@agentistics/core`, which is where that rule now lives BECAUSE
 * of this file. The browser has always had it; a second implementation here would be a second
 * opinion about whether a message has landed, on the same screen, in the same second.
 */

import { pendingEchoes } from '@agentistics/core'
import { AGENTISTICS_DATA_DIR } from '../config'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

export interface PendingPrompt {
  /** Exactly what was handed to the session. */
  text: string
  /** When, as epoch ms — so any device can age it, not just the one that sent it. */
  at: number
}

/**
 * How long an unmatched entry is kept.
 *
 * `pendingEchoes` retires a message the transcript accounts for; this retires one it never will.
 * A harness can drop a line (a dialog swallowed it, the pane died mid-write), and without a ceiling
 * that message waits on every device forever — which is the ghost, moved from one browser to all of
 * them. Twenty minutes is far longer than any real queue here and far short of a session's life.
 */
export const PENDING_TTL_MS = 20 * 60 * 1000

/**
 * How long an entry that the live view gave up on is still KEPT, to be offered back when its session
 * is killed (MENSAGENS.KILL). The live ceiling above stops a dropped message from haunting a RUNNING
 * session; it must not also erase it, because the person who killed a hung session needs exactly those
 * words again. Two weeks is far past any session's life and still bounded.
 */
export const STRANDED_KEEP_MS = 14 * 24 * 60 * 60 * 1000

/** The most entries kept per conversation — a runaway sender cannot grow this without bound. */
const MAX_PER_SESSION = 50
/**
 * The most entries kept in all. Expired ones (older than `STRANDED_KEEP_MS`, never offered again) are dropped
 * FIRST; only if the store is still over this does the OLDEST unexpired entry go. So a stranded message can be
 * evicted early only when more than this many unread messages are held at once (about 240 KB on disk).
 * At 500 a 13-day entry was lost under load, before the promised 14 days.
 */
export const MAX_STORED_PROMPTS = 1000
// Under `bun test` (NODE_ENV=test) the default store is a per-process temp file, so no suite that
// records or resets prompts can ever touch the user's real queue.
let storeFile = process.env.NODE_ENV === 'test'
  ? join(tmpdir(), `agentistics-pending-prompts-${process.pid}.json`)
  : join(AGENTISTICS_DATA_DIR, 'pending-prompts.json')

const byConversation = new Map<string, PendingPrompt[]>()
let loaded = false

function trimTotal(now = Date.now()): void {
  const all = [...byConversation.entries()].flatMap(([conversationId, prompts]) => prompts.map(prompt => ({ conversationId, prompt })))
  if (all.length <= MAX_STORED_PROMPTS) return
  const live = all.filter(x => now - x.prompt.at < STRANDED_KEEP_MS)
  const keep = new Set(live.sort((a, b) => a.prompt.at - b.prompt.at).slice(-MAX_STORED_PROMPTS).map(x => x.prompt))
  for (const [id, prompts] of byConversation) {
    const left = prompts.filter(prompt => keep.has(prompt))
    if (left.length) byConversation.set(id, left)
    else byConversation.delete(id)
  }
}

function load(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = JSON.parse(readFileSync(storeFile, 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!id || !Array.isArray(value)) continue
      const prompts = value.filter((p): p is PendingPrompt => Boolean(p) && typeof p === 'object'
        && typeof (p as PendingPrompt).text === 'string' && (p as PendingPrompt).text.trim() !== ''
        && Number.isFinite((p as PendingPrompt).at))
      if (prompts.length) byConversation.set(id, prompts.slice(-MAX_PER_SESSION))
    }
    trimTotal()
  } catch { /* missing/corrupt state is an empty queue */ }
}

function persist(): void {
  try {
    mkdirSync(dirname(storeFile), { recursive: true, mode: 0o700 })
    const tmp = `${storeFile}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(byConversation)), { mode: 0o600 })
    renameSync(tmp, storeFile)
  } catch { /* a display queue must never make a successful prompt fail */ }
}

/** Record a message just handed to a session. Called only on a delivery the backend confirmed. */
export function recordPrompt(conversationId: string, text: string, now = Date.now()): void {
  load()
  if (conversationId === '' || text.trim() === '') return
  const list = byConversation.get(conversationId) ?? []
  // A resend of words still held (stranded or expired) REPLACES the old copy: one message, one entry.
  const rest = list.filter(p => p.text !== text)
  rest.push({ text, at: now })
  byConversation.set(conversationId, rest.slice(-MAX_PER_SESSION))
  trimTotal(now)
  persist()
}

/**
 * What is still waiting for this conversation, given the user turns its transcript now carries.
 *
 * PURE in everything that matters: the store is read and rewritten to what survives, so the same
 * comparison decides both what is returned and what is kept. Two passes could disagree.
 */
export function pendingFor(
  conversationId: string,
  userTurns: readonly string[],
  now = Date.now(),
): PendingPrompt[] {
  load()
  const list = byConversation.get(conversationId)
  if (list === undefined || list.length === 0) return []
  // Past the live ceiling an entry is HIDDEN from a running session but KEPT (see STRANDED_KEEP_MS).
  const held = list.filter(p => now - p.at < STRANDED_KEEP_MS)
  const stillWaiting = new Set(pendingEchoes(held.map(p => p.text), userTurns))
  const kept = held.filter(p => stillWaiting.has(p.text))
  if (kept.length === 0) byConversation.delete(conversationId)
  else byConversation.set(conversationId, kept)
  if (held.length !== list.length || kept.length !== held.length) persist()
  return kept.filter(p => now - p.at < PENDING_TTL_MS)
}

/**
 * What a session that is NO LONGER RUNNING was handed and never read — everything still held, however
 * old, until the transcript accounts for it (a reopened conversation that already carries the text
 * retires it) or `STRANDED_KEEP_MS` passes. Offered to the person, never re-sent by itself: the session
 * may have been killed because of these very messages.
 */
export function strandedFor(
  conversationId: string,
  userTurns: readonly string[],
  now = Date.now(),
): PendingPrompt[] {
  pendingFor(conversationId, userTurns, now)
  return [...(byConversation.get(conversationId) ?? [])]
}

/**
 * Move what is held under `fromKey` to `toKey`, keeping order and dropping nothing.
 *
 * A message sent BEFORE its conversation is linked (codex / gemini / kimi / antigravity name no
 * conversation until the first one is claimed) is held under the managed ROW id. When the link
 * appears the entry belongs to the conversation, so it moves there — appended after what the
 * conversation already holds, and an identical (text, at) pair is never duplicated. Called on every
 * read, and idempotent: with nothing under `fromKey` it does nothing.
 */
export function migratePrompts(fromKey: string, toKey: string): void {
  load()
  if (fromKey === '' || toKey === '' || fromKey === toKey) return
  const moved = byConversation.get(fromKey)
  if (moved === undefined) return
  byConversation.delete(fromKey)
  const into = byConversation.get(toKey) ?? []
  for (const p of moved) if (!into.some(q => q.text === p.text && q.at === p.at)) into.push(p)
  into.sort((a, b) => a.at - b.at)
  byConversation.set(toKey, into.slice(-MAX_PER_SESSION))
  trimTotal()
  persist()
}

/** Drop everything for a conversation — used when a session is killed. */
export function clearPrompts(conversationId: string): void {
  load()
  byConversation.delete(conversationId)
  persist()
}

/** Test seam only: the store is process-wide, so a test that writes must be able to reset it. */
export function resetPrompts(): void {
  byConversation.clear()
  loaded = true
  try { unlinkSync(storeFile) } catch { /* already absent */ }
}

/** Test seam: point this process at a throwaway store without touching the user's data dir. */
export function usePromptStoreForTests(file: string): void {
  byConversation.clear()
  loaded = false
  storeFile = file
}

/** Test seam for a server restart: forget the process cache, then read the durable queue again. */
export function reloadPrompts(): void {
  byConversation.clear()
  loaded = false
  load()
}
