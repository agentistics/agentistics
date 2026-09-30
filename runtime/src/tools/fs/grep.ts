/**
 * tools/fs/grep.ts — `fs.grep` (catalogue §3): a pure-TS regex search over the same candidate list
 * `fs.glob` uses (`./candidates.ts`), bounded on every axis the spec names — result count, output
 * bytes, line length and wall time — because an unbounded grep is exactly the kind of tool call
 * that can flood a turn or hang it. Deliberately no dependency on `rg` being installed: a tool this
 * central to the catalogue must work the same on every machine the runtime ships to.
 *
 * ## Why a line is truncated BEFORE the regex runs, not only before display
 *
 * The pattern comes from the model and there is no way to preempt a synchronous JS regex mid-match
 * short of a worker-thread timeout, which this tool does not have. Testing against the
 * (already length-capped) line rather than the raw one bounds the WORST-CASE backtracking cost of
 * one line to a constant, at the price of missing a match that only occurs past the cap on an
 * unusually long line. That is a deliberate trade — a bounded tool over a complete one — the same
 * one the catalogue's D-T2 makes for shell output. The wall-clock budget (checked between files and
 * periodically between lines) catches the remaining case: many merely-slow lines rather than one
 * catastrophic one.
 *
 * ## Why "true totals" survive a truncated reply
 *
 * The spec asks the reply to "state what was cut with the true totals", so the count of matches is
 * never stopped early just because the returned LIST is full — scanning keeps counting matches
 * (a cheap increment) after `maxMatches` is reached, it only stops APPENDING to the list. The only
 * thing that makes the total a lower bound is the wall-clock budget itself
 * (`FsGrepResult.matchesTotalExact`), because that is the one condition under which continuing to
 * count would defeat the guard that exists to bound the call's time.
 */
import { readFile, stat } from 'node:fs/promises'
import type { PolicySubject, Tool, ToolContext, ToolOutcome } from '../contract.ts'
import { defineTool } from '../define.ts'
import { isInside, resolveToolPath } from '../paths.ts'
import { looksBinary } from './binary.ts'
import { listCandidates } from './candidates.ts'
import type { ResolvedFsToolsOptions } from './options.ts'
import { resolveRoot } from './resolve-root.ts'

export interface FsGrepInput {
  pattern: string
  root?: string
  glob?: string
  caseInsensitive?: boolean
  contextLines?: number
  maxMatches?: number
  /** Compiled at `parse()` time — validated once, before the policy is ever asked (an invalid
   *  regex is `invalid-input` and never reaches it, same as any other bad input). */
  regex: RegExp
}

export interface FsGrepMatch {
  path: string
  line: number
  text: string
  before?: string[]
  after?: string[]
}

export interface FsGrepResult {
  root: string
  pattern: string
  gitignoreAware: boolean
  matches: FsGrepMatch[]
  matchesShown: number
  /** Exact unless `budgetExceeded` — see the module header. */
  matchesTotal: number
  matchesTotalExact: boolean
  filesScanned: number
  filesSkippedBinary: number
  filesSkippedTooLarge: number
  truncated: boolean
  budgetExceeded: boolean
}

