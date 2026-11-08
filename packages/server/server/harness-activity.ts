/** PURE: the session-activity rules every harness shares.
 *
 *  These two rules used to live inside `jsonl.ts`, the Claude transcript parser — a 400-line file no
 *  adapter could reuse without copying, and a copied rule is a rule that drifts. That is why
 *  `git_commits` was hardcoded to 0 in every non-Claude adapter: not because the data was missing,
 *  but because the rule was not reachable. */
import type { HarnessId } from '@agentistics/core'

/** How many git commits and pushes a shell command line performs.
 *
 *  A command line is a CHAIN — `git add -A && git commit && git push` is three commands — so it is
 *  split on the shell's separators and each segment judged on its own.
 *
 *  `(?![\w-])` rather than the `\b` the original rule used: `\b` matches between `t` and `-`, so
 *  `git commit-tree` (plumbing, writes no commit) counted as one. Rare enough that no real total
 *  moves, wrong enough that it should not be carried into five more harnesses. */
/**
 * The part before `git` that is still a way of RUNNING git.
 *
 * A CLOSED LIST of wrapper verbs, not "a few words". The permissive version was tried first and is
 * wrong in the direction that matters: `echo git commit` and `# git commit is the next step` both
 * counted as commits, and the existing tests said so immediately. A counter that inflates on prose
 * is worse than one that misses a wrapper, because nothing on screen says which happened.
 *
 * Each entry is a program that RUNS another program. `npm`/`yarn`/`pnpm` are deliberately absent:
 * `npm run git commit` runs a script named `git`, not git.
 */
const WRAPPERS = 'rtk|sudo|doas|env|command|time|nice|ionice|docker|podman|kubectl|nix'
const WRAPPER = `(?:cd\\s+\\S+\\s+&&\\s+)?(?:(?:${WRAPPERS})(?:\\s+[\\w./@#:=-]+){0,3}\\s+)?`
/** `git`, or an absolute/relative path ending in it — `/usr/bin/git commit` is still a commit. */
const GIT = '(?:[\\w./-]*/)?git'
const GIT_COMMIT = new RegExp(`^${WRAPPER}${GIT}\\s+commit(?![\\w-])`)
const GIT_PUSH = new RegExp(`^${WRAPPER}${GIT}\\s+push(?![\\w-])`)

export function countGitCommands(cmd: string): { commits: number; pushes: number } {
  let commits = 0, pushes = 0
  for (const seg of cmd.split(/&&|\|\||;|\n/)) {
    const s = seg.trim()
    // The optional `cd … &&` prefix survives from the original rule: the split above already
    // separates that case, but a segment may still arrive whole from a caller that did not split.
    //
    // AND A WRAPPER. `git` is routinely reached through one — `rtk proxy git commit`, `sudo -u ci
    // git push`, `nix run nixpkgs#git -- commit`, `docker exec app git commit`. Anchoring on `git`
    // made every one of those invisible: measured on a real session, 62 commits counted as 2,
    // because the whole machine routes git through `rtk proxy`.
    //
    // The wrapper is matched as a BOUNDED prefix — a few plain words and flags, never `.*` — so
    // this still cannot count `echo "run git commit"` or a path that merely ends in `git`. The
    // segment must still be a COMMAND whose verb is `git`.
    if (GIT_COMMIT.test(s)) commits++
    if (GIT_PUSH.test(s)) pushes++
  }
  return { commits, pushes }
}

/**
 * What may precede a test runner and still be a way of RUNNING it: environment assignments
 * (`NODE_OPTIONS=--max-old-space-size=3500 bun test`) and a CLOSED list of wrapper programs — the same rule
 * `countGitCommands` follows, for the same reason (`echo "bun test"` runs nothing).
 */
const TEST_WRAPPER = '(?:(?:[A-Z_][A-Z0-9_]*=\\S*\\s+)*(?:(?:rtk(?:\\s+proxy)?|sudo|time|env|command|nice|flock\\s+\\S+|timeout\\s+\\S+|agentop\\s+run(?:\\s+--?[\\w-]+)*\\s+--)\\s+)*(?:[A-Z_][A-Z0-9_]*=\\S*\\s+)*)'
/**
 * A test RUNNER invoked as a command: a package manager's `test` script, or one of the runners themselves.
 * `(?![\w-])` after the verb, so `bun testify` and `go test-helper` are not it.
 */
