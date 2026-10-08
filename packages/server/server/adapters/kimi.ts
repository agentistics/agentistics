// packages/server/server/adapters/kimi.ts
import { join } from 'path'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import type { SessionMeta } from '@agentistics/core'
import type { HarnessAdapter } from './types'
import { harnessEnabled } from './types'
import { KIMI_DIR } from '../config'
import { createLimiter, safeReadDir } from '../utils'
import { createFileMemo, registerMemo, versionOf } from './file-memo'

/** One built session per version of its state.json + every agent wire + its index entry — see file-memo.ts. */
const memo = registerMemo(createFileMemo<SessionMeta | null>())

const KIMI_SESSIONS_DIR = join(KIMI_DIR, 'sessions')
const KIMI_INDEX_FILE = join(KIMI_DIR, 'session_index.jsonl')

/** sessionDir → workDir, from the global index. A session's own state.json normally carries the
 *  same value; the index is the fallback for one that was written without it. */
async function readWorkDirIndex(): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const text = await readFile(KIMI_INDEX_FILE, 'utf-8').catch(() => '')
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const d = JSON.parse(line) as { sessionDir?: string; workDir?: string }
      if (d.sessionDir && d.workDir) map.set(d.sessionDir, d.workDir)
    } catch { /* skip a malformed index line */ }
  }
  return map
}

export const kimiAdapter: HarnessAdapter = {
  id: 'kimi',
  dataRoot: KIMI_DIR,
  isAvailable() {
    return harnessEnabled('kimi') && existsSync(KIMI_SESSIONS_DIR)
  },
  async loadSessions(): Promise<SessionMeta[]> {
    const { parseKimiState, kimiAgentIds, accumulateKimiWire, buildKimiSession, emptyKimiTotals } =
      await import('./kimi-parse')

    const workDirs = await readWorkDirIndex()
    // sessions/<workspaceId>/session_<uuid>/
    const workspaces = await safeReadDir(KIMI_SESSIONS_DIR)
    const sessionDirs: string[] = []
    await Promise.all(workspaces.map(async ws => {
      const wsPath = join(KIMI_SESSIONS_DIR, ws)
      for (const name of await safeReadDir(wsPath)) {
        if (name.startsWith('session_')) sessionDirs.push(join(wsPath, name))
      }
    }))

    // Sorted: the walk pushes in completion order, and the build's output order follows this list.
    sessionDirs.sort()
    const limit = createLimiter(20)
    const sessions = await Promise.all(sessionDirs.map(dir => limit(async () => {
      // The wires a session is read from are named by its state.json, so the version covers every
      // wire present on disk: an agent added later changes the directory listing and the stamp.
      const agentsDir = join(dir, 'agents')
      const wires = (await safeReadDir(agentsDir)).sort().map(a => join(agentsDir, a, 'wire.jsonl'))
      const version = `${await versionOf([join(dir, 'state.json'), ...wires])}|${workDirs.get(dir) ?? ''}`
      return memo.get(dir, version, async () => {
        const state = parseKimiState(await readFile(join(dir, 'state.json'), 'utf-8').catch(() => ''))

        // Every agent under the session folds into it: a subagent's spend belongs to the session that
        // spawned it, and each agent keeps its own wire.jsonl, so reading only `main` would silently
        // drop that work.
        const totals = emptyKimiTotals()
        for (const agentId of kimiAgentIds(state)) {
          const wire = join(dir, 'agents', agentId, 'wire.jsonl')
          if (!existsSync(wire)) continue
          accumulateKimiWire(await readFile(wire, 'utf-8').catch(() => ''), totals, { main: agentId === 'main' })
        }

        // The directory is `session_<uuid>`; the uuid alone is the id the CLI resumes by.
        const dirName = dir.slice(dir.lastIndexOf('/') + 1)
        const sessionId = dirName.startsWith('session_') ? dirName.slice('session_'.length) : dirName
        return buildKimiSession(sessionId, state, totals, workDirs.get(dir) ?? '')
      })
    })))

    return sessions.filter((s): s is SessionMeta => s !== null && !!s.start_time)
  },
}
