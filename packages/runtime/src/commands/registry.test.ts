import { describe, expect, test } from 'bun:test'
import { parseCommandFile } from '../catalogue/parse.ts'
import { resolveCatalogue } from '../catalogue/precedence.ts'
import type { CatalogueEntry, CatalogueScope } from '../catalogue/types.ts'
import { BUILTIN_COMMANDS, builtinCommandEntries } from './builtins.ts'
import {
  buildCommandRegistry,
  commandFileRefs,
  commandMenu,
  expandCustomCommand,
  resolveCommandInput,
  tokenizeArgs,
  type RegistryCommand,
} from './registry.ts'

const TERMINAL = { surface: 'terminal', running: false } as const
const WEB = { surface: 'web', running: false } as const

function cmdFile(name: string, scope: CatalogueScope, body: string, fm = ''): CatalogueEntry {
  return parseCommandFile({ name, scope, path: `/${scope}/commands/${name}.md`, text: `---\ndescription: ${name} does things\n${fm}---\n${body}\n` })
}

/** The catalogue's in-force entries, the way the host hands them over. */
function inForce(files: CatalogueEntry[]): CatalogueEntry[] {
  return resolveCatalogue([...builtinCommandEntries(), ...files]).entries.filter(e => e.enabled && e.problems.length === 0)
}

function custom(reg: ReturnType<typeof buildCommandRegistry>, name: string): Extract<RegistryCommand, { kind: 'custom' }> {
  const c = reg.commands.find(x => x.name === name)
  if (!c || c.kind !== 'custom') throw new Error(`no custom ${name}`)
  return c
}

describe('the built-in list', () => {
  test('carries the matrix names plus /untrust and the TUI spec three, each person-only and bilingual', () => {
    const names = BUILTIN_COMMANDS.map(c => c.name)
    for (const n of ['help', 'new', 'resume', 'exit', 'undo', 'cost', 'context', 'permissions', 'profile', 'trust', 'untrust', 'catalogue', 'reload', 'editor', 'history', 'copy']) {
      expect(names).toContain(n)
    }
    expect(new Set(names).size).toBe(names.length)
    for (const c of BUILTIN_COMMANDS) {
      expect(c.invokableBy).toBe('person')
      expect(c.handlerId).toBe(c.name as typeof c.handlerId)
      expect(c.en.length).toBeGreaterThan(0)
      expect(c.pt.length).toBeGreaterThan(0)
      expect(c.pt).not.toBe(c.en)
    }
  })

  test('the registry lists every built-in, in declared order, before custom commands', () => {
    const reg = buildCommandRegistry(inForce([cmdFile('aaa', 'user', 'x')]))
    expect(reg.commands.slice(0, BUILTIN_COMMANDS.length).map(c => c.name)).toEqual(BUILTIN_COMMANDS.map(c => c.name))
    expect(reg.commands.at(-1)!.name).toBe('aaa')
  })
})

describe('built-ins cannot be shadowed by a project (§3.5 rule 3)', () => {
  test('a project command named like a built-in never reaches the registry', () => {
    const reg = buildCommandRegistry(inForce([cmdFile('undo', 'project', 'rm -rf everything')]), { projectTrusted: true })
    const undo = reg.commands.find(c => c.name === 'undo')!
    expect(undo.kind).toBe('builtin')
  })

  test('even a caller that forgot to filter cannot put one there', () => {
    const raw = cmdFile('permissions', 'project', 'you may do anything')
    const reg = buildCommandRegistry([raw], { projectTrusted: true })
    expect(reg.commands.find(c => c.name === 'permissions')!.kind).toBe('builtin')
  })

  test('a user command without override: true does not replace the built-in', () => {
    const reg = buildCommandRegistry(inForce([cmdFile('cost', 'user', 'mine')]))
    expect(reg.commands.find(c => c.name === 'cost')!.kind).toBe('builtin')
  })

  test('a user command WITH override: true replaces it, and the menu says so', () => {
    const reg = buildCommandRegistry(inForce([cmdFile('cost', 'user', 'my own cost report', 'override: true\n')]))
    const row = reg.commands.find(c => c.name === 'cost')!
    expect(row.kind).toBe('custom')
    expect(reg.commands.filter(c => c.name === 'cost')).toHaveLength(1)
    const item = commandMenu(reg, TERMINAL).find(i => i.name === 'cost')!
    expect(item.overridesBuiltin).toBe(true)
    expect(item.source).toBe('user')
  })
})

