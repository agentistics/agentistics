/**
 * cli-catalogue.ts — `agentop catalogue ls|show` (B8.2): what the native harness catalogue holds
 * here and now, and why anything in it is not in force.
 *
 * It renders `loadCatalogue()`'s view and decides nothing: statuses, problems, inert parts and
 * notices arrive already worded in EN and PT, and this module only PICKS by language. Chrome words
 * (headers, labels, usage, refusals) live in `cli-i18n.ts`. Listing is the product, so an item with
 * a problem is still exit 0.
 *
 * MCP env/header VALUES are never printed — a definition may carry a credential-shaped string, and
 * a listing is the kind of output people paste into an issue. Only the KEYS are shown.
 */
import { redactSecrets } from '@agentistics/core'
import { CATALOGUE_KINDS, problemSentence, type CatalogueKind, type CatalogueScope } from '@agentistics/runtime'
import type { CatalogueItem, ItemStatus, ScopeSettingsView } from './catalogue-plan.ts'
import { loadCatalogue, type LoadCatalogueOptions, type LoadedCatalogue } from './catalogue-host.ts'
import { cliStrings, resolveLang, type CatalogueStrings, type CliLang } from './cli-i18n.ts'

const SCOPES: readonly CatalogueScope[] = ['builtin', 'user', 'project', 'compat']

export interface CatalogueCliDeps {
  stdout: (line: string) => void
  stderr: (line: string) => void
  load: (opts: LoadCatalogueOptions) => Promise<LoadedCatalogue>
  isCentral: () => Promise<boolean>
  lang: () => Promise<CliLang>
  cwd: string
}

async function defaultIsCentral(): Promise<boolean> {
  const { TEAM_CENTRAL } = await import('./config.ts')
  if (TEAM_CENTRAL) return true
  try {
    const { readPreferences } = await import('./preferences.ts')
    const prefs = await readPreferences()
    const mode: string | undefined = prefs.team?.mode
    return mode === 'central'
  } catch {
    return false
  }
}

function defaultDeps(): CatalogueCliDeps {
  return {
    stdout: (line) => { process.stdout.write(`${line}\n`) },
    stderr: (line) => { process.stderr.write(`${line}\n`) },
    load: (opts) => loadCatalogue(opts),
    isCentral: defaultIsCentral,
    lang: resolveLang,
    cwd: process.cwd(),
  }
}

interface Parsed {
  verb: 'ls' | 'show' | 'help'
  positionals: string[]
  kind?: CatalogueKind
  scope?: CatalogueScope
  problems: boolean
  json: boolean
  cwd?: string
}

type ParseResult = { ok: true; parsed: Parsed } | { ok: false; message: (t: CatalogueStrings) => string }

function parseArgs(args: string[]): ParseResult {
  if (args.length === 0) return { ok: true, parsed: { verb: 'help', positionals: [], problems: false, json: false } }
  const [verbRaw, ...rest] = args
  if (verbRaw === 'help' || verbRaw === '--help' || verbRaw === '-h') {
    return { ok: true, parsed: { verb: 'help', positionals: [], problems: false, json: false } }
  }
  if (verbRaw !== 'ls' && verbRaw !== 'show') {
    return { ok: false, message: (t) => t.unknownVerb(verbRaw ?? '') }
  }
  const parsed: Parsed = { verb: verbRaw, positionals: [], problems: false, json: false }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string
    const value = (): string | null => {
      const v = rest[i + 1]
      if (v === undefined || v.startsWith('--')) return null
      i++
      return v
    }
    if (a === '--help' || a === '-h') return { ok: true, parsed: { verb: 'help', positionals: [], problems: false, json: false } }
    if (a === '--json') { parsed.json = true; continue }
    if (a === '--problems' && verbRaw === 'ls') { parsed.problems = true; continue }
    if (a === '--lang') { i++; continue } // read by resolveLang() from argv
    if (a === '--kind' && verbRaw === 'ls') {
      const v = value()
      if (v === null) return { ok: false, message: (t) => t.flagNeedsValue(a) }
      if (!(CATALOGUE_KINDS as readonly string[]).includes(v)) return { ok: false, message: (t) => t.badKind(v, CATALOGUE_KINDS.join(', ')) }
      parsed.kind = v as CatalogueKind
      continue
    }
    if (a === '--scope') {
      const v = value()
      if (v === null) return { ok: false, message: (t) => t.flagNeedsValue(a) }
      if (!(SCOPES as readonly string[]).includes(v)) return { ok: false, message: (t) => t.badScope(v, SCOPES.join(', ')) }
      parsed.scope = v as CatalogueScope
      continue
    }
    if (a === '--cwd') {
      const v = value()
      if (v === null) return { ok: false, message: (t) => t.flagNeedsValue(a) }
      parsed.cwd = v
      continue
    }
    if (a.startsWith('-')) return { ok: false, message: (t) => t.unknownFlag(a) }
    parsed.positionals.push(a)
  }
  if (verbRaw === 'show') {
    if (parsed.positionals.length !== 2) return { ok: false, message: (t) => t.showNeedsArgs }
    const k = parsed.positionals[0] as string
    if (!(CATALOGUE_KINDS as readonly string[]).includes(k)) return { ok: false, message: (t) => t.badKind(k, CATALOGUE_KINDS.join(', ')) }
    parsed.kind = k as CatalogueKind
  } else if (parsed.positionals.length > 0) {
    const extra = parsed.positionals[0] as string
    return { ok: false, message: (t) => t.unknownFlag(extra) }
  }
  return { ok: true, parsed }
}

