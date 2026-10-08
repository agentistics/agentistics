import { describe, expect, test } from 'bun:test'
import { postToolAnswer, preToolAnswer, rewriteVaultRefs } from './hook-rewrite'

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
