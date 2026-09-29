/**
 * commands/registry.ts — the ONE command list every surface reads (B8 spec §5.1, B8.5).
 *
 * `buildCommandRegistry` merges the built-ins (`builtins.ts`) with the custom commands the
 * catalogue resolved, and every surface asks the same three questions of the result:
 *
 * - `commandMenu` — what the palette / `/` popup / `/help` shows. An inapplicable command stays in
 *   the list with the sentence WHY (TUI spec GL-03); it never vanishes.
 * - `resolveCommandInput` — what a typed line means: a built-in with TYPED arguments, a custom
 *   command to expand, plain text, or a refusal in words.
 * - `expandCustomCommand` — a custom command's template turned into ONE user message.
 *
 * ## Precedence is not re-derived here
 *
 * The caller hands over the catalogue's IN-FORCE command entries (B8.1 `resolveCatalogue`, which
 * already refused a project command named like a built-in and required `override: true` from a
 * user one — §3.5 rule 3). This module trusts that and only re-checks eligibility, so a caller
 * that forgot to filter cannot put a disabled entry on the menu. A user command that won over a
 * built-in carries `shadows: { scope: 'builtin' }` and REPLACES it in the list, saying so.
 *
 * ## A custom command is TEXT, and only text (§5.1)
 *
 * - `$ARGUMENTS` and `$1…$9` are substituted in ONE pass over the TEMPLATE. An argument is never
 *   re-scanned, so an argument containing `$1` or `@x` is literal text, never a second expansion.
 * - Arguments are tokenised like a person reads them (whitespace, `"…"`, `'…'`) and nothing else:
 *   no variable, glob, `$(…)` or backtick is interpreted. Nothing here or downstream runs a shell.
 * - An `!` in a template is literal text. Claude Code's command files can run `!`bash`` lines on
 *   expansion; here there is no such path at all.
 * - `@path` in the TEMPLATE is a file reference. The runtime reads no files (D23), so expansion is
 *   two-phase: `commandFileRefs` names them, the HOST resolves each through the policy's read
 *   rules, and `expandCustomCommand` inlines the text — or refuses the whole expansion in words.
 *   Half a message is never sent.
 *
 * ## An untrusted project's command loads, and nothing in it that widens applies (§4)
 *
 * The template is text the model reads, so it loads. Its `agent` (a profile that may widen) and its
 * `model` (which paid model a person's key is billed against) are power: from an UNTRUSTED project
 * both are ignored, each with its sentence, and the command runs under the session's own.
 *
 * PURE.
 */

import { CATALOGUE_NAME, type CatalogueEntry, type CatalogueScope, type CommandDef } from '../catalogue/types.ts'
import { BUILTIN_COMMANDS, type BuiltinCommand, type BuiltinHandlerId, type CommandParam, type CommandSurface } from './builtins.ts'

export interface CommandSentence { en: string; pt: string }

/** One row of the registry. */
export type RegistryCommand =
  | {
      kind: 'builtin'
      name: string
      builtin: BuiltinCommand
    }
  | {
      kind: 'custom'
      name: string
      scope: Exclude<CatalogueScope, 'builtin'>
      /** The file it came from (a label for `/catalogue` and `/help`). */
      path?: string
      description: string
      /** The frontmatter's one-line hint of the arguments. */
      args?: string
      template: string
      /** Present only when it applies (an untrusted project's is dropped, see `ignored`). */
      agent?: string
      model?: string
      /** The built-in this user command replaced by `override: true` — said, never silent. */
      overridesBuiltin: boolean
      /** Parts of the command that do not apply, each in words. */
      ignored: CommandSentence[]
      invokableBy: 'person'
    }

export interface CommandRegistry {
  /** Sorted: built-ins in their declared order first, then custom commands by name. */
  commands: RegistryCommand[]
}

export interface RegistryOptions {
  /** Whether the project scope is trusted (B8.3). Absent reads as untrusted. */
  projectTrusted?: boolean
}

function eligible(e: CatalogueEntry): boolean {
  return e.enabled && e.problems.length === 0
}