/** A JSON dump must honour the same rule as the text: env/header VALUES never leave. */
function redactItem(item: CatalogueItem): CatalogueItem {
  if (item.entry.kind !== 'mcpServer' || item.entry.def === undefined) return item
  const def = { ...(item.entry.def as unknown as Record<string, unknown>) }
  for (const key of ['env', 'headers']) {
    const m = def[key]
    if (m && typeof m === 'object') def[key] = Object.fromEntries(Object.keys(m).map((k) => [k, '<redacted>']))
  }
  return { ...item, entry: { ...item.entry, def: def as never } }
}

const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - s.length))
const pick = (lang: CliLang, x: { en: string; pt: string }): string => (lang === 'pt' ? x.pt : x.en)
const sourcePath = (item: CatalogueItem, t: CatalogueStrings): string => item.entry.source.path ?? t.builtinPath

function indent(text: string, by: string): string[] {
  return text.split('\n').map((l) => `${by}${l}`)
}

// ── ls ──────────────────────────────────────────────────────────────────────────────────────────

function itemNotes(item: CatalogueItem, lang: CliLang, t: CatalogueStrings): string[] {
  const out: string[] = []
  const e = item.entry
  if (e.shadows) out.push(t.overrides(e.shadows.scope, e.shadows.path ?? t.builtinPath))
  for (const p of e.problems) out.push(problemSentence(p, lang))
  for (const i of item.inert) out.push(`${i.what}: ${pick(lang, i)}`)
  if (item.backup) out.push(`${t.backupLabel}: ${pick(lang, item.backup)}`)
  return out
}

function settingsLines(v: ScopeSettingsView, lang: CliLang, t: CatalogueStrings): string[] {
  const out: string[] = [`${v.scope}  ${v.path}`]
  const s = v.settings
  if (s.rules !== undefined) {
    out.push(`  ${t.settingsRules}:${s.rules.length === 0 ? ` ${t.noRules}` : ''}`)
    for (const r of s.rules) out.push(`    ${r.effect} ${r.id} ${JSON.stringify(r.match)}`)
  }
  if (s.profile !== undefined) out.push(`  ${t.settingsProfile}: ${s.profile}`)
  if (s.defaultModel !== undefined) out.push(`  ${t.settingsDefaultModel}: ${s.defaultModel.provider}/${s.defaultModel.model}`)
  if (s.compat !== undefined) out.push(`  ${t.settingsCompat}: ${JSON.stringify(s.compat)}`)
  if (s.skills !== undefined) out.push(`  ${t.settingsSkills}: ${JSON.stringify(s.skills)}`)
  for (const p of v.problems) out.push(`  ${problemSentence(p, lang)}`)
  for (const i of v.inert) out.push(`  ${i.what}: ${pick(lang, i)}`)
  return out
}

function hasBackupNote(i: CatalogueItem): boolean { return i.backup !== undefined }

