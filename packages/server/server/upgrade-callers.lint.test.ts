/**
 * upgrade-callers.lint.test.ts — UPD.NOTIFY: an update installs ONLY when the person asks: the popup's
 * "Instalar agora" (POST /api/upgrade), `agentop upgrade`, or the TUI's explicit Services action. The one
 * unattended path that exists is `check-update` + `AGENTISTICS_AUTO_UPGRADE=1`, opt-in and for a CRITICAL
 * release only. This pins the exact set of call sites, so a new place that installs by itself fails the build.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const PACKAGES = join(import.meta.dir, '..', '..')

function* sources(dir: string): Generator<string> {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n.startsWith('.')) continue
    const p = join(dir, n)
    if (statSync(p).isDirectory()) yield* sources(p)
    else if (/\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n)) yield p
  }
}

/** Code only: comment lines (`//`, `*`, `/*`) are prose about the call, not a call. */
const code = (f: string): string => readFileSync(f, 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
const callers = (re: RegExp): string[] =>
  [...sources(PACKAGES)].filter(f => re.test(code(f))).map(f => relative(PACKAGES, f)).sort()

describe('who can install an update', () => {
  test('runUpgrade() is called only by `agentop upgrade`', () => {
    expect(callers(/\brunUpgrade\(/)).toEqual(['server/bin/cli.ts', 'server/server/upgrade.ts'])
  })

  test('the detached background install is started only by check-update, behind the opt-in AND a critical release', () => {
    expect(callers(/\bstartBackgroundUpgrade\(/)).toEqual(['server/bin/cli.ts', 'server/server/upgrade.ts'])
    const cli = readFileSync(join(PACKAGES, 'server/bin/cli.ts'), 'utf8')
    expect(cli).toContain('if (info.critical && autoAllowed)')
    expect(cli).toContain('autoInstallAllowed()')
  })

  test('the opt-in is the explicit environment variable and nothing else (no preference, no default)', () => {
    const v = readFileSync(join(PACKAGES, 'server/server/version.ts'), 'utf8')
    expect(v).toContain("return env.AGENTISTICS_AUTO_UPGRADE === '1'")
  })

  test('the page installs only through the one startUpgrade: the popup\'s install exit, the sheet\'s button, the overlay\'s retry', () => {
    expect(callers(/\bstartUpgrade\(/)).toEqual([
      'web/src/App.tsx', 'web/src/components/UpdateModal.tsx', 'web/src/components/UpgradeOverlay.tsx', 'web/src/lib/upgradeFlow.ts',
    ])
    // the popup's timeout, close and "later" exits never install: only 'install' does
    const nay = readFileSync(join(PACKAGES, 'web/src/components/nay/NayUpdateCard.tsx'), 'utf8')
    expect(nay.match(/onExit\('install'\)/g)).toHaveLength(1)
  })
})
