/**
 * The REAL-protector smoke test (spec §6.5). Skipped unless `AGENTISTICS_VAULT_SMOKE=1` — it runs the
 * machine's actual protector (DPAPI through WSL interop on the reference machine), which CI does not
 * have and an ordinary test run must never touch.
 *
 * Everything happens under a throwaway HOME and data dir; the "secrets" are generated
 * `TEST-NOT-A-SECRET-…` markers. Steps:
 *   1. an UPGRADED install: plaintext GitHub config, plaintext central tokens in preferences.json
 *      (0664), a plaintext envelope key
 *   2. `agentop vault init` → the system protector is chosen and everything is migrated
 *   3. a SECOND process opens the vault and reads each secret back
 *   4. the same from a `systemd-run --user` unit — the agentop service's path (skipped without it)
 *   5. no file under the throwaway HOME contains any marker; `vault status` reports 0 pending
 *   6. `agentop vault reset --yes` removes it all
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SMOKE = process.env.AGENTISTICS_VAULT_SMOKE === '1'
const CLI = join(import.meta.dir, '..', '..', 'bin', 'cli.ts')
const ROOT = join(import.meta.dir, '..', '..', '..', '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

describe.skipIf(!SMOKE)('vault smoke — the real protector on this machine', () => {
  const home = mkdtempSync(join(tmpdir(), 'agentistics-vault-smoke-'))
  const data = join(home, '.agentistics')
  const marker = (k: string) => `TEST-NOT-A-SECRET-${k}-${Math.random().toString(36).slice(2, 10)}`
  const GH = marker('gh')
  const TOK = marker('tok')
  const PRIV = marker('priv')
  const env = { ...process.env, HOME: home, AGENTISTICS_DIR: data, NODE_ENV: 'production', AGENTISTICS_VAULT_SMOKE: '1', AGENTISTICS_LANG: 'en' }
  const run = (args: string[], extraEnv: Record<string, string> = {}) => {
    const t0 = performance.now()
    const r = Bun.spawnSync([process.execPath, CLI, ...args], { env: { ...env, ...extraEnv }, cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString(), ms: Math.round(performance.now() - t0) }
  }
  const probe = join(home, 'probe.ts')

  test('upgraded install → init → migrated → read back by a second process and by a systemd user unit → nothing in plain text → reset', () => {
    mkdirSync(join(data, 'connections'), { recursive: true })
    writeFileSync(join(data, 'github-backup.json'), JSON.stringify({ url: 'https://github.com/me/b', owner: 'me', repo: 'b', token: GH, keepRemote: 0, deleteLocalAfterUpload: false }), { mode: 0o600 })
    writeFileSync(join(data, 'preferences.json'), JSON.stringify({ customLayout: [], team: { schema: 2, mode: 'member', connections: [{ id: 'c_aaaaaaaaaaaa', endpoint: 'http://central.invalid:48080', org: 'acme', user: 'smoke', token: TOK, deniedRepos: [], shareMode: 'denylist', sources: [] }] } }), { mode: 0o664 })
    writeFileSync(join(data, 'connections', 'envelope-key.json'), JSON.stringify({ publicKey: 'TEST-NOT-A-SECRET-pub', privateKey: PRIV }), { mode: 0o600 })

    const before = run(['vault', 'status', '--json'])
    expect(JSON.parse(before.out).pending).toBe(3)

    const init = run(['vault', 'init'])
    process.stderr.write(`\n[smoke] vault init (${init.ms} ms):\n${init.out}${init.err}\n`)
    expect(init.code).toBe(0)
    const status = JSON.parse(run(['vault', 'status', '--json']).out)
    process.stderr.write(`[smoke] status: state=${status.state} protector=${status.protector} pending=${status.pending} sealed=${status.sealedFiles.length}\n`)
    expect(status.state === 'open' || status.state === 'locked').toBe(true)
    expect(status.protector).not.toBe('passphrase')
    expect(status.pending).toBe(0)
    expect(status.sealedFiles.length).toBe(3)
    expect((statSync(join(data, 'preferences.json')).mode & 0o777)).toBe(0o600)

    writeFileSync(probe, [
      `import { readGithubConfig } from '${join(ROOT, 'packages/server/server/backup/github-store.ts')}'`,
      `import { readPreferences } from '${join(ROOT, 'packages/server/server/preferences.ts')}'`,
      `import { loadOrCreateKeypair } from '${join(ROOT, 'packages/server/server/envelope-keys.ts')}'`,
      `const t0 = performance.now()`,
      `const gh = await readGithubConfig()`,
      `const p = await readPreferences()`,
      `const kp = await loadOrCreateKeypair()`,
      `console.log(JSON.stringify({ gh: gh?.token === ${JSON.stringify(GH)}, tok: p.team?.connections[0]?.token === ${JSON.stringify(TOK)}, priv: kp.privateKey === ${JSON.stringify(PRIV)}, ms: Math.round(performance.now() - t0) }))`,
    ].join('\n'))
    const second = Bun.spawnSync([process.execPath, probe], { env, cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
    process.stderr.write(`[smoke] second process: ${second.stdout.toString().trim()} ${second.stderr.toString().trim()}\n`)
    expect(JSON.parse(second.stdout.toString().trim().split('\n').pop()!)).toMatchObject({ gh: true, tok: true, priv: true })

    if (Bun.which('systemd-run')) {
      const unit = Bun.spawnSync(['systemd-run', '--user', '--wait', '--pipe', '--quiet', '--collect',
        ...Object.entries({ HOME: home, AGENTISTICS_DIR: data, NODE_ENV: 'production', AGENTISTICS_VAULT_SMOKE: '1', PATH: process.env.PATH ?? '', WSL_DISTRO_NAME: process.env.WSL_DISTRO_NAME ?? '' }).flatMap(([k, v]) => ['-E', `${k}=${v}`]),
        process.execPath, probe], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
      process.stderr.write(`[smoke] systemd-run --user: exit=${unit.exitCode} ${unit.stdout.toString().trim()} ${unit.stderr.toString().trim()}\n`)
      expect(JSON.parse(unit.stdout.toString().trim().split('\n').pop()!)).toMatchObject({ gh: true, tok: true, priv: true })
    } else {
      process.stderr.write('[smoke] systemd-run not available — the service-path step was skipped\n')
    }

    const leaks = walk(home).filter(f => f !== probe).filter(f => { const t = readFileSync(f, 'latin1'); return t.includes(GH) || t.includes(TOK) || t.includes(PRIV) })
    expect(leaks).toEqual([])

    const reset = run(['vault', 'reset', '--yes'])
    expect(reset.code).toBe(0)
    expect(existsSync(join(data, 'vault'))).toBe(false)
    expect(existsSync(join(data, 'github-backup.sealed'))).toBe(false)
    rmSync(home, { recursive: true, force: true })
  }, 120_000)
})