function runLs(cat: LoadedCatalogue, p: Parsed, lang: CliLang, t: CatalogueStrings, out: (l: string) => void): void {
  let items = cat.items
  let settings = cat.settings
  let notices = cat.notices
  if (p.kind) items = items.filter((i) => i.entry.kind === p.kind)
  if (p.scope) {
    items = items.filter((i) => i.entry.scope === p.scope)
    settings = settings.filter((s) => s.scope === p.scope)
    notices = notices.filter((n) => n.scope === p.scope)
  }
  if (p.problems) {
    items = items.filter((i) => i.status === 'disabled' || i.status === 'inert' || hasBackupNote(i))
    settings = settings.filter((s) => s.problems.length > 0 || s.inert.length > 0)
  }
  if (p.kind) { settings = []; notices = [] }

  if (p.json) {
    out(JSON.stringify({ roots: cat.roots, trust: cat.trust, items: items.map(redactItem), settings, notices }, null, 2))
    return
  }

  out(t.roots(cat.roots.workspaceRoot, cat.roots.user, cat.roots.project, cat.roots.compat))
  out(cliStrings(lang).trust.trustLine(cat.trust.state, cat.trust.state === 'trusted' ? cat.trust.trustedAt : undefined))
  out('')
  if (items.length === 0 && settings.length === 0 && notices.length === 0) {
    out(cat.items.length === 0 && cat.settings.length === 0 && cat.notices.length === 0 ? t.emptyList : t.emptyFiltered)
    return
  }
  const w = {
    kind: Math.max(...items.map((i) => i.entry.kind.length), 0),
    name: Math.max(...items.map((i) => i.entry.name.length), 0),
    scope: Math.max(...items.map((i) => i.entry.scope.length), 0),
    status: Math.max(...items.map((i) => t.statusWord[i.status].length), 0),
  }
  for (const i of items) {
    out(`${pad(i.entry.kind, w.kind)}  ${pad(i.entry.name, w.name)}  ${pad(i.entry.scope, w.scope)}  ${pad(t.statusWord[i.status], w.status)}  ${sourcePath(i, t)}`)
    for (const n of itemNotes(i, lang, t)) for (const l of indent(n, '    ')) out(l)
  }
  if (settings.length > 0) {
    out('')
    out(t.settingsHeader)
    for (const s of settings) for (const l of settingsLines(s, lang, t)) out(l)
  }
  if (notices.length > 0) {
    out('')
    out(t.noticesHeader)
    for (const n of notices) out(`${n.path}: ${pick(lang, n)}`)
  }
  const count = (s: ItemStatus): number => items.filter((i) => i.status === s).length
  out('')
  out(t.summary(items.length, count('active'), count('disabled'), count('shadowed'), count('inert')))
}

// ── show ────────────────────────────────────────────────────────────────────────────────────────

function defLines(item: CatalogueItem, t: CatalogueStrings): string[] {
  const e = item.entry
  const out: string[] = []
  const def = e.def as unknown
  if (def === undefined) return [t.noDef]
  const opt = (label: string, v: unknown): void => { if (v !== undefined) out.push(`${label}: ${String(v)}`) }
  const block = (label: string, text: string): void => { out.push(`${label}:`); out.push(...indent(text, '  ')) }
  switch (e.kind) {
    case 'command': {
      const d = def as { description: string; args?: string; agent?: string; model?: string; override?: boolean; template: string }
      opt(t.fieldDescription, d.description); opt(t.fieldArgs, d.args); opt(t.fieldAgent, d.agent); opt(t.fieldModel, d.model)
      if (d.override !== undefined) out.push(`${t.fieldOverride}: ${d.override ? t.yes : t.no}`)
      block(t.fieldTemplate, d.template)
      break
    }
    case 'skill': {
      const d = def as { description: string; body: string }
      opt(t.fieldDescription, d.description)
      block(t.fieldBody, d.body)
      break
    }
    case 'agent': {
      const d = def as { description: string; model?: string; tools?: string[]; permissionProfile?: string; prompt: string }
      opt(t.fieldDescription, d.description); opt(t.fieldModel, d.model)
      if (d.tools !== undefined) out.push(`${t.fieldTools}: ${d.tools.join(', ')}`)
      opt(t.fieldProfile, d.permissionProfile)
      block(t.fieldPrompt, d.prompt)
      break
    }
    case 'mcpServer': {
      const d = def as { type: 'stdio'; command: string[]; env?: Record<string, string> } | { type: 'http'; url: string; headers?: Record<string, string>; auth?: { credential: string } }
      out.push(`${t.fieldType}: ${d.type}`)
      if (d.type === 'stdio') {
        out.push(`${t.fieldCommand}: ${d.command.join(' ')}`)
        if (d.env) out.push(`${t.fieldEnvKeys}: ${Object.keys(d.env).join(', ')}`)
      } else {
        out.push(`${t.fieldUrl}: ${d.url}`)
        if (d.headers) out.push(`${t.fieldHeaderKeys}: ${Object.keys(d.headers).join(', ')}`)
        if (d.auth) out.push(`${t.fieldCredential}: ${d.auth.credential}`)
      }
      break
    }
    case 'permissionProfile': {
      const d = def as { description?: string; rules: Array<{ effect: string; id: string; match: unknown }> }
      opt(t.fieldDescription, d.description)
      out.push(`${t.fieldRules}:`)
      for (const r of d.rules) out.push(`  ${r.effect} ${r.id} ${JSON.stringify(r.match)}`)
      break
    }
    case 'afterEdit': {
      const d = def as { match: string; run: string[]; timeoutMs?: number }
      out.push(`${t.fieldMatch}: ${d.match}`)
      out.push(`${t.fieldRun}: ${d.run.join(' ')}`)
      opt(t.fieldTimeout, d.timeoutMs)
      break
    }
  }
  return out
}

