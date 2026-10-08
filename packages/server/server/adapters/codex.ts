// packages/server/server/adapters/codex.ts
import { join } from 'path'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import type { SessionMeta } from '@agentistics/core'
import type { HarnessAdapter } from './types'
import { harnessEnabled } from './types'
import { CODEX_DIR, CODEX_SESSIONS_DIR } from '../config'
import { createLimiter, safeReadDir } from '../utils'
import { createFileMemo, registerMemo, versionOf } from './file-memo'

/** One parsed rollout per file version — see file-memo.ts. */
const memo = registerMemo(createFileMemo<SessionMeta | null>())

/** Recursively collect rollout-*.jsonl paths under ~/.codex/sessions/YYYY/MM/DD/. */
async function collectRolloutFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await safeReadDir(dir)
  await Promise.all(entries.map(async name => {
    const full = join(dir, name)
    if (name.endsWith('.jsonl') && name.startsWith('rollout-')) {
      out.push(full)
    } else if (!name.includes('.')) {
      // year/month/day directories have no extension
      out.push(...await collectRolloutFiles(full))
    }
  }))
  return out
}

export const codexAdapter: HarnessAdapter = {
  id: 'codex',
  dataRoot: CODEX_DIR,
  isAvailable() {
    return harnessEnabled('codex') && existsSync(CODEX_SESSIONS_DIR)
  },
  async loadSessions(): Promise<SessionMeta[]> {
    const { parseCodexRollout } = await import('./codex-parse')
    // Sorted: the walk pushes in completion order, and the build's output order follows this list.
    const files = (await collectRolloutFiles(CODEX_SESSIONS_DIR)).sort()
    const limit = createLimiter(20)
    const sessions = await Promise.all(files.map(f => limit(async () => memo.get(f, await versionOf([f]), async () => {
      const content = await readFile(f, 'utf-8').catch(() => '')
      const fallbackId = f.split('/').pop()?.replace(/\.jsonl$/, '') ?? f
      return parseCodexRollout(content, fallbackId)
    }))))
    return sessions.filter((s): s is SessionMeta => s !== null && !!s.start_time)
  },
}
