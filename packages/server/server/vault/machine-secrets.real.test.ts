/**
 * Runs the machine key against THIS machine's real protectors (opt-in: `AGENTISTICS_MACHINE_REAL=1`), in a throwaway
 * directory — never the real vault. On the reference WSL2 box DPAPI (reached through powershell.exe interop) answers;
 * libsecret and systemd-creds usually do not, which is why the weaker file mode exists and is tested here too.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dpapiProtector, libsecretProtector, systemdCredsProtector, type Protector } from '@agentistics/vault'
import { realProtectorIo } from './io'
import { createMachineSecrets } from './machine-secrets'
import { readMachineId } from './machine-secrets-host'

const on = process.env.AGENTISTICS_MACHINE_REAL === '1'
const KEY = 'TEST-NOT-A-SECRET-real-0123456789'

describe.skipIf(!on)('machineSecrets on this machine', () => {
  test('which silent protector answers here, and the key works end to end with it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'machine-real-'))
    const io = realProtectorIo()
    const wsl = !!process.env.WSL_DISTRO_NAME
    const cands: Protector[] = [dpapiProtector({ io, vaultDir: dir, wsl }), libsecretProtector(io), systemdCredsProtector(io, dir)]
    const answered: string[] = []
    for (const p of cands) { const r = await p.probe().catch(() => ({ ok: false as const, reason: 'threw' })); console.info(`[machine-real] ${p.id}: ${r.ok ? 'answers' : `no (${r.reason.slice(0, 80)})`}`); if (r.ok) answered.push(p.id) }
    const ms = createMachineSecrets({ dir: join(dir, 'm'), protectors: () => cands, machineId: () => readMachineId() })
    const s = await ms.seal('engine/voice-elevenlabs-key', 'elevenlabs', new TextEncoder().encode(KEY))
    expect(s.ok).toBe(true); if (!s.ok) return
    console.info(`[machine-real] status: ${JSON.stringify(ms.status())}`)
    ms.dispose()
    const again = createMachineSecrets({ dir: join(dir, 'm'), protectors: () => cands, machineId: () => readMachineId() })
    const o = await again.open('engine/voice-elevenlabs-key', 'elevenlabs', s.sealed)
    expect(o.ok && new TextDecoder().decode(o.plaintext)).toBe(KEY)
    expect(ms.status().strength === (answered.length ? 'os' : 'file') || again.status().strength === (answered.length ? 'os' : 'file')).toBe(true)
  }, 60_000)

  test('the weaker file mode on this machine (real /etc/machine-id), when no protector answers', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'machine-real-file-')), 'm')
    expect(readMachineId()).not.toBeNull()
    const ms = createMachineSecrets({ dir, protectors: () => [], machineId: () => readMachineId() })
    const s = await ms.seal('engine/provider-key', 'x', new TextEncoder().encode(KEY))
    expect(s.ok).toBe(true); if (!s.ok) return
    expect(ms.status()).toMatchObject({ available: true, strength: 'file' })
    const o = await createMachineSecrets({ dir, protectors: () => [], machineId: () => readMachineId() }).open('engine/provider-key', 'x', s.sealed)
    expect(o.ok && new TextDecoder().decode(o.plaintext)).toBe(KEY)
  })
})
