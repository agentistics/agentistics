/**
 * agent-env.testing.ts — TEST SUPPORT. A spawn-door test (`start`, `batch`, `runSession`, `session open`) must not depend on
 * the shell it runs in. Inside a managed session the shell carries `AGENTOP_MANAGED_ID` (the caller's identity),
 * `AGENTISTICS_FLOWS`, `AGENTISTICS_ADAPTER_CHAT`, `AGENTISTICS_EXPERIMENTAL_APPLIED` and the other feature switches, and the doors
 * read every one of them: a test written on a bare shell then fails for whoever runs it from a session.
 *
 * `isolateAgentEnv(define?)` registers a `beforeEach`/`afterEach` pair for the file: before each test every `AGENTOP_*` and
 * `AGENTISTICS_*` variable the test does not define is removed; after it, the environment is put back exactly as it was
 * (variables the test added are removed, the ones it changed or the helper cleared are restored). `define` is what the
 * file sets itself — applied after the clearing, so a hook order never loses it.
 *
 * Kept, never cleared: names ending `_DIR` or `_FILE`. They are data locations, and the test runtime exports its own isolated
 * one into the environment (`config.ts` writes `AGENTISTICS_DIR` under `bun test`); clearing it would point a test at the
 * owner's real store.
 */
import { afterEach, beforeEach } from 'bun:test'

const AGENT_VAR = /^(AGENTOP_|AGENTISTICS_)/
const LOCATION = /(_DIR|_FILE)$/

export const isAgentVar = (name: string): boolean => AGENT_VAR.test(name)
export const isClearedByIsolation = (name: string): boolean => isAgentVar(name) && !LOCATION.test(name)

/** Every `AGENTOP_*` / `AGENTISTICS_*` variable right now (what `restore` puts back). */
export function snapshotAgentEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (isAgentVar(k) && v !== undefined) out[k] = v
  return out
}

/** Clear what the test does not define, apply what it does; returns the function that restores the snapshot exactly. */
export function isolate(define: Readonly<Record<string, string | undefined>> = {}, env: NodeJS.ProcessEnv = process.env): () => void {
  const before = snapshotAgentEnv(env)
  for (const k of Object.keys(before)) if (isClearedByIsolation(k)) delete env[k]
  for (const [k, v] of Object.entries(define)) { if (v === undefined) delete env[k]; else env[k] = v }
  return () => {
    for (const k of Object.keys(env)) if (isAgentVar(k) && !(k in before)) delete env[k]
    for (const [k, v] of Object.entries(before)) env[k] = v
  }
}

export function isolateAgentEnv(define: Readonly<Record<string, string | undefined>> = {}): void {
  let restore: (() => void) | null = null
  beforeEach(() => { restore = isolate(define) })
  afterEach(() => { restore?.(); restore = null })
}