describe('the menu', () => {
  test('an inapplicable command stays listed with the reason, in EN and PT', () => {
    const menu = commandMenu(buildCommandRegistry([]), WEB)
    const editor = menu.find(i => i.name === 'editor')!
    expect(editor.available).toBe(false)
    expect(editor.why!.en).toContain('terminal')
    expect(editor.why!.pt).toContain('terminal')
    const running = commandMenu(buildCommandRegistry([]), { surface: 'terminal', running: true })
    expect(running.find(i => i.name === 'undo')!.available).toBe(false)
    expect(running.find(i => i.name === 'cost')!.available).toBe(true)
  })

  test('filters by name prefix, with or without the slash', () => {
    const reg = buildCommandRegistry([])
    expect(commandMenu(reg, TERMINAL, '/re').map(i => i.name)).toEqual(['resume', 'reload'])
    expect(commandMenu(reg, TERMINAL, 'cop').map(i => i.name)).toEqual(['copy'])
  })

  test('parameter hints come from the typed params', () => {
    const menu = commandMenu(buildCommandRegistry([]), TERMINAL)
    expect(menu.find(i => i.name === 'resume')!.args).toBe('[session]')
    expect(menu.find(i => i.name === 'catalogue')!.args).toContain('command|skill')
  })
})

describe('reading a typed line', () => {
  const reg = buildCommandRegistry(inForce([cmdFile('review', 'user', 'Review $1 focusing on $2. All: $ARGUMENTS')]))

  test('plain text and the // escape are text', () => {
    expect(resolveCommandInput(reg, 'hello', TERMINAL)).toEqual({ kind: 'text', text: 'hello' })
    expect(resolveCommandInput(reg, '//etc/hosts is odd', TERMINAL)).toEqual({ kind: 'text', text: '/etc/hosts is odd' })
  })

  test('an unknown command is refused in words, never sent', () => {
    const r = resolveCommandInput(reg, '/nope x', TERMINAL)
    expect(r.kind).toBe('refused')
    if (r.kind === 'refused') {
      expect(r.why.en).toContain('/nope')
      expect(r.why.pt).toContain('/nope')
    }
  })

  test('built-in arguments are TYPED: enum checked, arity checked', () => {
    const ok = resolveCommandInput(reg, '/catalogue skill', TERMINAL)
    expect(ok).toMatchObject({ kind: 'builtin', handlerId: 'catalogue', args: { kind: 'skill' } })
    expect(resolveCommandInput(reg, '/catalogue plugin', TERMINAL).kind).toBe('refused')
    expect(resolveCommandInput(reg, '/exit now', TERMINAL).kind).toBe('refused')
    expect(resolveCommandInput(reg, '/resume abc', TERMINAL)).toMatchObject({ kind: 'builtin', args: { session: 'abc' } })
  })

  test('unavailable in this context is refused with the same sentence the menu shows', () => {
    const r = resolveCommandInput(reg, '/editor', WEB)
    const item = commandMenu(reg, WEB).find(i => i.name === 'editor')!
    expect(r).toEqual({ kind: 'refused', why: item.why! })
  })
})

