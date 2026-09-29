/**
 * catalogue/precedence.ts — which entry of a name is the ACTIVE one, and what a narrower scope may
 * change about a wider one's power (B8 spec §3.5). PURE: it is handed entries and returns data.
 *
 * ## Rule 1 — the more specific scope wins
 *
 * `project` > `user` > `compat` > `builtin` (`SCOPE_RANK`). Only an ELIGIBLE entry (`enabled` with
 * no problems) can win, and that is deliberate in both directions:
 *
 * - **A problem entry never wins.** A typo in a project's skill must not silently swap which skill
 *   is active for the one underneath — the person would be running a different skill than the
 *   files say and nothing would explain it.
 * - **A switched-off entry (`enabled: false`, no problems) lets the wider one show through.**
 *   That is what switching it off means.
 *
 * Either way the non-eligible entry stays in `entries`, unchanged, so `/catalogue` can say it
 * exists and why it is not in force (criterion 4: nothing is dropped). Within `entries` each
 * (kind, name) therefore holds at most ONE enabled entry — the winner. The eligible losers are
 * returned apart in `shadowed`, and the winner's `shadows` names the entry it won over (the next
 * eligible one down), never silently.
 *
 * ## Rule 3 — a built-in command is not redefined by a file
 *
 * A repository ships inside the thing an agent is working on; letting its `commands/help.md`
 * replace `/help` would be a repository redefining the tool's own verbs. So a `project` (or
 * `compat`, which never carries commands but is treated the same) command sharing a name with a
 * built-in one can NEVER win: it is listed, disabled, with a sentence. A `user` command may
 * shadow a built-in only with `override: true` in its own frontmatter — the person's explicit
 * act — and then the listing says it shadows the built-in. The built-in guard looks at whether a
 * built-in of that name EXISTS, not whether it is enabled: refusing depends on what the name
 * means, not on a switch.
 *
 * ## Duplicates and ordering
 *
 * Two candidates of one (kind, name, scope) — two files claiming one name in one place — are not
 * resolved by "last wins". The first (in the deterministic order below) stays; the rest become
 * `catalogue.duplicate-name` problems, disabled and listed. Every output is sorted by kind
 * (`CATALOGUE_KINDS` order), name, scope rank descending, then `source.path`, so the result never
 * depends on the order the host happened to list a directory.
 *
 * ## Rule 2 — power NARROWS, it does not override
 *
 * A narrower scope's profile or agent may REMOVE tools or ADD deny/ask. It never adds an allow, a
 * tool or a server the wider scope did not grant, unless it may. WHO may is settled here in one
 * place (`mayWiden`): **only `project` scope needs trust**. `user` scope is the person's own file
 * — their allows are their own decision — and `compat`/`builtin` are not files a repository
 * controls. A `project` scope is content that arrives inside a repository, so its widening waits
 * for an act of trust (B8.3). The functions below produce a PLAN (data) and name what they
 * ignored in a sentence; composing the rules themselves stays in `policy/rules.ts`.
 */

import { problem, withProblems } from './problems.ts'
import {
  CATALOGUE_KINDS,
  SCOPE_RANK,
  type AgentDef,
  type CatalogueEntry,
  type CatalogueKind,
  type CatalogueScope,
  type PermissionProfileDef,
} from './types.ts'
import type { PolicyRule } from '../policy/rules.ts'

export interface CatalogueResolution {
  /** Every winner plus every entry that was not eligible, unchanged. Nothing is dropped. */
  entries: CatalogueEntry[]
  /** Eligible entries that lost to a more specific one. */
  shadowed: CatalogueEntry[]
}

function pathOf(e: CatalogueEntry): string {
  return e.source.path ?? 'builtin'
}

function eligible(e: CatalogueEntry): boolean {
  return e.enabled && e.problems.length === 0
}

function compareEntries(a: CatalogueEntry, b: CatalogueEntry): number {
  const k = CATALOGUE_KINDS.indexOf(a.kind) - CATALOGUE_KINDS.indexOf(b.kind)
  if (k !== 0) return k
  if (a.name !== b.name) return a.name < b.name ? -1 : 1
  const s = SCOPE_RANK[b.scope] - SCOPE_RANK[a.scope]
  if (s !== 0) return s
  const pa = a.source.path ?? ''
  const pb = b.source.path ?? ''
  return pa === pb ? 0 : pa < pb ? -1 : 1
}

/** A command that may not take the place of a built-in one, with the reason as a problem. */
function refuseBuiltinShadow(e: CatalogueEntry): CatalogueEntry | null {
  if (e.kind !== 'command') return null
  const p = pathOf(e)
  if (e.scope === 'project' || e.scope === 'compat') {
    return withProblems(e, [problem(
      'catalogue.builtin-shadow-refused', p, 1,
      `a repository may not redefine the built-in /${e.name} command; rename this command.`,
      `um repositório não pode redefinir o comando embutido /${e.name}; renomeie este comando.`,
    )])
  }
  if (e.scope === 'user') {
    const def = e.def as { override?: boolean } | undefined
    if (def?.override === true) return null
    return withProblems(e, [problem(
      'catalogue.builtin-shadow-needs-override', p, 1,
      `/${e.name} is a built-in command; add \`override: true\` to the frontmatter to replace it, or rename this one.`,
      `/${e.name} é um comando embutido; adicione \`override: true\` ao frontmatter para substituí-lo, ou renomeie este.`,
    )])
  }
  return null
}