export function buildCommandRegistry(entries: readonly CatalogueEntry[], opts: RegistryOptions = {}): CommandRegistry {
  const trusted = opts.projectTrusted === true
  const custom = new Map<string, Extract<RegistryCommand, { kind: 'custom' }>>()
  for (const e of entries) {
    if (e.kind !== 'command' || e.scope === 'builtin' || !eligible(e) || !CATALOGUE_NAME.test(e.name)) continue
    const def = e.def as CommandDef | undefined
    if (!def) continue
    const isBuiltinName = BUILTIN_COMMANDS.some(c => c.name === e.name)
    // Belt and braces for §3.5 rule 3: only a user command with `override: true` may hold a
    // built-in's name, whatever the caller forgot to filter.
    if (isBuiltinName && !(e.scope === 'user' && def.override === true)) continue
    if (custom.has(e.name)) continue
    const ignored: CommandSentence[] = []
    const row: Extract<RegistryCommand, { kind: 'custom' }> = {
      kind: 'custom',
      name: e.name,
      scope: e.scope,
      description: def.description,
      template: def.template,
      overridesBuiltin: isBuiltinName,
      ignored,
      invokableBy: 'person',
    }
    if (e.source.path !== undefined) row.path = e.source.path
    if (def.args !== undefined) row.args = def.args
    const untrustedProject = e.scope === 'project' && !trusted
    if (def.agent !== undefined) {
      if (untrustedProject) {
        ignored.push({
          en: `/${e.name} names the agent profile "${def.agent}", which needs trust in this project; it runs under the session's own profile.`,
          pt: `/${e.name} indica o perfil de agente "${def.agent}", que precisa de confiança neste projeto; ele roda sob o perfil da própria sessão.`,
        })
      } else row.agent = def.agent
    }
    if (def.model !== undefined) {
      if (untrustedProject) {
        ignored.push({
          en: `/${e.name} names the model "${def.model}", which needs trust in this project; it runs on the session's model.`,
          pt: `/${e.name} indica o modelo "${def.model}", que precisa de confiança neste projeto; ele roda no modelo da sessão.`,
        })
      } else row.model = def.model
    }
    custom.set(e.name, row)
  }

  const commands: RegistryCommand[] = []
  for (const c of BUILTIN_COMMANDS) {
    const over = custom.get(c.name)
    if (over) {
      commands.push(over)
      custom.delete(c.name)
    } else commands.push({ kind: 'builtin', name: c.name, builtin: c })
  }
  for (const name of [...custom.keys()].sort()) commands.push(custom.get(name)!)
  return { commands }
}

// ── The menu ────────────────────────────────────────────────────────────────────────────────────

export interface CommandContext {
  surface: CommandSurface
  /** A turn is running right now. */
  running: boolean
}

export interface MenuItem {
  name: string
  kind: 'builtin' | 'custom'
  /** `builtin`, or the custom command's scope. */
  source: CatalogueScope
  en: string
  pt: string
  /** The argument hint, e.g. `[session]` or the custom command's `args`. */
  args?: string
  available: boolean
  /** Why it cannot run here, when `available` is false. */
  why?: CommandSentence
  /** Set when a user command replaced the built-in of this name. */
  overridesBuiltin?: boolean
  /** Parts that do not apply (an untrusted project's agent/model). */
  ignored?: CommandSentence[]
}

function paramHint(params: readonly CommandParam[]): string | undefined {
  if (params.length === 0) return undefined
  return params.map(p => {
    const inner = p.type === 'enum' ? p.values.join('|') : p.name
    return p.required ? `<${inner}>` : `[${inner}]`
  }).join(' ')
}

/** Why this command cannot run in this context, or null when it can. */
export function commandUnavailable(cmd: RegistryCommand, ctx: CommandContext): CommandSentence | null {
  if (cmd.kind === 'custom') {
    return ctx.running
      ? { en: `/${cmd.name} sends a message; wait for the turn to end.`, pt: `/${cmd.name} envia uma mensagem; espere o turno terminar.` }
      : null
  }
  const a = cmd.builtin.availability
  if (!a.surfaces.includes(ctx.surface)) {
    return ctx.surface === 'web'
      ? { en: `/${cmd.name} works only in the terminal.`, pt: `/${cmd.name} só funciona no terminal.` }
      : { en: `/${cmd.name} works only in the web composer.`, pt: `/${cmd.name} só funciona no compositor web.` }
  }
  if (a.idleOnly && ctx.running) {
    return { en: `/${cmd.name} cannot run during a turn; wait for it to end or interrupt it.`, pt: `/${cmd.name} não pode rodar durante um turno; espere ele terminar ou interrompa-o.` }
  }
  return null
}

