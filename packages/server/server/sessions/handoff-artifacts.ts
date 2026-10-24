/** Timestamped native usage for quota calibration, including builds without an engine. */
import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { calcCost, hasModelPrice, sessionCostUSD, type HarnessId, type PlanLimits } from '@agentistics/core'
import { CLAUDE_DIR, CODEX_DIR, GEMINI_DIR } from '../config'
import { emptyClaudeParse, foldClaudeParse } from '../jsonl'
import { parseGeminiChat } from '../adapters/gemini-parse'
import { listGeminiFamilies } from './gemini-family-io'
import type { AccountsFile } from '../harness-accounts'
import type { BilledReply } from './handoff-usage'

// @harness-adapters-only: only these harnesses write native usage logs we can parse for quota calibration.
export const nativeQuotaHarnesses = ['claude', 'codex', 'gemini'] as const
export type NativeQuotaRoots = Partial<Record<typeof nativeQuotaHarnesses[number], string>>
const defaultRoots: NativeQuotaRoots = { claude: CLAUDE_DIR, codex: CODEX_DIR, gemini: GEMINI_DIR }
const patterns = { claude: 'projects/**/*.jsonl', codex: 'sessions/**/*.jsonl', gemini: 'tmp/*/chats/*.json*' }

/** Reuse the normal parser for counters and TTLs; final usage wins per response ID. */
export function claudeBilledReplies(content: string, conversationId: string): BilledReply[] {
  const replies = new Map<string, BilledReply>()
  let anonymous = 0
  for (const line of content.split('\n')) {
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    if (entry?.type !== 'assistant' || !entry.message?.usage || entry.isApiErrorMessage) continue
    const state = emptyClaudeParse()
    foldClaudeParse(state, [line])
    const model = entry.message.model ?? ''
    if (state.inputTokens + state.outputTokens + state.cacheReadTokens + state.cacheCreationTokens === 0) continue
    const key = entry.message.id || `anonymous:${anonymous++}`
    const costUSD = hasModelPrice(model) ? calcCost({ inputTokens: state.inputTokens, outputTokens: state.outputTokens,
      cacheReadInputTokens: state.cacheReadTokens, cacheCreationInputTokens: state.cacheCreationTokens,
      ...(state.sawCacheCreationBreakdown && state.cacheCreation1hTokens + state.cacheCreation5mTokens === state.cacheCreationTokens
        ? { cacheCreation1hInputTokens: state.cacheCreation1hTokens, cacheCreation5mInputTokens: state.cacheCreation5mTokens } : {}),
      webSearchRequests: 0, costUSD: 0 }, model) : null
    replies.set(key, { harness: 'claude', conversationId, model, costUSD,
      at: replies.get(key)?.at ?? Date.parse(entry.timestamp) })
  }
  return [...replies.values()]
}

export function geminiBilledReplies(content: string, conversationId: string): BilledReply[] {
  // Gemini's file name differs from its native resume id; preserve the journal identity.
  for (const text of [content, content.split('\n')[0]!]) {
    try { const id = JSON.parse(text).sessionId; if (typeof id === 'string' && id) { conversationId = id; break } } catch { /* JSONL */ }
  }
  const messages = new Map<string, any>()
  const add = (rows: any[]) => { for (const msg of rows) messages.set(msg.id ?? JSON.stringify(msg), msg) }
  try { add(JSON.parse(content).messages ?? []) } catch {
    for (const line of content.split('\n')) {
      try { const e = JSON.parse(line); add(e.$set?.messages ?? e.messages ?? []) } catch { /* incomplete line */ }
    }
  }
  return [...messages.values()].flatMap(msg => {
    if (!msg.tokens || !['gemini', 'model'].includes(msg.type)) return []
    const parsed = parseGeminiChat(JSON.stringify({ sessionId: conversationId, messages: [msg] }), conversationId, '')
    return parsed ? [{ harness: 'gemini' as const, conversationId, at: Date.parse(msg.timestamp),
      model: parsed.model, costUSD: sessionCostUSD(parsed) }] : []
  })
}

/** Each registered root is walked, so a second login does not depend on default-root replay. */
export async function nativeQuotaSources(accounts: AccountsFile, limits: readonly PlanLimits[], roots: NativeQuotaRoots = defaultRoots) {
  const seen = new Set<string>()
  const sources: { harness: HarnessId; conversationId: string; path: string; paths: string[]; stamp: string }[] = []
  for (const harness of nativeQuotaHarnesses) {
    const meters = limits.filter(l => l.harness === harness)
    if (!meters.length) continue
    const since = Math.min(...meters.flatMap(l => l.windows.map(w => w.resetsAt - (w.kind === '5h' ? 5 * 3600_000 : 7 * 24 * 3600_000))))
    const prefix = `${harness}:`
    const homes = new Set([...(roots[harness] ? [roots[harness]!] : []),
      ...Object.keys(accounts.bindings).filter(k => k.startsWith(prefix) && k.length > prefix.length).map(k => k.slice(prefix.length))])
    for (const root of homes) {
      try {
        if (harness === 'gemini') {
          for await (const relative of new Bun.Glob('tmp/*/chats').scan({ cwd: root, onlyFiles: false })) {
            const dir = join(root, relative)
            for (const family of await listGeminiFamilies(dir)) {
              const paths = family.members.map(name => join(dir, name))
              const infos = await Promise.all(paths.map(path => stat(path).catch(() => null)))
              if (!infos.some(info => info && info.mtimeMs >= since) || paths.some(path => seen.has(path))) continue
              for (const path of paths) seen.add(path)
              sources.push({ harness, conversationId: family.id ?? basename(paths[0]!), path: paths[0]!, paths,
                stamp: infos.map((info, i) => `${paths[i]}:${info?.size}:${info?.mtimeMs}`).join('|') })
            }
          }
          continue
        }
        for await (const relative of new Bun.Glob(patterns[harness]).scan(root)) {
          const path = join(root, relative)
          if (seen.has(path)) continue
          seen.add(path)
          const info = await stat(path).catch(() => null)
          if (!info?.isFile() || info.mtimeMs < since) continue
          const name = basename(path, '.jsonl')
          const conversationId = harness === 'codex' ? name.match(/([\da-f]{8}-[\da-f-]{27})$/i)?.[1] ?? name : name
          sources.push({ harness, conversationId, path, paths: [path], stamp: `${info.size}:${info.mtimeMs}` })
        }
      } catch { /* missing/unreadable root */ }
    }
  }
  return sources
}