export function resolveCatalogue(candidates: readonly CatalogueEntry[]): CatalogueResolution {
  const sorted = [...candidates].sort(compareEntries)
  const groups = new Map<string, CatalogueEntry[]>()
  for (const e of sorted) {
    const key = `${e.kind}\u0000${e.name}`
    const g = groups.get(key)
    if (g) g.push(e)
    else groups.set(key, [e])
  }

  const entries: CatalogueEntry[] = []
  const shadowed: CatalogueEntry[] = []

  for (const group of groups.values()) {
    // 1. Same scope twice: the first stays, the rest are problems (never a silent last-wins).
    const seenScopes = new Set<CatalogueScope>()
    let work = group.map((e) => {
      if (!eligible(e)) return e
      if (!seenScopes.has(e.scope)) {
        seenScopes.add(e.scope)
        return e
      }
      return withProblems(e, [problem(
        'catalogue.duplicate-name', pathOf(e), 1,
        `another ${e.kind} named "${e.name}" already exists in ${e.scope} scope; this one is disabled.`,
        `já existe outro(a) ${e.kind} chamado(a) "${e.name}" no escopo ${e.scope}; este foi desativado.`,
      )])
    })

    // 2. A built-in command's name is not up for grabs.
    if (work.some((e) => e.kind === 'command' && e.scope === 'builtin')) {
      work = work.map((e) => {
        if (!eligible(e) || e.scope === 'builtin') return e
        return refuseBuiltinShadow(e) ?? e
      })
    }

    // 3. The most specific eligible entry wins; the rest of the eligible ones are shadowed.
    const live = work.filter(eligible)
    for (const e of work) if (!eligible(e)) entries.push(e)
    const winner = live[0]
    if (!winner) continue
    const under = live[1]
    if (under) {
      const shadows: NonNullable<CatalogueEntry['shadows']> = { scope: under.scope }
      if (under.source.path !== undefined) shadows.path = under.source.path
      entries.push({ ...winner, shadows })
    } else entries.push(winner)
    for (const loser of live.slice(1)) shadowed.push(loser)
  }

  return { entries: entries.sort(compareEntries), shadowed: shadowed.sort(compareEntries) }
}

// ── Narrowing (§3.5 rule 2) ─────────────────────────────────────────────────────────────────────

export interface NarrowingIgnored {
  /** What was left out (a rule id, a tool, a profile or server name). */
  what: string
  en: string
  pt: string
}

export interface NarrowingPlan<T> {
  effective: T
  ignored: NarrowingIgnored[]
}

export interface NarrowingOpts {
  /** Whether the project this entry lives in has been trusted (B8.3). */
  trusted: boolean
}

/** May an entry of this scope ADD power over a wider one? Only project scope needs trust. */
function mayWiden(scope: CatalogueScope, trusted: boolean): boolean {
  return scope === 'project' ? trusted : true
}

const NEEDS_TRUST_EN = 'needs trust'
const NEEDS_TRUST_PT = 'precisa de confiança'

/**
 * Effective profile = the wider profile's rules, then the narrower's. Deny and ask rules are
 * ALWAYS added (they only remove power). Allow rules are added only when `mayWiden`; otherwise
 * each is listed by rule id. Rules keep layer order (wider first) because at equal specificity
 * the earlier layer wins in `rules.ts`. An id that appears in both is KEPT in both: ids are labels
 * for the journal, and dropping a colliding narrower deny would remove a restriction. The
 * description comes from the narrower when it has one (text, not power).
 */
export function planProfileNarrowing(
  wider: CatalogueEntry<'permissionProfile'>,
  narrower: CatalogueEntry<'permissionProfile'>,
  opts: NarrowingOpts,
): NarrowingPlan<PermissionProfileDef> {
  const base: PolicyRule[] = wider.def?.rules ?? []
  const extra: PolicyRule[] = narrower.def?.rules ?? []
  const allowed = mayWiden(narrower.scope, opts.trusted)
  const rules: PolicyRule[] = [...base]
  const ignored: NarrowingIgnored[] = []
  for (const r of extra) {
    if (r.effect !== 'allow' || allowed) rules.push(r)
    else {
      ignored.push({
        what: r.id,
        en: `allow rule "${r.id}" from ${narrower.scope} scope ${NEEDS_TRUST_EN}; it is not applied.`,
        pt: `a regra allow "${r.id}" do escopo ${narrower.scope} ${NEEDS_TRUST_PT}; não foi aplicada.`,
      })
    }
  }
  const effective: PermissionProfileDef = { rules }
  const description = narrower.def?.description ?? wider.def?.description
  if (description !== undefined) effective.description = description
  return { effective, ignored }
}

