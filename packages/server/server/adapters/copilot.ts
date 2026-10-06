// packages/server/server/adapters/copilot.ts
import { join } from 'path'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import type { SessionMeta } from '@agentistics/core'
import type { HarnessAdapter } from './types'
import { harnessEnabled } from './types'
import { COPILOT_DIR } from '../config'
import { safeReadDir } from '../utils'
import { createLimiter } from '../utils'

const COPILOT_SESSION_STATE_DIR = join(COPILOT_DIR, 'session-state')

export const copilotAdapter: HarnessAdapter = {
  id: 'copilot',
  dataRoot: COPILOT_DIR,
  isAvailable() {
    return harnessEnabled('copilot') && existsSync(COPILOT_SESSION_STATE_DIR)
  },
  async loadSessions(): Promise<SessionMeta[]> {
    const { parseCopilotEvents, parseCopilotWorkspace, copilotGitRemote } = await import('./copilot-parse')
    const sessionDirs = await safeReadDir(COPILOT_SESSION_STATE_DIR)
    const limit = createLimiter(20)
    const sessions = await Promise.all(sessionDirs.map(dirName => limit(async () => {
      const eventsFile = join(COPILOT_SESSION_STATE_DIR, dirName, 'events.jsonl')
      if (!existsSync(eventsFile)) return null
      const content = await readFile(eventsFile, 'utf-8').catch(() => '')
      const session = parseCopilotEvents(content, dirName)
      if (!session) return null

      // events.jsonl carries the conversation; workspace.yaml carries the identity of the workspace
      // it happened in. Without it a Copilot session has no repo — it never showed up under
      // Repositories — and falls back to its first prompt for a name.
      const wsText = await readFile(join(COPILOT_SESSION_STATE_DIR, dirName, 'workspace.yaml'), 'utf-8')
        .catch(() => '')
      if (wsText) {
        const ws = parseCopilotWorkspace(wsText)
        // Agentop may give Copilot a distinct managed conversation id. That id is what task
        // attachments and the fleet row carry; the Copilot UUID remains the directory name.
        if (ws.mcSessionId) session.session_id = ws.mcSessionId
        const remote = copilotGitRemote(ws)
        if (remote) session.git_remote = remote
        if (ws.name) session.title = ws.name
        if (!session.project_path && ws.cwd) session.project_path = ws.cwd
      }
      return session
    })))
    return sessions.filter((s): s is SessionMeta => s !== null && !!s.start_time)
  },
}
