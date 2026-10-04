/**
 * marketplace.ts — the WIRE shape of `/api/marketplace` (MKT.UI) and the few pure readings both ends
 * share. The installer itself is the engine's (`harness-sources.ts` / `harness-install.ts`, B8.10); the
 * route is a door onto the SAME code `agentop code install|installed|update|uninstall` runs, so this
 * file holds no rule about what may be installed — only what the answer looks like and how a list of
 * it is searched.
 *
 * Nothing here carries a secret: a source URL is returned with any `user:password@` stripped
 * (`redactUrlCredentials`), and no key, token or file content is ever part of an answer.
 */

/** How a source was trusted (`harness.lock.json`'s `trust`). */
export type MarketplaceTrust = 'official' | 'user' | 'compat'

/** The catalogue kinds an install can carry (the engine's `InstallKind`). */
export type MarketplaceEntryKind = 'skill' | 'command' | 'agent' | 'permissionProfile'

/** The kind filter the browse view offers. An index `kind` is free text (`bundle` is common), so a
 *  listing that names none of these is reached through "all". */
export const MARKETPLACE_KINDS = ['skill', 'plugin', 'agent', 'mcp', 'profile'] as const
export type MarketplaceKindFilter = 'all' | (typeof MARKETPLACE_KINDS)[number]

/** One package of the signed index, as the browse view lists it. */
export interface MarketplaceListing {
  name: string
  version: string
  kind: string
  description: string
  author: string
  source: string
  sha256: string
  /** The version installed here from the official marketplace, or null. */
  installedVersion: string | null
}

/** `GET /api/marketplace/index`. `official.ok: false` carries the installer's own refusal sentence
 *  (unreachable, unsigned, signed by an unknown key) — never an empty list standing in for it. */
export interface MarketplaceIndexAnswer {
  url: string
  official:
    | { ok: true; issuedAt: string; keyId: string; packages: MarketplaceListing[] }
    | { ok: false; sentence: string }
}

/** What the person is asked, by the CLI and by the page alike. */
export type MarketplaceQuestion = 'install' | 'install-powers' | 'update' | 'update-gained'

/** The trust screen: everything `agentop code install` prints before it asks. */
export interface MarketplaceTrustScreen {
  spec: string
  name: string | null
  version: string
  previousVersion: string | null
  origin: string
  ref: string | null
  trust: MarketplaceTrust
  description: string | null
  author: string | null
  entries: { kind: MarketplaceEntryKind; name: string; files: number }[]
  /** Files a compat install does not carry (Claude Code-only, or power-bearing). */
  skipped: string[]
  /** EVERY declared power, in full. */
  powers: string[]
  /** On an update: what the new version gains and loses. */
  diff: { gained: string[]; lost: string[] } | null
  /** A user source's hash, which the person confirms (the CLI's `--sha256`). Null for official/compat. */
  pin: string | null
  /** The package's files hash: what the person looked at. */
  filesSha256: string
  question: MarketplaceQuestion
}

/** What an install request says the person accepted. The engine re-reads the source and refuses
 *  when what it would install is not exactly this — nothing is granted that was not shown. */
export interface MarketplaceAccept {
  filesSha256: string
  powers: string[]
  pin?: string
}

export type MarketplaceLockStatus = 'ok' | 'changed' | 'missing'

export interface MarketplaceInstalledEntry {
  kind: MarketplaceEntryKind
  name: string
  sha256: string
  /** `changed`: a file differs from the locked hash, so the entry is DISABLED until reinstalled. */
  status: MarketplaceLockStatus
  installedAt: string
}

/** One installed package — or one loose entry installed without a package name. */
export interface MarketplaceInstalledPackage {
  /** What uninstall takes: `pkg:<name>`, or `<kind>/<name>` for a loose entry. */
  target: string
  name: string
  version: string | null
  trust: MarketplaceTrust
  origin: string
  ref: string | null
  powers: string[]
  entries: MarketplaceInstalledEntry[]
  installedAt: string
  /** Only a named package can be updated (`agentop code update <package>`). */
  updatable: boolean
  /** A newer version in the signed index (official packages only), or null. */
  update: { version: string } | null
}

export interface MarketplaceInstalledAnswer {
  packages: MarketplaceInstalledPackage[]
  /** Why updates could not be checked (the index was unreadable), or null. */
  updatesUnknown: string | null
}

/** PURE. Does an index listing's free-text `kind` fall under a filter? */
export function marketplaceKindMatches(kind: string, filter: MarketplaceKindFilter): boolean {
  if (filter === 'all') return true
  const k = kind.trim().toLowerCase()
  if (filter === 'profile') return k === 'profile' || k === 'permissionprofile'
  if (filter === 'mcp') return k === 'mcp' || k === 'mcp-server'
  return k === filter
}

/** PURE. The browse view's search: name, description and author, case-insensitive, plus the kind. */
export function filterListings(listings: readonly MarketplaceListing[], query: string, kind: MarketplaceKindFilter): MarketplaceListing[] {
  const q = query.trim().toLowerCase()
  return listings.filter(l => marketplaceKindMatches(l.kind, kind)
    && (!q || `${l.name}\n${l.description}\n${l.author}`.toLowerCase().includes(q)))
}

/** PURE. A URL (or a sentence holding one) with any `user[:password]@` removed. */
export function redactUrlCredentials(s: string): string {
  return s.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1')
}

/** PURE. The kinds of source the "add a source" form accepts, read off the spelling. */
export type MarketplaceSourceKind = 'market' | 'git' | 'archive' | 'claude' | 'folder' | 'invalid'
export function marketplaceSourceKind(spec: string): MarketplaceSourceKind {
  const s = spec.trim()
  if (!s) return 'invalid'
  if (s.startsWith('market:')) return 'market'
  if (s.startsWith('git+')) return 'git'
  if (/^(https?|file):\/\/.+\.(tar\.gz|tgz)$/.test(s)) return 'archive'
  if (s.startsWith('claude:')) return s.length > 'claude:/'.length && s.slice(7).startsWith('/') ? 'claude' : 'invalid'
  if (s.startsWith('/')) return 'folder'
  return 'invalid'
}
