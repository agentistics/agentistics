/**
 * opencode-chat.ts — PURE. An opencode conversation's turns, folded from the rows `opencode.db` keeps.
 *
 * opencode stores EVERY session in one SQLite file (`<data>/opencode.db`), so unlike the other readers there
 * is no transcript to tail: a turn is one `message` row (its `data` JSON carries `role`), and what the turn
 * says is in its `part` rows — `text` (the words), `reasoning` (thinking), `tool` (a call, with
 * `state.input` / `state.status`). Measured against opencode 1.19.5 on 2026-10-31 (throwaway HOME) and the
 * 1.17.9 store before it; the same shape the engine's own reader folds.
 *
 * - A part opencode marks `synthetic` or `ignored` is its own plumbing (a file it attached, a reminder it
 *   injected), never words the person or the model said — dropped, the rule every reader here keeps for
 *   what nobody said.
 * - A message with no text, thinking or tool yields no turn (a step that only carried a `step-start`).
 * - Tool names stay opencode's own (`bash`, `write`); `canonical` carries the shared vocabulary, and a shell
 *   detail goes through `commandSummary` (via `toolDetailOf`), never a first-line cut.
 *
 * TOTAL: unparseable `data` is an empty object, and an unknown part type is skipped.
 */
import type { ChatTurn } from '@agentistics/core'
import { canonicalTool } from '../harness-activity'
import { toolDetailOf } from './kimi-chat'

export interface OpencodeMessageRow { id: string; time_created: number; data: string }
export interface OpencodePartRow { id: string; message_id: string; data: string }

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const parse = (s: unknown): Record<string, unknown> => { try { return obj(JSON.parse(String(s))) } catch { return {} } }

const WRITE_TOOLS = new Set(['write', 'edit', 'patch', 'multiedit'])

export function parseOpencodeChat(messages: readonly OpencodeMessageRow[], parts: readonly OpencodePartRow[]): ChatTurn[] {
  const byMsg = new Map<string, OpencodePartRow[]>()
  for (const p of parts) {
    const list = byMsg.get(p.message_id)
    if (list) list.push(p); else byMsg.set(p.message_id, [p])
  }
  const turns: ChatTurn[] = []
  for (const m of messages) {
    const role = parse(m.data).role
    if (role !== 'user' && role !== 'assistant') continue
    const text: string[] = []
    const thinking: string[] = []
    const tools: NonNullable<ChatTurn['tools']> = []
    for (const p of byMsg.get(m.id) ?? []) {
      const d = parse(p.data)
      if (d.synthetic === true || d.ignored === true) continue
      if (d.type === 'text' && typeof d.text === 'string' && d.text.trim() !== '') text.push(d.text)
      else if (d.type === 'reasoning' && typeof d.text === 'string' && d.text.trim() !== '') thinking.push(d.text)
      else if (d.type === 'tool' && typeof d.tool === 'string') {
        const st = obj(d.state)
        const input = obj(st.input)
        const canonical = canonicalTool('opencode', d.tool)
        const detail = toolDetailOf(input)
        const file = typeof input.filePath === 'string' ? input.filePath : typeof input.filepath === 'string' ? input.filepath : null
        tools.push({
          name: d.tool,
          ...(canonical !== d.tool ? { canonical } : {}),
          ...(st.status === 'error' ? { failed: true } : {}),
          ...(detail ? { detail } : {}),
          ...(file && WRITE_TOOLS.has(d.tool) ? { writes: [file] } : {}),
          ref: p.id,
        })
      }
    }
    if (text.length === 0 && thinking.length === 0 && tools.length === 0) continue
    const at = Number.isFinite(m.time_created) ? new Date(m.time_created).toISOString() : undefined
    turns.push({
      role,
      text: text.join('\n'),
      ...(at ? { at } : {}),
      ...(tools.length ? { tools } : {}),
      ...(thinking.length ? { thinking: thinking.join('\n') } : {}),
    })
  }
  return turns
}

/** 2.x tool names → the 1.x names `parseOpencodeChat` and `canonicalTool` know (engine `api.ts` keeps the same table). */
const TOOL_V1: Record<string, string> = { shell: 'bash', subagent: 'task' }
/** 2.x tool status → 1.x (`streaming` is the input still arriving: 1.x called that `pending`). */
const STATUS_V1: Record<string, string> = { streaming: 'pending', running: 'running', completed: 'completed', error: 'error' }

/**
 * PURE. OpenCode 2.x messages (`GET /api/session/{id}/message?order=asc`, measured on 2.2.5) → the 1.x message/part
 * rows `parseOpencodeChat` reads. 2.x folds the parts into the assistant message's own `content[]` (`text`,
 * `reasoning`, `tool`), and a `user` message carries its `text` directly; every other type (`idle`, `system`,
 * `synthetic`, …) is opencode's own plumbing and is dropped, exactly as the 1.x reader drops synthetic parts.
 * Without this, a session created after the 1.x → 2.x migration was "not found" by every host reader (the 1.x
 * tables are frozen at the migration), which is what the hand-off briefing reported as "o arquivo da conversa não
 * foi encontrado". Part ids are `<message id>:<index>`, stable across reads. Junk is skipped, never thrown on.
 */
export function chatRowsOfV2Messages(msgs: readonly unknown[]): { messages: OpencodeMessageRow[]; parts: OpencodePartRow[] } {
  const messages: OpencodeMessageRow[] = []
  const parts: OpencodePartRow[] = []
  for (const raw of msgs) {
    const m = obj(raw)
    if (typeof m.id !== 'string') continue
    const created = typeof obj(m.time).created === 'number' ? obj(m.time).created as number : 0
    if (m.type === 'user') {
      messages.push({ id: m.id, time_created: created, data: JSON.stringify({ role: 'user' }) })
      if (typeof m.text === 'string' && m.text !== '') parts.push({ id: `${m.id}:0`, message_id: m.id, data: JSON.stringify({ type: 'text', text: m.text }) })
      continue
    }
    if (m.type !== 'assistant') continue
    messages.push({ id: m.id, time_created: created, data: JSON.stringify({ role: 'assistant' }) })
    const content = Array.isArray(m.content) ? m.content : []
    content.forEach((rc, i) => {
      const c = obj(rc)
      let data: Record<string, unknown> | null = null
      if ((c.type === 'text' || c.type === 'reasoning') && typeof c.text === 'string') data = { type: c.type, text: c.text }
      else if (c.type === 'tool' && typeof c.name === 'string') {
        const st = obj(c.state)
        const input = { ...obj(st.input) }
        if (typeof input.path === 'string' && input.filePath === undefined) input.filePath = input.path
        data = { type: 'tool', tool: TOOL_V1[c.name] ?? c.name, state: { status: STATUS_V1[String(st.status)] ?? st.status, input } }
      }
      if (data) parts.push({ id: `${m.id}:${i}`, message_id: m.id as string, data: JSON.stringify(data) })
    })
  }
  return { messages, parts }
}
