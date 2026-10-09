/** Pure installer table. It describes official commands; it never executes them. */
import type { HarnessId } from '@agentistics/core'

export type HarnessInstallPlatform = 'linux' | 'darwin' | 'unsupported'
export type HarnessInstallReason = 'ok' | 'unsupported-platform' | 'node-required'

export interface HarnessInstallFacts {
  platform: string
  nodePresent: boolean
  npmGlobalWritable: boolean
  npmPrefix: string
  /** `process.arch` — only the Node.js tarball name depends on it. */
  arch?: string
  /** The user's home; the Node.js tarball is unpacked under it, never system-wide. */
  home?: string
}

/** Official Node.js LTS the user-level fallback unpacks (nodejs.org/dist, checked 2026-10). */
export const NODE_LTS_VERSION = '22.11.0'

/** Directories (relative to home) put in front of PATH for every install step and version check. */
export const USER_BIN_DIRS = ['.local/bin']

export function withUserBin(path: string | undefined, home: string): string {
  const dirs = USER_BIN_DIRS.map(d => `${home}/${d}`)
  const rest = (path ?? '').split(':').filter(p => p && !dirs.includes(p))
  return [...dirs, ...rest].join(':')
}

/** Strips ANSI escapes and bounds a line so a noisy installer cannot flood the modal. */
export function cleanInstallLine(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '').trim().slice(0, 200)
}

/**
 * Node.js prerequisite for the npm-based harnesses, installed for the USER only (official tarball
 * from nodejs.org unpacked under ~/.local, symlinks in ~/.local/bin). No sudo, no package manager.
 */
export function planNodeInstall(facts: HarnessInstallFacts): { reason: HarnessInstallReason; command?: string[] } {
  const platform = installPlatform(facts.platform)
  if (platform === 'unsupported') return { reason: 'unsupported-platform' }
  const arch = facts.arch === 'arm64' ? 'arm64' : facts.arch === 'x64' ? 'x64' : null
  if (!arch || !facts.home) return { reason: 'unsupported-platform' }
  const name = `node-v${NODE_LTS_VERSION}-${platform}-${arch}`
  const dest = `${facts.home}/.local/share/agentistics`
  const script = [
    'set -e',
    `mkdir -p "${dest}" "${facts.home}/.local/bin"`,
    `curl -fsSL "https://nodejs.org/dist/v${NODE_LTS_VERSION}/${name}.tar.gz" | tar -xz -C "${dest}"`,
    `for b in node npm npx; do ln -sf "${dest}/${name}/bin/$b" "${facts.home}/.local/bin/$b"; done`,
  ].join(' && ')
  return { reason: 'ok', command: ['sh', '-c', script] }
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
