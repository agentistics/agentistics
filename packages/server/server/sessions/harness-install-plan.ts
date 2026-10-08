/** Pure installer table. It describes official commands; it never executes them. */
import type { HarnessId } from '@agentistics/core'

export type HarnessInstallPlatform = 'linux' | 'darwin' | 'unsupported'
export type HarnessInstallReason = 'ok' | 'unsupported-platform' | 'node-required'

export interface HarnessInstallFacts {
  platform: string
  nodePresent: boolean
  npmGlobalWritable: boolean
  npmPrefix: string
}

export interface HarnessInstallPlan {
  harness: Extract<HarnessId, 'claude' | 'codex' | 'gemini' | 'copilot'>
  reason: HarnessInstallReason
  command?: string[]
  verify: string[]
  package?: string
}

type HarnessPlanEntry = { package?: string; command: (facts: HarnessInstallFacts) => string[] }

/** One source of truth for the official installers used by the UI and the server. */
export const HARNESS_INSTALLERS: Record<HarnessInstallPlan['harness'], HarnessPlanEntry> = {
  claude: { command: () => ['sh', '-c', 'curl -fsSL https://claude.ai/install.sh | bash'] },
  codex: { package: '@openai/codex', command: f => npmCommand('@openai/codex', f) },
  gemini: { package: '@google/gemini-cli', command: f => npmCommand('@google/gemini-cli', f) },
  copilot: { package: '@github/copilot', command: f => npmCommand('@github/copilot', f) },
}

function npmCommand(pkg: string, facts: HarnessInstallFacts): string[] {
  return facts.npmGlobalWritable
    ? ['npm', 'i', '-g', pkg]
    : ['npm', 'i', '-g', '--prefix', facts.npmPrefix, pkg]
}

export function installPlatform(platform: string): HarnessInstallPlatform {
  return platform === 'linux' || platform === 'darwin' ? platform : 'unsupported'
}

export function planHarnessInstall(
  harness: HarnessInstallPlan['harness'], facts: HarnessInstallFacts,
): HarnessInstallPlan {
  const entry = HARNESS_INSTALLERS[harness]
  const platform = installPlatform(facts.platform)
  const base = { harness, verify: [harness === 'claude' ? 'claude' : harness, '--version'] }
  if (platform === 'unsupported') return { ...base, reason: 'unsupported-platform' }
  if (harness !== 'claude' && !facts.nodePresent) return { ...base, reason: 'node-required' }
  return { ...base, reason: 'ok', command: entry.command(facts), ...(entry.package ? { package: entry.package } : {}) }
}

export function parseHarnessVersion(output: string): string | null {
  const match = output.match(/\b(?:v)?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/)
  return match?.[1] ?? null
}
