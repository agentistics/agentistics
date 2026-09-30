/**
 * tools/env.ts — the environment a tool's child process sees, and why the runtime never reads its
 * own.
 *
 * The shell, git and the fs candidate lister spawn processes, and a process needs an environment.
 * The runtime does NOT take it from its own process environment, for two reasons that point the same way:
 *
 * - D23: the runtime reads no host state; the HOST decides (`provider-secrets.lint.test.ts` Guard 3
 *   forbids reading the process environment anywhere in this package).
 * - The host's environment routinely holds provider API keys and tokens. A shell the MODEL drives
 *   that inherited it would hand them over to the first `env | grep KEY`. What the agent may see is
 *   a decision, so it is an explicit input.
 *
 * So every spawning tool takes an `env` from its caller, and with none it gets `MINIMAL_TOOL_ENV`: a
 * standard PATH and a UTF-8 locale, and NOTHING from the host — no HOME, no tokens. A host that wants
 * the agent to see more passes it, variable by variable or wholesale, and owns that choice.
 */

export type ToolEnv = Readonly<Record<string, string | undefined>>

export const MINIMAL_TOOL_ENV: ToolEnv = Object.freeze({
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  LANG: 'C.UTF-8',
})

/** A mutable copy holding only the defined values of `env` (default: the minimal environment). */
export function toolEnv(env: ToolEnv = MINIMAL_TOOL_ENV): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v
  return out
}
