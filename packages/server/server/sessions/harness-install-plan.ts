/** Pure installer table. It describes official commands; it never executes them. */
import { redactSecrets, type HarnessId } from '@agentistics/core'

export type HarnessInstallPlatform = 'linux' | 'darwin' | 'unsupported'
export type HarnessInstallReason = 'ok' | 'unsupported-platform' | 'node-required'

export interface HarnessInstallFacts {
  platform: string
  nodePresent: boolean
  /** @deprecated unused: npm installs always target `npmPrefix` (see npmCommand). */
  npmGlobalWritable?: boolean
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

/**
 * The shell every installer script runs under, by ABSOLUTE path. `Bun.spawn` resolves a bare `sh`
 * against the child's PATH and THROWS when it is not there ("Executable not found in $PATH") — a
 * server launched from a macOS GUI/launcher can carry a PATH with no `/bin` at all. `/bin/sh` exists
 * on every Linux and macOS.
 */
export const INSTALL_SHELL = '/bin/sh'

/**
 * System directories the installers' own tools live in (`curl`, `bash`, `tar`, `shasum`, `uname`).
 * APPENDED to the user's PATH when missing — the user's order still decides which binary wins.
 * `/opt/homebrew/bin` is macOS Homebrew's prefix (npm/node installed by brew live there).
 */
export const INSTALL_SYSTEM_DIRS = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']

/** The PATH an installer runs with: the given one, plus every system directory it lacks. */
export function installSearchPath(path: string | undefined): string {
  const have = (path ?? '').split(':').filter(Boolean)
  const missing = INSTALL_SYSTEM_DIRS.filter(d => !have.includes(d))
  return [...have, ...missing].join(':')
}

/** What went wrong, short and bounded, for the dialog and the log. Never empty. */
export function installFailureDetail(
  outcome: { code: number | null; spawnError?: string; stderrTail?: string[] }, lang: 'pt' | 'en',
): string {
  const pt = lang === 'pt'
  if (outcome.spawnError) {
    return redactSecrets(`${pt ? 'O instalador não iniciou' : 'The installer did not start'}: ${cleanInstallLine(outcome.spawnError)}`)
  }
  const code = outcome.code === null ? '?' : String(outcome.code)
  const head = pt ? `O instalador saiu com código ${code}` : `The installer exited with code ${code}`
  const tail = (outcome.stderrTail ?? []).map(cleanInstallLine).filter(Boolean).slice(-3).join(' · ')
  const body = tail || (pt ? 'sem nenhuma mensagem' : 'without any message')
  return redactSecrets(`${head} (${body.slice(0, 300)}).`)
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
  return { reason: 'ok', command: [INSTALL_SHELL, '-c', script] }
}

export interface HarnessInstallPlan {
  harness: Extract<HarnessId, 'claude' | 'codex' | 'gemini' | 'copilot' | 'opencode'>
  reason: HarnessInstallReason
  command?: string[]
  verify: string[]
  package?: string
}

type HarnessPlanEntry = {
  package?: string
  command: (facts: HarnessInstallFacts) => string[]
  /** The harness's OWN updater, when it has one (it knows how it was installed: curl, npm, brew …). Absent = re-run `command`. */
  update?: () => string[]
  /** A standalone binary needs no Node.js (absent = the npm installers, which do). */
  noNode?: true
}

/** One source of truth for the official installers used by the UI and the server. */
export const HARNESS_INSTALLERS: Record<HarnessInstallPlan['harness'], HarnessPlanEntry> = {
  claude: { command: () => [INSTALL_SHELL, '-c', 'curl -fsSL https://claude.ai/install.sh | bash'] },
  codex: { package: '@openai/codex', command: f => npmCommand('@openai/codex', f) },
  gemini: { package: '@google/gemini-cli', command: f => npmCommand('@google/gemini-cli', f) },
  copilot: { package: '@github/copilot', command: f => npmCommand('@github/copilot', f) },
  // opencode's official installer (opencode.ai/docs) puts a standalone binary in ~/.opencode/bin; `opencode upgrade`
  // (1.17.9 --help) updates it by whatever method installed it — the one-click answer to "needs 1.18.0" (OPENCODE.CORREÇÕES).
  opencode: { command: () => [INSTALL_SHELL, '-c', 'curl -fsSL https://opencode.ai/install | bash'], update: () => ['opencode', 'upgrade'], noNode: true },
}

/**
 * ALWAYS the user prefix: with the app's private Node on PATH, `npm i -g` is "writable" yet lands
 * the binary in node-vX/bin, outside the PATH the app and the user's shell use (~/.local/bin).
 */
function npmCommand(pkg: string, facts: HarnessInstallFacts): string[] {
  return ['npm', 'i', '-g', '--prefix', facts.npmPrefix, pkg]
}

export function installPlatform(platform: string): HarnessInstallPlatform {
  return platform === 'linux' || platform === 'darwin' ? platform : 'unsupported'
}

export function planHarnessInstall(
  harness: HarnessInstallPlan['harness'], facts: HarnessInstallFacts, operation: 'install' | 'update' = 'install',
): HarnessInstallPlan {
  const entry = HARNESS_INSTALLERS[harness]
  const platform = installPlatform(facts.platform)
  const base = { harness, verify: [harness === 'claude' ? 'claude' : harness, '--version'] }
  if (platform === 'unsupported') return { ...base, reason: 'unsupported-platform' }
  if (harness !== 'claude' && !entry.noNode && !facts.nodePresent) return { ...base, reason: 'node-required' }
  const command = operation === 'update' && entry.update ? entry.update() : entry.command(facts)
  return { ...base, reason: 'ok', command, ...(entry.package ? { package: entry.package } : {}) }
}

export function parseHarnessVersion(output: string): string | null {
  const match = output.match(/\b(?:v)?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/)
  return match?.[1] ?? null
}