function showLines(item: CatalogueItem, lang: CliLang, t: CatalogueStrings): string[] {
  const e = item.entry
  const out = [
    `${t.fieldKind}: ${e.kind}`,
    `${t.fieldName}: ${e.name}`,
    `${t.fieldScope}: ${e.scope}`,
    `${t.fieldStatus}: ${t.statusWord[item.status]}`,
    `${t.fieldTrust}: ${e.trust}`,
    `${t.fieldEnabled}: ${e.enabled ? t.yes : t.no}`,
    `${t.fieldSource}: ${sourcePath(item, t)}`,
  ]
  if (e.shadows) out.push(`${t.fieldShadows}: ${t.overrides(e.shadows.scope, e.shadows.path ?? t.builtinPath)}`)
  if (e.problems.length > 0) {
    out.push(`${t.fieldProblems}:`)
    for (const p of e.problems) out.push(`  ${problemSentence(p, lang)}`)
  }
  if (item.inert.length > 0) {
    out.push(`${t.fieldInert}:`)
    for (const i of item.inert) out.push(`  ${i.what}: ${pick(lang, i)}`)
  }
  if (item.backup) out.push(`${t.fieldBackup}: ${pick(lang, item.backup)}`)
  out.push(...defLines(item, t))
  return out
}

// ── entry ───────────────────────────────────────────────────────────────────────────────────────

export async function runCatalogue(args: string[], deps: Partial<CatalogueCliDeps> = {}): Promise<number> {
  const d: CatalogueCliDeps = { ...defaultDeps(), ...deps }
  // EVERY string printed below may come from file content (a rule's match, a template, a URL, an
  // argv), and a deny/ask rule that itself carries a secret stays in force by design. So output is
  // buffered and passed once through `redactSecrets` — the whole text, so a multi-line credential
  // cannot slip between two lines. Never print around this.
  const buf: string[] = []
  const flush = (): void => { if (buf.length > 0) d.stdout(redactSecrets(buf.join('\n'))); buf.length = 0 }
  const emit = (l: string): void => { buf.push(l) }
  const lang = await d.lang()
  const t = cliStrings(lang).catalogue
  const r = parseArgs(args)
  if (!r.ok) {
    d.stderr(r.message(t))
    d.stderr(t.usage)
    return 2
  }
  const p = r.parsed
  if (p.verb === 'help') { d.stdout(t.usage); return 0 }
  if (await d.isCentral()) { d.stderr(t.refusedCentral); return 1 }

  const cat = await d.load({ cwd: p.cwd ?? d.cwd })
  if (p.verb === 'ls') {
    runLs(cat, p, lang, t, emit)
    flush()
    return 0
  }
  const name = p.positionals[1] as string
  const matches = cat.items.filter((i) => i.entry.kind === p.kind && i.entry.name === name && (p.scope === undefined || i.entry.scope === p.scope))
  if (matches.length === 0) {
    d.stderr(t.noMatch(p.kind as string, name))
    return 1
  }
  if (p.json) {
    emit(JSON.stringify(matches.map(redactItem), null, 2))
    flush()
    return 0
  }
  matches.forEach((m, idx) => {
    if (idx > 0) emit('')
    for (const l of showLines(m, lang, t)) emit(l)
  })
  flush()
  return 0
}

// ── trust / untrust (B8.3) ──────────────────────────────────────────────────────────────────────

export interface TrustCliDeps {
  stdout: (line: string) => void
  stderr: (line: string) => void
  load: (opts: LoadCatalogueOptions) => Promise<LoadedCatalogue>
  isCentral: () => Promise<boolean>
  lang: () => Promise<CliLang>
  cwd: string
  /** The data dir grants live under. Default `AGENTISTICS_DATA_DIR`. */
  dataDir: string
  now: () => Date
}

async function defaultTrustDeps(): Promise<TrustCliDeps> {
  const { AGENTISTICS_DATA_DIR } = await import('./config.ts')
  const base = defaultDeps()
  return { ...base, dataDir: AGENTISTICS_DATA_DIR, now: () => new Date() }
}

