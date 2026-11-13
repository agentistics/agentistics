/**
 * build-info.ts — the running build's identity (IO boundary over `build-identity.ts`).
 *
 * A BUILT binary (`build:assets` wrote `build` into the engine slot) answers with exactly what was baked in.
 * A DEV server (the slot was written by `bun run stub`, without a `build`) reads the checkout's git LIVE, once
 * per process: it runs from the checkout, so HEAD IS what it is serving, and answering nulls there would make
 * the install ledger useless for every branch served by `agentop run --serve`. `builtAt` is then the process
 * start. A process that is neither (a compiled binary whose slot carries no build, outside a checkout) says
 * nulls — never a guess.
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BUILD_CAPABILITIES, parseSlotBuild, readBuildIdentity, type BuildIdentity, type GitRun } from './build-identity.ts'

const ROOT = resolve(new URL('../../..', import.meta.url).pathname)

export function gitRunnerIn(dir: string, env: Record<string, string | undefined> = process.env): GitRun {
  return args => {
    try {
      const p = Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'ignore', env: { ...env, GIT_TERMINAL_PROMPT: '0' } })
      return p.exitCode === 0 ? p.stdout.toString() : null
    } catch { return null }
  }
}

/** PURE-ish decision, exported for tests: the slot's build wins; else a live read when a checkout exists; else nulls. */
export function resolveBuild(slotBuild: unknown, o: { checkout: boolean; run: GitRun; now: Date }): BuildIdentity {
  const baked = parseSlotBuild(slotBuild)
  if (baked) return baked
  if (o.checkout) return readBuildIdentity(o.run, o.now)
  return { repoKey: null, sha: null, tree: null, builtAt: o.now.toISOString(), capabilities: [...BUILD_CAPABILITIES] }
}

/** PURE. `/api/version`'s body: everything the old body carried, untouched, plus `build`. */
export function versionPayload<T extends object>(info: T, upgradable: string | null, build: BuildIdentity): T & { upgradable: string | null; build: BuildIdentity } {
  return { ...info, upgradable, build }
}

let memo: Promise<BuildIdentity> | null = null

export function currentBuild(): Promise<BuildIdentity> {
  memo ??= (async () => {
    let slotBuild: unknown
    try { slotBuild = ((await import('./engine-slot.generated')) as { build?: unknown }).build } catch { slotBuild = undefined }
    return resolveBuild(slotBuild, { checkout: existsSync(join(ROOT, '.git')), run: gitRunnerIn(ROOT), now: new Date() })
  })()
  return memo
}
