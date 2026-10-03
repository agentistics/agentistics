/**
 * SECRETS.4 §5.2 / §11 S4.1 — a process that is not the service is a vault CLIENT for real: run as a
 * separate OS process (NODE_ENV unset, like any `agentop …` CLI call), it never opens the vault, is
 * refused every read with `service-only`, seals THROUGH the service, and sees the GitHub token only
 * as the service-held marker. Only this (test) process — the holder — ever has the key.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { openRecord } from '@agentistics/vault'
import { AGENTISTICS_DATA_DIR } from '../config'
import { __resetVaultForTests, ensureVaultOpen, sealToFile, vaultSocketPath } from './service'
import { startVaultSocket, stopVaultSocket } from './socket'
import { installVaultOps } from './ops'
import { GITHUB_BACKUP_SEALED_FILE, SERVICE_HELD_TOKEN } from '../backup/github-store'

const M = 'TEST-NOT-A-SECRET-' + randomBytes(8).toString('hex')
const probe = join(import.meta.dir, '__fixtures__', 'client-probe.ts')

async function runClient(): Promise<{ stdout: string; stderr: string }> {
  const home = await mkdtemp(join(tmpdir(), 'agentistics-client-home-'))
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: home, AGENTISTICS_DIR: AGENTISTICS_DATA_DIR, AGENTISTICS_LANG: 'en' }
  const p = Bun.spawn([process.execPath, probe, GITHUB_BACKUP_SEALED_FILE, M], { env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  await p.exited
  return { stdout, stderr }
}

beforeAll(async () => {
  __resetVaultForTests({ dir: join(AGENTISTICS_DATA_DIR, 'vault'), lang: 'en' })
  await sealToFile(GITHUB_BACKUP_SEALED_FILE, 'github-backup', 'github-backup',
    new TextEncoder().encode(JSON.stringify({ url: 'https://github.com/o/r', owner: 'o', repo: 'r', token: M + '-gh', keepRemote: 0, deleteLocalAfterUpload: false })))
  installVaultOps()
  expect((await startVaultSocket(vaultSocketPath())).ok).toBe(true)
})
afterAll(() => stopVaultSocket())

describe('a CLI process is a vault client', () => {
  test('never opens the vault, cannot read, seals through the service, sees only the marker', async () => {
    const { stdout, stderr } = await runClient()
    expect(stdout + stderr).not.toContain(M + '-gh')
    const line = stdout.trim().split('\n').pop()!
    const r = JSON.parse(line) as { role: string; opened: boolean; readCode: string; sealed: string; gh: { state: string; token?: string; owner?: string }; holdsKey: boolean }
    expect(r.role).toBe('client')
    expect(r.opened).toBe(false)
    expect(r.holdsKey).toBe(false)
    expect(r.readCode).toBe('service-only')
    expect(r.gh).toEqual({ state: 'ok', token: SERVICE_HELD_TOKEN, owner: 'o' })
    // What it sealed was sealed by THIS process's key — the only key there is.
    const o = await ensureVaultOpen()
    const back = openRecord({ dek: o!.dek, kid: o!.kid, purpose: 'central-token', name: 'probe', bytes: new Uint8Array(Buffer.from(r.sealed, 'base64')) })
    expect(back.ok && new TextDecoder().decode(back.plaintext)).toBe(M)
  }, 30_000)

  test('with no service answering, a client seal is refused with service-down — never opened locally', async () => {
    stopVaultSocket()
    try {
      const { stdout, stderr } = await runClient()
      expect(stdout).toBe('')
      expect(stderr).toContain('the service is not running')
    } finally {
      expect((await startVaultSocket(vaultSocketPath())).ok).toBe(true)
    }
  }, 30_000)
})
