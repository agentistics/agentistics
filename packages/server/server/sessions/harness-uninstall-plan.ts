/**
 * Pure uninstall table — the counterpart of `harness-install-plan.ts`. It describes how to remove a
 * harness CLI, never executes anything.
 *
 * Two rules:
 * - **Only what we recognise.** The method is read off WHERE the resolved binary lives (npm prefix,
 *   bun global, Volta, or the exact paths an official installer creates). Anything else — Homebrew,
 *   a system package, a hand-copied binary — yields a sentence for the person and NO argv.
 * - **Never user data.** No argv this module returns names a config, session or credential
 *   directory (`~/.claude`, `~/.codex`, `~/.gemini`, `~/.copilot`, `~/.config/opencode`,
 *   `~/.local/share/opencode`).
 */
import type { HarnessInstallPlan } from './harness-install-plan'

export type UninstallHarness = HarnessInstallPlan['harness']

export interface HarnessUninstallFacts {
  platform: string
  home: string
  /** The binary a lookup finds, or `null` when none does. */
  binPath: string | null
  /** `binPath` with every symlink followed. */
  realPath: string | null
  /** `home` with symlinks followed (macOS `/var` style); defaults to `home`. */
  realHome?: string
  /** `false` when the npm prefix that holds the package cannot be written without sudo. */
  prefixWritable?: boolean
  /** Windows only: the npm shim's own folder holds `node_modules/<package>`. */
  shimHasPackage?: boolean
}

export type UninstallMethod = 'npm' | 'bun' | 'volta' | 'native'

export interface HarnessUninstallPlan {
  harness: UninstallHarness
  reason: 'ok' | 'manual' | 'not-installed'
  method?: UninstallMethod
  command?: string[]
  /** The binary the plan was read from — what must be gone afterwards. */
  binPath?: string
  /** What disappears, for the confirmation dialog. */
  removes: string[]
  /** `reason: 'manual'` — what the person has to do themselves. */
  manual?: { pt: string; en: string }
}

/** The published npm package of each CLI (a person may have installed claude/opencode through npm too). */
export const UNINSTALL_PACKAGES: Record<UninstallHarness, string> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  gemini: '@google/gemini-cli',
  copilot: '@github/copilot',
  opencode: 'opencode-ai',
}

/** Where each harness keeps sessions, settings and sign-in. Shown as "kept"; never removed. */
export const HARNESS_KEPT_DATA: Record<UninstallHarness, string[]> = {
  claude: ['~/.claude'],
  codex: ['~/.codex'],
  gemini: ['~/.gemini'],
  copilot: ['~/.copilot'],
  opencode: ['~/.config/opencode', '~/.local/share/opencode'],
}

const slashes = (p: string) => p.replace(/\\/g, '/')

/** The npm prefix holding `pkg`, read off a resolved binary under `<prefix>/lib/node_modules/<pkg>/`. */
export function npmPrefixOf(realPath: string, pkg: string): string | null {
  const marker = `/lib/node_modules/${pkg}/`
  const at = slashes(realPath).lastIndexOf(marker)
  return at > 0 ? realPath.slice(0, at) : null
}

export function planHarnessUninstall(harness: UninstallHarness, facts: HarnessUninstallFacts): HarnessUninstallPlan {
  const { binPath, platform } = facts
  if (!binPath) return { harness, reason: 'not-installed', removes: [] }
  const pkg = UNINSTALL_PACKAGES[harness]
  const bin = slashes(binPath)
  const real = slashes(facts.realPath ?? binPath)
  const home = slashes(facts.realHome ?? facts.home)
  const ok = (method: UninstallMethod, command: string[], removes: string[]): HarnessUninstallPlan =>
    ({ harness, reason: 'ok', method, command, removes, binPath })

  const manual = (pt: string, en: string): HarnessUninstallPlan => ({ harness, reason: 'manual', removes: [], manual: { pt, en } })
  const unknown = () => manual(
    `Não reconheço como este programa foi instalado (${binPath}), então não vou apagar nada. Remova pelo mesmo caminho usado para instalar.`,
    `I do not recognise how this program was installed (${binPath}), so I will not delete anything. Remove it the same way it was installed.`,
  )

  if (platform === 'win32') {
    // Only npm's global shim is recognisable here; the native installers are not driven on Windows.
    if (facts.shimHasPackage && /\.(cmd|ps1)$/i.test(bin)) {
      const dir = binPath.slice(0, Math.max(binPath.lastIndexOf('\\'), binPath.lastIndexOf('/')))
      return ok('npm', ['npm.cmd', 'uninstall', '-g', '--prefix', dir, pkg], [`${dir}\\node_modules\\${pkg.replace('/', '\\')}`, binPath])
    }
    return unknown()
  }
  if (platform !== 'linux' && platform !== 'darwin') return unknown()

  // Homebrew first: a formula can carry a `lib/node_modules` of its own, which npm must not touch.
  if (/\/(Cellar|Caskroom)\//.test(real)) {
    return manual(
      `Este programa foi instalado pelo Homebrew (${binPath}). Remova com o próprio Homebrew (brew uninstall).`,
      `This program was installed with Homebrew (${binPath}). Remove it with Homebrew itself (brew uninstall).`,
    )
  }
  if (bin.includes('/.volta/') || real.endsWith('/volta-shim')) {
    return ok('volta', ['volta', 'uninstall', pkg], [pkg, binPath])
  }
  if (real.includes(`/.bun/install/global/node_modules/${pkg}/`)) {
    return ok('bun', ['bun', 'remove', '-g', pkg], [pkg, binPath])
  }
  const prefix = npmPrefixOf(facts.realPath ?? binPath, pkg)
  if (prefix) {
    if (facts.prefixWritable === false) {
      return manual(
        `Este programa está numa pasta do sistema (${prefix}) que só o administrador altera. Para remover: sudo npm uninstall -g --prefix ${prefix} ${pkg}`,
        `This program lives in a system folder (${prefix}) only an administrator can change. To remove it: sudo npm uninstall -g --prefix ${prefix} ${pkg}`,
      )
    }
    return ok('npm', ['npm', 'uninstall', '-g', '--prefix', prefix, pkg], [`${prefix}/lib/node_modules/${pkg}`, binPath])
  }
  // The official installers, matched by the EXACT paths they create.
  if (harness === 'claude' && binPath === `${facts.home}/.local/bin/claude` && real.startsWith(`${home}/.local/share/claude/versions/`)) {
    const versions = `${facts.home}/.local/share/claude/versions`
    return ok('native', ['/bin/rm', '-rf', '--', binPath, versions], [binPath, versions])
  }
  if (harness === 'opencode' && binPath === `${facts.home}/.opencode/bin/opencode` && real === `${home}/.opencode/bin/opencode`) {
    return ok('native', ['/bin/rm', '-f', '--', binPath], [binPath])
  }
  return unknown()
}