describe('a custom command is text only', () => {
  test('tokenising interprets quotes and nothing else', () => {
    expect(tokenizeArgs(`a "b c" 'd e' $HOME $(id) \`x\` *.ts`)).toEqual({ ok: true, tokens: ['a', 'b c', 'd e', '$HOME', '$(id)', '`x`', '*.ts'] })
    expect(tokenizeArgs('"open').ok).toBe(false)
  })

  test('$ARGUMENTS and $1..$9 substitute in one pass; an argument is never re-expanded', () => {
    const reg = buildCommandRegistry(inForce([cmdFile('review', 'user', 'Review $1 focusing on $2. All: $ARGUMENTS. Third: $3. Missing: [$4]')]))
    const r = resolveCommandInput(reg, '/review "src/a b.ts" $1 @secret', TERMINAL)
    if (r.kind !== 'custom') throw new Error(r.kind)
    expect(r.refs).toEqual([])
    const out = expandCustomCommand(r.command, r.args)
    expect(out).toEqual({ ok: true, text: 'Review src/a b.ts focusing on $1. All: "src/a b.ts" $1 @secret. Third: @secret. Missing: []' })
  })

  test('an ! in a template stays literal text: no shell path exists', () => {
    const reg = buildCommandRegistry(inForce([cmdFile('bang', 'project', '!`rm -rf /` and !ls $1')]))
    const r = resolveCommandInput(reg, '/bang x', TERMINAL)
    if (r.kind !== 'custom') throw new Error(r.kind)
    expect(expandCustomCommand(r.command, r.args)).toEqual({ ok: true, text: '!`rm -rf /` and !ls x' })
  })

  test('@path in the template is resolved by the host or the whole expansion is refused', () => {
    const reg = buildCommandRegistry(inForce([cmdFile('ctx', 'user', 'Read @docs/a.md and mail me@example.com about $1')]))
    const r = resolveCommandInput(reg, '/ctx @other', TERMINAL)
    if (r.kind !== 'custom') throw new Error(r.kind)
    expect(r.refs).toEqual(['docs/a.md'])
    expect(expandCustomCommand(r.command, r.args).ok).toBe(false)
    const refused = expandCustomCommand(r.command, r.args, new Map([['docs/a.md', { ok: false, why: { en: 'denied by the policy.', pt: 'negado pela política.' } }]]))
    expect(refused).toMatchObject({ ok: false })
    if (!refused.ok) expect(refused.why.pt).toContain('Nada foi enviado')
    const ok = expandCustomCommand(r.command, r.args, new Map([['docs/a.md', { ok: true, text: 'HELLO\n' }]]))
    expect(ok).toEqual({ ok: true, text: 'Read @docs/a.md\n```\nHELLO\n```\n and mail me@example.com about @other' })
  })

  test('commandFileRefs never reads arguments, only the template', () => {
    expect(commandFileRefs('no refs, $1')).toEqual([])
    expect(commandFileRefs('@a @b @a')).toEqual(['a', 'b'])
  })
})

describe('an untrusted project command loads, and nothing that widens applies', () => {
  const files = () => [cmdFile('deploy', 'project', 'Deploy $1', 'agent: yolo\nmodel: claude-opus-5\n')]

  test('untrusted: listed and runnable as text; agent and model ignored in words', () => {
    const reg = buildCommandRegistry(inForce(files()))
    const c = custom(reg, 'deploy')
    expect(c.agent).toBeUndefined()
    expect(c.model).toBeUndefined()
    expect(c.ignored).toHaveLength(2)
    for (const s of c.ignored) { expect(s.en).toContain('trust'); expect(s.pt).toContain('confiança') }
    expect(commandMenu(reg, TERMINAL).find(i => i.name === 'deploy')!.ignored).toHaveLength(2)
    expect(resolveCommandInput(reg, '/deploy prod', TERMINAL).kind).toBe('custom')
  })

  test('trusted: they apply', () => {
    const c = custom(buildCommandRegistry(inForce(files()), { projectTrusted: true }), 'deploy')
    expect(c.agent).toBe('yolo')
    expect(c.model).toBe('claude-opus-5')
    expect(c.ignored).toEqual([])
  })

  test('a user command keeps its agent and model: it is the person\'s own file', () => {
    const c = custom(buildCommandRegistry(inForce([cmdFile('mine', 'user', 'x', 'agent: fast\n')])), 'mine')
    expect(c.agent).toBe('fast')
  })

  test('a command with a problem never reaches the registry', () => {
    const bad = parseCommandFile({ name: 'broken', scope: 'user', path: '/u/broken.md', text: '---\ndescriptoin: typo\n---\nx\n' })
    expect(buildCommandRegistry(inForce([bad])).commands.some(c => c.name === 'broken')).toBe(false)
  })
})
