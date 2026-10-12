/**
 * spawn-env.ts — what the server's CHILDREN inherit, with the variables only the server may hold taken
 * out (QA perf-idle-1 r2).
 *
 * `gc-markers.ts` re-executes `agentop server` with `BUN_JSC_numberOfGCMarkers` (+ its marker) so the
 * runtime reads it at boot. Deleting them from `process.env` afterwards is NOT enough, measured on bun
 * 1.3.14: a spawn without an explicit `env` — `Bun.spawn`, `Bun.spawnSync`, every `node:child_process`
 * function — passes the environment the process STARTED with, whatever `process.env` says since
 * (`delete`, assignment and replacement all leave the child's copy untouched). So every tmux server,
 * session, harness (Claude Code is itself a Bun binary), MCP and `bun test` inherited the server's GC
 * tuning.
 *
 * The fix sits where every spawn passes, not at 253 call sites: `installSpawnEnvGuard` wraps the spawn
 * functions once, at boot, before anything has spawned. A call with no `env` gets the environment the
 * process started with — exactly what it got before — minus the dropped keys; a call with an `env`
 * keeps it, minus the dropped keys. Nothing else about any spawn changes. `spawnEnv()` is the same
 * environment for a caller that builds one explicitly.
 */
import { readFileSync } from 'node:fs'

/** PURE: `env` without `keys`, `undefined` values dropped (a spawn's env holds strings). */
export function withoutKeys(env: Record<string, string | undefined>, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !keys.includes(k)) out[k] = v
  return out
}

/** PURE: a NUL-separated `/proc/<pid>/environ` as a record. */
export function parseEnviron(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const kv of text.split('\0')) {
    const eq = kv.indexOf('=')
    if (eq > 0) out[kv.slice(0, eq)] = kv.slice(eq + 1)
  }
  return out
}

type ChildProcessApi = 'spawn' | 'spawnSync' | 'execFile' | 'execFileSync' | 'fork' | 'exec' | 'execSync'

/**
 * PURE: the arguments with `env` decided — inserted where the API takes its options object when the
 * caller passed none, rewritten when it did. Signatures: `exec(cmd, opts?, cb?)`,
 * `execSync(cmd, opts?)`, and `spawn|spawnSync|execFile|execFileSync|fork(file, args?, opts?, cb?)`.
 */
export function withChildEnv(api: ChildProcessApi, args: unknown[], decide: (env: Record<string, string | undefined> | undefined) => Record<string, string>): unknown[] {
  const out = [...args]
  const at = api === 'exec' || api === 'execSync' ? 1 : Array.isArray(out[1]) ? 2 : 1
  const slot = out[at]
  if (slot && typeof slot === 'object' && !Array.isArray(slot)) {
    const o = slot as { env?: Record<string, string | undefined> }
    out[at] = { ...o, env: decide(o.env) }
  } else if (slot === undefined || slot === null) {
    out[at] = { env: decide(undefined) }
  } else {
    // A callback where the options would be: options go in front of it.
    out.splice(at, 0, { env: decide(undefined) })
  }
  return out
}

/** PURE: `Bun.spawn(cmd[], opts?)` / `Bun.spawn({ cmd, … })` with `env` decided. */
export function withBunEnv(args: unknown[], decide: (env: Record<string, string | undefined> | undefined) => Record<string, string>): unknown[] {
  const out = [...args]
  const first = out[0]
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    const o = first as { env?: Record<string, string | undefined> }
    out[0] = { ...o, env: decide(o.env) }
  } else {
    const o = (out[1] && typeof out[1] === 'object' ? out[1] : {}) as { env?: Record<string, string | undefined> }
    out[1] = { ...o, env: decide(o.env) }
  }
  return out
}

let started: Record<string, string> | null = null
let dropped: readonly string[] = []

/** The environment this process STARTED with — what a spawn without `env` has always passed. */
function startedEnv(): Record<string, string> {
  if (started) return started
  try { started = parseEnviron(readFileSync('/proc/self/environ', 'utf8')) } catch {
    // No /proc (macOS): `process.env` at the first call — the guard is installed before anything ran.
    started = withoutKeys(process.env, [])
  }
  return started
}

/** The environment for a child of this server: what it started with, minus the dropped keys, plus `extra`. */
export function spawnEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  return { ...withoutKeys(startedEnv(), dropped), ...withoutKeys(extra, dropped) }
}

let installed = false

/** Wrap every spawn function so no child inherits `keys`. Once per process; see the header. */
export function installSpawnEnvGuard(keys: readonly string[]): void {
  dropped = [...new Set([...dropped, ...keys])]
  startedEnv()
  if (installed) return
  installed = true
  const decide = (env: Record<string, string | undefined> | undefined) => env ? withoutKeys(env, dropped) : spawnEnv()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cp = require('node:child_process') as Record<ChildProcessApi, (...a: unknown[]) => unknown>
  for (const api of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync'] as const) {
    const orig = cp[api]
    if (typeof orig !== 'function') continue
    cp[api] = function (this: unknown, ...a: unknown[]) { return orig.apply(this, withChildEnv(api, a, decide)) }
  }
  const bun = Bun as unknown as Record<'spawn' | 'spawnSync', (...a: unknown[]) => unknown>
  const spawn = bun.spawn.bind(Bun), spawnSync = bun.spawnSync.bind(Bun)
  bun.spawn = (...a: unknown[]) => spawn(...withBunEnv(a, decide))
  bun.spawnSync = (...a: unknown[]) => spawnSync(...withBunEnv(a, decide))
}
