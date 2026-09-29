/**
 * catalogue/parse.ts — the parsers: TEXT in, `CatalogueEntry` out (B8 §3.2–§3.4).
 *
 * PURE. The host hands over the file's text and a `path` LABEL; nothing here opens anything.
 *
 * ## The two rules every parser here keeps
 *
 * 1. **An entry with a problem is RETURNED, `enabled: false`, carrying its sentence with
 *    `file:line`** — never dropped. `def` is present whenever enough parsed to build one, so a
 *    surface can still show what the entry was trying to be.
 * 2. **Unknown keys are REFUSED, not ignored.** A misspelled key that is silently accepted is a
 *    setting the person believes is in force. The single deliberate exception is
 *    `COMPAT_SKILL_FOREIGN_KEYS`, and only in `compat` scope: those directories are written by
 *    OTHER harnesses, whose keys are theirs to write, not ours to refuse.
 *
 * ## Literal secrets are REFUSED, never scrubbed (§3.4, criterion 5)
 *
 * `containsSecret` (the shape side of `redactSecrets`) is used as a refusal. Nothing is rewritten,
 * and no sentence here ever echoes the value: it names the key path and says to use `{env:VAR}` or
 * a host credential id. `auth.credential` is an ID, checked on its value alone — checking it with
 * key context would flag `credential=my-docs-oauth-token`, a name, not a secret.
 *
 * ## Derived names are scope-qualified
 *
 * An unnamed `afterEdit` entry is called `${scope}-after-edit-${n}`. Qualifying by scope keeps a
 * user's `after-edit-1` and a project's from sharing a name, which precedence would otherwise
 * resolve by silently shadowing one with the other.
 */

import { containsSecret } from '@agentistics/core'
import type { PolicyRule, RuleMatch } from '../policy/rules.ts'
import type { FloorEnv } from '../policy/floor.ts'
import { frontmatterOrEmpty } from './parse-fm.ts'
import type { FmField } from './frontmatter.ts'
import { parseJsonc, pointerSegment, type JsonValue } from './jsonc.ts'
import { ruleFloorHit } from './floor-target.ts'
import { problem, withProblems } from './problems.ts'
import {
  CATALOGUE_NAME,
  initialTrust,
  type AfterEditDef,
  type AgentDef,
  type CatalogueEntry,
  type CatalogueKind,
  type CatalogueProblem,
  type CatalogueScope,
  type CatalogueSettings,
  type CommandDef,
  type McpServerDef,
  type PermissionProfileDef,
  type SkillDef,
} from './types.ts'

/** Keys other harnesses write into a SKILL.md; accepted and ignored in `compat` scope only. */
export const COMPAT_SKILL_FOREIGN_KEYS: readonly string[] = [
  'license',
  'allowed-tools',
  'metadata',
  'version',
  'model',
  'argument-hint',
  'disable-model-invocation',
  'user-invocable',
]

const POLICY_ACTIONS = ['read', 'write', 'shell', 'shell-input', 'shell-control', 'git-read', 'plan', 'ask-user'] as const

// ── small shared helpers ────────────────────────────────────────────────────────────────────────

function blank<K extends CatalogueKind>(kind: K, name: string, scope: CatalogueScope, path: string | undefined): CatalogueEntry<K> {
  return { kind, name, scope, source: path === undefined ? {} : { path }, enabled: true, trust: initialTrust(scope), problems: [] }
}

/** Dotted rendering of a JSON pointer for a sentence: `/mcpServers/db/env` -> `mcpServers.db.env`. */
function dotted(pointer: string): string {
  return pointer.split('/').filter(s => s !== '').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~')).join('.')
}

