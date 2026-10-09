import { parseHarnessVersion } from './harness-install-plan'
import { userSearchPath } from './user-path'

const TTL_MS = 30_000
const cache = new Map<string, { at: number; version: string | undefined }>()

/**
 * `<bin> --version`, parsed. Total: a binary that is missing from PATH, hangs or prints junk yields
 * `undefined` — never a throw, because this runs inside `/api/chat-harnesses`, which must still
 * answer. `~/.local/bin` is searched first (where the official installers put things) even when
 * the server was started with a PATH that lacks it. Cached briefly: the Settings page re-polls
 * every few seconds while something is not ready.
 */
export async function readHarnessVersion(bin: string, now = Date.now()): Promise<string | undefined> {
  const hit = cache.get(bin)
  if (hit && now - hit.at < TTL_MS) return hit.version
  let version: string | undefined
  try {
    const env = { ...process.env, PATH: userSearchPath() }
    const proc = Bun.spawn([bin, '--version'], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', env })
    const timer = setTimeout(() => proc.kill(), 5_000)
    const output = await new Response(proc.stdout).text().catch(() => '')
    await proc.exited.catch(() => 1)
    clearTimeout(timer)
    version = parseHarnessVersion(output) ?? undefined
  } catch { version = undefined }
  cache.set(bin, { at: now, version })
  return version
}

/** Forget a cached answer — called after an install/update so the badge reads the new version. */
export function forgetHarnessVersion(bin?: string): void {
  if (bin) cache.delete(bin); else cache.clear()
}
