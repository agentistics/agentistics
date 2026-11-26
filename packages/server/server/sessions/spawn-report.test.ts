import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { planLimitsPayload, __resetPlanLimitsForTest } from '../plan-limits'
import { stopVaultSocket } from '../vault/socket'
import { bootstrapServer } from '../server-bootstrap'
import { handleVaultOp, installVaultOps } from '../vault/ops'
import { harnessSpawnability, resetHarnessSpawnability } from './harness-spawnable'

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
  const env = { ...process.env, AGENTISTICS_DIR: dirname(dirname(path)) }
  delete env.NODE_ENV
  // Hermetic: the probe is the owner's CLI, never the managed session the test runner may itself be inside.
  delete (env as Record<string, string | undefined>).AGENTOP_MANAGED_ID
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
  await bootstrapServer()
  const { vaultSocketPath } = await import('../vault/service')
  const path = vaultSocketPath()
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

test('direct server entry point receives production CLI startup reports without vault initialization', async () => {
  dir = await mkdtemp(join(tmpdir(), 'spawn-direct-'))
  await writeFile(join(dir, 'codex'), '#!/bin/sh\nexit 0\n')
  await chmod(join(dir, 'codex'), 0o700)
  process.env.PATH = `${dir}:${originalPath ?? ''}`
  // Reserve an ephemeral port, then hand it to the real direct entry point.
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = reservation.port!
  reservation.stop(true)
  const env = { ...process.env, HOME: dir, AGENTISTICS_DIR: join(dir, 'data'),
    PORT: String(port), SERVE_STATIC: '0', PATH: `${dir}:${originalPath ?? ''}`,
    AGENTISTICS_TELEMETRY: '0', NODE_ENV: 'test' }
  const server = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'index.ts')], { env, stdout: 'ignore', stderr: 'pipe' })
  const errors = new Response(server.stderr).text()
  try {
    const url = `http://127.0.0.1:${port}/api/plan-limits`
    let ready = false
    for (let i = 0; i < 200; i++) {
      try { if ((await fetch(url)).ok) { ready = true; break } } catch { /* still booting */ }
      if (server.exitCode !== null) throw new Error(await errors)
      await Bun.sleep(50)
    }
    expect(ready).toBe(true)
    const path = join(dir, 'data', 'run', 'vault.sock')
    await cli(path, 'production-failure')
    expect((await (await fetch(url)).json()).harnesses.codex.spawnable).toBe(false)
    await cli(path, 'production-success')
    expect((await (await fetch(url)).json()).harnesses.codex.spawnable).toBe(true)
  } finally {
    server.kill()
    await server.exited
    await errors
  }
}, 30_000)

test('far-future and fractional reports are rejected without poisoning subsequent updates', async () => {
  installVaultOps()
  const report = (startedAt: number, died: boolean) => handleVaultOp({
    header: { op: 'fresh-spawn', harness: 'codex', startedAt, died, status: died ? 2 : 0 },
    body: null, emit() {}, closed: Promise.resolve(),
  })
  for (const startedAt of [Number.MAX_VALUE, Date.now() + 10 * 60_000, Date.now() + 0.5]) {
    expect((await report(startedAt, false)).reply).toMatchObject({ ok: false, code: 'bad-request' })
  }
  expect((await report(Date.now(), true)).reply.ok).toBe(true)
  expect(harnessSpawnability('codex', Date.now(), () => '/bin/codex').spawnable).toBe(false)
  expect((await report(Date.now(), false)).reply.ok).toBe(true)
  expect(harnessSpawnability('codex', Date.now(), () => '/bin/codex').spawnable).toBe(true)
})
