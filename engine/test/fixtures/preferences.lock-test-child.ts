// preferences.lock-test-child.ts — spawned as a SEPARATE OS process by preferences.test.ts's
// cross-process lock tests. Never imported by production code and never spawned in production —
// it exists to prove `acquireFileLock` (in preferences.ts) serializes a read-modify-write against
// a writer running in ANOTHER process, which `enqueueWrite`'s in-process chain cannot do (a
// second `bun` process has its own, independent `_writeChain`) — and, when told to disable the
// lock via the same test-only seam the parent uses, to prove the guard is not vacuous on this
// hardware (round-2 review finding R5).
//
// Usage: bun run preferences.lock-test-child.ts <primary> <legacy> <prefix4hex> <count> <readyFile> [--disable-lock]
//
// Performs <count> SEQUENTIAL updateTeamConfigAt calls against the given preferences file pair,
// each appending one connection with a distinct id `c_<prefix4hex><i as 8 hex>` (exactly 12 hex
// chars after `c_`, matching @agentistics/core's ID_RE, so migrateTeamConfig never regenerates it
// out from under the test's ability to count survivors by prefix) AND a distinct endpoint — the
// endpoint is `connections[]`'s uniqueness key (see TeamConnection's own doc comment in
// core/src/team.ts), so migrateTeamConfig legitimately DEDUPES same-endpoint entries down to one;
// reusing one endpoint here would look exactly like a lost-update bug in the lock, when it is
// actually this fixture violating the schema's own invariant.
//
// `readyFile` is a synchronization barrier: this process creates it right before starting its
// write loop (AFTER `bun run`'s own startup/import cost, which is the dominant source of the
// two processes' writes never actually overlapping in wall-clock time) so the PARENT test process
// can wait for it and start its own racing loop at approximately the same instant, instead of
// hoping incidental process-scheduling luck produces overlap.

import { updateTeamConfigAt, __setTestOnlyDisableLock } from '../../server/preferences'
import { writeFile } from 'node:fs/promises'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const disableLock = args.includes('--disable-lock')
  const positional = args.filter(a => a !== '--disable-lock')
  const [primary, legacy, prefix, countStr, readyFile] = positional
  if (!primary || !legacy || !prefix || !countStr || !readyFile || prefix.length !== 4) {
    process.stderr.write('usage: bun run preferences.lock-test-child.ts <primary> <legacy> <prefix4hex> <count> <readyFile> [--disable-lock]\n')
    process.exit(1)
  }
  if (disableLock) __setTestOnlyDisableLock(true)
  const count = Number(countStr)

  await writeFile(readyFile, String(process.pid))

  for (let i = 0; i < count; i++) {
    await updateTeamConfigAt(primary, legacy, (current) => ({
      ...current,
      connections: [
        ...current.connections,
        {
          id: `c_${prefix}${i.toString(16).padStart(8, '0')}`,
          endpoint: `http://127.0.0.1:1/${prefix}${i}`,
          org: 'default',
          user: '',
          token: '',
          deniedRepos: [],
        },
      ],
    }))
  }
}

main()
