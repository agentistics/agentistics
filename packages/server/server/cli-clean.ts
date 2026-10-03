/**
 * `agentop clean` (PERF.1 step 5): the worktrees agentop's projects have accumulated, with their
 * sizes and what can go — merged and clean worktrees removed, the `node_modules` of worktrees nobody
 * committed to for 30 days, git's bookkeeping for worktrees whose directory is gone. Nothing is
 * removed without a "yes" (`--yes`, or the prompt), uncommitted work is never touched, branches stay.
 *
 *   agentop clean [--repo <path>]… [--stale-days <n>] [--yes] [--json]
 */
import { homedir } from 'node:os'
import { resolveLang } from './cli-lang'
import { applyClean, repoOf, worktreeFacts } from './clean/clean-io'
import { formatPlan, planClean, reclaimable, STALE_DAYS, type WorktreeFacts } from './clean/clean-plan'

/** The repositories to look at: the ones named, else this directory's and every known project's. */
export async function cleanRepos(argv: readonly string[]): Promise<string[]> {
  const named: string[] = []
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--repo' && argv[i + 1]) named.push(argv[++i]!)
  const candidates = named.length > 0 ? named : [process.cwd(), ...(await knownProjectPaths())]
  const repos = new Set<string>()
  for (const p of candidates) { const r = await repoOf(p); if (r) repos.add(r) }
  return [...repos].sort()
}

async function knownProjectPaths(): Promise<string[]> {
  try {
    const { loadConsolidated } = await import('./consolidate')
    const paths = new Set<string>()
    for (const s of (await loadConsolidated()).values()) if (s.project_path) paths.add(s.project_path)
    return [...paths]
  } catch { return [] }
}

export async function collectCleanFacts(repos: readonly string[]): Promise<WorktreeFacts[]> {
  const all: WorktreeFacts[] = []
  for (const r of repos) all.push(...(await worktreeFacts(r)))
  return all
}

export async function runClean(argv: string[]): Promise<void> {
  const lang = await resolveLang()
  const sd = argv.indexOf('--stale-days')
  const staleDays = sd >= 0 && Number(argv[sd + 1]) > 0 ? Number(argv[sd + 1]) : STALE_DAYS
  const repos = await cleanRepos(argv)
  const plan = planClean(await collectCleanFacts(repos), Date.now(), staleDays)
  const total = reclaimable(plan)
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ repos, items: plan, reclaimable: total }, null, 2))
    if (!argv.includes('--yes')) return
  } else {
    for (const l of formatPlan(plan, lang, homedir())) console.log(l)
  }
  if (total.count === 0) return
  let yes = argv.includes('--yes')
  if (!yes && process.stdin.isTTY) {
    process.stdout.write(lang === 'pt' ? 'Limpar os itens marcados com •? [s/N] ' : 'Clean the items marked •? [y/N] ')
    const answer = await new Promise<string>(r => process.stdin.once('data', d => r(String(d).trim().toLowerCase())))
    process.stdin.pause()
    yes = answer === 'y' || answer === 'yes' || answer === 's' || answer === 'sim'
  }
  if (!yes) {
    if (!process.stdin.isTTY) console.log(lang === 'pt' ? 'Nada removido (use --yes para remover).' : 'Nothing removed (pass --yes to remove).')
    return
  }
  const problems = await applyClean(plan)
  for (const p of problems) console.error(p)
  console.log(lang === 'pt' ? `Feito.${problems.length ? ` ${problems.length} item(ns) não removido(s).` : ''}` : `Done.${problems.length ? ` ${problems.length} item(s) not removed.` : ''}`)
}
