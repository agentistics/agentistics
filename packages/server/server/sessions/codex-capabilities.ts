import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { HarnessId } from '@agentistics/core'
import { adoptUserBinOnPath, userSearchPath } from './user-path'

export const CODEX_HELP_TIMEOUT_MS = 1_500
const execFileAsync = promisify(execFile)

export interface CodexProbeDeps {
  binary: () => string | null
  mtime: (path: string) => Promise<number>
  help: (path: string) => Promise<string>
}

/** One help probe per binary path + mtime, including failures and concurrent callers. */
export function createCodexCapabilityProbe(deps: CodexProbeDeps): () => Promise<boolean> {
  const cache = new Map<string, { mtime: number; supported: Promise<boolean> }>()
  return async () => {
    try {
      const path = deps.binary()
      if (!path) return false
      const mtime = await deps.mtime(path)
      const hit = cache.get(path)
      if (hit?.mtime === mtime) return await hit.supported
      const supported = Promise.resolve().then(() => deps.help(path))
        .then(help => /(?:^|\s)--no-daemon(?=\s|$)/m.test(help), () => false)
      cache.set(path, { mtime, supported })
      return await supported
    } catch { return false }
  }
}

const supportsNoDaemon = createCodexCapabilityProbe({
  binary: () => {
    adoptUserBinOnPath()
    return Bun.which('codex', { PATH: userSearchPath() })
  },
  mtime: async path => (await stat(path)).mtimeMs,
  help: async path => {
    // codex-cli 0.161.0 advertises --no-daemon; 0.155.1 does not. Never infer support from version.
    const { stdout } = await execFileAsync(path, ['--help'], {
      timeout: CODEX_HELP_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 256 * 1024,
      env: { ...process.env, PATH: userSearchPath() },
    })
    return stdout
  },
})

/** I/O belongs at the launch boundary; planSpawn receives only the measured capability. */
export async function spawnCapabilities(harness: HarnessId): Promise<{ codexNoDaemon?: boolean }> {
  return harness === 'codex' ? { codexNoDaemon: await supportsNoDaemon() } : {}
}
