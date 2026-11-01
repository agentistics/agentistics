/** Live context uses the chat's exact-ID resolver, including every account store and newest copy.
 * The consolidated history alone can be missing (or frozen before an account switch).
 */
import { basename } from 'node:path'
import { HARNESS_CAPABILITIES, resolveContextWindow, type HarnessId, type SessionMeta } from '@agentistics/core'
import { claudeTranscriptState } from '../transcript-state'
import { createFileMemo, versionOf } from '../adapters/file-memo'
import { transcriptReaderFor } from './harness-transcript'
import { toConversation, findConversation, type Conversation } from './conversations'
import { readTailWindow } from './transcript-window'
import { parseCodexRollout } from '../adapters/codex-parse'
import { parseGeminiChat } from '../adapters/gemini-parse'
import { emptyKimiTotals, accumulateKimiWire } from '../adapters/kimi-parse'

interface ContextSample { tokens?: number; window?: number; model?: string }
const memo = createFileMemo<ContextSample | null>(256)

async function readContext(harness: HarnessId, path: string, fallbackModel?: string): Promise<ContextSample | null> {
  if (harness === 'claude') {
    // Shared incremental walk: unchanged polls read no transcript bytes; appends read only new bytes.
    const read = await claudeTranscriptState(path)
    return read ? { tokens: read.state.contextTokensAny || undefined, model: read.state.modelId || read.state.modelFirst200 || undefined } : null
  }
  return memo.get(`${harness}:${path}:${fallbackModel ?? ''}`, await versionOf([path]), async () => {
    // A gauge needs the last usage record, not the whole history. Reuse the chat's bounded,
    // widening tail reader and the adapters' measured arithmetic; unchanged files cost a stat.
    const samples = await readTailWindow<ContextSample>(path, 1, (lines, atStart) => {
      const content = lines.join('\n')
      let sample: ContextSample | null = null
      switch (harness) {
        case 'codex': {
          const s = parseCodexRollout(content, basename(path))
          if (s) sample = { tokens: s.context_tokens, window: s.context_window, model: s.model }
          break
        }
        case 'gemini': {
          const s = parseGeminiChat(content, basename(path), '')
          if (s) sample = { tokens: s.context_tokens, window: s.context_window, model: s.model }
          break
        }
        case 'kimi': {
          // A child agent's window is never the main session's window.
          if (!path.endsWith('/agents/main/wire.jsonl')) break
          const totals = emptyKimiTotals()
          accumulateKimiWire(content, totals, { main: true })
          sample = { tokens: totals.contextTokens, model: totals.model || totals.requestedModel || totals.boundModel || undefined }
          break
        }
      }
      if (!sample?.tokens) return []
      // Widen for model/window metadata when the linked row cannot supply it.
      return atStart || sample.window || resolveContextWindow(sample.model ?? fallbackModel) ? [sample] : []
    })
    return samples[0] ?? null
  })
}

export interface ContextLink {
  harness: HarnessId
  cwd: string
  conversationId?: string
  model?: string
  endedAt?: string
}

/** Enrich copies, never the cached history. No account binding or directory inference is needed. */
export async function refreshConversationContexts(
  history: readonly Conversation[],
  rows: readonly ContextLink[],
  readerFor = transcriptReaderFor,
  loadOpencode: () => Promise<SessionMeta[]> = async () => {
    const { opencodeAdapter } = await import('../adapters/opencode')
    return opencodeAdapter.isAvailable() ? opencodeAdapter.loadSessions() : []
  },
): Promise<Conversation[]> {
  const result = [...history]
  const seen = new Set<string>()
  let opencode: Promise<SessionMeta[]> | undefined
  for (const row of rows) {
    const id = row.conversationId
    if (!id || row.endedAt || !HARNESS_CAPABILITIES[row.harness]?.contextWindow) continue
    const key = `${row.harness}:${id}`
    if (seen.has(key)) continue
    seen.add(key)
    try {
      // SQLite has no transcript path. Refresh exact native IDs through its adapter, including
      // token/cost footer fields, so the consolidated-history TTL cannot freeze a live OpenCode row.
      if (row.harness === 'opencode') {
        const sessions = await (opencode ??= loadOpencode())
        const meta = sessions.find(s => s.session_id === id)
        if (meta) {
          const previous = findConversation(result.filter(c => c.harness === row.harness), id)
          const next = toConversation(meta)
          if (previous) result[result.indexOf(previous)] = next
          else result.push(next)
        }
        continue
      }
      const reader = readerFor(row.harness)
      const path = await reader?.resolve({ conversationId: id, cwd: row.cwd })
      if (!path) continue
      const previous = findConversation(result.filter(c => c.harness === row.harness), id)
      const sample = await readContext(row.harness, path, previous?.model ?? row.model)
      if (!sample?.tokens) continue
      const model = sample.model ?? previous?.model ?? row.model
      const window = sample.window ?? resolveContextWindow(model)?.tokens
      if (!window) continue
      const next: Conversation = {
        ...(previous ?? {
          sessionId: id, harness: row.harness, cwd: row.cwd, title: '', firstPrompt: '',
          startedMs: 0, lastActivityMs: 0, resumable: true,
        }),
        contextTokens: sample.tokens, contextWindow: window,
      }
      if (previous) result[result.indexOf(previous)] = next
      else result.push(next)
    } catch { /* An unreadable transcript costs its live reading, never the fleet. */ }
  }
  return result
}
