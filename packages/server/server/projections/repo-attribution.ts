/**
 * projections/repo-attribution.ts: the REPOSITORY of a projected fact, attributed at read time.
 *
 * The journal's replays name no repository (`session.started.repoKey` is set only by the store import,
 * from the legacy `git_remote`), so most facts carried `repo: ''`. A repository is a property of a
 * directory, and the projections cannot ask git: they are folds and must replay identically. So the
 * READER attributes it:
 * - a fact with no repo gets the normalized `origin` of its project, the same `getGitRemote` the legacy
 *   `/api/data` uses;
 * - the project is already its repository's ROOT (`canonicalProjectPath` in `dimensionsOf`), so a
 *   worktree's facts land on the repository the worktree belongs to;
 * - each root is resolved once per process.
 *
 * A repo the journal stated is kept. A directory that is gone, not a repository, or has no origin stays
 * `''`, the "no linked repository" bucket, which is what the legacy reports for it too.
 */

export type RepoResolver = (projectRoot: string) => Promise<string>

/** Once per root per process; a resolver that throws or answers nothing means `''`. */
export function memoRepoResolver(resolve: (root: string) => Promise<string | undefined>): RepoResolver {
  const memo = new Map<string, Promise<string>>()
  return root => {
    let p = memo.get(root)
    if (!p) {
      p = resolve(root).then(r => r ?? '', () => '')
      memo.set(root, p)
    }
    return p
  }
}

export async function* withRepoAttribution<T extends { repo: string; project: string }>(
  facts: AsyncIterable<T>,
  repoOf: RepoResolver,
): AsyncIterable<T> {
  for await (const f of facts) {
    if (f.repo === '' && f.project !== '') {
      const repo = await repoOf(f.project)
      yield repo ? { ...f, repo } : f
    } else {
      yield f
    }
  }
}
