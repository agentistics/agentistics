/**
 * nativeChatSource.ts — PURE (UI.UNIFY): a NATIVE session's chat, read through the SAME seam the
 * standard `SessionChat` reads a harness transcript through.
 *
 * `SessionChat` used to read exactly one source: `/api/fleet/chat` for the turns, the tmux screen
 * for the in-flight text, `/api/fleet/act` for every verb. A native session has none of the three —
 * the engine streams its own window and events — so it had a whole second chat (`NativeSessionChat`)
 * with its own composer, bubbles and bottom strip. The owner's ruling: one shell for every harness.
 *
 * So the standard chat now takes an optional `ChatSource` (`components/sessions/chatSource.ts`) and
 * this file is the native half of it, kept pure so it can be pinned:
 *
 *   - `nativeChatTurns`  the engine's items -> `ChatTurn[]`, the shape `ChatBubble` already draws.
 *                        Tool calls become the `tools` a CLI assistant turn carries, in the shared
 *                        vocabulary (`nativeToolName`), so the live feed, the artifacts list and the
 *                        working note read them exactly as they read a CLI session's. A sent attachment becomes a markdown link/image to
 *                        the engine's own URL, so the bubble renders it with no new component.
 *   - `nativeLiveText`   the model's own stream (the `live` item), which is what the screen scrape
 *                        is for a CLI session — and unlike the scrape it is exact.
 *   - `nativeAsks`       the questions waiting on the person — drawn where `ApprovalCard` draws.
 *   - `nativeSendParts`  the composer's message (paths on their own lines above the words, see
 *                        `messageAttachments.ts`) back into words + the stored upload names the
 *                        engine attaches.
 */
import type { ChatTurn } from '../components/sessions/ChatBubble'
import type { NativeAsk, NativeChatItem } from './nativeChat'
import { ATTACHMENT_DIR_MARK, attachmentName, splitMessage } from './messageAttachments'
import { mediaTypeOf } from './nativeAttachments'

/** The native runtime's tool names in the shared vocabulary. A MAPPING, never a filter. */
const NATIVE_TOOL_NAMES: Record<string, string> = {
  'file.read': 'Read', 'file.write': 'Write', 'file.patch': 'Edit',
  'shell.start': 'Bash', 'fs.grep': 'Grep', 'fs.glob': 'Glob',
}
export function nativeToolName(name: string): string {
  return NATIVE_TOOL_NAMES[name] ?? name
}

const STOPPED = {
  en: '_Stopped by you — the answer above is incomplete._',
  pt: '_Parada por você — a resposta acima ficou incompleta._',
} as const

/** The engine's chat items as the standard chat's turns. The live text is NOT a turn (`nativeLiveText`). */
export function nativeChatTurns(items: readonly NativeChatItem[], lang: 'pt' | 'en'): ChatTurn[] {
  const out: ChatTurn[] = []
  /** Consecutive tool calls fold into ONE assistant turn's chip row, as a CLI turn carries them. */
  let tools: NonNullable<ChatTurn['tools']> | null = null
  const flushTools = () => {
    if (tools && tools.length > 0) out.push({ role: 'assistant', text: '', tools })
    tools = null
  }
  for (const i of items) {
    if (i.kind === 'tool') {
      // In the SHARED vocabulary (Claude's, the one every surface selects on — `canonicalTool` on the
      // server), with the bare path or command as `detail`: that is what lets the aside's live feed
      // and its artifacts list a native call exactly as they list a CLI one. A name with no mapping
      // passes through unchanged, never dropped.
      const detail = i.card.detail
      ;(tools ??= []).push({ name: nativeToolName(i.card.name), ...(detail ? { detail } : {}) })
      continue
    }
    if (i.kind === 'approval') continue
    if (i.key === 'live') continue
    flushTools()
    const links = (i.attachments ?? []).map(a => {
      const name = (a.name || '').replace(/^[0-9a-f]{8}-/, '') || (a.mediaType === 'application/pdf' ? 'PDF' : 'image')
      return a.mediaType.startsWith('image/') ? `![${name}](${a.url})` : `[${name}](${a.url})`
    })
    const text = [...links, i.turn.text].filter(t => t.trim() !== '').join('\n\n')
    const turn: ChatTurn = { role: i.turn.role, text: i.stopped ? `${text}\n\n${STOPPED[lang]}` : text }
    if (i.turn.at) turn.at = i.turn.at
    if (i.turn.thinking) turn.thinking = i.turn.thinking
    if (i.turn.reasoning) turn.reasoning = i.turn.reasoning
    out.push(turn)
  }
  flushTools()
  return out
}

/** The model's in-flight text, or null — the native counterpart of the CLI's screen-read live turn. */
export function nativeLiveText(items: readonly NativeChatItem[]): string | null {
  for (const i of items) if (i.kind === 'turn' && i.key === 'live' && i.turn.text.trim() !== '') return i.turn.text
  return null
}

/** The in-flight turn's REASONING (its own channel), or null — folded above the live text. */
export function nativeLiveReasoning(items: readonly NativeChatItem[]): string | null {
  for (const i of items) if (i.kind === 'turn' && i.key === 'live' && i.turn.reasoning?.trim()) return i.turn.reasoning
  return null
}

/** The questions waiting on the person, in order, each once. */
export function nativeAsks(items: readonly NativeChatItem[]): NativeAsk[] {
  const seen = new Set<string>()
  const out: NativeAsk[] = []
  for (const i of items) {
    const ask = i.kind === 'approval' ? i.ask : i.kind === 'tool' ? i.card.ask : undefined
    if (!ask || seen.has(ask.questionId)) continue
    seen.add(ask.questionId)
    out.push(ask)
  }
  return out
}

/** Whether a tool call is running and no question is open — the standard chat's "working" note. */
export function nativeRunningTools(items: readonly NativeChatItem[]): { name: string; detail?: string }[] {
  return items.flatMap(i => (i.kind === 'tool' && i.card.status === 'running'
    ? [{ name: nativeToolName(i.card.name), ...(i.card.detail ? { detail: i.card.detail } : {}) }]
    : []))
}

/** The composer's message as the engine takes it: the words, and the stored names of what it carries. */
export function nativeSendParts(message: string): { text: string; uploads: { name: string; mediaType: string; size: number }[]; refused: string[] } {
  const { attachments, text } = splitMessage(message)
  const uploads: { name: string; mediaType: string; size: number }[] = []
  const refused: string[] = []
  for (const path of attachments) {
    if (!path.includes(ATTACHMENT_DIR_MARK)) continue
    const name = attachmentName(path)
    const mediaType = mediaTypeOf({ name, type: '' })
    if (mediaType) uploads.push({ name, mediaType, size: 0 })
    else refused.push(name)
  }
  return { text, uploads, refused }
}
