/**
 * integrations/gemini/index.ts — the IO half of the Gemini replay: which chat files exist, and
 * reading one whole (see `replay.ts`'s header for why there is no incremental cursor in v1).
 *
 * Discovery mirrors `adapters/gemini.ts` exactly (the `bin` directory is skipped, `.jsonl`/`.json`
 * both count, and the project map comes from `projects.json`) — a second, drifting copy of that
 * walk is exactly what this repo's harness-contract checklist warns against, so any change to how
 * gemini chat files are found belongs in both places or in neither.
 */
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { AgentisticsEvent } from '@agentistics/core'
import { GEMINI_DIR } from '../../config'
import { safeReadDir, safeReadJson } from '../../utils'
import type { HarnessReplay, ReplayBatch, ReplayCursor, ReplaySource } from '../types'
import { foldGeminiChat } from './replay'
import { geminiContext } from './replay-core'

const GEMINI_TMP_DIR = join(GEMINI_DIR, 'tmp')
const GEMINI_PROJECTS_FILE = join(GEMINI_DIR, 'projects.json')

export interface GeminiReplayOptions {
  /** Default: `GEMINI_DIR` (`~/.gemini`, or `GEMINI_DIR`'s own env override — see `config.ts`). */
  geminiDir?: string
  /** Default: `Date.now`. Overridable so a test can drive `recordedAt` deterministically. */
  now?: () => number
}

/** The synthetic id `adapters/gemini.ts` derives for a chat file — `session_id` on the legacy
 *  `SessionMeta`, and `Run.conversationId` here (see `replay-core.ts`'s header on why it is never
 *  a UUID). */
function fallbackIdOf(file: string): string {
  const dirName = basename(file.replace(/\/chats\/[^/]+$/, ''))
  const fileBase = basename(file).replace(/\.(jsonl|json)$/, '')
  return `${dirName}/${fileBase}`
}

async function buildProjectMap(geminiDir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const data = await safeReadJson<{ projects?: Record<string, string> }>(join(geminiDir, 'projects.json'))
  if (data?.projects) {
    for (const [absPath, shortName] of Object.entries(data.projects)) map.set(shortName, absPath)
  }
  return map
}

async function collectChatFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const chatsDir = join(dir, 'chats')
  const entries = await safeReadDir(chatsDir)
  for (const name of entries) {
    if (name.endsWith('.jsonl') || name.endsWith('.json')) out.push(join(chatsDir, name))
  }
  return out
}

interface DiscoveredFile { file: string; conversationId: string; projectPath: string }

async function discoverFiles(geminiDir: string): Promise<DiscoveredFile[]> {
  const tmpDir = join(geminiDir, 'tmp')
  const projectMap = await buildProjectMap(geminiDir)
  const topDirs = await safeReadDir(tmpDir)
  const out: DiscoveredFile[] = []
  await Promise.all(topDirs.map(async dirName => {
    if (dirName === 'bin') return
    const dirPath = join(tmpDir, dirName)
    const projectPath = projectMap.get(dirName) ?? ''
    const files = await collectChatFiles(dirPath)
    for (const file of files) out.push({ file, conversationId: fallbackIdOf(file), projectPath })
  }))
  return out
}

export function createGeminiReplay(opts: GeminiReplayOptions = {}): HarnessReplay {
  const geminiDir = opts.geminiDir ?? GEMINI_DIR
  const now = opts.now ?? Date.now

  // conversationId -> the file it was found at, and the project path beside it. Kept between
  // `discover()` and `replay()` calls in the same process, the same shape
  // `transcript-path-memo.ts` documents for Claude: a resume that cannot trust its own memory
  // re-scans rather than guessing, and `discover()` is what fills it in the first place.
  const found = new Map<string, { file: string; projectPath: string }>()

  async function discover(): Promise<ReplaySource[]> {
    const files = await discoverFiles(geminiDir)
    const sources: ReplaySource[] = []
    for (const f of files) {
      found.set(f.conversationId, { file: f.file, projectPath: f.projectPath })
      sources.push({ sessionId: f.conversationId, sourceRef: `gemini:${f.conversationId}` })
    }
    return sources
  }

  async function locate(conversationId: string): Promise<{ file: string; projectPath: string } | null> {
    const cached = found.get(conversationId)
    if (cached) return cached
    // A `replay()` call that never went through `discover()` first (a test, or a caller that
    // already knows the id) re-derives the file from the id's own two segments rather than
    // failing — the id IS the relative path, so this is a lookup, never a guess.
    const slash = conversationId.indexOf('/')
    if (slash <= 0) return null
    const dirName = conversationId.slice(0, slash)
    const fileBase = conversationId.slice(slash + 1)
    const projectMap = await buildProjectMap(geminiDir)
    const projectPath = projectMap.get(dirName) ?? ''
    for (const ext of ['.jsonl', '.json']) {
      const candidate = join(geminiDir, 'tmp', dirName, 'chats', `${fileBase}${ext}`)
      const content = await readFile(candidate, 'utf-8').catch(() => null)
      if (content !== null) {
        found.set(conversationId, { file: candidate, projectPath })
        return { file: candidate, projectPath }
      }
    }
    return null
  }

  async function replay(source: ReplaySource, cursor: ReplayCursor): Promise<ReplayBatch> {
    void cursor // no incremental replay in v1 — see replay.ts's header
    const located = await locate(source.sessionId)
    if (!located) return { events: [], cursor: null }

    const content = await readFile(located.file, 'utf-8').catch(() => null)
    if (content === null) return { events: [], cursor: null }

    const recordedAt = new Date(now()).toISOString()
    const ctx = geminiContext(source.sessionId, located.projectPath || undefined, recordedAt)
    const events: AgentisticsEvent[] = []
    foldGeminiChat(ctx, content, e => events.push(e))
    return { events, cursor: null }
  }

  return { discover, replay }
}

/** The default instance, reading `GEMINI_DIR` on the real clock — what `INTEGRATIONS.gemini` would
 *  fill (the registry entry itself is a shared file — see this subagent's handback, "SHARED
 *  CHANGES REQUESTED"). */
export const geminiReplay = createGeminiReplay()