/**
 * What a surface lists. `query` filters by name prefix (with or without the leading `/`); an
 * inapplicable command is KEPT, marked unavailable with its reason.
 */
export function commandMenu(reg: CommandRegistry, ctx: CommandContext, query = ''): MenuItem[] {
  const q = query.trim().replace(/^\//, '').toLowerCase()
  const out: MenuItem[] = []
  for (const cmd of reg.commands) {
    if (q !== '' && !cmd.name.startsWith(q)) continue
    const why = commandUnavailable(cmd, ctx)
    let item: MenuItem
    if (cmd.kind === 'builtin') {
      item = { name: cmd.name, kind: 'builtin', source: 'builtin', en: cmd.builtin.en, pt: cmd.builtin.pt, available: why === null }
      const hint = paramHint(cmd.builtin.params)
      if (hint !== undefined) item.args = hint
    } else {
      item = { name: cmd.name, kind: 'custom', source: cmd.scope, en: cmd.description, pt: cmd.description, available: why === null }
      if (cmd.args !== undefined) item.args = cmd.args
      if (cmd.overridesBuiltin) item.overridesBuiltin = true
      if (cmd.ignored.length > 0) item.ignored = [...cmd.ignored]
    }
    if (why) item.why = why
    out.push(item)
  }
  return out
}

// ── Reading a typed line ────────────────────────────────────────────────────────────────────────

/** Arguments as a person typed them: the raw text and its quote-aware tokens. */
export interface CommandArgs {
  raw: string
  tokens: string[]
}

/**
 * Splits on whitespace, honouring `"…"` and `'…'` (a backslash escapes the next character inside
 * double quotes only). NOTHING else is interpreted: `$VAR`, `*`, `$(…)`, backticks stay literal.
 */
export function tokenizeArgs(raw: string): { ok: true; tokens: string[] } | { ok: false; why: CommandSentence } {
  const tokens: string[] = []
  let cur = ''
  let inTok = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (quote) {
      if (ch === quote) { quote = null; continue }
      if (quote === '"' && ch === '\\' && i + 1 < raw.length) { cur += raw[++i]!; continue }
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; inTok = true; continue }
    if (/\s/.test(ch)) {
      if (inTok) { tokens.push(cur); cur = ''; inTok = false }
      continue
    }
    cur += ch
    inTok = true
  }
  if (quote) {
    return { ok: false, why: { en: `a ${quote} quote is not closed.`, pt: `uma aspa ${quote} não foi fechada.` } }
  }
  if (inTok) tokens.push(cur)
  return { ok: true, tokens }
}

export type TypedArgs = Record<string, string>

export type CommandInput =
  /** Not a command: send the text as a message (a `//` prefix sends one literal `/`). */
  | { kind: 'text'; text: string }
  | { kind: 'builtin'; command: BuiltinCommand; handlerId: BuiltinHandlerId; args: TypedArgs }
  | { kind: 'custom'; command: Extract<RegistryCommand, { kind: 'custom' }>; args: CommandArgs; refs: string[] }
  | { kind: 'refused'; why: CommandSentence }

function typedArgs(cmd: BuiltinCommand, tokens: readonly string[]): { ok: true; args: TypedArgs } | { ok: false; why: CommandSentence } {
  const args: TypedArgs = {}
  if (tokens.length > cmd.params.length) {
    const hint = paramHint(cmd.params)
    return {
      ok: false,
      why: hint === undefined
        ? { en: `/${cmd.name} takes no arguments.`, pt: `/${cmd.name} não recebe argumentos.` }
        : { en: `/${cmd.name} takes at most ${cmd.params.length}: /${cmd.name} ${hint}.`, pt: `/${cmd.name} recebe no máximo ${cmd.params.length}: /${cmd.name} ${hint}.` },
    }
  }
  for (let i = 0; i < cmd.params.length; i++) {
    const p = cmd.params[i]!
    const v = tokens[i]
    if (v === undefined) {
      if (p.required) return { ok: false, why: { en: `/${cmd.name} needs <${p.name}>: ${p.en}.`, pt: `/${cmd.name} precisa de <${p.name}>: ${p.pt}.` } }
      continue
    }
    if (p.type === 'enum' && !p.values.includes(v)) {
      return { ok: false, why: { en: `"${v}" is not one of: ${p.values.join(', ')}.`, pt: `"${v}" não é um de: ${p.values.join(', ')}.` } }
    }
    args[p.name] = v
  }
  return { ok: true, args }
}

