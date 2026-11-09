import { HARNESS_LABELS, HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import type { ChatDriver, HarnessChatStatus } from './types'
import { claudeDriver } from './claude'
import { codexDriver } from './codex'
import { geminiDriver } from './gemini'
import { copilotDriver } from './copilot'
import { modelCatalog } from '../model-catalog'
import { readHarnessDefaults } from '../sessions/harness-defaults'
import { readHarnessVersion } from '../sessions/harness-version'
import { availableHarnesses } from '../sessions/harness-available'
import { HARNESS_INSTALLERS } from '../sessions/harness-install-plan'

/** Backends that can actually serve Nay chat. */
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
export async function chatHarnessStatus(all = false): Promise<HarnessChatStatus[]> {
  const byId = new Map(ALL_DRIVERS.map(d => [d.id, d]))
  const detected = all ? availableHarnesses() : null
  const installedIds = new Set(detected && !detected.blind ? detected.ids : [])
  const ids = all ? HARNESS_ORDER : ALL_DRIVERS.map(d => d.id)
  return Promise.all(ids.map(async id => {
    const driver = byId.get(id)
    const catalog = await modelCatalog(id)
    if (!driver) {
      return {
        id,
        label: HARNESS_LABELS[id],
        installed: installedIds.has(id),
        canInstall: Object.hasOwn(HARNESS_INSTALLERS, id),
        authReady: false,
        ready: false,
        updateAvailable: false,
        models: catalog.models.map(m => ({ id: m.id, label: m.label })),
        modelsSource: catalog.source,
        modelFreeText: catalog.freeText,
        defaultModel: '',
        setup: { docUrl: CATALOG_DOCS[id], note: 'This harness has no Nay chat driver.' },
      }
    }
    const installed = all ? installedIds.has(id) : driver.isAvailable()
    const authReady = driver.authReady()
    const version = installed ? await readHarnessVersion(driver.id) : undefined
    return {
      id,
      label: driver.label,
      installed,
      canInstall: Object.hasOwn(HARNESS_INSTALLERS, id),
      authReady,
      ready: installed && authReady,
      ...(version ? { version } : {}),
      updateAvailable: false,
      models: catalog.models.map(m => ({ id: m.id, label: m.label })),
      modelsSource: catalog.source,
      modelFreeText: catalog.freeText,
      defaultModel: await chatDefaultModel(driver.id),
      setup: driver.setup,
    }
  }))
}

/** Official guidance for catalog entries without an integrated chat setup. */
const CATALOG_DOCS: Partial<Record<HarnessId, string>> = {
  antigravity: 'https://antigravity.google/download',
  kimi: 'https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html',
  opencode: 'https://opencode.ai/docs/',
  hermes: 'https://hermes-agent.nousresearch.com/docs/',
}
