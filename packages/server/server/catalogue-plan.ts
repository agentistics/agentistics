/**
 * catalogue-plan.ts — the harness catalogue as ONE view, from the text the host read (B8.2).
 *
 * PURE. `catalogue-host.ts` walks the scope directories and hands over `{ path, text }` records;
 * this module calls B8.1's parsers and precedence (`@agentistics/runtime`, `catalogue/`) and
 * restates none of their rules. What it adds is the two things B8.1 left to the host:
 *
 * ## 1. A file-level secret keeps the file's RESTRICTIONS and drops its WIDENING (leader decision 8)
 *
 * `parseSettingsFile` reports a literal secret found outside `mcpServers` / `afterEdit` as a
 * problem of the FILE. Disabling the whole file would also drop the person's own `deny` rules, so a
 * pasted token would silently make the policy MORE permissive. Fail closed means the opposite: the
 * file keeps every `deny` / `ask` rule and `skills.budgetTokens`, and everything in it that widens
 * power — `allow` rules, the `profile` swap, `defaultModel`, the `compat` opt-in, every declared MCP
 * server and after-edit step — is ignored, each said in a sentence naming the file. The secret is
 * never echoed (the parser's own sentence names the key path, not the value).
 *
 * ## 2. An untrusted project's power has NO effect (spec §4, criterion 1)
 *
 * Trust itself (grants, the hash, `trust`/`untrust`) is B8.3. Until it exists every project is
 * `untrusted`, and:
 *
 * - its `allow` rules and its `profile` are INERT, listed with the sentence why; `deny`/`ask` apply;
 * - its MCP servers and after-edit steps are INERT and are kept OUT of precedence entirely. Left in,
 *   a project server named `db` would win the name and SHADOW the person's own `db` — an effect,
 *   which is exactly what an untrusted project may not have;
 * - its agent and permission profiles take part in precedence, and B8.1's narrowing plans say which
 *   of their parts are ignored (a tool the wider agent did not grant, an allow rule, a profile swap).
 *
 * Nothing is dropped anywhere: every file becomes an item, a notice, or a settings view.
 */
import {
  initialTrust,
  parseAgentFile,
  parseCommandFile,
  parsePermissionProfileFile,
  parseSettingsFile,
  parseSkillFile,
  planAgentNarrowing,
  planMcpServerShadow,
  planProfileNarrowing,
  resolveCatalogue,
  withProblems,
  type CatalogueEntry,
  type CatalogueKind,
  type CatalogueProblem,
  type CatalogueScope,
  type CatalogueSettings,
  type FloorEnv,
  type PolicyRule,
} from '@agentistics/runtime'
import { excludeFor, type ExcludeReason } from './backup/backup-plan'

// ── What the host hands over ────────────────────────────────────────────────────────────────────

/** The file kinds a scope directory holds. `settings` yields settings plus mcpServer/afterEdit entries. */
export type RecordKind = 'settings' | 'command' | 'agent' | 'permissionProfile' | 'skill'

/**
 * One file the host found. `text` is null when the host refused to read it (it points outside the
 * project, it is too large, it could not be read) — `refusal` then says why, and the planner still
 * lists an entry of that kind and name, disabled, carrying the sentence.
 */
export interface CatalogueRecord {
  scope: CatalogueScope
  kind: RecordKind
  /** The label a sentence shows as `file:line` (an absolute path on this machine). */
  path: string
  /** The entry name the file stands for (the file stem; for a skill, its directory). Unused for settings. */
  name: string
  text: string | null
  refusal?: Refusal
}

export interface Refusal { code: string; en: string; pt: string }

/**
 * A file that could not be read. A named constant rather than a `code: '…'` literal: the web's
 * notification-coverage lint reads that literal shape in server source as a notification code, and
 * this is a catalogue problem code, never a notification.
 */
export const UNREADABLE = 'catalogue.unreadable'

/** A file or directory that is not an entry at all (an unrecognised file, a skipped scope). */
export interface CatalogueNotice {
  scope: CatalogueScope
  path: string
  code: string
  en: string
  pt: string
}

export interface CataloguePlanInput {
  records: readonly CatalogueRecord[]
  notices: readonly CatalogueNotice[]
  /** Built-in entries the host supplies (decision 9). */
  builtins: readonly CatalogueEntry[]
  /** The REAL floor environment (leader decision (b)); never the symbolic fallback. */
  floorEnv: FloorEnv
  /**
   * The user scope directory, and its `$HOME`-relative form — only used to say, per file, when a
   * backup would NOT carry it (spec §3.3, stated limit). Absent: no backup note is computed.
   */
  userRoot?: { abs: string; homeRel: string }
}

// ── What the view says ─────────────────────────────────────────────────────────────────────────

