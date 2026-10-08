// packages/server/server/adapters/gemini.ts
import { join, basename } from 'path'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import type { SessionMeta } from '@agentistics/core'
import type { HarnessAdapter } from './types'
import { harnessEnabled } from './types'
import { GEMINI_DIR } from '../config'
import { createLimiter, safeReadDir, safeReadJson } from '../utils'
import { createFileMemo, registerMemo, versionOf } from './file-memo'

/** One parsed chat per (file version, project path) — see file-memo.ts. */
const memo = registerMemo(createFileMemo<SessionMeta | null>())

const GEMINI_TMP_DIR = join(GEMINI_DIR, 'tmp')
const GEMINI_PROJECTS_FILE = join(GEMINI_DIR, 'projects.json')

/** Build a map from Gemini short name → absolute project path by reading projects.json.
 *  projects.json structure: { "projects": { "/abs/path": "shortname", ... } } */
async function buildProjectMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const data = await safeReadJson<{ projects?: Record<string, string> }>(GEMINI_PROJECTS_FILE)
  if (data?.projects) {
    for (const [absPath, shortName] of Object.entries(data.projects)) {
      map.set(shortName, absPath)
    }
  }
  return map
}

/** Recursively collect *.jsonl and *.json chat files under <dir>/chats/. */
async function collectChatFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const chatsDir = join(dir, 'chats')
  const entries = await safeReadDir(chatsDir)
  for (const name of entries) {
    if (name.endsWith('.jsonl') || name.endsWith('.json')) {
      out.push(join(chatsDir, name))
    }
  }
  return out
}

export const geminiAdapter: HarnessAdapter = {
  id: 'gemini',
  dataRoot: GEMINI_DIR,
  isAvailable() {
    return harnessEnabled('gemini') && existsSync(GEMINI_TMP_DIR)
  },
  async loadSessions(): Promise<SessionMeta[]> {
    const { parseGeminiChat } = await import('./gemini-parse')

    // Build short-name → absolute-path map from projects.json
    const projectMap = await buildProjectMap()

    // Walk ~/.gemini/tmp/<projectDirName>/ entries
    const topDirs = await safeReadDir(GEMINI_TMP_DIR)
    const allFiles: Array<{ file: string; projectPath: string }> = []

    await Promise.all(topDirs.map(async dirName => {
      const dirPath = join(GEMINI_TMP_DIR, dirName)
      // Skip the bin helper directory
      if (dirName === 'bin') return

      const projectPath = projectMap.get(dirName) ?? ''
      const files = await collectChatFiles(dirPath)
      for (const file of files) {
        allFiles.push({ file, projectPath })
      }
    }))

    // Sorted: the walk pushes in completion order, and the build's output order follows this list.
    allFiles.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    const limit = createLimiter(20)
    const sessions = await Promise.all(allFiles.map(({ file, projectPath }) =>
      limit(async () => memo.get(file, `${await versionOf([file])}|${projectPath}`, async () => {
        const content = await readFile(file, 'utf-8').catch(() => '')
        // Derive a stable fallback ID from the file path: <dirName>/<filename-no-ext>
        const dirName = basename(file.replace(/\/chats\/[^/]+$/, ''))
        const fileBase = basename(file).replace(/\.(jsonl|json)$/, '')
        const fallbackId = `${dirName}/${fileBase}`
        return parseGeminiChat(content, fallbackId, projectPath)
      }))
    ))

    return sessions.filter((s): s is SessionMeta => s !== null && !!s.start_time)
  },
}
