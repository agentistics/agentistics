/**
 * browser-bin.ts — which browser executable agentistics can use, and, when there is none, WHY.
 *
 * Order (spec §1.2): `AGENTISTICS_BROWSER_BIN` → the Playwright cache's headless shell (newest build
 * number wins) → `chromium` / `chromium-browser` on PATH → `google-chrome` / `chrome` on PATH and the
 * platform's standard install paths. Using the Chrome BINARY with our own `--user-data-dir` is safe;
 * what is never touched is the person's PROFILE.
 *
 * `resolveBrowserBin` is PURE over injected lookups (tested); `findBrowserBin` wires the real file
 * system and memoizes the answer for the life of the process (a re-check is one `refresh: true`).
 */

import { accessSync, constants, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { BrowserKind } from './browser-spec'

export type BrowserBinSource = 'env' | 'playwright' | 'path' | 'system'

export type BrowserBin =
  | { found: true; path: string; kind: BrowserKind; source: BrowserBinSource }
  | { found: false; reason: 'env-not-executable' | 'none'; tried: string[] }

export interface BinLookup {
  env: Record<string, string | undefined>
  home: string
  platform: NodeJS.Platform
  /** Is this path an executable file? */
  executable: (path: string) => boolean
  /** Entry names of a directory, or [] when it cannot be read. */
  list: (dir: string) => string[]
}

/** Inside one `chromium_headless_shell-<n>` folder, the layouts Playwright has shipped. */
const SHELL_LAYOUTS = [
  'chrome-headless-shell-linux64/chrome-headless-shell',
  'chrome-linux/headless_shell',
  'chrome-headless-shell-mac-arm64/chrome-headless-shell',
  'chrome-headless-shell-mac-x64/chrome-headless-shell',
  'chrome-headless-shell-win64/chrome-headless-shell.exe',
]

const PATH_NAMES: ReadonlyArray<readonly [string, BrowserKind]> = [
  ['chromium', 'chromium'],
  ['chromium-browser', 'chromium'],
  ['google-chrome', 'chrome'],
  ['google-chrome-stable', 'chrome'],
  ['chrome', 'chrome'],
]

function systemPaths(platform: NodeJS.Platform, env: Record<string, string | undefined>): Array<readonly [string, BrowserKind]> {
  if (platform === 'darwin') {
    return [
      ['/Applications/Chromium.app/Contents/MacOS/Chromium', 'chromium'],
      ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'chrome'],
    ]
  }
  if (platform === 'win32') {
    const pf = env.ProgramFiles ?? 'C:\\Program Files'
    const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    return [
      [`${pf}\\Google\\Chrome\\Application\\chrome.exe`, 'chrome'],
      [`${pf86}\\Google\\Chrome\\Application\\chrome.exe`, 'chrome'],
      [`${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`, 'chrome'],
    ]
  }
  return []
}

/** The kind of an explicitly named binary, judged by its file name. */
export function kindOfPath(path: string): BrowserKind {
  const base = path.split(/[\\/]/).pop()!.toLowerCase()
  if (base.includes('headless')) return 'headless-shell'
  if (base.includes('chromium')) return 'chromium'
  return 'chrome'
}

export function resolveBrowserBin(l: BinLookup): BrowserBin {
  const tried: string[] = []
  const explicit = l.env.AGENTISTICS_BROWSER_BIN?.trim()
  if (explicit) {
    if (l.executable(explicit)) return { found: true, path: explicit, kind: kindOfPath(explicit), source: 'env' }
    // A path the person NAMED that does not work is said as such — falling through to another browser
    // would run something they did not choose.
    return { found: false, reason: 'env-not-executable', tried: [explicit] }
  }

  const cache = l.env.PLAYWRIGHT_BROWSERS_PATH?.trim() || join(l.home, '.cache', 'ms-playwright')
  const builds = l.list(cache)
    .map(name => /^chromium_headless_shell-(\d+)$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
  for (const m of builds) {
    for (const layout of SHELL_LAYOUTS) {
      const p = join(cache, m[0], layout)
      tried.push(p)
      if (l.executable(p)) return { found: true, path: p, kind: 'headless-shell', source: 'playwright' }
    }
  }

  const dirs = (l.env.PATH ?? '').split(l.platform === 'win32' ? ';' : delimiter).filter(Boolean)
  for (const [name, kind] of PATH_NAMES) {
    for (const d of dirs) {
      const p = join(d, l.platform === 'win32' ? `${name}.exe` : name)
      tried.push(p)
      if (l.executable(p)) return { found: true, path: p, kind, source: 'path' }
    }
  }

  for (const [p, kind] of systemPaths(l.platform, l.env)) {
    tried.push(p)
    if (l.executable(p)) return { found: true, path: p, kind, source: 'system' }
  }
  return { found: false, reason: 'none', tried }
}

let memo: BrowserBin | null = null

/** The real lookup, memoized. */
export function findBrowserBin(opts: { refresh?: boolean } = {}): BrowserBin {
  if (memo && !opts.refresh) return memo
  memo = resolveBrowserBin({
    env: process.env,
    home: homedir(),
    platform: process.platform,
    executable: (p) => {
      try {
        if (!statSync(p).isFile()) return false
        accessSync(p, constants.X_OK)
        return true
      } catch { return false }
    },
    list: (d) => { try { return readdirSync(d) } catch { return [] } },
  })
  return memo
}

/** The sentence `status` says when nothing was found. */
export function browserBinSentence(b: BrowserBin, lang: 'en' | 'pt' = 'en'): string {
  if (b.found) {
    return lang === 'pt' ? `Usando ${b.path} (${b.kind}, via ${b.source}).` : `Using ${b.path} (${b.kind}, via ${b.source}).`
  }
  if (b.reason === 'env-not-executable') {
    return lang === 'pt'
      ? `AGENTISTICS_BROWSER_BIN aponta para ${b.tried[0]}, que não é um executável.`
      : `AGENTISTICS_BROWSER_BIN points at ${b.tried[0]}, which is not an executable.`
  }
  return lang === 'pt'
    ? 'Este computador não tem um navegador que o agentistics possa usar.'
    : 'This computer has no browser agentistics can use.'
}