/** A sentence about something present that has no effect, and why. */
export interface InertPart {
  /** A rule id, a server or step name, a tool, or `profile` / `defaultModel` / `compat`. */
  what: string
  code: string
  en: string
  pt: string
}

export type ItemStatus = 'active' | 'disabled' | 'shadowed' | 'inert'

export interface CatalogueItem {
  entry: CatalogueEntry
  /**
   * - `active`: in force (for a project entry, only its narrowing part — see `inert`);
   * - `disabled`: it carries a problem (or was switched off) and is not in force;
   * - `shadowed`: valid, but a more specific scope holds the name;
   * - `inert`: an untrusted project's server or after-edit step — listed, no effect at all.
   */
  status: ItemStatus
  /** Parts of the entry that are ignored, each with its sentence. */
  inert: InertPart[]
  /** Set when a backup would not carry this file, with the plan's reason. */
  backup?: { excluded: ExcludeReason; en: string; pt: string }
}

export interface ScopeSettingsView {
  scope: CatalogueScope
  path: string
  /** What is IN FORCE from this file: after the file-secret rule and the project trust gate. */
  settings: CatalogueSettings
  /** What the file says and has no effect, each with its sentence. */
  inert: InertPart[]
  /** The file's own problems (syntax, unknown keys, a literal secret, a refused rule). */
  problems: CatalogueProblem[]
  /** True when a file-level literal secret switched off every widening part (decision 8). */
  secretNarrowed: boolean
}

export interface CatalogueView {
  items: CatalogueItem[]
  settings: ScopeSettingsView[]
  notices: CatalogueNotice[]
}

// ── settings.json ───────────────────────────────────────────────────────────────────────────────

const WIDENS_EN = 'is ignored until it is removed'
const WIDENS_PT = 'é ignorado até ser removido'

interface Part { en: string; pt: string }

function secretSentence(path: string, part: Part): { en: string; pt: string } {
  return {
    en: `${path} holds a literal secret, so everything in it that widens power ${WIDENS_EN}: ${part.en}. Its deny and ask rules still apply.`,
    pt: `${path} contém um segredo literal, então tudo nele que amplia poder ${WIDENS_PT}: ${part.pt}. Suas regras deny e ask continuam valendo.`,
  }
}

function untrustedSentence(part: Part): { en: string; pt: string } {
  return {
    en: `${part.en} comes from an untrusted project and has no effect until the project is trusted.`,
    pt: `${part.pt} vem de um projeto não confiável e não tem efeito até o projeto ser marcado como confiável.`,
  }
}

function hasFileSecret(problems: readonly CatalogueProblem[]): boolean {
  return problems.some((p) => p.code === 'catalogue.literal-secret')
}

interface SettingsOutcome {
  view: ScopeSettingsView
  /** mcpServer / afterEdit entries of this file, after the secret rule (not yet the trust gate). */
  entries: CatalogueEntry[]
}

/**
 * One settings file, parsed and narrowed. Exported because the host reads the USER file first to
 * learn whether the person opted into the compat directories — and must learn it AFTER the secret
 * rule, or a file carrying a pasted token could still widen what is read.
 */
