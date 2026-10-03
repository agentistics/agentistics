/**
 * affected-tests.ts — PURE: which tests the pre-commit hook runs for a staged change.
 *
 * The hook used to run `tsc` + the whole suite (~13.8k tests, ~2 minutes, longer under the shared
 * lock), which slowed every commit. The full suite still runs in CI and before every release; the
 * hook only needs the tests the change can plausibly affect:
 *
 *  - a staged test file runs itself;
 *  - a staged source file runs the tests in its own directory (non-recursive — the repo keeps
 *    `foo.ts` beside `foo.test.ts`);
 *  - a change to something EVERYTHING imports (`packages/core`, `engine-api`, `vault`, root config,
 *    the lockfile, the hooks themselves) falls back to the full suite;
 *  - docs and images need no tests at all.
 *
 * The SLOW set (`scripts/slow-tests.txt`: server-spawning e2e files) is excluded from the hook's
 * selection in every case, and only the hook: `bun run test` and CI run everything.
 */

export interface Selection {
  /** `full` = the whole suite; `files` = exactly these; `none` = nothing to run. */
  mode: 'full' | 'files' | 'none'
  files: string[]
  /** One line saying why, printed by the hook so a partial run is never silent. */
  reason: string
}

const TEST_RE = /\.test\.(ts|tsx)$/
const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/
const NO_TEST_RE = /\.(md|mdx|txt|png|jpe?g|gif|svg|webp|ico|pdf|woff2?|yml|yaml)$/i

/** Shared code or config whose change can break any package: the hook runs everything. */
const SHARED: RegExp[] = [
  /^packages\/core\//,
  /^packages\/engine-api\//,
  /^packages\/vault\//,
  /^bun\.lock$/,
  /^package\.json$/,
  /^tsconfig[^/]*\.json$/,
  /^bunfig\.toml$/,
  /^commitlint\.config\./,
  /^\.husky\//,
  /^scripts\//,
]

export function isTestFile(path: string): boolean {
  return TEST_RE.test(path)
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

export function parseSlowList(text: string): Set<string> {
  return new Set(
    text.split('\n').map(l => l.replace(/#.*/, '').trim()).filter(l => l !== ''),
  )
}

/**
 * @param staged    repo-relative paths of added/changed/renamed files (deletions excluded)
 * @param allTests  every test file in the repo, repo-relative
 * @param slow      the slow set, repo-relative
 */
export function selectTests(staged: readonly string[], allTests: readonly string[], slow: ReadonlySet<string>): Selection {
  const existing = new Set(allTests)
  const shared = staged.find(p => SHARED.some(re => re.test(p)))
  if (shared !== undefined) {
    return { mode: 'full', files: [], reason: `${shared} is shared code/config — running the full suite` }
  }

  const picked = new Set<string>()
  for (const p of staged) {
    if (NO_TEST_RE.test(p)) continue
    if (isTestFile(p)) { if (existing.has(p)) picked.add(p); continue }
    if (!SOURCE_RE.test(p)) continue
    const dir = dirOf(p)
    for (const t of allTests) if (dirOf(t) === dir) picked.add(t)
  }

  const files = [...picked].filter(f => !slow.has(f)).sort()
  const skipped = [...picked].filter(f => slow.has(f)).length
  if (files.length === 0) {
    return { mode: 'none', files: [], reason: skipped > 0 ? `only slow tests relate to this change (${skipped}) — left to CI` : 'no tests relate to this change' }
  }
  return {
    mode: 'files', files,
    reason: `${files.length} related test file(s)${skipped > 0 ? `, ${skipped} slow one(s) left to CI` : ''}`,
  }
}

/** Does the staged change need a typecheck at all? Docs/images/yaml do not. */
export function needsTypecheck(staged: readonly string[]): boolean {
  return staged.some(p => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(p) || /(^|\/)(tsconfig[^/]*\.json|package\.json|bun\.lock)$/.test(p))
}
