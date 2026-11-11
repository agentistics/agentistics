import { realpath, stat } from 'node:fs/promises'

export type NayResponder = 'analytics' | 'own-agent'

export interface NayPersonaPreferences {
  chatResponder?: NayResponder
  chatWorkingDir?: string
  chatLabel?: string
  chatMcpEnabled?: boolean
}

export interface NayPersona {
  responder: NayResponder
  cwd: string
  label: string
  mcpEnabled: boolean
}

export const DEFAULT_NAY_LABEL = 'Nay'

export const NAY_WORKING_DIR_ERROR = 'chatWorkingDir must be an existing absolute directory without leading or trailing whitespace'

/** Validate the Nay-specific preference keys at the boundary shared by HTTP and MCP writes. */
export async function validateNayPreferencePatch(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const next = { ...current, ...patch }
  if (next.chatResponder !== undefined && next.chatResponder !== 'analytics' && next.chatResponder !== 'own-agent') {
    throw new Error('chatResponder must be analytics or own-agent')
  }
  if (patch.chatWorkingDir !== undefined) {
    if (typeof patch.chatWorkingDir !== 'string' || patch.chatWorkingDir !== patch.chatWorkingDir.trim()) {
      throw new Error(NAY_WORKING_DIR_ERROR)
    }
    if (patch.chatWorkingDir.length > 0) {
      const canonical = await validateNayWorkingDir(patch.chatWorkingDir)
      if (!canonical) throw new Error(NAY_WORKING_DIR_ERROR)
      next.chatWorkingDir = canonical
    }
  }
  if (next.chatResponder === 'own-agent') {
    const canonical = await validateNayWorkingDir(next.chatWorkingDir)
    if (!canonical) throw new Error(NAY_WORKING_DIR_ERROR)
    next.chatWorkingDir = canonical
  }
  const normalized: Record<string, unknown> = { ...patch }
  if (next.chatResponder === 'own-agent' && next.chatWorkingDir !== undefined) normalized.chatWorkingDir = next.chatWorkingDir
  else if (patch.chatWorkingDir !== undefined && next.chatWorkingDir !== patch.chatWorkingDir) normalized.chatWorkingDir = next.chatWorkingDir
  return normalized
}

export async function validateNayWorkingDir(value: unknown): Promise<string | null> {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0') || value !== value.trim() || !value) return null
  try {
    const cwd = await realpath(value)
    return (await stat(cwd)).isDirectory() ? cwd : null
  } catch {
    return null
  }
}

export async function resolveNayPersona(prefs: NayPersonaPreferences, analyticsCwd: string): Promise<NayPersona> {
  if (prefs.chatResponder !== 'own-agent') {
    return { responder: 'analytics', cwd: analyticsCwd, label: DEFAULT_NAY_LABEL, mcpEnabled: true }
  }
  const cwd = await validateNayWorkingDir(prefs.chatWorkingDir)
  if (!cwd) throw new Error(NAY_WORKING_DIR_ERROR)
  const label = typeof prefs.chatLabel === 'string' && prefs.chatLabel.trim() ? prefs.chatLabel.trim() : DEFAULT_NAY_LABEL
  return { responder: 'own-agent', cwd, label, mcpEnabled: prefs.chatMcpEnabled === true }
}
