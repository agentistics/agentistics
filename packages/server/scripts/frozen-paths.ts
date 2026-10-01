// PURE: may this pull request touch the paths the ENGINE repo now owns?
//
// The list lives in `.github/frozen-engine-paths.txt` and is read by `frozen-paths-check.ts`;
// nothing here does IO. The one exception is the ES.4 deletion PR — its title carries
// `[ES.4]` and its only change to a frozen path is deletion. A rename is not a deletion: the
// caller diffs with `--no-renames`, so a moved file arrives as D + A and the A is refused.

export const ES4_TAG = '[ES.4]'
export const ENGINE_REPO = 'agentistics/agentistics-engine'

export type ChangeStatus = 'A' | 'M' | 'D' | 'T' | 'C' | 'R' | 'U' | 'X'
export interface Change { status: ChangeStatus; path: string }

export interface FrozenViolation { path: string; status: ChangeStatus; sentence: string }
export interface FrozenVerdict { ok: boolean; violations: FrozenViolation[]; deleted: string[] }

/** Parses the list file: one glob per line, `#` comments and blank lines ignored. */
export function parseFrozenList(text: string): string[] {
  return text
    .split('\n')
    .map(l => l.replace(/#.*$/, '').trim())
    .filter(l => l.length > 0)
}

/** `**` crosses directories, `*` stays inside one segment; everything else is literal. */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*'
      i++
    } else if (c === '*') {
      re += '[^/]*'
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

export function isFrozen(path: string, globs: readonly string[]): boolean {
  return globs.some(g => globToRegExp(g).test(path))
}

/** `git diff --name-status --no-renames` output → changes. Unparseable lines are dropped. */
export function parseNameStatus(text: string): Change[] {
  const out: Change[] = []
  for (const line of text.split('\n')) {
    const parts = line.split('\t')
    if (parts.length < 2) continue
    const status = parts[0]!.trim().charAt(0) as ChangeStatus
    // With renames/copies (if ever passed) the NEW path is last; the old one is a deletion too.
    if ((status === 'R' || status === 'C') && parts.length >= 3) {
      if (status === 'R') out.push({ status: 'D', path: parts[1]! })
      out.push({ status: 'A', path: parts[2]! })
      continue
    }
    out.push({ status, path: parts[1]! })
  }
  return out
}

export function hasEs4Tag(title: string): boolean {
  return title.includes(ES4_TAG)
}

export function checkFrozen(changes: readonly Change[], globs: readonly string[], title: string): FrozenVerdict {
  const touched = changes.filter(c => isFrozen(c.path, globs))
  const deleted = touched.filter(c => c.status === 'D').map(c => c.path)
  const tagged = hasEs4Tag(title)
  const violations: FrozenViolation[] = []
  for (const c of touched) {
    if (c.status === 'D' && tagged) continue
    const why = c.status === 'D'
      ? `deletes a frozen path without the ${ES4_TAG} title tag (only the ES.4 deletion PR may delete these)`
      : 'changes a frozen path'
    violations.push({
      path: c.path,
      status: c.status,
      sentence: `${c.path}: this PR ${why} — the engine repo is its source of truth; fix it in ${ENGINE_REPO}.`,
    })
  }
  return { ok: violations.length === 0, violations, deleted }
}
