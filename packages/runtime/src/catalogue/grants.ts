/**
 * catalogue/grants.ts — TRUST for a project catalogue (B8 spec §4, B8.3). PURE: it is handed the
 * parsed project catalogue and the grants file's TEXT, and returns data. Where the file lives, its
 * mode and who may write it are the host's (`harness-grants.ts`).
 *
 * ## The grants hash covers exactly what trust UNLOCKS
 *
 * A project's catalogue arrives inside a repository, so the parts of it that grant power wait for
 * a person's act (§4). At trust time the host records a hash of the POWER-GRANTING subset; on every
 * load it recomputes it, and a different hash drops the project back to `untrusted`. The subset is
 * precisely the set of things the loader withholds from an untrusted project — nothing more, or a
 * text edit re-asks and people learn to trust without reading; nothing less, or a `git pull` can
 * add power to a folder trusted last month without anyone being asked:
 *
 * | part | key | what is hashed |
 * |---|---|---|
 * | an `allow` rule in `settings.json` | `rule:<id>` | the whole rule |
 * | the starting `profile` in `settings.json` | `profile` | the name |
 * | an MCP server | `mcpServer:<name>` | the whole declaration |
 * | an after-edit step | `afterEdit:<name>` | the whole step |
 * | a permission profile with an `allow` rule | `permissionProfile:<name>` | its allow rules only |
 * | an agent that lists tools or names a profile | `agent:<name>` | `tools` + `permissionProfile` only |
 *
 * `deny`/`ask` rules, commands, skills, and an agent's description, model and prompt are TEXT or
 * restrictions: they apply untrusted, and editing them does not re-ask (§4, criterion 2).
 *
 * An entry the parser could not read far enough to have a `def` is still hashed (as `null`): the
 * day its typo is fixed it starts granting, and that is a change the person must be asked about.
 *
 * What is hashed is the catalogue AS PARSED on this machine, i.e. after the parsers refused every
 * rule aiming at the deny floor. So a change to the machine's own floor (`protectedPaths`, a
 * relocated data dir) that changes which allow rules survive is also a change and re-asks: a rule
 * the floor used to swallow and now lets through is power the person never saw when trusting.
 *
 * ## The file — everything a trust earned lives UNDER the project's record
 *
 * `harness-grants.json` is `{ version, projects: { <realpath>: { trust?, servers? } }, user? }`.
 * Revoking trust deletes the project's WHOLE record, so "nothing the first trust earned survives
 * the revocation" (criterion 2) is structural rather than a list somebody must keep complete: a
 * future grant keyed to a project is added inside that record and is cleared with it. `servers` is
 * B6.3's per-server MCP approval store; its place is reserved here and it is cleared on untrust.
 *
 * ## A corrupt file reads as NOTHING trusted
 *
 * Any structural doubt — not JSON, a wrong version, one malformed record — makes the whole file
 * read as empty and `corrupt: true`. Salvaging the records that look fine would be trusting a file
 * something has already written garbage into.
 */

import { sha256Hex } from '@agentistics/core'
import { canonicalJson } from '../loop/repeat-guard.ts'
import type { PolicyRule } from '../policy/rules.ts'
import { grantsPower } from './precedence.ts'
import type { AgentDef, CatalogueEntry, PermissionProfileDef } from './types.ts'

// ── The manifest: what trust unlocks, one digest per part ───────────────────────────────────────

export interface GrantsManifest {
  /** sha256 over the canonical `parts` map — what `harness-grants.json` records as `grants`. */
  hash: string
  /** Part key (see the module header) → the digest of that part. Sorted keys. */
  parts: Record<string, string>
}

export interface GrantsInput {
  /** The PROJECT `settings.json`, as parsed — before any trust gate. Absent: the project has none. */
  settings?: { rules?: readonly PolicyRule[]; profile?: string }
  /** The project's parsed entries (any kind; only power-granting ones are hashed). */
  entries: readonly CatalogueEntry[]
}

function digest(value: unknown): string {
  return sha256Hex(canonicalJson(value ?? null))
}

