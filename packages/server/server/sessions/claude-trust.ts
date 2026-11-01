import { chmod, mkdir, open, readFile, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Claude stores folder trust beside the account's config directory. Managed account roots do not
 * share the default `~/.claude.json`, so seed the same per-project flag before starting the child.
 */
export async function ensureClaudeProjectTrusted(configRoot: string, cwd: string): Promise<void> {
  try {
    const file = join(configRoot, '.claude.json')
    await mkdir(configRoot, { recursive: true, mode: 0o700 })

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

    let config = await readConfig()
    const projects = config.projects
    if (projects !== undefined && !isObject(projects)) throw new Error('Claude config projects must contain a JSON object')
    const projectMap = isObject(projects) ? projects : {}
    const project = projectMap[cwd]
    if (isObject(project) && project.hasTrustDialogAccepted === true) return

    // Claude rewrites this file while running. Re-read immediately before constructing the write
    // so account credentials and usage counters from a concurrent rewrite are retained.
    config = await readConfig()
    const currentProjects = config.projects
    if (currentProjects !== undefined && !isObject(currentProjects)) throw new Error('Claude config projects must contain a JSON object')
    const currentProjectMap = isObject(currentProjects) ? currentProjects : {}
    const currentProject = currentProjectMap[cwd]
    if (isObject(currentProject) && currentProject.hasTrustDialogAccepted === true) return
    currentProjectMap[cwd] = { ...(isObject(currentProject) ? currentProject : {}), hasTrustDialogAccepted: true }
    config.projects = currentProjectMap

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
  } catch (error) {
    console.warn(`[sessions] could not pre-trust Claude folder ${cwd}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
