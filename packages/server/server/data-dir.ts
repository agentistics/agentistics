/**
 * data-dir.ts — where this process may WRITE its own state, and the guard that keeps a TEST run
 * out of the owner's real `~/.agentistics`.
 *
 * WHY A GUARD AND NOT DISCIPLINE: a test that forgets ONE injection reaches the real store. It
 * happened: `envelope-client.test.ts` called `sendRestriction` without `notify`, the first-time
 * pin fell through to the real notifier, and the owner's bell showed "1 new machine on
 * https://central.example … laptop-b" — fixture values, in the real inbox
 * (`~/.agentistics/notifications.json`). `team-uploader.ts` had already grown a per-module
 * `__setNotifierForTests` for the same leak; a per-module seam fixes the module somebody noticed
 * and no other. Every persisted path in `config.ts` derives from `AGENTISTICS_DATA_DIR`, so
 * resolving THAT one value under test closes the whole class at once.
 *
 * The rules, in `resolveDataDir` (pure):
 *  - outside a test run, nothing changes: `AGENTISTICS_DIR` or `~/.agentistics`;
 *  - under `bun test` (it sets `NODE_ENV=test`) with no `AGENTISTICS_DIR`, a FRESH temporary
 *    directory per process — and the caller exports it back into `process.env`, so a module that
 *    reads the variable itself (`@agentistics/mcp`'s audit log) and any child process inherit it;
 *  - under test with `AGENTISTICS_DIR` pointing AT the real default, it REFUSES (throws). An
 *    explicit choice that lands on the owner's store is the leak spelled out, not an override.
 */
import { join, resolve } from 'path'

export interface DataDirInputs {
  env: Record<string, string | undefined>
  home: string
  /** The OWNER's home as the account database records it (`os.userInfo().homedir`), which a test
   *  overriding `HOME` does not move. The refusal is about THAT store: a sandbox that sets
   *  `HOME=/tmp/x` and `AGENTISTICS_DIR=/tmp/x/.agentistics` is isolated and must be allowed. */
  ownerHome: string
  /** Creates (and returns) a fresh temporary directory. Injected so the rule stays pure. */
  makeTemp: () => string
}

export interface DataDirResult {
  dir: string
  /** True when the directory was minted for this test process and must be exported to env. */
  isolated: boolean
}

export function underTest(env: Record<string, string | undefined>): boolean {
  return env.NODE_ENV === 'test'
}

export function resolveDataDir({ env, home, ownerHome, makeTemp }: DataDirInputs): DataDirResult {
  const real = join(home, '.agentistics')
  const owners = join(ownerHome, '.agentistics')
  const explicit = env.AGENTISTICS_DIR
  if (!underTest(env)) return { dir: explicit ?? real, isolated: false }
  if (explicit !== undefined && explicit !== '') {
    if (ownerHome && resolve(explicit) === resolve(owners)) {
      throw new Error(
        `refusing to run tests against the real data dir ${owners} — unset AGENTISTICS_DIR or point it at a temporary directory`,
      )
    }
    return { dir: explicit, isolated: false }
  }
  return { dir: makeTemp(), isolated: true }
}
