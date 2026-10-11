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
  let changed = false
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
        // The shared briefing teaches every harness the safe form. Claude's hook sees that form too;
        // leave the reference alone when it is already the argument of `vault ref`.
        if (/vault ref '\s*$/.test(command.slice(0, i))) {
          out += hit[0]
          i += hit[0].length
          continue
        }
        const sub = call(hit[0])
        out += quote === '"' ? sub : quote === "'" ? `'"${sub}"'` : `"${sub}"`
        changed = true
        i += hit[0].length
        continue
      }
    }
    out += c
    i++
  }
  return changed ? out : null
}

/** The PostToolUse answer, or null when nothing was scrubbed (the hook then prints nothing at all). */
export function postToolAnswer(original: unknown, scrubbedJson: string, changed: boolean): string | null {
  if (!changed) return null
  let updated: unknown
  try { updated = typeof original === 'string' ? JSON.parse(scrubbedJson) as string : JSON.parse(scrubbedJson) } catch { return null }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: updated } })
}

/** The PostToolUse answer that withholds the whole output (the vault refused or could not be asked). */
export function withheldAnswer(): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: '«output held back by the vault»' } })
}

/** The PreToolUse answer for a rewritten Bash command (the rest of the input untouched). */
export function preToolAnswer(toolInput: Record<string, unknown>, command: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...toolInput, command } } })
}

/** The hook's own deadline for the vault's answer: under `timeoutSec` (5 s, claude-hooks.ts), so a slow server lands in the fail-closed branch instead of the hook being killed with the output raw. */
export const HOOK_ASK_TIMEOUT_MS = 3_000

export interface ScrubReply { ok?: boolean; changed?: boolean; text?: string }

/**
 * PostToolUse decision (§3.11-B). `reply` is the vault's answer (undefined = socket down, timeout, error);
 * `hadGrant` = this session was EVER granted something (a marker written at grant time). The output is
 * withheld whenever the vault cannot vouch for it — except for a session that never had a grant: there is
 * nothing in its output to leak, and withholding would blind every managed session while the server is down.
 */
export function postToolDecision(original: unknown, reply: ScrubReply | undefined, hadGrant: boolean): string | null {
  if (reply?.ok && typeof reply.text === 'string') {
    return postToolAnswer(original, reply.text, reply.changed === true) ?? (reply.changed === true ? withheldAnswer() : null)
  }
  return hadGrant ? withheldAnswer() : null
}

/** Marker file name for a session's grant history (no value inside; the id is already `[A-Za-z0-9_:-]{1,80}`). */
export const grantMarkerName = (sessionId: string): string => `grant-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}`
