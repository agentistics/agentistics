/**
 * LIVE: the closing stats line of a REAL `agentop run --rm` (QA 2026-11-23: it never printed because the
 * sampler watched `systemd-run`, which stays in the launcher's cgroup, not the scope the command runs in).
 *
 * It needs a user systemd that can create a scope, which a run inside a run cannot (the bus refuses the
 * peer), so it skips there and says why. Run it from a plain shell: `bun test run-scope-stats.live.test.ts`.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'cli.ts')

const canScope = (() => {
  if (process.platform !== 'linux' || !process.env.XDG_RUNTIME_DIR) return false
  if (process.env.AGENTISTICS_THROWAWAY === '1' || process.env.AGENTOP_RUN_NAME) return false
  const r = spawnSync('systemd-run', ['--user', '--scope', '--quiet', 'true'], { timeout: 5000, stdio: 'ignore' })
  return r.status === 0
})()

function run(command: string[]): { out: string; err: string; status: number | null } {
  const env = { ...process.env }
  delete env.AGENTISTICS_FLOWS
  const r = spawnSync('bun', [CLI, 'run', '--rm', '--', ...command], { env, encoding: 'utf8', timeout: 170_000 })
  return { out: r.stdout ?? '', err: r.stderr ?? '', status: r.status }
}

/** Parses `agentop run: cpu 2.9s over 3.1s wall (0.94 cores) · memory peak 211 MB of the 2.0 GB cap`. */
function parse(line: string) {
  const cpu = /cpu ([\d.]+)(s|m)/.exec(line)
  const peak = /memory peak (\d+) MB/.exec(line)
  return { cpuSeconds: cpu ? Number(cpu[1]) * (cpu[2] === 'm' ? 60 : 1) : NaN, peakMb: peak ? Number(peak[1]) : NaN }
}

describe.skipIf(!canScope)('agentop run closing stats line (live, real scope)', () => {
  test('a 3 s sleep prints the line with a non-zero memory peak', () => {
    const r = run(['sleep', '3'])
    expect(r.status).toBe(0)
    const line = r.err.split('\n').find(l => l.startsWith('agentop run: cpu'))
    expect(line).toBeDefined()
    expect(parse(line!).peakMb).toBeGreaterThan(0)
  }, 180_000)

  test('a command that holds ~200 MB and burns cpu reports both', () => {
    const script = 'const b = Buffer.alloc(200 * 1024 * 1024, 1); const end = Date.now() + 3000; let x = 0; while (Date.now() < end) x += b[x % b.length]!; console.log(x > 0)'
    const r = run(['bun', '-e', script])
    expect(r.status).toBe(0)
    const line = r.err.split('\n').find(l => l.startsWith('agentop run: cpu'))
    expect(line).toBeDefined()
    const { cpuSeconds, peakMb } = parse(line!)
    expect(cpuSeconds).toBeGreaterThan(0.5)
    expect(peakMb).toBeGreaterThan(150)
  }, 180_000)
})
