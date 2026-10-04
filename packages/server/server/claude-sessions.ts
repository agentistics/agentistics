import path from 'node:path'
import { PROJECTS_DIR } from './config'
import { safeReadDir } from './utils'
import { UUID_RE } from './git'
import { createTranscriptFold } from './transcript-fold'

export type ClaudeSessionSummary = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
  model: string
}

export type ClaudeSessionMessage = {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  tools?: string[]
}

/** The person's text in a user line, or null for a line that is only tool results / empty. */
function userText(e: Record<string, unknown>): { text: string; counts: boolean } | null {
  const msgContent = (e.message as Record<string, unknown> | undefined)?.content
  if (typeof msgContent === 'string' && msgContent.trim()) return { text: msgContent, counts: true }
  if (Array.isArray(msgContent)) {
    const arr = msgContent as Record<string, unknown>[]
    if (arr.every(p => p.type === 'tool_result')) return null
    const text = arr.find(p => p.type === 'text' && typeof p.text === 'string')?.text as string | undefined
    return { text: text ?? '', counts: true }
  }
  return null
}

// PERF.1 step 3: each transcript is parsed ONCE and then only as it grows (`transcript-fold.ts`).
// The list used to re-parse every transcript of a project on each call, the open its whole file.

interface Summary { title: string; firstTs: string; lastTs: string; userMsgCount: number; model: string }

const summaries = createTranscriptFold<Summary>({
  init: () => ({ title: '', firstTs: '', lastTs: '', userMsgCount: 0, model: '' }),
  fold(s, e) {
    const ts = e.timestamp as string | undefined
    if (ts) { if (!s.firstTs) s.firstTs = ts; s.lastTs = ts }
    if (e.type === 'user') {
      const u = userText(e)
      if (u) {
        if (!s.title && u.text) s.title = u.text.slice(0, 120)
        s.userMsgCount++
      }
    }
    if (!s.model && e.type === 'assistant') {
      const m = (e.message as Record<string, unknown> | undefined)?.model
      if (typeof m === 'string' && m.startsWith('claude-')) s.model = m
    }
  },
}, { maxEntries: 5000 })

const messageFolds = createTranscriptFold<ClaudeSessionMessage[]>({
  init: () => [],
  fold(messages, e) {
    const ts = e.timestamp ? new Date(e.timestamp as string).getTime() : Date.now()
    if (e.type === 'user') {
      const u = userText(e)
      if (u && u.text) messages.push({ role: 'user', content: u.text, timestamp: ts })
    } else if (e.type === 'assistant') {
      const msgContent = (e.message as Record<string, unknown> | undefined)?.content
      if (Array.isArray(msgContent)) {
        const textBlock = msgContent.find((p: Record<string, unknown>) => p.type === 'text' && typeof p.text === 'string')
        if (textBlock) {
          const tools = (msgContent as Record<string, unknown>[])
            .filter(p => p.type === 'tool_use' && typeof p.name === 'string')
            .map(p => p.name as string)
          messages.push({ role: 'assistant', content: textBlock.text as string, timestamp: ts, tools: tools.length > 0 ? tools : undefined })
        }
      }
    }
  },
  weigh: ms => ms.reduce((n, m) => n + m.content.length * 2 + 64, 0),
}, { maxEntries: 16, maxWeight: 64 * 1024 * 1024 })

export async function listClaudeSessions(encodedDir: string, projectsDir = PROJECTS_DIR): Promise<ClaudeSessionSummary[]> {
  const dir = path.join(projectsDir, encodedDir)
  const files = await safeReadDir(dir)
  const sessions: ClaudeSessionSummary[] = []
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue
    const id = file.slice(0, -6)
    if (!UUID_RE.test(id)) continue
    const s = await summaries.get(path.join(dir, file))
    if (!s || !s.title) continue
    sessions.push({ id, title: s.title, createdAt: s.firstTs, updatedAt: s.lastTs || s.firstTs, messageCount: s.userMsgCount, model: s.model })
  }
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function getClaudeSessionMessages(encodedDir: string, sessionId: string, projectsDir = PROJECTS_DIR): Promise<ClaudeSessionMessage[]> {
  if (!UUID_RE.test(sessionId)) return []
  const ms = await messageFolds.get(path.join(projectsDir, encodedDir, `${sessionId}.jsonl`))
  return ms ? [...ms] : []
}

export interface ClaudeSessionPage {
  messages: ClaudeSessionMessage[]
  /** Index of the first message returned; `0` means the conversation's beginning is included. */
  start: number
  total: number
}

/** The END of a conversation first (`before` absent), then older pages by index. */
export async function getClaudeSessionPage(encodedDir: string, sessionId: string, limit: number, before?: number, projectsDir = PROJECTS_DIR): Promise<ClaudeSessionPage> {
  if (!UUID_RE.test(sessionId)) return { messages: [], start: 0, total: 0 }
  const ms = (await messageFolds.get(path.join(projectsDir, encodedDir, `${sessionId}.jsonl`))) ?? []
  const end = Math.max(0, Math.min(ms.length, before ?? ms.length))
  const start = Math.max(0, end - Math.max(1, limit))
  return { messages: ms.slice(start, end), start, total: ms.length }
}
