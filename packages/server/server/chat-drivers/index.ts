import type { HarnessId } from '@agentistics/core'
import type { ChatDriver, HarnessChatStatus } from './types'
import { claudeDriver } from './claude'
import { codexDriver } from './codex'
import { geminiDriver } from './gemini'
import { copilotDriver } from './copilot'
import { modelCatalog } from '../model-catalog'
import { readHarnessDefaults } from '../sessions/harness-defaults'
import { readHarnessVersion } from '../sessions/harness-version'

/**
 * Registry of all chat drivers in display order: claude, codex, gemini, copilot.
 */
export const ALL_DRIVERS: ChatDriver[] = [claudeDriver, codexDriver, geminiDriver, copilotDriver]

export function getChatDriver(harness: HarnessId): ChatDriver | undefined {
  return ALL_DRIVERS.find(d => d.id === harness)
}

/**
 * The default model a chat with this harness runs when none is asked for: the one this machine's
 * CLI is configured with, or `''` (the CLI's own default — no `--model` flag at all). Never guessed.
 */
export async function chatDefaultModel(harness: HarnessId): Promise<string> {
  const configured = await readHarnessDefaults(harness).catch(() => ({} as { model?: string }))
  return configured.model ?? ''
}

/**
 * Returns status for ALL known drivers (installed or not), with per-field
 * install/auth/ready flags and setup guidance. Used by GET /api/chat-harnesses.
 * The models come from the ONE catalog every model picker reads (`model-catalog.ts`).
 */
export async function chatHarnessStatus(): Promise<HarnessChatStatus[]> {
  return Promise.all(ALL_DRIVERS.map(async d => {
    const installed = d.isAvailable()
    const authReady = d.authReady()
    const version = installed ? await readHarnessVersion(d.id) : undefined
    const catalog = await modelCatalog(d.id)
    return {
      id: d.id,
      label: d.label,
      installed,
      authReady,
      ready: installed && authReady,
      ...(version ? { version } : {}),
      updateAvailable: false,
      models: catalog.models.map(m => ({ id: m.id, label: m.label })),
      modelsSource: catalog.source,
      modelFreeText: catalog.freeText,
      defaultModel: await chatDefaultModel(d.id),
      setup: d.setup,
    }
  }))
}
