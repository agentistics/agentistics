import { chmod, link, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const LOCK_STALE_MS = 30_000
const LOCK_RETRY_MS = 25
const inProcessLocks = new Map<string, Promise<void>>()
type LockFs = Pick<typeof import('node:fs/promises'), 'link' | 'open' | 'readFile' | 'stat' | 'rename' | 'unlink'>
let lockFs: LockFs = { link, open, readFile, stat, rename, unlink }

export function __setClaudeTrustFsForTest(overrides: Partial<LockFs> | null): void {
  lockFs = overrides ? { link, open, readFile, stat, rename, unlink, ...overrides } : { link, open, readFile, stat, rename, unlink }
}

async function realConfigFile(file: string): Promise<string> {
  try {
    return await realpath(file)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return file
    throw error
  }
}

async function withConfigLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const previous = inProcessLocks.get(file) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  const queued = previous.then(() => current)
  inProcessLocks.set(file, queued)
  await previous
  const lock = `${file}.lock`
  const ownerToken = `${process.pid}:${crypto.randomUUID()}`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let acquired = false
  try {
    for (;;) {
      try {
        handle = await lockFs.open(lock, 'wx', 0o600)
        await handle.write(ownerToken)
        await handle.sync()
        acquired = true
        break
      } catch (error) {
        await handle?.close().catch(() => {})
        handle = undefined
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error
        try {
          const observed = await lockFs.stat(lock)
          const observedToken = await lockFs.readFile(lock, 'utf8').catch(error => {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
            throw error
          })
          if (Date.now() - observed.mtimeMs > LOCK_STALE_MS) {
            const reclaimed = `${lock}.${process.pid}.${crypto.randomUUID()}.stale`
            try {
              await lockFs.rename(lock, reclaimed)
              let sameLock = false
              try {
                const [reclaimedStat, reclaimedToken] = await Promise.all([
                  lockFs.stat(reclaimed),
                  lockFs.readFile(reclaimed, 'utf8'),
                ])
                sameLock = reclaimedStat.mtimeMs === observed.mtimeMs && reclaimedToken === observedToken
              } catch (reclaimError) {
                if (!(reclaimError && typeof reclaimError === 'object' && 'code' in reclaimError && reclaimError.code === 'ENOENT')) throw reclaimError
              }
              if (sameLock) await lockFs.unlink(reclaimed).catch(() => {})
              else {
                try {
                  await lockFs.link(reclaimed, lock)
                  await lockFs.unlink(reclaimed).catch(() => {})
                } catch (restoreError) {
                  if (!(restoreError && typeof restoreError === 'object' && 'code' in restoreError && (restoreError.code === 'ENOENT' || restoreError.code === 'EEXIST'))) throw restoreError
                }
              }
            } catch (reclaimError) {
              if (!(reclaimError && typeof reclaimError === 'object' && 'code' in reclaimError && reclaimError.code === 'ENOENT')) throw reclaimError
            }
          }
        } catch (statError) {
          if (!(statError && typeof statError === 'object' && 'code' in statError && statError.code === 'ENOENT')) throw statError
        }
        await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS))
      }
    }
    return await operation()
  } finally {
    await handle?.close().catch(() => {})
    if (acquired) {
      try {
        if (await lockFs.readFile(lock, 'utf8') === ownerToken) await lockFs.unlink(lock)
      } catch {
        // The lock may have been reclaimed while the operation was running.
      }
    }
    release()
    if (inProcessLocks.get(file) === queued) inProcessLocks.delete(file)
  }
}

/**
 * Claude stores folder trust beside the account's config directory. Managed account roots do not
 * share the default `~/.claude.json`, so seed the same per-project flag before starting the child.
 */
export async function ensureClaudeProjectTrusted(configRoot: string, cwd: string): Promise<void> {
  try {
    const file = await realConfigFile(join(configRoot, '.claude.json'))
    await mkdir(configRoot, { recursive: true, mode: 0o700 })
    await withConfigLock(file, async () => {
      const readConfig = async (): Promise<JsonObject> => {
        try {
          const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
          if (!isObject(parsed)) throw new Error('Claude config must contain a JSON object')
          return parsed
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return {}
          throw error
        }
      }

      const config = await readConfig()
      const projects = config.projects
      if (projects !== undefined && !isObject(projects)) throw new Error('Claude config projects must contain a JSON object')
      const projectMap = isObject(projects) ? projects : {}
      const currentProject = projectMap[cwd]
      if (isObject(currentProject) && currentProject.hasTrustDialogAccepted === true) return
      projectMap[cwd] = { ...(isObject(currentProject) ? currentProject : {}), hasTrustDialogAccepted: true }
      config.projects = projectMap

      let mode = 0o600
      try { mode = (await stat(file)).mode & 0o777 } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
      }
      const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
      const handle = await open(temporary, 'w', mode)
      try {
        await handle.write(`${JSON.stringify(config, null, 2)}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await chmod(temporary, mode)
      await rename(temporary, file)
    })
  } catch (error) {
    console.warn(`[sessions] could not pre-trust Claude folder ${cwd}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
