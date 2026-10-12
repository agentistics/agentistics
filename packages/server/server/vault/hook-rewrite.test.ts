import { describe, expect, test } from 'bun:test'
import { HOOK_ASK_TIMEOUT_MS, postToolDecision, postToolAnswer, preToolAnswer, rewriteVaultRefs } from './hook-rewrite'

const G = ['vault://gh', 'vault://banco/password']
const run = (cmd: string) => rewriteVaultRefs(cmd, G, 'agentop')
/** What bash would see after the substitution, with the call replaced by a stand-in value with a space. */
const expand = (cmd: string) => {
  const r = Bun.spawnSync(['bash', '-c', `agentop() { [ "$1 $2" = "vault ref" ] && printf 'VALUE WITH SPACE'; }; ${cmd}`])
  return r.stdout.toString()
}

describe('PreToolUse rewrite — the command keeps the reference, never the value', () => {
  test('unquoted, double-quoted and single-quoted references all expand to the value at run time', () => {
    expect(expand(run('printf "%s|" vault://gh')!)).toBe('VALUE WITH SPACE|')
    expect(expand(run('printf "%s|" "Bearer vault://gh"')!)).toBe('Bearer VALUE WITH SPACE|')
    expect(expand(run("printf '%s|' 'Bearer vault://gh'")!)).toBe('Bearer VALUE WITH SPACE|')
    expect(expand(run('printf "%s|" vault://banco/password')!)).toBe('VALUE WITH SPACE|')
  })
  test('a reference not granted is left as written; no reference → null', () => {
    expect(run('echo vault://other')).toBeNull()
    expect(run('echo hello')).toBeNull()
    expect(run('echo vault://gh vault://other')).toContain('vault://other')
  })
  test('the rewritten text holds the call, not a value', () => {
    expect(run('curl -H "Authorization: Bearer vault://gh" x')).toBe(`curl -H "Authorization: Bearer $(agentop vault ref 'vault://gh')" x`)
  })
  test('does not wrap a reference already inside a vault ref call', () => {
    const command = "printf %s \"$(agentop vault ref 'vault://gh')\""
    expect(run(command)).toBeNull()
  })
  test('rewrites only the bare reference in a mixed command', () => {
    const command = "printf '%s %s' \"$(agentop vault ref 'vault://gh')\" vault://banco/password"
    expect(run(command)).toBe("printf '%s %s' \"$(agentop vault ref 'vault://gh')\" \"$(agentop vault ref 'vault://banco/password')\"")
  })
  test('answers', () => {
    expect(JSON.parse(preToolAnswer({ command: 'a', description: 'd' }, 'b'))).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'b', description: 'd' } } })
    expect(postToolAnswer({ stdout: 'x' }, '{"stdout":"«vault:gh»"}', true)).toContain('updatedToolOutput')
    expect(postToolAnswer({ stdout: 'x' }, '{"stdout":"x"}', false)).toBeNull()
  })
})

describe('PostToolUse decision (§3.11-B)', () => {
  const orig = { stdout: 'key=sk-SECRET' }
  test('socket down / timeout / error: withheld with a grant, passes without one', () => {
    expect(postToolDecision(orig, undefined, true)).toContain('held back by the vault')
    expect(postToolDecision(orig, undefined, false)).toBeNull()
    expect(postToolDecision(orig, { ok: false }, true)).toContain('held back')
    expect(postToolDecision(orig, { ok: false }, false)).toBeNull()
  })
  test('the vault answered: scrubbed output, untouched output, or an unparsable changed one withheld', () => {
    expect(postToolDecision(orig, { ok: true, changed: true, text: '{"stdout":"«vault:x»"}' }, true)).toContain('«vault:x»')
    expect(postToolDecision(orig, { ok: true, changed: false, text: JSON.stringify(orig) }, true)).toBeNull()
    expect(postToolDecision(orig, { ok: true, changed: true, text: 'not json' }, true)).toContain('held back')
  })
  test('the limit sentence (ok, changed) replaces the whole output', () => {
    const a = postToolDecision(orig, { ok: true, changed: true, text: JSON.stringify('«output held back by the vault: limit»') }, true)
    expect(a).toContain('limit')
    expect(a).not.toContain('SECRET')
  })
  test('the hook asks for less than its own 5 s timeout', () => {
    expect(HOOK_ASK_TIMEOUT_MS).toBeLessThan(5_000)
  })
})
