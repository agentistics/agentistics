import { readFile, mkdir, writeFile } from 'node:fs/promises'
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
  const file = join(configRoot, '.claude.json')
  await mkdir(configRoot, { recursive: true, mode: 0o700 })

  let config: JsonObject = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (!isObject(parsed)) throw new Error('Claude config must contain a JSON object')
    config = parsed
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
  }

  const projects = config.projects
  if (projects !== undefined && !isObject(projects)) throw new Error('Claude config projects must contain a JSON object')
  const projectMap = isObject(projects) ? projects : {}
  const project = projectMap[cwd]
  if (isObject(project) && project.hasTrustDialogAccepted === true) return

  projectMap[cwd] = { ...(isObject(project) ? project : {}), hasTrustDialogAccepted: true }
  config.projects = projectMap
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}
