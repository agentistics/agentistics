/**
 * SECRETS.4 §1.1 / §12.1 on the host: the runner scope is its OWN vault directory with its own DEK;
 * the runner handle reads no human secret; destroying the runner scope leaves the human one intact.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryProtector } from '@agentistics/vault'
import {
  __resetVaultForTests, destroyRunnerVault, ensureVaultOpen, initRunnerVault, openFromFile, openRunnerVault,
  runnerVaultDir, sealToFile, vaultDir,
} from './service'

const enc = (s: string) => new TextEncoder().encode(s)
afterAll(async () => { __resetVaultForTests({ dir: join(await mkdtemp(join(tmpdir(), 'agentistics-scope-')), 'vault') }) })

describe('the runner scope on the host', () => {
  test('lives beside the human vault, opens with its own DEK, and cannot read a human secret', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentistics-scope-'))
    __resetVaultForTests({ dir: join(dir, 'vault') })
    expect(runnerVaultDir()).toBe(join(dir, 'vault-runner'))
    const human = join(dir, 'gh.sealed')
    await sealToFile(human, 'github-backup', 'github-backup', enc('TEST-NOT-A-SECRET-human'))
    const h = await ensureVaultOpen()
    expect(h).not.toBeNull()

    const made = await initRunnerVault(memoryProtector(), 'machine-1')
    expect(made.ok).toBe(true)
    const opened = await openRunnerVault()
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(opened.machineId).toBe('machine-1')
    expect(opened.handle.kid).not.toBe(h!.kid)
    const bytes = await Bun.file(human).bytes()
    // @ts-expect-error — the runner handle cannot name a human purpose.
    expect(opened.handle.open('github-backup', 'github-backup', bytes)).toEqual({ ok: false, code: 'purpose' })

    const sealed = opened.handle.seal('cloud-runner/refresh', 'refresh', enc('TEST-NOT-A-SECRET-runner'))
    const back = opened.handle.open('cloud-runner/refresh', 'refresh', sealed)
    expect(back.ok).toBe(true)
    opened.handle.close()

    await destroyRunnerVault()
    expect(existsSync(join(runnerVaultDir(), 'vault.json'))).toBe(false)
    expect((await openRunnerVault()).ok).toBe(false)
    // The human scope is untouched.
    expect(existsSync(join(vaultDir(), 'vault.json'))).toBe(true)
    const still = await openFromFile(human, 'github-backup', 'github-backup')
    expect(still.ok).toBe(true)
  })
})