export function settingsOutcome(record: CatalogueRecord, floorEnv: FloorEnv): SettingsOutcome {
  const { scope, path } = record
  if (record.text === null) {
    const r = record.refusal ?? { code: UNREADABLE, en: 'the file could not be read.', pt: 'o arquivo não pôde ser lido.' }
    const problem: CatalogueProblem = { code: r.code, path, line: 1, en: r.en, pt: r.pt }
    return { view: { scope, path, settings: {}, inert: [], problems: [problem], secretNarrowed: false }, entries: [] }
  }
  const parsed = parseSettingsFile({ text: record.text, path, scope, floorEnv })
  const secret = hasFileSecret(parsed.problems)
  const untrusted = initialTrust(scope) === 'untrusted'
  const inert: InertPart[] = []
  const settings: CatalogueSettings = {}
  const s = parsed.settings

  if (s.rules !== undefined) {
    const kept: PolicyRule[] = []
    for (const r of s.rules) {
      if (r.effect !== 'allow') { kept.push(r); continue }
      if (secret) inert.push({ what: r.id, code: 'catalogue.file-secret-widening', ...secretSentence(path, { en: `the allow rule "${r.id}"`, pt: `a regra allow "${r.id}"` }) })
      else if (untrusted) inert.push({ what: r.id, code: 'catalogue.needs-trust', ...untrustedSentence({ en: `The allow rule "${r.id}"`, pt: `A regra allow "${r.id}"` }) })
      else kept.push(r)
    }
    settings.rules = kept
  }
  if (s.profile !== undefined) {
    if (secret) inert.push({ what: 'profile', code: 'catalogue.file-secret-widening', ...secretSentence(path, { en: `the starting profile "${s.profile}"`, pt: `o perfil inicial "${s.profile}"` }) })
    else if (untrusted) inert.push({ what: 'profile', code: 'catalogue.needs-trust', ...untrustedSentence({ en: `The starting profile "${s.profile}"`, pt: `O perfil inicial "${s.profile}"` }) })
    else settings.profile = s.profile
  }
  if (s.defaultModel !== undefined) {
    if (secret) inert.push({ what: 'defaultModel', code: 'catalogue.file-secret-widening', ...secretSentence(path, { en: 'defaultModel', pt: 'defaultModel' }) })
    else settings.defaultModel = s.defaultModel
  }
  if (s.compat !== undefined) {
    const on = Object.entries(s.compat).some(([, v]) => v === true)
    if (secret && on) inert.push({ what: 'compat', code: 'catalogue.file-secret-widening', ...secretSentence(path, { en: 'the compat opt-in', pt: 'a opção compat' }) })
    else settings.compat = s.compat
  }
  if (s.skills !== undefined) settings.skills = s.skills

  const entries = parsed.entries.map((e) => secret
    ? withProblems(e, [{
        code: 'catalogue.file-secret-widening', path, line: 1,
        ...secretSentence(path, e.kind === 'mcpServer'
          ? { en: `the MCP server "${e.name}" is not started`, pt: `o servidor MCP "${e.name}" não é iniciado` }
          : { en: `the after-edit step "${e.name}" is not run`, pt: `o passo pós-edição "${e.name}" não roda` }),
      }])
    : e)

  return { view: { scope, path, settings, inert, problems: parsed.problems, secretNarrowed: secret }, entries }
}

// ── the whole catalogue ─────────────────────────────────────────────────────────────────────────

function refusedEntry(record: CatalogueRecord, kind: CatalogueKind): CatalogueEntry {
  const r = record.refusal ?? { code: UNREADABLE, en: 'the file could not be read.', pt: 'o arquivo não pôde ser lido.' }
  return {
    kind, name: record.name, scope: record.scope, source: { path: record.path },
    enabled: false, trust: initialTrust(record.scope),
    problems: [{ code: r.code, path: record.path, line: 1, en: r.en, pt: r.pt }],
  }
}

function parseRecord(record: CatalogueRecord, floorEnv: FloorEnv): CatalogueEntry {
  const kind = record.kind as Exclude<RecordKind, 'settings'>
  if (record.text === null) return refusedEntry(record, kind)
  const { text, path, name, scope } = record
  switch (kind) {
    case 'command': return parseCommandFile({ text, path, name, scope })
    case 'agent': return parseAgentFile({ text, path, name, scope })
    case 'skill': return parseSkillFile({ text, path, dirName: name, scope })
    case 'permissionProfile': return parsePermissionProfileFile({ text, path, name, scope, floorEnv })
  }
}

const POWER_KINDS: ReadonlySet<CatalogueKind> = new Set<CatalogueKind>(['mcpServer', 'afterEdit'])

function keyOf(e: CatalogueEntry): string {
  return `${e.kind}\u0000${e.name}\u0000${e.scope}\u0000${e.source.path ?? ''}`
}

function backupNote(e: CatalogueEntry, userRoot: CataloguePlanInput['userRoot']): CatalogueItem['backup'] {
  if (!userRoot || e.scope !== 'user' || e.source.path === undefined) return undefined
  const abs = userRoot.abs.replace(/\/+$/, '')
  if (!e.source.path.startsWith(`${abs}/`)) return undefined
  const rel = `${userRoot.homeRel.replace(/\/+$/, '')}/${e.source.path.slice(abs.length + 1)}`
  const rule = excludeFor(rel)
  if (!rule) return undefined
  return {
    excluded: rule.reason,
    en: `a backup does not carry this file: its path matches the backup plan's "${rule.pattern}" exclusion (${rule.reason}). Rename it if it should travel.`,
    pt: `um backup não leva este arquivo: o caminho casa com a exclusão "${rule.pattern}" do plano de backup (${rule.reason}). Renomeie-o se ele deve ir junto.`,
  }
}

