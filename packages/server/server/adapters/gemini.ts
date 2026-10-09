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
import { listGeminiFamilies } from '../sessions/gemini-family-io'

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

/**
 * The chat files of one project, GROUPED INTO CONVERSATIONS. A reopened gemini session continues in
 * a NEW headerless file (`gemini-family.ts`), so reading each file as a session dropped every turn
 * after a reopen and listed nothing for the continuation — a conversation is a family of files.
 * The first member keeps naming the session, so a conversation that was never reopened keeps the
 * exact id it always had.
 */
async function collectChatFamilies(dir: string): Promise<string[][]> {
  const chatsDir = join(dir, 'chats')
  return (await listGeminiFamilies(chatsDir)).map(f => f.members.map(name => join(chatsDir, name)))
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
    const allFiles: Array<{ files: string[]; projectPath: string }> = []

    await Promise.all(topDirs.map(async dirName => {
      const dirPath = join(GEMINI_TMP_DIR, dirName)
      // Skip the bin helper directory
      if (dirName === 'bin') return

      const projectPath = projectMap.get(dirName) ?? ''
      for (const files of await collectChatFamilies(dirPath)) {
        allFiles.push({ files, projectPath })
      }
    }))

    // Sorted: the walk pushes in completion order, and the build's output order follows this list.
    allFiles.sort((a, b) => (a.files[0]! < b.files[0]! ? -1 : a.files[0]! > b.files[0]! ? 1 : 0))
    const limit = createLimiter(20)
    const sessions = await Promise.all(allFiles.map(({ files, projectPath }) =>
      limit(async () => memo.get(files[0]!, `${await versionOf(files)}|${projectPath}`, async () => {
        const file = files[0]!
        const content = (await Promise.all(files.map(f => readFile(f, 'utf-8').catch(() => '')))).join('\n')
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
