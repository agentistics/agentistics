/**
 * scripts/perf/server-harness.ts — start a THROWAWAY agentop server over a given home (a synthetic
 * one from `synth-home.ts`, or a copy made by `copy-data.sh`), on free ports, with tmux isolated, and
 * never the machine's running server: it refuses a home that is the real $HOME, and a port in use.
 */
import { spawn, type Subprocess } from 'bun'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface PerfServer {
  base: string
  pid: number
  /** `[boot]` lines' times, ms since the process started. */
  boot: { claimed?: number; listening?: number; firstData?: number }
  /** Wall ms from spawn until `/api/health` answered. */
  healthMs: number
  log: () => string
  rssKb: () => Promise<number>
  serverPid: () => Promise<number>
  stop: () => Promise<void>
}

const REPO = join(import.meta.dir, '..', '..')

async function portFree(port: number): Promise<boolean> {
  try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(300) }); return false } catch (e) { return String(e).includes('ConnectionRefused') || String(e).includes('Unable to connect') }
}

export async function startPerfServer(home: string, o: { port?: number; env?: Record<string, string> } = {}): Promise<PerfServer> {
  if (home === homedir() || home === process.env.HOME) throw new Error('refusing to run the perf server over the real $HOME')
  let port = o.port ?? 47_400 + Math.floor(Math.random() * 400) * 2
  for (let i = 0; i < 20 && !(await portFree(port) && await portFree(port + 1)); i++) port += 2
  const t0 = performance.now()
  let out = ''
  const proc: Subprocess = spawn(['bun', join(REPO, 'packages/server/bin/cli.ts'), 'server', '--port', String(port)], {
    cwd: REPO,
    env: { ...process.env, HOME: home, TMUX_TMPDIR: join(home, '..', 'tmux'), PORT: String(port), WEB_PORT: String(port + 1), AGENTISTICS_JOURNAL_BACKFILL: '0', AGENTISTICS_TELEMETRY: '0', INVOCATION_ID: '', ...o.env },
    stdout: 'pipe', stderr: 'pipe',
  })
  const drain = async (s: ReadableStream<Uint8Array> | null | undefined) => { if (!s) return; const d = new TextDecoder(); for await (const c of s) out += d.decode(c) }
  void drain(proc.stdout as ReadableStream<Uint8Array>); void drain(proc.stderr as ReadableStream<Uint8Array>)
  const base = `http://127.0.0.1:${port}`
  let healthMs = -1
  for (let i = 0; i < 1200; i++) {
    if (proc.exitCode !== null) throw new Error(`perf server exited ${proc.exitCode}:\n${out.slice(-2000)}`)
    try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok) { healthMs = performance.now() - t0; break } } catch { /* not yet */ }
    await Bun.sleep(50)
  }
  if (healthMs < 0) { proc.kill(); throw new Error('perf server never answered /api/health') }
  const lock = join(home, '.agentistics', 'server.lock')
  const serverPid = async (): Promise<number> => { try { return Number((await Bun.file(lock).text()).trim().split(/\s+/)[0]) || 0 } catch { return 0 } }
  const alive = (pid: number) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch { return false } }
  const bootOf = (what: string) => { const m = out.match(new RegExp(`\\[boot\\] \\+(\\d+) ms ${what}`)); return m ? Number(m[1]) : undefined }
  return {
    base, pid: proc.pid, healthMs,
    get boot() { return { claimed: bootOf('data dir claimed'), listening: bootOf('listening'), firstData: bootOf('first /api/data built') } },
    log: () => out,
    async rssKb() { const pid = await serverPid(); try { return Number((await Bun.file(`/proc/${pid}/status`).text()).match(/VmRSS:\s+(\d+)/)?.[1] ?? 0) } catch { return 0 } },
    serverPid,
    async stop() {
      // `cli.ts server` re-launches the server detached: the process to stop is the lock holder.
      const pid = await serverPid()
      proc.kill('SIGTERM')
      if (pid) {
        try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
        for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(100)
        if (alive(pid)) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
      }
      for (let i = 0; i < 50 && alive(pid); i++) await Bun.sleep(100)
    },
  }
}

export function quantiles(xs: number[]): { p50: number; p95: number; n: number } {
  const s = [...xs].sort((a, b) => a - b)
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN
  return { p50: Math.round(q(0.5)), p95: Math.round(q(0.95)), n: s.length }
}