/**
 * What a typed line means. A line that does not start with `/` is text. `//x` is the literal text
 * `/x`. `/name args`: the registry is asked; an unknown name is REFUSED in words (never sent to
 * the model as if it were a question), and so is a command unavailable in this context.
 */
export function resolveCommandInput(reg: CommandRegistry, line: string, ctx: CommandContext): CommandInput {
  const text = line.trim()
  if (!text.startsWith('/')) return { kind: 'text', text }
  if (text.startsWith('//')) return { kind: 'text', text: text.slice(1) }
  const m = /^\/(\S*)(?:\s+([\s\S]*))?$/.exec(text)
  const name = (m?.[1] ?? '').toLowerCase()
  const raw = (m?.[2] ?? '').trim()
  const cmd = reg.commands.find(c => c.name === name)
  if (!cmd) {
    return {
      kind: 'refused',
      why: {
        en: `there is no /${name} command; /help lists them. To send text that starts with "/", begin it with "//".`,
        pt: `não existe o comando /${name}; /help lista os comandos. Para enviar um texto que começa com "/", comece-o com "//".`,
      },
    }
  }
  const why = commandUnavailable(cmd, ctx)
  if (why) return { kind: 'refused', why }
  const tok = tokenizeArgs(raw)
  if (!tok.ok) return { kind: 'refused', why: { en: `/${name}: ${tok.why.en}`, pt: `/${name}: ${tok.why.pt}` } }
  if (cmd.kind === 'builtin') {
    const t = typedArgs(cmd.builtin, tok.tokens)
    if (!t.ok) return { kind: 'refused', why: t.why }
    return { kind: 'builtin', command: cmd.builtin, handlerId: cmd.builtin.handlerId, args: t.args }
  }
  return { kind: 'custom', command: cmd, args: { raw, tokens: tok.tokens }, refs: commandFileRefs(cmd.template) }
}

// ── Expanding a custom command ──────────────────────────────────────────────────────────────────

/** `$ARGUMENTS`, `$1`…`$9`, or `@path` preceded by the start or whitespace. */
const EXPANSION = /\$(ARGUMENTS|[1-9])|(^|(?<=\s))@([^\s]+)/g

/** The `@path` references in a TEMPLATE, in order, deduplicated. Arguments are never scanned. */
export function commandFileRefs(template: string): string[] {
  const out: string[] = []
  for (const m of template.matchAll(EXPANSION)) {
    const p = m[3]
    if (p !== undefined && !out.includes(p)) out.push(p)
  }
  return out
}

/** How the host answered one `@path`: its text, or why it may not be read. */
export type FileRefResolution = { ok: true; text: string } | { ok: false; why: CommandSentence }

/**
 * The template as ONE user message. `resolved` must answer every ref `commandFileRefs` named; a
 * missing or refused one refuses the whole expansion (never half a message).
 */
export function expandCustomCommand(
  cmd: Extract<RegistryCommand, { kind: 'custom' }>,
  args: CommandArgs,
  resolved: ReadonlyMap<string, FileRefResolution> = new Map(),
): { ok: true; text: string } | { ok: false; why: CommandSentence } {
  for (const ref of commandFileRefs(cmd.template)) {
    const r = resolved.get(ref)
    if (!r) return { ok: false, why: { en: `/${cmd.name}: @${ref} was not resolved; nothing was sent.`, pt: `/${cmd.name}: @${ref} não foi resolvido; nada foi enviado.` } }
    if (!r.ok) return { ok: false, why: { en: `/${cmd.name}: @${ref}: ${r.why.en} Nothing was sent.`, pt: `/${cmd.name}: @${ref}: ${r.why.pt} Nada foi enviado.` } }
  }
  const text = cmd.template.replace(EXPANSION, (_all, arg: string | undefined, _lead: string | undefined, ref: string | undefined) => {
    if (arg === 'ARGUMENTS') return args.raw
    if (arg !== undefined) return args.tokens[Number(arg) - 1] ?? ''
    const r = resolved.get(ref!) as { ok: true; text: string }
    return `@${ref}\n\`\`\`\n${r.text.replace(/\n$/, '')}\n\`\`\`\n`
  })
  return { ok: true, text: text.trim() }
}
