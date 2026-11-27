#!/usr/bin/env bun
/**
 * TEST FIXTURE — one writer of the ledger race: `bun ledger-race.testing.ts <dataDir> <n>` increments a counter
 * `n` times through `withLedger`. Several of these in parallel must end at exactly processes × n (no lost update).
 */
import { withLedger } from './ledger'

const [dataDir, n] = process.argv.slice(2)
for (let k = 0; k < Number(n); k++) {
  withLedger(dataDir!, l => {
    const s = (l.sessions['race'] ??= { state: 'pronto', perRun: false, createdAt: '', nmGen: 0, volumes: [], containers: [], execs: {} })
    s.nmGen += 1
  })
}
