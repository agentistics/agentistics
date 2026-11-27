/**
 * DOCKER.AMBIENTES S2 — the ONE door to the `docker` binary. Every call passes `argvRefusal` first (no build,
 * no prune, no published port, no socket, no network but `none`), so no code path can issue one.
 * The binary is `AGENTISTICS_DOCKER_BIN` or `docker` on PATH — the tests put a fake there and assert the exact argv.
 */
import { spawn, spawnSync } from 'node:child_process'
import { argvRefusal } from './docker-argv'

export class DockerRefusal extends Error {}

export interface DockerResult { code: number; stdout: string; stderr: string }

export const dockerBin = (env: Record<string, string | undefined> = process.env): string => env.AGENTISTICS_DOCKER_BIN || 'docker'

/** Only env the docker CLIENT needs; never the launcher's secrets (the client passes nothing to containers, but keep it tight). */
function clientEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'XDG_RUNTIME_DIR', 'AGENTISTICS_FAKE_DOCKER_LOG', 'AGENTISTICS_FAKE_DOCKER_STATE']) if (env[k]) out[k] = env[k]!
  return out
}

export function docker(argv: readonly string[], opts: { env?: Record<string, string | undefined>; timeoutMs?: number; input?: string } = {}): DockerResult {
  const refusal = argvRefusal(argv)
  if (refusal) throw new DockerRefusal(refusal)
  const env = opts.env ?? process.env
  const r = spawnSync(dockerBin(env), [...argv], { env: clientEnv(env), encoding: 'utf8', timeout: opts.timeoutMs ?? 60_000, input: opts.input, maxBuffer: 64 * 1024 * 1024 })
  return { code: r.status ?? (r.error ? 127 : 1), stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error.message) : '') }
}

/** `docker start -a -i <id>`: attached, streaming through to our own stdio. Resolves with the container's exit code. */
export function dockerAttached(argv: readonly string[], opts: { env?: Record<string, string | undefined>; stdin?: boolean } = {}): { done: Promise<number>; pid: number | undefined } {
  const refusal = argvRefusal(argv)
  if (refusal) throw new DockerRefusal(refusal)
  const env = opts.env ?? process.env
  const child = spawn(dockerBin(env), [...argv], { env: clientEnv(env), stdio: [opts.stdin ? 'inherit' : 'ignore', 'inherit', 'inherit'] })
  const done = new Promise<number>(resolve => {
    child.once('exit', (code, sig) => resolve(code ?? (sig ? 128 + 15 : 1)))
    child.once('error', () => resolve(127))
  })
  return { done, pid: child.pid }
}

export const parseJson = <T = any>(text: string): T | null => { try { return JSON.parse(text) as T } catch { return null } }