/**
 * Agent narrowing. `tools`: absent in the narrower keeps the wider's. Present: it replaces the
 * wider's when the wider had no list (that only removes from "everything") or when the narrower
 * may widen; otherwise it is intersected with the wider's list and the extras are listed.
 * `permissionProfile`: naming a different profile (or naming one where the wider named none) may
 * be a widening, so it is ignored and listed unless the narrower may widen. `description`,
 * `model` and `prompt` come from the narrower — text and a same-provider model are not power.
 */
export function planAgentNarrowing(
  wider: CatalogueEntry<'agent'>,
  narrower: CatalogueEntry<'agent'>,
  opts: NarrowingOpts,
): NarrowingPlan<AgentDef> {
  const w = wider.def
  const n = narrower.def
  if (!n) return { effective: w ?? { description: '', prompt: '' }, ignored: [] }
  const base: AgentDef = w ?? { description: '', prompt: '' }
  const allowed = mayWiden(narrower.scope, opts.trusted)
  const ignored: NarrowingIgnored[] = []
  const effective: AgentDef = { description: n.description, prompt: n.prompt }
  const model = n.model ?? base.model
  if (model !== undefined) effective.model = model

  let tools = base.tools
  if (n.tools !== undefined) {
    if (base.tools === undefined || allowed) tools = [...n.tools]
    else {
      const have = base.tools
      tools = n.tools.filter((t) => have.includes(t))
      for (const t of n.tools) {
        if (have.includes(t)) continue
        ignored.push({
          what: t,
          en: `tool "${t}" is not granted by the wider agent; adding it ${NEEDS_TRUST_EN}.`,
          pt: `a ferramenta "${t}" não é concedida pelo agente mais amplo; adicioná-la ${NEEDS_TRUST_PT}.`,
        })
      }
    }
  }
  if (tools !== undefined) effective.tools = tools

  let profile = base.permissionProfile
  if (n.permissionProfile !== undefined && n.permissionProfile !== base.permissionProfile) {
    if (allowed) profile = n.permissionProfile
    else {
      ignored.push({
        what: n.permissionProfile,
        en: `permission profile "${n.permissionProfile}" may widen the wider agent's; switching it ${NEEDS_TRUST_EN}.`,
        pt: `o perfil de permissão "${n.permissionProfile}" pode ampliar o do agente mais amplo; trocá-lo ${NEEDS_TRUST_PT}.`,
      })
    }
  }
  if (profile !== undefined) effective.permissionProfile = profile

  return { effective, ignored }
}

export interface McpShadowDecision {
  decision: 'use' | 'needs-trust'
  en: string
  pt: string
}

/**
 * A project-scope server — new, or replacing a wider declaration of the same name (a different
 * process is a different grant) — needs trust while the project is untrusted. User scope is the
 * person's own. Starting servers and approving them are B6.3 / B8.3 / B8.8; this only decides.
 */
export function planMcpServerShadow(
  wider: CatalogueEntry<'mcpServer'> | undefined,
  narrower: CatalogueEntry<'mcpServer'>,
  opts: NarrowingOpts,
): McpShadowDecision {
  if (mayWiden(narrower.scope, opts.trusted)) {
    return {
      decision: 'use',
      en: `MCP server "${narrower.name}" from ${narrower.scope} scope is used.`,
      pt: `o servidor MCP "${narrower.name}" do escopo ${narrower.scope} será usado.`,
    }
  }
  return wider
    ? {
        decision: 'needs-trust',
        en: `the project declares its own MCP server "${narrower.name}", replacing the ${wider.scope} one; it ${NEEDS_TRUST_EN} before it runs.`,
        pt: `o projeto declara seu próprio servidor MCP "${narrower.name}", substituindo o do escopo ${wider.scope}; ele ${NEEDS_TRUST_PT} antes de rodar.`,
      }
    : {
        decision: 'needs-trust',
        en: `the project declares an MCP server "${narrower.name}"; it ${NEEDS_TRUST_EN} before it runs.`,
        pt: `o projeto declara um servidor MCP "${narrower.name}"; ele ${NEEDS_TRUST_PT} antes de rodar.`,
      }
}

/**
 * Does this entry GRANT power (the subset B8.3 hashes for trust)? MCP servers and after-edit
 * hooks run processes; a profile with any allow rule grants; an agent that lists tools or names a
 * permission profile is shaping power. Commands and skills are text.
 */
export function grantsPower(entry: CatalogueEntry): boolean {
  const kind: CatalogueKind = entry.kind
  switch (kind) {
    case 'mcpServer':
    case 'afterEdit':
      return true
    case 'permissionProfile': {
      const def = entry.def as PermissionProfileDef | undefined
      return def?.rules.some((r) => r.effect === 'allow') ?? false
    }
    case 'agent': {
      const def = entry.def as AgentDef | undefined
      return def !== undefined && (def.tools !== undefined || def.permissionProfile !== undefined)
    }
    default:
      return false
  }
}
