/**
 * floor.ts — the machine's policy floor, as GLOBS (1.3).
 *
 * The host's backup plan names every credential path on this machine as a `secret` row
 * (`backup/backup-plan.ts`). An engine's tool policy must refuse every one of them, and the floor is
 * DERIVED from those rows, never restated. Up to 1.2 the host handed each row over as an absolute
 * path (`join(home, pattern)`), which cannot express half of the table: a row matched with
 * `contains` and no `/` (`.key` — the per-session control-socket tokens under `.claude/sessions/`
 * and `.claude/daemon/`) became the single path `~/.key`, and a tool could write
 * `~/.claude/sessions/1.abc.key` freely. This module is the one derivation, in the contract so the
 * host and every engine read the same answer.
 *
 * The dialect is the one an engine's policy matches in: `~/` is the home directory, `*` matches
 * within one segment and `**` any number of segments (including none). `protectedGlobMatches` is
 * that dialect's reference reading — an engine whose matcher disagrees with it on any glob this
 * module produces has a floor that differs from the host's.
 */

/** One backup-plan `secret` row, as the floor reads it. `pattern` is `$HOME`-relative, no leading `/`. */
export interface ProtectedRule {
  pattern: string
  /** `prefix` — a STRING prefix (it matches a filename stem); `contains` — anywhere in the path. */
  match: 'prefix' | 'contains'
}

/** The data dir's own name under `$HOME`. An engine floors that whole directory itself. */
const DATA_DIR = '.agentistics'

/**
 * The directories a `contains` row with no `/` is searched under: every harness home the table
 * names (the first segment of a `prefix` row that has one). Anchored there because a bare
 * `**\/*.key*` would floor any workspace file that merely has `.key` in its name.
 */
function harnessHomes(rules: readonly ProtectedRule[]): string[] {
  const homes = new Set<string>()
  for (const r of rules) {
    if (r.match !== 'prefix' || !r.pattern.includes('/')) continue
    const first = r.pattern.split('/')[0]
    if (first && first.startsWith('.') && first !== DATA_DIR) homes.add(first)
  }
  return [...homes].sort()
}

/**
 * PURE. The policy globs for the backup plan's `secret` rows — sorted, deduplicated.
 *
 * - `prefix` becomes `~/<p>`, `~/<p>*` and `~/<p>*\/**`: the file, its stem siblings (`cache.db`
 *   catches `cache.db-wal`) and anything below a directory of that name.
 * - `contains` with a `/` (`.copilot/token`) becomes `~/**\/<p>*` and its subtree.
 * - `contains` with no `/` (`.key`) becomes `~/<home>/**\/*<p>*` for every harness home the table
 *   names — so `~/.claude/x.key` and `~/.claude/sessions/creds.key.json` are both floored.
 * - A `#field` suffix names a FIELD inside a file (`preferences.json#team.token`); the whole file
 *   is floored, which is the over-protective direction.
 *
 * `.agentistics/…` rows are skipped: the engine floors the data directory itself, wherever the host
 * says it is (`paths.dataDir`, `paths.defaultDataDir`).
 */
export function protectedGlobs(rules: readonly ProtectedRule[]): string[] {
  const out = new Set<string>()
  const homes = harnessHomes(rules)
  for (const r of rules) {
    const p = (r.pattern.split('#')[0] ?? '').replace(/^\/+/, '').replace(/\/+$/, '')
    if (!p || p === DATA_DIR || p.startsWith(`${DATA_DIR}/`)) continue
    if (r.match === 'prefix') {
      out.add(`~/${p}`); out.add(`~/${p}*`); out.add(`~/${p}*/**`)
    } else if (p.includes('/')) {
      out.add(`~/**/${p}*`); out.add(`~/**/${p}*/**`)
    } else {
      for (const h of homes) out.add(`~/${h}/**/*${p}*`)
    }
  }
  return [...out].sort()
}

function escapeRe(c: string): string {
  return /[.+^${}()|[\]\\?*]/.test(c) ? `\\${c}` : c
}

/**
 * PURE. Does `glob` (the dialect above) match the ABSOLUTE `path`, with `~` read as `home`? The
 * reference reading of the globs `protectedGlobs` produces — `*` and `**` only.
 */
export function protectedGlobMatches(glob: string, path: string, home: string): boolean {
  const abs = glob === '~' ? home : glob.startsWith('~/') ? `${home.replace(/\/+$/, '')}/${glob.slice(2)}` : glob
  const parts = abs.split('/')
  let re = ''
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i] ?? ''
    if (seg === '**') {
      re += i === parts.length - 1 ? '(?:/.*)?' : '(?:/[^/]+)*'
      continue
    }
    if (i > 0) re += '/'
    for (const c of seg) re += c === '*' ? '[^/]*' : escapeRe(c)
  }
  const target = path.length > 1 ? path.replace(/\/+$/, '') : path
  return new RegExp(`^${re}$`).test(target)
}

/** PURE. Is `path` under the floor `globs` describe? */
export function floored(globs: readonly string[], path: string, home: string): boolean {
  return globs.some(g => protectedGlobMatches(g, path, home))
}
