import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planLimitsPayload, __resetPlanLimitsForTest } from '../plan-limits'
import { startVaultSocket, stopVaultSocket } from '../vault/socket'
import { handleVaultOp, installVaultOps } from '../vault/ops'
import { resetHarnessSpawnability } from './harness-spawnable'

const probe = join(import.meta.dir, '__fixtures__', 'spawn-report-client.ts')
let dir: string | undefined
const originalPath = process.env.PATH

afterEach(async () => {
  stopVaultSocket()
  process.env.PATH = originalPath
  resetHarnessSpawnability()
  __resetPlanLimitsForTest()
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

async function cli(path: string, result: string): Promise<void> {
  const env = { ...process.env }
  delete env.NODE_ENV
  const child = Bun.spawn([process.execPath, probe, path, result], { env, stdout: 'pipe', stderr: 'pipe' })
  const stderr = await new Response(child.stderr).text()
  expect(await child.exited).toBe(0)
  expect(stderr).toBe('')
}

test('CLI failure and later success reach the server plan-limits payload across processes', async () => {
  dir = await mkdtemp(join(tmpdir(), 'spawn-report-'))
  await writeFile(join(dir, 'codex'), '#!/bin/sh\nexit 0\n')
  await chmod(join(dir, 'codex'), 0o700)
  process.env.PATH = `${dir}:${originalPath ?? ''}`
  resetHarnessSpawnability()
  __resetPlanLimitsForTest()
  installVaultOps()
  const path = join(dir, 's')
  expect(await startVaultSocket(path)).toEqual({ ok: true })
  await cli(path, 'failure')
  expect((await planLimitsPayload(undefined)).harnesses.codex).toMatchObject({ spawnable: false })
  await cli(path, 'unknown')
  expect((await planLimitsPayload(undefined)).harnesses.codex).toMatchObject({ spawnable: false })
  await cli(path, 'success')
  expect((await planLimitsPayload(undefined)).harnesses.codex).toEqual({ spawnable: true })
}, 15_000)

test('CLI startup check still succeeds with an unreachable server', async () => {
  dir = await mkdtemp(join(tmpdir(), 'spawn-report-down-'))
  await cli(join(dir, 'absent.sock'), 'success')
})

test('the service rejects malformed classified outcomes', async () => {
  for (const header of [
    { op: 'fresh-spawn', harness: 'invalid', startedAt: 0, died: false },
    { op: 'fresh-spawn', harness: 'codex', startedAt: 'now', died: false },
    { op: 'fresh-spawn', harness: 'codex', startedAt: 0, died: 'false' },
    { op: 'fresh-spawn', harness: 'codex', startedAt: 0, died: true, status: -1 },
  ]) {
    const result = await handleVaultOp({ header, body: null, emit() {}, closed: Promise.resolve() })
    expect(result.reply).toMatchObject({ ok: false, code: 'bad-request' })
  }
})