function parseFsGrepInput(raw: unknown): FsGrepInput | string {
  if (typeof raw !== 'object' || raw === null) return 'fs.grep needs an object input.'
  const r = raw as Record<string, unknown>
  if (typeof r.pattern !== 'string' || r.pattern.length === 0) {
    return 'fs.grep needs a non-empty "pattern" string (a regular expression).'
  }
  if (r.root !== undefined && typeof r.root !== 'string') return '"root" must be a string when given.'
  if (r.glob !== undefined && typeof r.glob !== 'string') return '"glob" must be a string when given.'
  if (r.caseInsensitive !== undefined && typeof r.caseInsensitive !== 'boolean') {
    return '"caseInsensitive" must be a boolean when given.'
  }
  if (
    r.contextLines !== undefined &&
    (typeof r.contextLines !== 'number' || !Number.isInteger(r.contextLines) || r.contextLines < 0)
  ) {
    return '"contextLines" must be a non-negative integer when given.'
  }
  if (
    r.maxMatches !== undefined &&
    (typeof r.maxMatches !== 'number' || !Number.isInteger(r.maxMatches) || r.maxMatches < 1)
  ) {
    return '"maxMatches" must be a positive integer when given.'
  }
  let regex: RegExp
  try {
    regex = new RegExp(r.pattern, r.caseInsensitive ? 'i' : '')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return `"${r.pattern}" is not a valid regular expression: ${msg}`
  }
  return {
    pattern: r.pattern,
    root: r.root as string | undefined,
    glob: r.glob as string | undefined,
    caseInsensitive: r.caseInsensitive as boolean | undefined,
    contextLines: r.contextLines as number | undefined,
    maxMatches: r.maxMatches as number | undefined,
    regex,
  }
}

function truncateLine(line: string, maxLen: number): string {
  if (line.length <= maxLen) return line
  return `${line.slice(0, maxLen)}…[truncated, ${line.length} chars]`
}

function formatMatch(m: FsGrepMatch): string {
  const lines: string[] = []
  if (m.before) lines.push(...m.before)
  lines.push(`${m.path}:${m.line}: ${m.text}`)
  if (m.after) lines.push(...m.after)
  return lines.join('\n')
}

function buildModelText(input: FsGrepInput, result: FsGrepResult): string {
  const scope = result.gitignoreAware ? '' : ' (not gitignore-aware — outside a git repository)'
  const totalPhrase = result.matchesTotalExact ? `${result.matchesTotal}` : `at least ${result.matchesTotal}`
  const header = `${result.matchesShown} of ${totalPhrase} match(es) for "${input.pattern}" under ${result.root}${scope}, ${result.filesScanned} file(s) scanned:`

  const notes: string[] = []
  if (result.filesSkippedBinary > 0) notes.push(`${result.filesSkippedBinary} binary file(s) skipped`)
  if (result.filesSkippedTooLarge > 0) notes.push(`${result.filesSkippedTooLarge} file(s) over the size cap skipped`)
  if (result.budgetExceeded) notes.push('the search stopped early on its time budget — totals above are a lower bound')
  else if (result.truncated) notes.push(`raise maxMatches to see more than ${result.matchesShown}`)
  const noteLine = notes.length > 0 ? `\n(${notes.join('; ')})` : ''

  const body = result.matches.length > 0 ? result.matches.map(formatMatch).join('\n') : '(no matches)'
  return `${header}${noteLine}\n${body}`
}