/** The one entry point: records in, a view out. */
export function planCatalogue(input: CataloguePlanInput): CatalogueView {
  const { floorEnv } = input
  const settings: ScopeSettingsView[] = []
  const candidates: CatalogueEntry[] = [...input.builtins]
  const inertEntries: CatalogueEntry[] = []

  for (const record of input.records) {
    if (record.kind === 'settings') {
      const out = settingsOutcome(record, floorEnv)
      settings.push(out.view)
      for (const e of out.entries) {
        // An untrusted project's process-starting entries never enter precedence (module header).
        if (e.trust === 'untrusted' && POWER_KINDS.has(e.kind)) inertEntries.push(e)
        else candidates.push(e)
      }
    } else {
      candidates.push(parseRecord(record, floorEnv))
    }
  }

  const resolved = resolveCatalogue(candidates)
  const findEligibleBelow = (e: CatalogueEntry): CatalogueEntry | undefined => {
    if (!e.shadows) return undefined
    const { scope, path } = e.shadows
    return resolved.shadowed.find((s) => s.kind === e.kind && s.name === e.name && s.scope === scope && s.source.path === path)
  }

  const items: CatalogueItem[] = []
  for (const e of resolved.entries) {
    const eligible = e.enabled && e.problems.length === 0
    const inert: InertPart[] = []
    if (eligible && e.trust === 'untrusted') {
      const wider = findEligibleBelow(e)
      if (e.kind === 'agent') {
        const plan = planAgentNarrowing(
          (wider ?? { ...e, def: undefined }) as CatalogueEntry<'agent'>,
          e as CatalogueEntry<'agent'>, { trusted: false },
        )
        for (const i of plan.ignored) inert.push({ what: i.what, code: 'catalogue.needs-trust', en: i.en, pt: i.pt })
      } else if (e.kind === 'permissionProfile') {
        const plan = planProfileNarrowing(
          (wider ?? { ...e, def: { rules: [] } }) as CatalogueEntry<'permissionProfile'>,
          e as CatalogueEntry<'permissionProfile'>, { trusted: false },
        )
        for (const i of plan.ignored) inert.push({ what: i.what, code: 'catalogue.needs-trust', en: i.en, pt: i.pt })
      }
    }
    const item: CatalogueItem = { entry: e, status: eligible ? 'active' : 'disabled', inert }
    const note = backupNote(e, input.userRoot)
    if (note) item.backup = note
    items.push(item)
  }
  for (const e of resolved.shadowed) {
    const item: CatalogueItem = { entry: e, status: 'shadowed', inert: [] }
    const note = backupNote(e, input.userRoot)
    if (note) item.backup = note
    items.push(item)
  }

  // The untrusted project's servers and steps: listed, with the sentence, and no effect.
  const inForce = (kind: CatalogueKind, name: string): CatalogueEntry | undefined =>
    resolved.entries.find((x) => x.kind === kind && x.name === name && x.enabled && x.problems.length === 0)
  for (const e of inertEntries) {
    const parts: InertPart[] = []
    if (e.kind === 'mcpServer') {
      const d = planMcpServerShadow(inForce('mcpServer', e.name) as CatalogueEntry<'mcpServer'> | undefined, e as CatalogueEntry<'mcpServer'>, { trusted: false })
      parts.push({ what: e.name, code: 'catalogue.needs-trust', en: d.en, pt: d.pt })
    } else {
      parts.push({
        what: e.name, code: 'catalogue.needs-trust',
        en: `the project declares an after-edit step "${e.name}"; it is not run until the project is trusted.`,
        pt: `o projeto declara um passo pós-edição "${e.name}"; ele não roda até o projeto ser marcado como confiável.`,
      })
    }
    items.push({ entry: e, status: e.problems.length > 0 ? 'disabled' : 'inert', inert: parts })
  }

  items.sort((a, b) => compareItems(a, b))
  const notices = [...input.notices].sort((a, b) => (a.path === b.path ? (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) : a.path < b.path ? -1 : 1))
  return { items, settings: [...settings].sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope]), notices }
}

const KIND_ORDER: Record<CatalogueKind, number> = { command: 0, skill: 1, agent: 2, mcpServer: 3, permissionProfile: 4, afterEdit: 5 }
/** Most specific first, the order a person reads precedence in. */
const SCOPE_ORDER: Record<CatalogueScope, number> = { project: 0, user: 1, compat: 2, builtin: 3 }
const STATUS_ORDER: Record<ItemStatus, number> = { active: 0, inert: 1, disabled: 2, shadowed: 3 }

function compareItems(a: CatalogueItem, b: CatalogueItem): number {
  const k = KIND_ORDER[a.entry.kind] - KIND_ORDER[b.entry.kind]
  if (k !== 0) return k
  if (a.entry.name !== b.entry.name) return a.entry.name < b.entry.name ? -1 : 1
  const s = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
  if (s !== 0) return s
  const sc = SCOPE_ORDER[a.entry.scope] - SCOPE_ORDER[b.entry.scope]
  if (sc !== 0) return sc
  return keyOf(a.entry) < keyOf(b.entry) ? -1 : keyOf(a.entry) > keyOf(b.entry) ? 1 : 0
}
