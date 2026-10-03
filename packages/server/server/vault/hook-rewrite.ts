/**
 * vault/hook-rewrite.ts — PURE. What the Claude Code hooks do to a tool call of a granted session
 * (VAULT.PERSONAL §8.3).
 *
 * PreToolUse: each GRANTED `vault://key[/field]` in a Bash command becomes a command substitution that
 * asks the service for the value AT THE MOMENT THE COMMAND RUNS — `$(agentop vault ref 'vault://key')`.
 * The command the transcript records holds the reference and that call, never the value. Quoting is
 * respected: inside double quotes the substitution goes in bare (it is already quoted), outside any
 * quotes it is wrapped in double quotes (no word splitting of a value with spaces), and inside single
 * quotes — where nothing expands — the single-quoted string is closed around it. A reference that was
 * NOT granted is left exactly as written (the command then fails visibly rather than half-working).
 */
import { findVaultRefs, VAULT_REF } from '@agentistics/vault'

export function rewriteVaultRefs(command: string, granted: readonly string[], invocation: string): string | null {
  if (!command.includes('vault://')) return null
  const refs = findVaultRefs(command).filter(r => granted.includes(r.raw))
  if (refs.length === 0) return null
  const call = (raw: string) => `$(${invocation} vault ref '${raw}')`
  let out = ''
  let quote: '"' | "'" | null = null
  let i = 0
  VAULT_REF.lastIndex = 0
  while (i < command.length) {
    const c = command[i]!
    if (quote === null && c === '\\') { out += command.slice(i, i + 2); i += 2; continue }
    if (quote === '"' && c === '\\') { out += command.slice(i, i + 2); i += 2; continue }
    if (c === '"' && quote !== "'") { quote = quote === '"' ? null : '"'; out += c; i++; continue }
    if (c === "'" && quote !== '"') { quote = quote === "'" ? null : "'"; out += c; i++; continue }
    if (command.startsWith('vault://', i)) {
      const m = new RegExp(VAULT_REF.source, 'y')
      m.lastIndex = i
      const hit = m.exec(command)
      if (hit && granted.includes(hit[0])) {
        const sub = call(hit[0])
        out += quote === '"' ? sub : quote === "'" ? `'"${sub}"'` : `"${sub}"`
        i += hit[0].length
        continue
      }
    }
    out += c
    i++
  }
  return out
}

/** The PostToolUse answer, or null when nothing was scrubbed (the hook then prints nothing at all). */
export function postToolAnswer(original: unknown, scrubbedJson: string, changed: boolean): string | null {
  if (!changed) return null
  let updated: unknown
  try { updated = typeof original === 'string' ? JSON.parse(scrubbedJson) as string : JSON.parse(scrubbedJson) } catch { return null }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: updated } })
}

/** The PreToolUse answer for a rewritten Bash command (the rest of the input untouched). */
export function preToolAnswer(toolInput: Record<string, unknown>, command: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...toolInput, command } } })
}
