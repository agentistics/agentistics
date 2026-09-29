/**
 * catalogue/types.ts — the ONE entry shape every kind of harness addition takes (B8 spec §3.1–§3.2,
 * decision C1).
 *
 * Everything under `catalogue/` is PURE (C7, D23): it parses TEXT a host hands it and plans from
 * data. No module here reads a file, lists a directory or knows where `AGENTISTICS_DIR` is — that is
 * the host loader's (B8.2). A `path` on an entry is a LABEL the host supplied so a sentence can say
 * `file:line`; nothing here opens it.
 *
 * ## Two rules the whole directory is built around
 *
 * 1. **An entry with a problem stays LISTED and `enabled: false`, carrying its sentence** (§3.2,
 *    criterion 4). A skill that "does nothing" because of a typo in its frontmatter is
 *    indistinguishable from a broken harness — the reason `HARNESS_CAPABILITIES` renders N/A
 *    rather than 0. No function here drops an entry it was handed.
 * 2. **Unknown keys are REFUSED, not ignored** (§3.2). A misspelled permission key that is
 *    silently ignored is a rule the person believes is in force and is not.
 *
 * ## Language
 *
 * Every problem carries its sentence in EN and PT, keyed by a stable `code`, following the
 * runtime's one existing convention for user-facing wording (`sandbox/sentences.ts`). Policy
 * verdict sentences are EN-only because the MODEL reads them; these are read by a PERSON in
 * `/catalogue`.
 */

import type { PolicyRule } from '../policy/rules.ts'

/** The kinds a catalogue entry can be (§3.1). */
export type CatalogueKind = 'command' | 'skill' | 'agent' | 'mcpServer' | 'permissionProfile' | 'afterEdit'

export const CATALOGUE_KINDS: readonly CatalogueKind[] = ['command', 'skill', 'agent', 'mcpServer', 'permissionProfile', 'afterEdit']

/**
 * Names reserved for kinds that have NO parser. `plugin` is D9's: the contract now, the loader on
 * demand, never code executed in-process. Nothing in this directory accepts it as a kind.
 */
export const RESERVED_KINDS: readonly string[] = ['plugin']

export type CatalogueScope = 'builtin' | 'user' | 'project' | 'compat'

/**
 * Precedence (§3.5 rule 1): the more specific scope wins — `project` > `user` > `compat` >
 * `builtin`. A HIGHER number wins.
 */
export const SCOPE_RANK: Record<CatalogueScope, number> = { builtin: 0, compat: 1, user: 2, project: 3 }

/** An entry's name: `[a-z0-9][a-z0-9-]{0,63}`, unique per kind after precedence. */
export const CATALOGUE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Where an installed entry came from (B8.10's lockfile). Only carried here, never computed. */
export interface LockRef {
  /** The lockfile's own label (host-supplied path). */
  lockfile: string
  /** The entry's key inside the lockfile. */
  id: string
  /** The hash recorded at install time. */
  sha256: string
}

export interface CatalogueSource {
  path?: string
  sha256?: string
  installed?: LockRef
}

/** `n/a` outside project scope; project scope is `untrusted` until a person trusts it (§4, B8.3). */
export type CatalogueTrust = 'n/a' | 'untrusted' | 'trusted'

export type CatalogueLang = 'en' | 'pt'

/** One validation finding. Always a SENTENCE tied to a place (§3.2). */
export interface CatalogueProblem {
  /** Stable, machine-readable (`catalogue.<what>`); a host may localise by it. */
  code: string
  /** The host-supplied label of the file (or `builtin`). */
  path: string
  /** 1-based line the finding is about; `1` when the finding is about the whole file. */
  line: number
  en: string
  pt: string
}

// ── What each kind carries once parsed ──────────────────────────────────────────────────────────

/** `commands/<name>.md` — frontmatter + a prompt TEMPLATE (§5.1). An `!` in it is literal text. */
export interface CommandDef {
  description: string
  /** A one-line hint of the arguments, shown by a surface. */
  args?: string
  /** An agent profile to run the expansion under (narrowed like any profile). */
  agent?: string
  /** A model id, same provider only (§12 Q5 — B8.1 records it; enforcing "same provider" is the host's). */
  model?: string
  /** User scope only: the explicit opt-in to shadow a BUILT-IN command (§3.5 rule 3). */
  override?: boolean
  template: string
}

/** `skills/<name>/SKILL.md` — frontmatter `name` + `description`, body markdown (§5.2). */
export interface SkillDef {
  description: string
  body: string
}

/** `agents/<name>.md` — a named profile; the body is a prompt addendum (§5.3). */
export interface AgentDef {
  description: string
  model?: string
  /** An allowlist over the session's tools. Absent: every tool the session has. */
  tools?: string[]
  permissionProfile?: string
  prompt: string
}

/** A `settings.json` `mcpServers` entry (§3.4). Declared here, connected by B6.3. */
export type McpServerDef =
  | { type: 'stdio'; command: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string>; auth?: { credential: string } }

/** `profiles/<name>.json` — a named `PolicyLayer` in the unchanged `rules.ts` shape (§5.5). */
export interface PermissionProfileDef {
  description?: string
  rules: PolicyRule[]
}

/** A `settings.json` `afterEdit` entry (§3.4, §5.6). */
export interface AfterEditDef {
  /** A glob over the edited path. */
  match: string
  /** argv; `{path}` is substituted by the loop. */
  run: string[]
  timeoutMs?: number
}

export interface CatalogueDefs {
  command: CommandDef
  skill: SkillDef
  agent: AgentDef
  mcpServer: McpServerDef
  permissionProfile: PermissionProfileDef
  afterEdit: AfterEditDef
}

/** §3.2. `def` is absent exactly when the entry could not be parsed far enough to have one. */
export interface CatalogueEntry<K extends CatalogueKind = CatalogueKind> {
  kind: K
  name: string
  scope: CatalogueScope
  source: CatalogueSource
  /** False when a person switched it off, OR when it carries a problem. */
  enabled: boolean
  trust: CatalogueTrust
  /** Said, never silent: the entry this one won over. */
  shadows?: { scope: CatalogueScope; path?: string }
  problems: CatalogueProblem[]
  def?: CatalogueDefs[K]
}

/** `settings.json` (§3.4), after validation. Every field optional; absent means "not said here". */
export interface CatalogueSettings {
  /** User scope only (§3.4) — refused in project scope. */
  defaultModel?: { provider: string; model: string }
  rules?: PolicyRule[]
  /** The permission profile a session starts in. */
  profile?: string
  compat?: { claudeSkills?: boolean; agentsSkills?: boolean }
  skills?: { budgetTokens?: number }
}

/** The trust a scope starts with, before any person's act (§4). */
export function initialTrust(scope: CatalogueScope): CatalogueTrust {
  return scope === 'project' ? 'untrusted' : 'n/a'
}