function powerPart(e: CatalogueEntry): unknown {
  switch (e.kind) {
    case 'permissionProfile': {
      const def = e.def as PermissionProfileDef | undefined
      return def ? def.rules.filter((r) => r.effect === 'allow') : null
    }
    case 'agent': {
      const def = e.def as AgentDef | undefined
      return def ? { tools: def.tools, permissionProfile: def.permissionProfile } : null
    }
    default:
      return e.def ?? null
  }
}

/** Does this entry belong in the hash? A power kind is hashed even when it could not be parsed. */
function hashed(e: CatalogueEntry): boolean {
  if (e.kind === 'mcpServer' || e.kind === 'afterEdit') return true
  // A profile or agent carrying a problem is hashed whatever its partial def says: the fix that
  // clears the problem may be the edit that makes it grant.
  if (e.kind === 'permissionProfile' || e.kind === 'agent') return e.def === undefined || e.problems.length > 0 || grantsPower(e)
  return grantsPower(e)
}

function uniqueKey(parts: Record<string, string>, key: string): string {
  if (!(key in parts)) return key
  let n = 2
  while (`${key}#${n}` in parts) n++
  return `${key}#${n}`
}

export function grantsManifest(input: GrantsInput): GrantsManifest {
  const raw: Record<string, string> = {}
  for (const r of input.settings?.rules ?? []) {
    if (r.effect !== 'allow') continue
    raw[uniqueKey(raw, `rule:${r.id}`)] = digest(r)
  }
  if (input.settings?.profile !== undefined) raw.profile = digest(input.settings.profile)
  const entries = [...input.entries].filter(hashed).sort((a, b) => {
    const ka = `${a.kind}:${a.name}\u0000${a.source.path ?? ''}`
    const kb = `${b.kind}:${b.name}\u0000${b.source.path ?? ''}`
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
  for (const e of entries) raw[uniqueKey(raw, `${e.kind}:${e.name}`)] = digest(powerPart(e))
  const parts: Record<string, string> = {}
  for (const k of Object.keys(raw).sort()) parts[k] = raw[k] as string
  return { hash: digest(parts), parts }
}

// ── What changed, in words ──────────────────────────────────────────────────────────────────────

export interface GrantsDiff {
  added: string[]
  removed: string[]
  changed: string[]
  /** The record predates per-part digests: something changed, and what cannot be said. */
  unknown: boolean
}

export function diffGrants(before: Record<string, string> | undefined, now: Record<string, string>): GrantsDiff {
  if (before === undefined) return { added: [], removed: [], changed: [], unknown: true }
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  for (const k of Object.keys(now).sort()) {
    if (!(k in before)) added.push(k)
    else if (before[k] !== now[k]) changed.push(k)
  }
  for (const k of Object.keys(before).sort()) if (!(k in now)) removed.push(k)
  return { added, removed, changed, unknown: false }
}

/** One part key as a person reads it: `the MCP server "db"`. */
export function describePart(key: string): { en: string; pt: string } {
  const base = key.replace(/#\d+$/, '')
  const i = base.indexOf(':')
  const kind = i === -1 ? base : base.slice(0, i)
  const name = i === -1 ? '' : base.slice(i + 1)
  switch (kind) {
    case 'rule': return { en: `the allow rule "${name}"`, pt: `a regra allow "${name}"` }
    case 'profile': return { en: 'the starting profile', pt: 'o perfil inicial' }
    case 'mcpServer': return { en: `the MCP server "${name}"`, pt: `o servidor MCP "${name}"` }
    case 'afterEdit': return { en: `the after-edit step "${name}"`, pt: `o passo pós-edição "${name}"` }
    case 'permissionProfile': return { en: `the allow rules of profile "${name}"`, pt: `as regras allow do perfil "${name}"` }
    case 'agent': return { en: `the tools or profile of agent "${name}"`, pt: `as ferramentas ou o perfil do agente "${name}"` }
    default: return { en: `"${key}"`, pt: `"${key}"` }
  }
}

function listOf(keys: readonly string[], lang: 'en' | 'pt'): string {
  return keys.map((k) => describePart(k)[lang]).join(', ')
}

/** The sentence a load shows when a trusted project's power-granting subset moved (§4). */
export function grantsChangeSentence(diff: GrantsDiff): { en: string; pt: string } {
  if (diff.unknown) {
    return {
      en: 'what this project may do changed since it was trusted, so it is untrusted again and everything its trust earned was cleared; trust it again to allow it as it is now.',
      pt: 'o que este projeto pode fazer mudou desde que foi marcado como confiável, então ele voltou a não ser confiável e tudo que a confiança concedeu foi limpo; marque-o como confiável de novo para permiti-lo como está agora.',
    }
  }
  const en: string[] = []
  const pt: string[] = []
  if (diff.added.length > 0) { en.push(`added ${listOf(diff.added, 'en')}`); pt.push(`adicionou ${listOf(diff.added, 'pt')}`) }
  if (diff.changed.length > 0) { en.push(`changed ${listOf(diff.changed, 'en')}`); pt.push(`alterou ${listOf(diff.changed, 'pt')}`) }
  if (diff.removed.length > 0) { en.push(`removed ${listOf(diff.removed, 'en')}`); pt.push(`removeu ${listOf(diff.removed, 'pt')}`) }
  return {
    en: `since this project was trusted it ${en.join('; ')}, so it is untrusted again and everything its trust earned was cleared; trust it again to allow it as it is now.`,
    pt: `desde que este projeto foi marcado como confiável ele ${pt.join('; ')}, então voltou a não ser confiável e tudo que a confiança concedeu foi limpo; marque-o como confiável de novo para permiti-lo como está agora.`,
  }
}

// ── The grants file ─────────────────────────────────────────────────────────────────────────────

export const GRANTS_FILE_VERSION = 1

export interface TrustRecord {
  /** ISO instant of the person's act. */
  trustedAt: string
  /** `GrantsManifest.hash` at that moment. */
  grants: string
  /** `GrantsManifest.parts` at that moment — what lets a later load NAME what changed. */
  parts: Record<string, string>
}

/** B6.3's remembered approval of one MCP server, keyed by the hash of its declaration (§5.4). */
export interface ServerApproval {
  declaration: string
  approvedAt: string
}

/** Everything held for ONE project. Deleting this record is what untrust means. */
export interface ProjectGrants {
  trust?: TrustRecord
  /** Reserved for B6.3: per-server approvals the project's servers obtained. Cleared on untrust. */
  servers?: Record<string, ServerApproval>
}

export interface GrantsFile {
  version: typeof GRANTS_FILE_VERSION
  /** Keyed by the workspace root's REALPATH. */
  projects: Record<string, ProjectGrants>
  /** Reserved for B6.3: approvals of the person's own (user-scope) servers. Never touched by untrust. */
  user?: { servers?: Record<string, ServerApproval> }
}

export function emptyGrantsFile(): GrantsFile {
  return { version: GRANTS_FILE_VERSION, projects: {} }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const HEX64 = /^[0-9a-f]{64}$/

function validDigestMap(v: unknown): v is Record<string, string> {
  return isObj(v) && Object.values(v).every((d) => isStr(d) && HEX64.test(d))
}

function validServers(v: unknown): v is Record<string, ServerApproval> {
  if (!isObj(v)) return false
  for (const a of Object.values(v)) {
    if (!isObj(a) || !isStr(a.declaration) || !isStr(a.approvedAt)) return false
    if (Object.keys(a).some((k) => k !== 'declaration' && k !== 'approvedAt')) return false
  }
  return true
}

function validTrust(v: unknown): v is TrustRecord {
  if (!isObj(v)) return false
  if (Object.keys(v).some((k) => k !== 'trustedAt' && k !== 'grants' && k !== 'parts')) return false
  return isStr(v.trustedAt) && !Number.isNaN(Date.parse(v.trustedAt)) && isStr(v.grants) && HEX64.test(v.grants) && validDigestMap(v.parts)
}

function validProject(v: unknown): v is ProjectGrants {
  if (!isObj(v)) return false
  if (Object.keys(v).some((k) => k !== 'trust' && k !== 'servers')) return false
  if (v.trust !== undefined && !validTrust(v.trust)) return false
  if (v.servers !== undefined && !validServers(v.servers)) return false
  return true
}

export interface ParsedGrants {
  file: GrantsFile
  /** True when the text existed and could not be trusted as a whole. `file` is then empty. */
  corrupt: boolean
}

/** `null` text (no file yet) is an empty, healthy file. Anything doubtful is `corrupt`. */
export function parseGrantsFile(text: string | null): ParsedGrants {
  if (text === null) return { file: emptyGrantsFile(), corrupt: false }
  const bad: ParsedGrants = { file: emptyGrantsFile(), corrupt: true }
  let v: unknown
  try { v = JSON.parse(text) } catch { return bad }
  if (!isObj(v) || v.version !== GRANTS_FILE_VERSION || !isObj(v.projects)) return bad
  if (Object.keys(v).some((k) => k !== 'version' && k !== 'projects' && k !== 'user')) return bad
  for (const [key, p] of Object.entries(v.projects)) if (key === '' || !validProject(p)) return bad
  if (v.user !== undefined) {
    if (!isObj(v.user) || Object.keys(v.user).some((k) => k !== 'servers')) return bad
    if (v.user.servers !== undefined && !validServers(v.user.servers)) return bad
  }
  return { file: v as unknown as GrantsFile, corrupt: false }
}

export function serializeGrantsFile(file: GrantsFile): string {
  const projects: Record<string, ProjectGrants> = {}
  for (const k of Object.keys(file.projects).sort()) projects[k] = file.projects[k] as ProjectGrants
  const out: GrantsFile = { version: GRANTS_FILE_VERSION, projects }
  if (file.user !== undefined) out.user = file.user
  return `${JSON.stringify(out, null, 2)}\n`
}

// ── Decisions ───────────────────────────────────────────────────────────────────────────────────

export type TrustDecision =
  | { state: 'untrusted' }
  | { state: 'trusted'; record: TrustRecord }
  /** Was trusted; the power-granting subset moved. The host must CLEAR the project (§4). */
  | { state: 'changed'; record: TrustRecord; diff: GrantsDiff; en: string; pt: string }

export function trustDecision(file: GrantsFile, key: string, manifest: GrantsManifest): TrustDecision {
  const record = file.projects[key]?.trust
  if (!record) return { state: 'untrusted' }
  if (record.grants === manifest.hash) return { state: 'trusted', record }
  const diff = diffGrants(record.parts, manifest.parts)
  return { state: 'changed', record, diff, ...grantsChangeSentence(diff) }
}

/** What a revocation took away — the audit event names it. */
export interface ClearedGrants {
  /** The project had a trust record. */
  trust: boolean
  /** Names of the MCP servers whose remembered approvals were dropped. Sorted. */
  servers: string[]
}

export function revokeProject(file: GrantsFile, key: string): { file: GrantsFile; cleared: ClearedGrants } {
  const rec = file.projects[key]
  const cleared: ClearedGrants = { trust: rec?.trust !== undefined, servers: Object.keys(rec?.servers ?? {}).sort() }
  if (rec === undefined) return { file, cleared }
  const projects = { ...file.projects }
  delete projects[key]
  return { file: { ...file, projects }, cleared }
}

/**
 * The person trusts the project AS IT IS NOW. If it is already trusted under this very hash nothing
 * changes (`already`). Otherwise the project's record is REPLACED by one holding only the new trust:
 * approvals obtained under an earlier trust do not carry over to a different set of grants.
 */
export function grantTrust(
  file: GrantsFile, key: string, manifest: GrantsManifest, now: Date,
): { file: GrantsFile; already: boolean; cleared: ClearedGrants } {
  const existing = file.projects[key]
  if (existing?.trust?.grants === manifest.hash) {
    return { file, already: true, cleared: { trust: false, servers: [] } }
  }
  const revoked = revokeProject(file, key)
  const trust: TrustRecord = { trustedAt: now.toISOString(), grants: manifest.hash, parts: { ...manifest.parts } }
  return {
    file: { ...revoked.file, projects: { ...revoked.file.projects, [key]: { trust } } },
    already: false,
    cleared: revoked.cleared,
  }
}
