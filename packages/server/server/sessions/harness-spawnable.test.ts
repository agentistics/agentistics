import { beforeEach, expect, test } from 'bun:test'
import { harnessSpawnability, noteFreshSpawn, resetHarnessSpawnability, STARTUP_FAILURE_TTL_MS } from './harness-spawnable'
import { spawnDeath } from './spawn-check'
import { spawnOutcome } from './spawn-outcome'

const installed = () => '/test/bin/codex'
const failure = spawnOutcome(['error: unexpected argument', 'Pane is dead (status 2)'])
beforeEach(resetHarnessSpawnability)

test('missing binary is unavailable even after a successful spawn', () => {
  noteFreshSpawn('codex', undefined, 0, 0)
  expect(harnessSpawnability('codex', 1, () => null)).toMatchObject({ spawnable: false })
})

test('startup refusal expires after thirty minutes', () => {
  noteFreshSpawn('codex', failure, 0, 0)
  expect(harnessSpawnability('codex', STARTUP_FAILURE_TTL_MS - 1, installed).spawnable).toBe(false)
  expect(harnessSpawnability('codex', STARTUP_FAILURE_TTL_MS, installed)).toEqual({ spawnable: true })
})

test('a later successful fresh spawn clears the failure', () => {
  noteFreshSpawn('codex', failure, 0, 0)
  noteFreshSpawn('codex', undefined, 1, 1)
  expect(harnessSpawnability('codex', 2, installed)).toEqual({ spawnable: true })
  // An older concurrent startup check must not overwrite the latest fresh start.
  noteFreshSpawn('codex', failure, 0, 3)
  expect(harnessSpawnability('codex', 4, installed)).toEqual({ spawnable: true })
})

test('an immediate clean exit is not a startup refusal', () => {
  noteFreshSpawn('codex', spawnOutcome(['Pane is dead (status 0)']), 0, 0)
  expect(harnessSpawnability('codex', 1, installed).spawnable).toBe(true)
})

test('fresh spawn polling records failure and clears it on success; resume checks do neither', async () => {
  const backend = { capture: async () => ['error: unexpected argument', 'Pane is dead (status 2)'] }
  await spawnDeath(backend, 'fresh', 1, 'codex')
  expect(harnessSpawnability('codex', Date.now(), installed).spawnable).toBe(false)
  await spawnDeath({ capture: async () => [] }, 'resume', 1)
  expect(harnessSpawnability('codex', Date.now(), installed).spawnable).toBe(false)
  await spawnDeath({ capture: async () => [] }, 'fresh-success', 1, 'codex')
  expect(harnessSpawnability('codex', Date.now(), installed).spawnable).toBe(true)
  await spawnDeath(backend, 'resume-failure', 1)
  expect(harnessSpawnability('codex', Date.now(), installed).spawnable).toBe(true)
})

test('a wholly unobservable fresh check preserves the previous failure', async () => {
  noteFreshSpawn('codex', failure, 0)
  await spawnDeath({ capture: async () => { throw new Error('capture unavailable') } }, 'unobservable', 1, 'codex')
  expect(harnessSpawnability('codex', Date.now(), installed).spawnable).toBe(false)
})
