/**
 * The one set of tests that SPAWN: a real process under the real wrapper, observing the limit from
 * inside. Local and harmless (a `sh` that prints its own limits). The Docker test runs only with
 * AGENTISTICS_TEST_DOCKER=1 — it pulls/starts containers, which a unit run must not do by default.
 */
import { describe, expect, test } from 'bun:test'
import type { SpawnPlan } from '../tools/contract'
import { createSandboxLauncher } from './launcher'
import { defaultRunner, probeSandbox, type CommandRunner, type SandboxProbe } from './probe'

/** The real runner, except Docker and unshare are never touched by the offline tests. */
const offlineRunner: CommandRunner = (argv, o) =>
  argv[0] === 'docker' || argv[0] === 'unshare' ? Promise.resolve({ kind: 'not-found' }) : defaultRunner(argv, o)

async function run(plan: SpawnPlan): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(plan.argv, { cwd: plan.cwd, env: plan.env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, out, err }
}

const linux = process.platform === 'linux'
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' }

describe.skipIf(!linux)('real rlimit spawns', () => {
  test('prlimit: the child sees the configured nofile and fsize', async () => {
    const probe = await probeSandbox({ run: offlineRunner })
    if (probe.prlimit.status !== 'available') {
      console.warn('prlimit unavailable here; skipping', probe.prlimit)
      return
    }
    const l = createSandboxLauncher({ requested: 'rlimit', limits: { openFiles: 64, fileSizeBytes: 1024 * 1024 }, probe })
    const wrapped = l.wrap({ argv: ['sh', '-c', 'ulimit -n; ulimit -f'], cwd: '/', env })
    if ('refused' in wrapped) throw new Error(wrapped.refused)
    const r = await run(wrapped)
    expect(r.code).toBe(0)
    // `sh` reports -f in 512-byte blocks: 1 MiB = 2048.
    expect(r.out.trim().split('\n')).toEqual(['64', '2048'])
  })

  test('ulimit fallback: the limit applies AND a hostile argv survives positionally', async () => {
    const real = await probeSandbox({ run: offlineRunner })
    if (real.ulimit.status !== 'available') {
      console.warn('ulimit unavailable here; skipping', real.ulimit)
      return
    }
    const probe: SandboxProbe = { ...real, prlimit: { status: 'unavailable', reason: 'not-found' } }
    const l = createSandboxLauncher({ requested: 'rlimit', limits: { openFiles: 32 }, probe })
    expect(l.mechanism).toBe('ulimit')
    const tricky = ["a b", "it's", '"q"', '$(echo INJECTED)', '; echo pwned', '*']
    const wrapped = l.wrap({ argv: ['sh', '-c', 'ulimit -n; printf "<%s>\\n" "$@"', 'inner', ...tricky], cwd: '/', env })
    if ('refused' in wrapped) throw new Error(wrapped.refused)
    const r = await run(wrapped)
    expect(r.code).toBe(0)
    const lines = r.out.trimEnd().split('\n')
    expect(lines[0]).toBe('32')
    expect(lines.slice(1)).toEqual(tricky.map((t) => `<${t}>`))
    expect(r.out).not.toContain('INJECTED>')
  })

  test('a file larger than fsize cannot be written', async () => {
    const probe = await probeSandbox({ run: offlineRunner })
    if (probe.prlimit.status !== 'available') return
    const l = createSandboxLauncher({ requested: 'rlimit', limits: { fileSizeBytes: 4096 }, probe })
    const file = `/tmp/agentistics-rlimit-${process.pid}`
    // The writer (dd) is killed by SIGXFSZ at the limit; the outer sh survives to measure the file.
    const wrapped = l.wrap({ argv: ['sh', '-c', 'dd if=/dev/zero of="$1" bs=1024 count=64 2>/dev/null; wc -c < "$1"; rm -f "$1"', 'x', file], cwd: '/', env })
    if ('refused' in wrapped) throw new Error(wrapped.refused)
    const r = await run(wrapped)
    expect(Number(r.out.trim())).toBe(4096)
  })
})

describe.skipIf(process.env.AGENTISTICS_TEST_DOCKER !== '1')('real docker spawn (AGENTISTICS_TEST_DOCKER=1)', () => {
  test('the container sees the workspace, no network, and the env value by name only', async () => {
    const probe = await probeSandbox()
    const root = process.cwd()
    const l = createSandboxLauncher({ requested: 'docker', docker: { image: 'alpine:3', workspaceRoot: root }, probe })
    expect(l.state).toBe('container')
    const wrapped = l.wrap({
      argv: ['sh', '-c', 'pwd; echo "$PROBE_VALUE"; (wget -q -T 2 -O- http://1.1.1.1 >/dev/null 2>&1 && echo net) || echo nonet'],
      cwd: root,
      env: { ...env, PROBE_VALUE: 'value with spaces' },
    })
    if ('refused' in wrapped) throw new Error(wrapped.refused)
    expect(wrapped.argv.join(' ')).not.toContain('value with spaces')
    const r = await run(wrapped)
    expect(r.out.trim().split('\n')).toEqual([root, 'value with spaces', 'nonet'])
  }, 120_000)
})
