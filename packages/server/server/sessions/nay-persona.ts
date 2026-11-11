import { stat } from 'node:fs/promises'

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

export async function validateNayWorkingDir(value: unknown): Promise<string | null> {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) return null
  const cwd = value.trim()
  if (!cwd) return null
  try {
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
  if (!cwd) throw new Error('chatWorkingDir must be an existing absolute directory')
  const label = typeof prefs.chatLabel === 'string' && prefs.chatLabel.trim() ? prefs.chatLabel.trim() : DEFAULT_NAY_LABEL
  return { responder: 'own-agent', cwd, label, mcpEnabled: prefs.chatMcpEnabled === true }
}
