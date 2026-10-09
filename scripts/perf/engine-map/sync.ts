/**
 * scripts/perf/engine-map/sync.ts — provenance of the copies of the ENGINE repo's bench files.
 *
 * The canonical bench lives in the engine repo (branch docs/engine-map, docs/engine-map/scripts/).
 * `SOURCE.json` records, per file, the sha256 of the engine's version and of ours; `check()` answers
 * what a test (or a person) needs to know:
 *
 *   - our copy still hashes to what SOURCE.json says (nobody edited it without recording it);
 *   - an `identical` file equals the engine's;
 *   - where the engine repo is on disk, the engine's file is still the one we copied.
 *
 *   bun scripts/perf/engine-map/sync.ts           # report
 *   bun scripts/perf/engine-map/sync.ts --write   # record the current hashes (after a deliberate re-sync)
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SourceEntry { mode: 'identical' | 'patched'; engine: string; public: string }
export interface Source { engineRef: string; engineCommit: string; files: Record<string, SourceEntry> }

const HERE = import.meta.dir
export const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')
export const readSource = (): Source => JSON.parse(readFileSync(join(HERE, 'SOURCE.json'), 'utf8')) as Source

/**
 * The engine's copy of `name`. Null unless ENGINE_REPO names the engine checkout: the engine's branch
 * moves on its own schedule, so comparing against it is an explicit act (`ENGINE_REPO=~/agentistics-engine
 * bun test scripts/perf/engine-map/sync.test.ts`), never something a commit hook trips over.
 */
export function engineFile(name: string, source: Source): Uint8Array | null {
  const repo = process.env.ENGINE_REPO
  if (!repo || !existsSync(join(repo, '.git'))) return null
  const r = Bun.spawnSync(['git', '-C', repo, 'show', `${source.engineRef}:docs/engine-map/scripts/${name}`])
  return r.exitCode === 0 ? new Uint8Array(r.stdout) : null
}

export interface Finding { file: string; problem: string }

export function check(source = readSource()): { findings: Finding[]; engineChecked: boolean } {
  const findings: Finding[] = []
  let engineChecked = false
  for (const [name, e] of Object.entries(source.files)) {
    const ours = sha256(readFileSync(join(HERE, name)))
    if (ours !== e.public) findings.push({ file: name, problem: 'edited without recording it in SOURCE.json (run sync.ts --write after a deliberate change)' })
    if (e.mode === 'identical' && e.public !== e.engine) findings.push({ file: name, problem: 'marked identical but SOURCE.json holds two different hashes' })
    const theirs = engineFile(name, source)
    if (theirs) {
      engineChecked = true
      if (sha256(theirs) !== e.engine) findings.push({ file: name, problem: `the engine's copy changed since ${source.engineCommit.slice(0, 8)} — re-sync (copy, re-apply the listed patch, sync.ts --write)` })
    }
  }
  return { findings, engineChecked }
}

if (import.meta.main) {
  const source = readSource()
  if (process.argv.includes('--write')) {
    for (const [name, e] of Object.entries(source.files)) {
      e.public = sha256(readFileSync(join(HERE, name)))
      const theirs = engineFile(name, source)
      if (theirs) e.engine = sha256(theirs)
      if (e.mode === 'identical') e.public = e.engine
    }
    writeFileSync(join(HERE, 'SOURCE.json'), JSON.stringify(source, null, 2) + '\n')
    console.log('SOURCE.json updated')
  }
  const { findings, engineChecked } = check()
  console.log(engineChecked ? 'compared with the engine repo (ENGINE_REPO)' : 'ENGINE_REPO not set — only the local hashes were checked')
  for (const f of findings) console.log(`✗ ${f.file}: ${f.problem}`)
  process.exit(findings.length ? 1 : 0)
}