function isObj(v: JsonValue | undefined): v is { [k: string]: JsonValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Names the rules of naming, so a refusal can be fixed without reading the source. */
export function validateName(name: string, path: string, line: number): CatalogueProblem[] {
  if (CATALOGUE_NAME.test(name)) return []
  return [problem(
    'catalogue.bad-name', path, line,
    `The name "${name}" is not allowed: use 1–64 characters, lowercase letters, digits and dashes, starting with a letter or digit.`,
    `O nome "${name}" não é permitido: use de 1 a 64 caracteres, letras minúsculas, dígitos e hífens, começando por letra ou dígito.`,
  )]
}

// ── frontmatter files ───────────────────────────────────────────────────────────────────────────

interface FmRead {
  fields: Map<string, FmField>
  body: string
  bodyStartLine: number
  problems: CatalogueProblem[]
  hadFrontmatter: boolean
}

function readFm(text: string, path: string, allowed: readonly string[], ignored: readonly string[] = []): FmRead {
  const r = frontmatterOrEmpty(text)
  const problems: CatalogueProblem[] = r.errors.map(e => problem(
    'catalogue.frontmatter-syntax', path, e.line,
    `The frontmatter cannot be read: ${e.message}. Fix that line.`,
    `O frontmatter não pôde ser lido: ${e.message}. Corrija essa linha.`,
  ))
  for (const [key, f] of r.fields) {
    if (allowed.includes(key) || ignored.includes(key)) continue
    problems.push(problem(
      'catalogue.unknown-key', path, f.line,
      `Unknown key "${key}". Allowed keys: ${allowed.join(', ')}. Remove it or fix the spelling.`,
      `Chave desconhecida "${key}". Chaves permitidas: ${allowed.join(', ')}. Remova-a ou corrija a grafia.`,
    ))
  }
  return { fields: r.fields, body: r.body, bodyStartLine: r.bodyStartLine, problems, hadFrontmatter: r.hadFrontmatter }
}

function fmString(r: FmRead, key: string, path: string, required: boolean): string | undefined {
  const f = r.fields.get(key)
  if (!f) {
    if (required) {
      r.problems.push(problem(
        'catalogue.missing-key', path, 1,
        `Required key "${key}" is missing. Add \`${key}: ...\` to the frontmatter.`,
        `A chave obrigatória "${key}" está ausente. Adicione \`${key}: ...\` ao frontmatter.`,
      ))
    }
    return undefined
  }
  if (f.value.kind !== 'string') {
    r.problems.push(problem(
      'catalogue.wrong-type', path, f.line,
      `The key "${key}" must be text. Put the value in quotes if it is not.`,
      `A chave "${key}" deve ser texto. Coloque o valor entre aspas se não for.`,
    ))
    return undefined
  }
  if (f.value.value.trim() === '') {
    if (required) {
      r.problems.push(problem(
        'catalogue.empty-key', path, f.line,
        `The key "${key}" is empty. Give it a value.`,
        `A chave "${key}" está vazia. Dê um valor a ela.`,
      ))
    }
    return undefined
  }
  return f.value.value
}

function fmName(r: FmRead, key: string, path: string): string | undefined {
  const v = fmString(r, key, path, false)
  if (v === undefined) return undefined
  const bad = validateName(v, path, r.fields.get(key)?.line ?? 1)
  if (bad.length > 0) { r.problems.push(...bad); return undefined }
  return v
}

// ── commands ────────────────────────────────────────────────────────────────────────────────────

export interface CommandFileInput { text: string; path: string; name: string; scope: CatalogueScope }

export function parseCommandFile(input: CommandFileInput): CatalogueEntry<'command'> {
  const { text, path, name, scope } = input
  const r = readFm(text, path, ['description', 'args', 'agent', 'model', 'override'])
  const entry = blank('command', name, scope, path)
  const found: CatalogueProblem[] = validateName(name, path, 1)
  if (!r.hadFrontmatter) {
    found.push(problem(
      'catalogue.no-frontmatter', path, 1,
      'The file has no frontmatter. Start it with a --- block holding at least `description:`.',
      'O arquivo não tem frontmatter. Comece com um bloco --- contendo ao menos `description:`.',
    ))
  }
  const description = fmString(r, 'description', path, true)
  const args = fmString(r, 'args', path, false)
  const agent = fmName(r, 'agent', path)
  const model = fmString(r, 'model', path, false)
  let override: boolean | undefined
  const ov = r.fields.get('override')
  if (ov) {
    if (ov.value.kind !== 'boolean') {
      r.problems.push(problem(
        'catalogue.wrong-type', path, ov.line,
        'The key "override" must be true or false.',
        'A chave "override" deve ser true ou false.',
      ))
    } else if (ov.value.value && scope !== 'user') {
      r.problems.push(problem(
        'catalogue.override-scope', path, ov.line,
        `\`override: true\` is only allowed in user scope; a ${scope} command may never redefine a built-in. Remove it, or move the command to your user commands.`,
        `\`override: true\` só é permitido no escopo de usuário; um comando de escopo ${scope} nunca pode redefinir um embutido. Remova-o ou mova o comando para os seus comandos de usuário.`,
      ))
    } else override = ov.value.value
  }
  const template = r.body.trim() === '' ? '' : r.body
  if (template === '') {
    r.problems.push(problem(
      'catalogue.empty-body', path, r.bodyStartLine,
      'The command has no template. Write the prompt after the closing --- line.',
      'O comando não tem template. Escreva o prompt depois da linha --- de fechamento.',
    ))
  }
  const out = withProblems(entry, [...found, ...r.problems])
  if (description !== undefined) {
    const def: CommandDef = { description, template }
    if (args !== undefined) def.args = args
    if (agent !== undefined) def.agent = agent
    if (model !== undefined) def.model = model
    if (override !== undefined) def.override = override
    out.def = def
  }
  return out
}

// ── agents ──────────────────────────────────────────────────────────────────────────────────────

export interface AgentFileInput { text: string; path: string; name: string; scope: CatalogueScope }

export function parseAgentFile(input: AgentFileInput): CatalogueEntry<'agent'> {
  const { text, path, name, scope } = input
  const r = readFm(text, path, ['description', 'model', 'tools', 'permissionProfile'])
  const found: CatalogueProblem[] = validateName(name, path, 1)
  if (!r.hadFrontmatter) {
    found.push(problem(
      'catalogue.no-frontmatter', path, 1,
      'The file has no frontmatter. Start it with a --- block holding at least `description:`.',
      'O arquivo não tem frontmatter. Comece com um bloco --- contendo ao menos `description:`.',
    ))
  }
  const description = fmString(r, 'description', path, true)
  const model = fmString(r, 'model', path, false)
  const permissionProfile = fmName(r, 'permissionProfile', path)
  let tools: string[] | undefined
  const tf = r.fields.get('tools')
  if (tf) {
    if (tf.value.kind !== 'list') {
      r.problems.push(problem(
        'catalogue.wrong-type', path, tf.line,
        'The key "tools" must be a list, e.g. `tools: [file.read, shell.start]`.',
        'A chave "tools" deve ser uma lista, por exemplo `tools: [file.read, shell.start]`.',
      ))
    } else if (tf.value.value.some(t => t.trim() === '')) {
      r.problems.push(problem(
        'catalogue.empty-item', path, tf.line,
        'The list "tools" has an empty item. Remove it.',
        'A lista "tools" tem um item vazio. Remova-o.',
      ))
    } else tools = tf.value.value
  }
  const out = withProblems(blank('agent', name, scope, path), [...found, ...r.problems])
  if (description !== undefined) {
    const def: AgentDef = { description, prompt: r.body.trim() === '' ? '' : r.body }
    if (model !== undefined) def.model = model
    if (tools !== undefined) def.tools = tools
    if (permissionProfile !== undefined) def.permissionProfile = permissionProfile
    out.def = def
  }
  return out
}

// ── skills ──────────────────────────────────────────────────────────────────────────────────────

export interface SkillFileInput { text: string; path: string; dirName: string; scope: CatalogueScope }

export function parseSkillFile(input: SkillFileInput): CatalogueEntry<'skill'> {
  const { text, path, dirName, scope } = input
  const r = readFm(text, path, ['name', 'description'], scope === 'compat' ? COMPAT_SKILL_FOREIGN_KEYS : [])
  const found: CatalogueProblem[] = validateName(dirName, path, 1)
  if (!r.hadFrontmatter) {
    found.push(problem(
      'catalogue.no-frontmatter', path, 1,
      'The file has no frontmatter. Start it with a --- block holding `name:` and `description:`.',
      'O arquivo não tem frontmatter. Comece com um bloco --- contendo `name:` e `description:`.',
    ))
  }
  const declared = fmString(r, 'name', path, true)
  if (declared !== undefined && declared !== dirName) {
    r.problems.push(problem(
      'catalogue.skill-name-mismatch', path, r.fields.get('name')?.line ?? 1,
      `The skill's name "${declared}" must equal its directory name "${dirName}". Rename one of them.`,
      `O nome da skill "${declared}" deve ser igual ao nome do diretório "${dirName}". Renomeie um dos dois.`,
    ))
  }
  const description = fmString(r, 'description', path, true)
  const out = withProblems(blank('skill', dirName, scope, path), [...found, ...r.problems])
  if (description !== undefined) {
    const def: SkillDef = { description, body: r.body }
    out.def = def
  }
  return out
}

// ── rules ───────────────────────────────────────────────────────────────────────────────────────

export interface ValidateRulesInput {
  path: string
  /** JSON pointer of the array, e.g. `/rules`. */
  pointer: string
  lines: ReadonlyMap<string, number>
  floorEnv?: FloorEnv
}

const RULE_KEYS = ['id', 'effect', 'match']
const MATCH_KEYS = ['action', 'tool', 'pathGlob', 'commandPrefix']

/** Validates a `rules` array. Refused rules are absent from `rules`; each refusal is a problem. */
export function validateRules(value: JsonValue | undefined, input: ValidateRulesInput): { rules: PolicyRule[]; problems: CatalogueProblem[] } {
  const { path, pointer, lines, floorEnv } = input
  const at = (p: string): number => lines.get(p) ?? lines.get(pointer) ?? 1
  const problems: CatalogueProblem[] = []
  const rules: PolicyRule[] = []
  if (!Array.isArray(value)) {
    problems.push(problem(
      'catalogue.wrong-type', path, at(pointer),
      `"${dotted(pointer)}" must be an array of rules.`,
      `"${dotted(pointer)}" deve ser uma lista de regras.`,
    ))
    return { rules, problems }
  }
  const seen = new Set<string>()
  value.forEach((raw, i) => {
    const rp = `${pointer}/${i}`
    const where = dotted(rp)
    const line = at(rp)
    const refuse = (code: string, en: string, pt: string, l = line): void => { problems.push(problem(code, path, l, en, pt)); ok = false }
    let ok = true
    if (!isObj(raw)) { refuse('catalogue.wrong-type', `The rule ${where} must be an object with id, effect and match.`, `A regra ${where} deve ser um objeto com id, effect e match.`); return }
    for (const k of Object.keys(raw)) {
      if (!RULE_KEYS.includes(k)) refuse('catalogue.unknown-key', `Unknown key "${where}.${k}" in a rule. Allowed keys: ${RULE_KEYS.join(', ')}.`, `Chave desconhecida "${where}.${k}" em uma regra. Chaves permitidas: ${RULE_KEYS.join(', ')}.`, at(`${rp}/${pointerSegment(k)}`))
    }
    const id = raw.id
    if (typeof id !== 'string' || id === '') refuse('catalogue.rule-id', `The rule ${where} needs a non-empty text "id".`, `A regra ${where} precisa de um "id" de texto não vazio.`)
    else if (seen.has(id)) refuse('catalogue.duplicate-rule-id', `The rule id "${id}" is used twice. Ids must be unique.`, `O id de regra "${id}" está repetido. Os ids devem ser únicos.`, at(`${rp}/id`))
    else seen.add(id)
    const effect = raw.effect
    if (effect !== 'deny' && effect !== 'ask' && effect !== 'allow') refuse('catalogue.rule-effect', `The rule ${where} needs "effect" to be deny, ask or allow.`, `A regra ${where} precisa que "effect" seja deny, ask ou allow.`, at(`${rp}/effect`))
    const m = raw.match
    const match: RuleMatch = {}
    if (!isObj(m)) refuse('catalogue.rule-match', `The rule ${where} needs a "match" object.`, `A regra ${where} precisa de um objeto "match".`)
    else {
      const ml = at(`${rp}/match`)
      for (const k of Object.keys(m)) {
        if (!MATCH_KEYS.includes(k)) refuse('catalogue.unknown-key', `Unknown key "${where}.match.${k}". Allowed keys: ${MATCH_KEYS.join(', ')}.`, `Chave desconhecida "${where}.match.${k}". Chaves permitidas: ${MATCH_KEYS.join(', ')}.`, at(`${rp}/match/${pointerSegment(k)}`))
      }
      const kl = (k: string): number => at(`${rp}/match/${k}`)
      if (m.action !== undefined) {
        if (typeof m.action === 'string' && (POLICY_ACTIONS as readonly string[]).includes(m.action)) match.action = m.action as RuleMatch['action']
        else refuse('catalogue.rule-action', `The action in ${where}.match is not valid. Use one of: ${POLICY_ACTIONS.join(', ')}.`, `A action em ${where}.match não é válida. Use uma de: ${POLICY_ACTIONS.join(', ')}.`, kl('action'))
      }
      if (m.tool !== undefined) {
        if (typeof m.tool === 'string' && m.tool !== '') match.tool = m.tool
        else refuse('catalogue.wrong-type', `The tool in ${where}.match must be non-empty text.`, `A tool em ${where}.match deve ser um texto não vazio.`, kl('tool'))
      }
      if (m.pathGlob !== undefined) {
        if (typeof m.pathGlob === 'string' && m.pathGlob !== '') match.pathGlob = m.pathGlob
        else refuse('catalogue.wrong-type', `The pathGlob in ${where}.match must be non-empty text.`, `O pathGlob em ${where}.match deve ser um texto não vazio.`, kl('pathGlob'))
      }
      if (m.commandPrefix !== undefined) {
        const cp = m.commandPrefix
        if (Array.isArray(cp) && cp.length > 0 && cp.every(t => typeof t === 'string')) match.commandPrefix = cp as string[]
        else refuse('catalogue.wrong-type', `The commandPrefix in ${where}.match must be a non-empty list of text tokens.`, `O commandPrefix em ${where}.match deve ser uma lista não vazia de textos.`, kl('commandPrefix'))
      }
      if (ok && Object.keys(match).length === 0) {
        refuse('catalogue.rule-empty-match', `The rule ${where} has an empty match, which would match everything. Set at least one of: ${MATCH_KEYS.join(', ')}.`, `A regra ${where} tem um match vazio, o que casaria com tudo. Defina ao menos um de: ${MATCH_KEYS.join(', ')}.`, ml)
      }
    }
    if (!ok) return
    const rule: PolicyRule = { id: id as string, effect: effect as PolicyRule['effect'], match }
    const hit = ruleFloorHit(rule, floorEnv)
    if (hit) {
      refuse(
        'catalogue.rule-floor',
        `The rule "${rule.id}" targets ${hit.name}, which the policy floor protects. The floor can never be lifted by any rule or profile, so this rule would never be in force. Remove it (a deny rule over it is accepted).`,
        `A regra "${rule.id}" mira ${hit.name}, que o piso da política protege. O piso nunca pode ser suspenso por regra ou perfil algum, então esta regra nunca entraria em vigor. Remova-a (uma regra deny sobre isso é aceita).`,
      )
      return
    }
    rules.push(rule)
  })
  return { rules, problems }
}

// ── permission profiles ─────────────────────────────────────────────────────────────────────────

export interface ProfileFileInput { text: string; path: string; name: string; scope: CatalogueScope; floorEnv?: FloorEnv }

export function parsePermissionProfileFile(input: ProfileFileInput): CatalogueEntry<'permissionProfile'> {
  const { text, path, name, scope, floorEnv } = input
  const entry = blank('permissionProfile', name, scope, path)
  const found: CatalogueProblem[] = validateName(name, path, 1)
  const parsed = parseJsonc(text)
  if (!parsed.ok) return withProblems(entry, [...found, syntaxProblem(path, parsed.line, parsed.message)])
  const { value, lines } = parsed
  if (!isObj(value)) {
    return withProblems(entry, [...found, problem('catalogue.wrong-type', path, 1, 'A profile must be a JSON object with "rules".', 'Um perfil deve ser um objeto JSON com "rules".')])
  }
  for (const k of Object.keys(value)) {
    if (k !== 'description' && k !== 'rules') {
      found.push(problem('catalogue.unknown-key', path, lines.get(`/${pointerSegment(k)}`) ?? 1, `Unknown key "${k}". Allowed keys: description, rules.`, `Chave desconhecida "${k}". Chaves permitidas: description, rules.`))
    }
  }
  const def: PermissionProfileDef = { rules: [] }
  if (value.description !== undefined) {
    if (typeof value.description === 'string') def.description = value.description
    else found.push(problem('catalogue.wrong-type', path, lines.get('/description') ?? 1, 'The key "description" must be text.', 'A chave "description" deve ser texto.'))
  }
  if (value.rules === undefined) {
    found.push(problem('catalogue.missing-key', path, 1, 'Required key "rules" is missing. Add a "rules" array.', 'A chave obrigatória "rules" está ausente. Adicione uma lista "rules".'))
  } else {
    const v = validateRules(value.rules, { path, pointer: '/rules', lines, floorEnv })
    def.rules = v.rules
    found.push(...v.problems)
  }
  const out = withProblems(entry, found)
  out.def = def
  return out
}

function syntaxProblem(path: string, line: number, message: string): CatalogueProblem {
  return problem('catalogue.syntax', path, line, `The file cannot be read: ${message}.`, `O arquivo não pôde ser lido: ${message}.`)
}

// ── settings.json ───────────────────────────────────────────────────────────────────────────────

export interface SettingsFileInput { text: string; path: string; scope: CatalogueScope; floorEnv?: FloorEnv }
export interface SettingsResult { settings: CatalogueSettings; entries: CatalogueEntry[]; problems: CatalogueProblem[] }

const TOP_KEYS = ['defaultModel', 'rules', 'profile', 'mcpServers', 'afterEdit', 'compat', 'skills']

function secretProblem(path: string, line: number, pointer: string): CatalogueProblem {
  const where = dotted(pointer)
  return problem(
    'catalogue.literal-secret', path, line,
    `"${where}" holds what looks like a literal secret. Secrets are never written into settings: use an {env:VAR} reference or a host credential id instead.`,
    `"${where}" contém o que parece ser um segredo literal. Segredos nunca são escritos em configurações: use uma referência {env:VAR} ou um id de credencial do host.`,
  )
}

/** Pointers (under `root`) of every string that is a literal secret. `auth/credential` is an id. */
function secretPointers(value: JsonValue, root: string, lines: ReadonlyMap<string, number>): Array<{ pointer: string; line: number }> {
  const out: Array<{ pointer: string; line: number }> = []
  // `mapEntryKey` is set for the values of an `env` / `headers` map, where the KEY is context too.
  const walk = (v: JsonValue, pointer: string, mapEntryKey: string | null): void => {
    if (typeof v === 'string') {
      if (pointer.endsWith('/auth/credential')) return
      if (containsSecret(v) || (mapEntryKey !== null && containsSecret(`${mapEntryKey}=${v}`))) {
        out.push({ pointer, line: lines.get(pointer) ?? 1 })
      }
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${pointer}/${i}`, null))
    } else if (isObj(v)) {
      const isMap = pointer.endsWith('/env') || pointer.endsWith('/headers')
      for (const k of Object.keys(v)) walk(v[k] as JsonValue, `${pointer}/${pointerSegment(k)}`, isMap ? k : null)
    }
  }
  walk(value, root, null)
  return out
}

function stringMap(v: JsonValue | undefined): Record<string, string> | null {
  if (!isObj(v)) return null
  const out: Record<string, string> = {}
  for (const k of Object.keys(v)) {
    const x = v[k]
    if (typeof x !== 'string') return null
    out[k] = x
  }
  return out
}

export function parseSettingsFile(input: SettingsFileInput): SettingsResult {
  const { text, path, scope, floorEnv } = input
  const settings: CatalogueSettings = {}
  const entries: CatalogueEntry[] = []
  const problems: CatalogueProblem[] = []
  const parsed = parseJsonc(text)
  if (!parsed.ok) return { settings, entries, problems: [syntaxProblem(path, parsed.line, parsed.message)] }
  const { value: root, lines } = parsed
  const L = (p: string): number => lines.get(p) ?? 1
  if (!isObj(root)) {
    return { settings, entries, problems: [problem('catalogue.wrong-type', path, 1, 'settings.json must be a JSON object.', 'settings.json deve ser um objeto JSON.')] }
  }
  const P = (code: string, pointer: string, en: string, pt: string): void => { problems.push(problem(code, path, L(pointer), en, pt)) }
  const unknownIn = (obj: { [k: string]: JsonValue }, pointer: string, allowed: readonly string[], into: CatalogueProblem[] = problems): void => {
    for (const k of Object.keys(obj)) {
      if (allowed.includes(k)) continue
      const p = `${pointer}/${pointerSegment(k)}`
      into.push(problem('catalogue.unknown-key', path, L(p), `Unknown key "${dotted(p)}". Allowed keys here: ${allowed.join(', ')}.`, `Chave desconhecida "${dotted(p)}". Chaves permitidas aqui: ${allowed.join(', ')}.`))
    }
  }
  unknownIn(root, '', TOP_KEYS)

  // literal secrets outside mcpServers / afterEdit are file-level
  for (const k of Object.keys(root)) {
    if (k === 'mcpServers' || k === 'afterEdit') continue
    for (const s of secretPointers(root[k] as JsonValue, `/${pointerSegment(k)}`, lines)) problems.push(secretProblem(path, s.line, s.pointer))
  }

  // defaultModel
  if ('defaultModel' in root) {
    const dm = root.defaultModel as JsonValue
    if (scope !== 'user') {
      P('catalogue.default-model-scope', '/defaultModel', 'defaultModel is only allowed in user scope: a repository choosing which paid model a person\'s key is billed against is a billing decision made by someone else. Set it in your user settings.', 'defaultModel só é permitido no escopo de usuário: um repositório escolher em qual modelo pago a chave de uma pessoa é cobrada é uma decisão de cobrança tomada por outra pessoa. Defina-o nas suas configurações de usuário.')
    } else if (!isObj(dm)) {
      P('catalogue.wrong-type', '/defaultModel', 'defaultModel must be an object {provider, model}.', 'defaultModel deve ser um objeto {provider, model}.')
    } else {
      unknownIn(dm, '/defaultModel', ['provider', 'model'])
      if (typeof dm.provider === 'string' && dm.provider !== '' && typeof dm.model === 'string' && dm.model !== '') {
        settings.defaultModel = { provider: dm.provider, model: dm.model }
      } else P('catalogue.wrong-type', '/defaultModel', 'defaultModel needs both "provider" and "model" as non-empty text.', 'defaultModel precisa de "provider" e "model", ambos texto não vazio.')
    }
  }

  // rules
  if ('rules' in root) {
    const v = validateRules(root.rules, { path, pointer: '/rules', lines, floorEnv })
    problems.push(...v.problems)
    settings.rules = v.rules
  }

  // profile
  if ('profile' in root) {
    const pf = root.profile
    if (typeof pf !== 'string') P('catalogue.wrong-type', '/profile', 'profile must be the name of a permission profile.', 'profile deve ser o nome de um perfil de permissão.')
    else {
      const bad = validateName(pf, path, L('/profile'))
      if (bad.length > 0) problems.push(...bad)
      else settings.profile = pf
    }
  }

  // compat
  if ('compat' in root) {
    const c = root.compat
    if (scope === 'project') {
      P('catalogue.compat-scope', '/compat', 'compat is only allowed in user scope: it would make a repository opt the person into reading skills from their home directory, and opting in is the person\'s own act. Set it in your user settings.', 'compat só é permitido no escopo de usuário: faria um repositório optar, pela pessoa, por ler skills do diretório pessoal dela, e optar é ato da própria pessoa. Defina-o nas suas configurações de usuário.')
    } else if (!isObj(c)) {
      P('catalogue.wrong-type', '/compat', 'compat must be an object {claudeSkills?, agentsSkills?}.', 'compat deve ser um objeto {claudeSkills?, agentsSkills?}.')
    } else {
      unknownIn(c, '/compat', ['claudeSkills', 'agentsSkills'])
      const out: { claudeSkills?: boolean; agentsSkills?: boolean } = {}
      for (const k of ['claudeSkills', 'agentsSkills'] as const) {
        if (c[k] === undefined) continue
        if (typeof c[k] === 'boolean') out[k] = c[k] as boolean
        else P('catalogue.wrong-type', `/compat/${k}`, `compat.${k} must be true or false.`, `compat.${k} deve ser true ou false.`)
      }
      settings.compat = out
    }
  }

  // skills
  if ('skills' in root) {
    const s = root.skills
    if (!isObj(s)) P('catalogue.wrong-type', '/skills', 'skills must be an object {budgetTokens?}.', 'skills deve ser um objeto {budgetTokens?}.')
    else {
      unknownIn(s, '/skills', ['budgetTokens'])
      const out: { budgetTokens?: number } = {}
      if (s.budgetTokens !== undefined) {
        if (typeof s.budgetTokens === 'number' && Number.isInteger(s.budgetTokens) && s.budgetTokens > 0) out.budgetTokens = s.budgetTokens
        else P('catalogue.wrong-type', '/skills/budgetTokens', 'skills.budgetTokens must be a positive integer.', 'skills.budgetTokens deve ser um inteiro positivo.')
      }
      settings.skills = out
    }
  }

  // mcpServers
  if ('mcpServers' in root) {
    const ms = root.mcpServers
    if (!isObj(ms)) P('catalogue.wrong-type', '/mcpServers', 'mcpServers must be an object of name -> server.', 'mcpServers deve ser um objeto nome -> servidor.')
    else {
      for (const name of Object.keys(ms).sort()) entries.push(parseMcpServer(name, ms[name] as JsonValue, `/mcpServers/${pointerSegment(name)}`, path, scope, lines))
    }
  }

  // afterEdit
  if ('afterEdit' in root) {
    const ae = root.afterEdit
    if (!Array.isArray(ae)) P('catalogue.wrong-type', '/afterEdit', 'afterEdit must be an array.', 'afterEdit deve ser uma lista.')
    else ae.forEach((item, i) => entries.push(parseAfterEdit(item, i, `/afterEdit/${i}`, path, scope, lines)))
  }

  return { settings, entries, problems }
}

function parseMcpServer(name: string, v: JsonValue, pointer: string, path: string, scope: CatalogueScope, lines: ReadonlyMap<string, number>): CatalogueEntry<'mcpServer'> {
  const L = (p: string): number => lines.get(p) ?? lines.get(pointer) ?? 1
  const found: CatalogueProblem[] = validateName(name, path, L(pointer))
  const P = (code: string, p: string, en: string, pt: string): void => { found.push(problem(code, path, L(p), en, pt)) }
  const entry = blank('mcpServer', name, scope, path)
  if (!isObj(v)) {
    P('catalogue.wrong-type', pointer, `The MCP server "${name}" must be an object with a "type".`, `O servidor MCP "${name}" deve ser um objeto com um "type".`)
    return withProblems(entry, found)
  }
  const at = dotted(pointer)
  for (const s of secretPointers(v, pointer, lines)) found.push(secretProblem(path, s.line, s.pointer))
  let def: McpServerDef | undefined
  const unknown = (allowed: readonly string[]): void => {
    for (const k of Object.keys(v)) if (!allowed.includes(k)) P('catalogue.unknown-key', `${pointer}/${pointerSegment(k)}`, `Unknown key "${at}.${k}". Allowed keys: ${allowed.join(', ')}.`, `Chave desconhecida "${at}.${k}". Chaves permitidas: ${allowed.join(', ')}.`)
  }
  if (v.type === 'stdio') {
    unknown(['type', 'command', 'env'])
    const cmd = v.command
    let command: string[] | null = null
    if (Array.isArray(cmd) && cmd.length > 0 && cmd.every(t => typeof t === 'string' && t !== '')) command = cmd as string[]
    else P('catalogue.wrong-type', `${pointer}/command`, `${at}.command must be a non-empty list of text tokens, e.g. ["bunx","some-mcp"].`, `${at}.command deve ser uma lista não vazia de textos, por exemplo ["bunx","some-mcp"].`)
    let env: Record<string, string> | undefined
    if (v.env !== undefined) {
      const m = stringMap(v.env)
      if (m) env = m
      else P('catalogue.wrong-type', `${pointer}/env`, `${at}.env must map names to text values.`, `${at}.env deve mapear nomes para valores de texto.`)
    }
    if (command) { def = { type: 'stdio', command }; if (env) def.env = env }
  } else if (v.type === 'http') {
    unknown(['type', 'url', 'headers', 'auth'])
    let url: string | null = null
    if (typeof v.url === 'string' && /^https?:\/\/[^\s/]+/i.test(v.url)) url = v.url
    else P('catalogue.wrong-type', `${pointer}/url`, `${at}.url must be an http:// or https:// URL.`, `${at}.url deve ser uma URL http:// ou https://.`)
    let headers: Record<string, string> | undefined
    if (v.headers !== undefined) {
      const m = stringMap(v.headers)
      if (m) headers = m
      else P('catalogue.wrong-type', `${pointer}/headers`, `${at}.headers must map names to text values.`, `${at}.headers deve mapear nomes para valores de texto.`)
    }
    let auth: { credential: string } | undefined
    if (v.auth !== undefined) {
      const a = v.auth
      if (isObj(a)) {
        for (const k of Object.keys(a)) if (k !== 'credential') P('catalogue.unknown-key', `${pointer}/auth/${pointerSegment(k)}`, `Unknown key "${at}.auth.${k}". Allowed keys: credential.`, `Chave desconhecida "${at}.auth.${k}". Chaves permitidas: credential.`)
        if (typeof a.credential === 'string' && a.credential !== '') auth = { credential: a.credential }
        else P('catalogue.wrong-type', `${pointer}/auth`, `${at}.auth.credential must be the id of a host credential.`, `${at}.auth.credential deve ser o id de uma credencial do host.`)
      } else P('catalogue.wrong-type', `${pointer}/auth`, `${at}.auth must be an object {credential}.`, `${at}.auth deve ser um objeto {credential}.`)
    }
    if (url) { def = { type: 'http', url }; if (headers) def.headers = headers; if (auth) def.auth = auth }
  } else {
    P('catalogue.mcp-type', `${pointer}/type`, `${at}.type must be "stdio" or "http".`, `${at}.type deve ser "stdio" ou "http".`)
  }
  const out = withProblems(entry, found)
  if (def) out.def = def
  return out
}

function parseAfterEdit(v: JsonValue, index: number, pointer: string, path: string, scope: CatalogueScope, lines: ReadonlyMap<string, number>): CatalogueEntry<'afterEdit'> {
  const L = (p: string): number => lines.get(p) ?? lines.get(pointer) ?? 1
  const found: CatalogueProblem[] = []
  const P = (code: string, p: string, en: string, pt: string): void => { found.push(problem(code, path, L(p), en, pt)) }
  const derived = `${scope}-after-edit-${index + 1}`
  const at = dotted(pointer)
  if (!isObj(v)) {
    P('catalogue.wrong-type', pointer, `${at} must be an object {match, run}.`, `${at} deve ser um objeto {match, run}.`)
    return withProblems(blank('afterEdit', derived, scope, path), found)
  }
  for (const k of Object.keys(v)) {
    if (!['name', 'match', 'run', 'timeoutMs'].includes(k)) P('catalogue.unknown-key', `${pointer}/${pointerSegment(k)}`, `Unknown key "${at}.${k}". Allowed keys: name, match, run, timeoutMs.`, `Chave desconhecida "${at}.${k}". Chaves permitidas: name, match, run, timeoutMs.`)
  }
  let name = derived
  if (v.name !== undefined) {
    if (typeof v.name === 'string') {
      const bad = validateName(v.name, path, L(`${pointer}/name`))
      if (bad.length > 0) found.push(...bad)
      else name = v.name
    } else P('catalogue.wrong-type', `${pointer}/name`, `${at}.name must be text.`, `${at}.name deve ser texto.`)
  }
  for (const s of secretPointers(v, pointer, lines)) found.push(secretProblem(path, s.line, s.pointer))
  const match = typeof v.match === 'string' && v.match.trim() !== '' ? v.match : null
  if (match === null) P('catalogue.wrong-type', `${pointer}/match`, `${at}.match must be a non-empty glob, e.g. "**/*.ts".`, `${at}.match deve ser um glob não vazio, por exemplo "**/*.ts".`)
  const run = Array.isArray(v.run) && v.run.length > 0 && v.run.every(t => typeof t === 'string' && t !== '') ? (v.run as string[]) : null
  if (run === null) P('catalogue.wrong-type', `${pointer}/run`, `${at}.run must be a non-empty list of text tokens (argv).`, `${at}.run deve ser uma lista não vazia de textos (argv).`)
  let timeoutMs: number | undefined
  if (v.timeoutMs !== undefined) {
    if (typeof v.timeoutMs === 'number' && Number.isInteger(v.timeoutMs) && v.timeoutMs > 0) timeoutMs = v.timeoutMs
    else P('catalogue.wrong-type', `${pointer}/timeoutMs`, `${at}.timeoutMs must be a positive integer.`, `${at}.timeoutMs deve ser um inteiro positivo.`)
  }
  const out = withProblems(blank('afterEdit', name, scope, path), found)
  if (match !== null && run !== null) {
    const def: AfterEditDef = { match, run }
    if (timeoutMs !== undefined) def.timeoutMs = timeoutMs
    out.def = def
  }
  return out
}