const TEST_RUNNER = new RegExp(
  `^${TEST_WRAPPER}(?:`
  + '(?:bun|npm|pnpm|yarn)\\s+(?:run\\s+)?test(?::[\\w-]+)?'
  + '|bunx?\\s+(?:--bun\\s+)?(?:vitest|jest|playwright\\s+test)'
  + '|(?:npx|pnpm\\s+exec|yarn)\\s+(?:vitest|jest|playwright\\s+test)'
  + '|(?:vitest|jest|pytest|py\\.test|phpunit|rspec|mocha)'
  + '|python3?\\s+-m\\s+(?:pytest|unittest)'
  + '|go\\s+test|cargo\\s+(?:nextest\\s+run|test)|dotnet\\s+test|mvn\\s+(?:-\\S+\\s+)*test|gradlew?\\s+test'
  + ')(?![\\w-])',
)

/** How many test runs a shell command line performs — one per chained segment whose verb is a test runner. */
export function countTestCommands(cmd: string): number {
  let runs = 0
  for (const seg of cmd.split(/&&|\|\||;|\n/)) if (TEST_RUNNER.test(seg.trim())) runs++
  return runs
}

/**
 * Each harness's own tool name → the shared name.
 *
 * The tools breakdown compares harnesses; it cannot do that while one calls it `Bash`, another
 * `exec_command` and a third `RUN_COMMAND`. Claude's names are the shared vocabulary because they
 * are already what every chart, label and filter in the product is written against.
 *
 * It is a MAPPING, not an interpretation: a name nobody has mapped passes through unchanged rather
 * than being dropped or bucketed as "other". A new tool should show up as itself and be noticed.
 */
const TOOL_ALIASES: Record<string, string> = {
  // shell
  exec_command: 'Bash',
  local_shell_call: 'Bash',
  shell: 'Bash',
  bash: 'Bash',
  run_shell_command: 'Bash',
  run_command: 'Bash',
  RUN_COMMAND: 'Bash',
  // codex 0.161 names every shell call `exec` (454 of 455 calls in the last 40 rollouts); copilot `read_bash`
  exec: 'Bash',
  read_bash: 'Bash',
  // read
  view: 'Read',
  read_file: 'Read',
  read_many_files: 'Read',
  view_file: 'Read',
  read: 'Read',
  // write / edit
  write_to_file: 'Write',
  write_file: 'Write',
  create_file: 'Write',
  write: 'Write',
  // skill (opencode names its skill-invocation tool literally "skill"; Claude's own tool_use is
  // already "Skill" and needs no alias)
  skill: 'Skill',
  replace_file_content: 'Edit',
  multi_replace_file_content: 'Edit',
  str_replace: 'Edit',
  edit_file: 'Edit',
  // opencode's own edit tool (a `kind: "edit"` tool call, probed 1.17.9) — it used to pass through as `edit`
  edit: 'Edit',
  replace: 'Edit',
  // search
  grep_search: 'Grep',
  search_file_content: 'Grep',
  glob_file_search: 'Glob',
  find_files: 'Glob',
  list_dir: 'Glob',
  // names measured 2026-10-16 (copilot rg/apply_patch, gemini glob/web/plan, agy web/subagent/plan)
  rg: 'Grep',
  grep: 'Grep',
  glob: 'Glob',
  apply_patch: 'Edit',
  google_web_search: 'WebSearch',
  search_web: 'WebSearch',
  web_fetch: 'WebFetch',
  read_url_content: 'WebFetch',
  invoke_subagent: 'Agent',
  update_plan: 'TodoWrite',
  update_topic: 'TodoWrite',
  manage_task: 'TodoWrite',
  // opencode's own names, measured over ACP on 1.19.5 (2026-11-07, throwaway HOME) plus its 2.x renames. Without them its
  // todo list read as a bare "todowrite" and its subagent as a generic tool, and the Tools page counted them apart.
  todowrite: 'TodoWrite',
  task: 'Task',
  subagent: 'Task',
  list: 'LS',
  multiedit: 'MultiEdit',
  patch: 'Edit',
  codesearch: 'Grep',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
}

/** The shared name for a harness's tool, or the name itself when nothing maps it. */
export function canonicalTool(_harness: HarnessId, name: string): string {
  return TOOL_ALIASES[name] ?? name
}