/**
 * `agentop code trust <dir>` / `agentop code untrust <dir>` — the ONLY way a project catalogue
 * gains power (spec §4): a person naming a folder. Nothing in a repository can ask for it, and a
 * central refuses it. Trust is recorded for the folder's WORKSPACE ROOT (the same root the loader
 * reads `.agentistics/` under), for its power-granting subset as it is right now.
 */
export async function runTrust(verb: 'trust' | 'untrust', args: string[], deps: Partial<TrustCliDeps> = {}): Promise<number> {
  const d: TrustCliDeps = { ...(await defaultTrustDeps()), ...deps }
  const lang = await d.lang()
  const t = cliStrings(lang).trust
  const positionals: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '--help' || a === '-h') { d.stdout(t.usage); return 0 }
    if (a === '--lang') { i++; continue }
    if (a.startsWith('-') && a !== '-') { d.stderr(t.unknownArg(a)); d.stderr(t.usage); return 2 }
    positionals.push(a)
  }
  if (positionals.length !== 1) { d.stderr(t.needsDir(verb)); return 2 }
  if (await d.isCentral()) { d.stderr(t.refusedCentral); return 1 }

  const { resolve } = await import('node:path')
  const { stat } = await import('node:fs/promises')
  const { grantTrust, revokeProject, describePart } = await import('@agentistics/runtime')
  const { appendGrantsAudit, projectKey, readGrants, writeGrants } = await import('./harness-grants.ts')
  const { workspaceRootFor } = await import('./runtime-host.ts')

  const dir = resolve(d.cwd, positionals[0] as string)
  const isDir = await stat(dir).then(s => s.isDirectory()).catch(() => false)
  if (verb === 'trust' && !isDir) { d.stderr(t.notADir(dir)); return 1 }
  // An untrust of a folder that is gone must still find the record it left.
  const root = isDir ? workspaceRootFor(dir) : dir
  if (resolve(root) !== dir) d.stdout(t.rootNote(dir, root))
  const now = d.now()
  const out: string[] = []

  if (verb === 'untrust') {
    const key = await projectKey(root)
    const loaded = await readGrants(d.dataDir)
    const { file, cleared } = revokeProject(loaded.file, key)
    if (!cleared.trust && cleared.servers.length === 0) {
      d.stdout(t.wasNotTrusted(key))
      return 0
    }
    try {
      await writeGrants(d.dataDir, file, { corrupt: loaded.corrupt, now })
    } catch (err) {
      d.stderr(t.writeFailed((err as NodeJS.ErrnoException).code ?? 'EIO'))
      return 1
    }
    await appendGrantsAudit(d.dataDir, {
      action: 'harness.untrust', targetId: key, ip: 'local',
      meta: { root: key, clearedTrust: cleared.trust, clearedServers: cleared.servers },
    }, now)
    out.push(t.untrusted(key))
    if (cleared.trust) out.push(t.clearedTrust)
    if (cleared.servers.length > 0) out.push(t.clearedServers(cleared.servers))
    out.push(t.nextLoadAsks)
    d.stdout(out.join('\n'))
    return 0
  }

  // trust — load first: the loader computes the hash, and drops (and audits) a stale trust itself.
  const cat = await d.load({ cwd: root, workspaceRoot: root, dataDir: d.dataDir, now })
  if (cat.roots.project === null || cat.grants === null) { d.stderr(t.projectIsDataDir(root)); return 1 }
  const key = await projectKey(root)
  const loaded = await readGrants(d.dataDir)
  const r = grantTrust(loaded.file, key, cat.grants, now)
  if (r.already) { d.stdout(t.alreadyTrusted(key)); return 0 }
  try {
    await writeGrants(d.dataDir, r.file, { corrupt: loaded.corrupt, now })
  } catch (err) {
    d.stderr(t.writeFailed((err as NodeJS.ErrnoException).code ?? 'EIO'))
    return 1
  }
  const parts = Object.keys(cat.grants.parts)
  await appendGrantsAudit(d.dataDir, {
    action: 'harness.trust', targetId: key, ip: 'local',
    meta: {
      root: key, grants: cat.grants.hash, granted: parts,
      replacedTrust: r.cleared.trust, clearedServers: r.cleared.servers,
    },
  }, now)
  out.push(t.trusted(key))
  if (loaded.corrupt) out.push(t.corruptMoved)
  if (r.cleared.trust) out.push(t.replacedEarlier(r.cleared.servers))
  if (parts.length === 0) out.push(t.grantsNothing)
  else {
    out.push(t.nowAllowed)
    for (const k of parts) out.push(`  ${describePart(k)[lang]}`)
  }
  // Part names come from file content (a rule id, a server name): same redaction as the listing.
  d.stdout(redactSecrets(out.join('\n')))
  return 0
}