export function createFsGrepTool(opts: ResolvedFsToolsOptions): Tool<FsGrepInput> {
  return defineTool<FsGrepInput>({
    name: 'fs.grep',
    description:
      'Search file contents by regular expression under a root directory. Bounded: matches, output bytes, line length and wall time all have caps, stated in the reply when hit.',
    kind: 'search',
    permission: 'auto',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'A regular expression to search for.' },
        root: { type: 'string', description: 'Directory to search under. Defaults to the current directory.' },
        glob: { type: 'string', description: 'Restrict the search to files matching this glob pattern.' },
        caseInsensitive: { type: 'boolean', description: 'Match case-insensitively.' },
        contextLines: { type: 'number', description: 'Lines of context to include before and after each match.' },
        maxMatches: {
          type: 'number',
          description: `How many matches to return (default ${opts.grepMaxMatchesDefault}, hard cap ${opts.grepMaxMatchesHardCap}).`,
        },
      },
      required: ['pattern'],
    },
    parse: parseFsGrepInput,
    subjects: async (input: FsGrepInput, ctx: ToolContext): Promise<readonly PolicySubject[]> => {
      const root = await resolveRoot(input.root, ctx)
      return [{ action: 'read', path: root }]
    },
    run: async (input: FsGrepInput, ctx: ToolContext): Promise<ToolOutcome> => {
      const root = await resolveRoot(input.root, ctx)

      let rootStat
      try {
        rootStat = await stat(root)
      } catch {
        const detail = `"${input.root ?? ctx.cwd}" does not exist.`
        return { ok: false, modelText: detail, error: { class: 'not-found', detail } }
      }
      if (!rootStat.isDirectory()) {
        const detail = `"${root}" is not a directory.`
        return { ok: false, modelText: detail, error: { class: 'invalid-input', detail } }
      }

      const { files, gitignoreAware } = await listCandidates(root, opts.env)
      const candidateFiles = input.glob
        ? (() => {
            const g = new Bun.Glob(input.glob as string)
            return files.filter(f => g.match(f))
          })()
        : files

      const maxMatches = Math.min(input.maxMatches ?? opts.grepMaxMatchesDefault, opts.grepMaxMatchesHardCap)
      const contextLines = input.contextLines ?? 0

      const matches: FsGrepMatch[] = []
      let matchesTotal = 0
      let filesScanned = 0
      let filesSkippedBinary = 0
      let filesSkippedTooLarge = 0
      let budgetExceeded = false
      let outputBytes = 0
      let linesSinceBudgetCheck = 0
      const startedAt = performance.now()

      const budgetOk = (): boolean => {
        if (ctx.signal.aborted) return false
        return performance.now() - startedAt <= opts.grepBudgetMs
      }

      filesLoop: for (const rel of candidateFiles) {
        if (!budgetOk()) {
          budgetExceeded = true
          break
        }
        const abs = await resolveToolPath(root, rel)
        if (!isInside(root, abs)) continue // belt and suspenders — see candidates.ts

        let fileStat
        try {
          fileStat = await stat(abs)
        } catch {
          continue
        }
        if (!fileStat.isFile()) continue
        if (fileStat.size > opts.grepMaxFileBytes) {
          filesSkippedTooLarge++
          continue
        }
        if (await looksBinary(abs, opts.binarySniffBytes)) {
          filesSkippedBinary++
          continue
        }

        let text: string
        try {
          text = await readFile(abs, 'utf8')
        } catch {
          continue
        }
        filesScanned++
        const lines = text.split('\n')

        for (const [i, rawLine] of lines.entries()) {
          linesSinceBudgetCheck++
          if (linesSinceBudgetCheck >= 500) {
            linesSinceBudgetCheck = 0
            if (!budgetOk()) {
              budgetExceeded = true
              break filesLoop
            }
          }

          const capped = truncateLine(rawLine, opts.grepMaxLineLength)
          if (!input.regex.test(capped)) continue
          matchesTotal++

          if (matches.length < maxMatches && outputBytes < opts.grepMaxTotalOutputBytes) {
            const before =
              contextLines > 0 ? lines.slice(Math.max(0, i - contextLines), i).map(l => truncateLine(l, opts.grepMaxLineLength)) : []
            const after =
              contextLines > 0
                ? lines.slice(i + 1, i + 1 + contextLines).map(l => truncateLine(l, opts.grepMaxLineLength))
                : []
            const m: FsGrepMatch = { path: rel, line: i + 1, text: capped }
            if (before.length > 0) m.before = before
            if (after.length > 0) m.after = after
            matches.push(m)
            outputBytes += capped.length
          }
        }
      }

      const truncated = budgetExceeded || matchesTotal > matches.length
      const result: FsGrepResult = {
        root,
        pattern: input.pattern,
        gitignoreAware,
        matches,
        matchesShown: matches.length,
        matchesTotal,
        matchesTotalExact: !budgetExceeded,
        filesScanned,
        filesSkippedBinary,
        filesSkippedTooLarge,
        truncated,
        budgetExceeded,
      }
      return { ok: true, modelText: buildModelText(input, result), result }
    },
  })
}
