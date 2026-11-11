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
// Performs <count> SEQUENTIAL updatePreferencesAt calls against the given preferences file pair,
// each appending one entry `<prefix4hex><i as 8 hex>` to the `scanRoots` list, so the parent can
// count survivors by prefix.
//
// `readyFile` is a synchronization barrier: this process creates it right before starting its
// write loop (AFTER `bun run`'s own startup/import cost, which is the dominant source of the
// two processes' writes never actually overlapping in wall-clock time) so the PARENT test process
// can wait for it and start its own racing loop at approximately the same instant, instead of
// hoping incidental process-scheduling luck produces overlap.

import { updatePreferencesAt, __setTestOnlyDisableLock } from '../../server/preferences'
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
    await updatePreferencesAt(primary, legacy, (current) => ({
      scanRoots: [...(current.scanRoots ?? []), `${prefix}${i.toString(16).padStart(8, '0')}`],
    }))
  }
}

main()
