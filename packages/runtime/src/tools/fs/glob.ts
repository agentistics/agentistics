/**
 * tools/fs/glob.ts — `fs.glob` (catalogue §3): find files by pattern under a root, gitignore-aware
 * inside a git repository. Permission `auto` — it only reads a directory LISTING, never a file's
 * content, so the one `PolicySubject` it states is the root itself (never one per candidate); the
 * "never return a file outside root" guarantee is instead enforced structurally, inside
 * `./candidates.ts` (see its header) — every path this tool can possibly return has already been
 * resolved and boundary-checked before `run` ever sees it.
 */
import { stat } from 'node:fs/promises'
import type { PolicySubject, Tool, ToolContext, ToolOutcome } from '../contract.ts'
import { defineTool } from '../define.ts'
import { listCandidates } from './candidates.ts'
import type { ResolvedFsToolsOptions } from './options.ts'
import { resolveRoot } from './resolve-root.ts'

export interface FsGlobInput {
  pattern: string
  root?: string
  maxResults?: number
}

export interface FsGlobResult {
  root: string
  pattern: string
  gitignoreAware: boolean
  /** Relative to `root`, sorted by path (see `candidates.ts`). */
  matches: string[]
  totalMatched: number
  shown: number
  truncated: boolean
}

function parseFsGlobInput(raw: unknown): FsGlobInput | string {
  if (typeof raw !== 'object' || raw === null) return 'fs.glob needs an object input.'
  const r = raw as Record<string, unknown>
  if (typeof r.pattern !== 'string' || r.pattern.length === 0) {
    return 'fs.glob needs a non-empty "pattern" string.'
  }
  if (r.root !== undefined && typeof r.root !== 'string') return '"root" must be a string when given.'
  if (
    r.maxResults !== undefined &&
    (typeof r.maxResults !== 'number' || !Number.isInteger(r.maxResults) || r.maxResults < 1)
  ) {
    return '"maxResults" must be a positive integer when given.'
  }
  return {
    pattern: r.pattern,
    root: r.root as string | undefined,
    maxResults: r.maxResults as number | undefined,
  }
}

function buildModelText(input: FsGlobInput, result: FsGlobResult): string {
  const scope = result.gitignoreAware ? '' : ' (not gitignore-aware — outside a git repository)'
  const header = `${result.shown} of ${result.totalMatched} file(s) matching "${input.pattern}" under ${result.root}${scope}:`
  const body = result.matches.length > 0 ? result.matches.join('\n') : '(no matches)'
  const note = result.truncated
    ? `\n[${result.shown} of ${result.totalMatched} shown — raise maxResults to see more]`
    : ''
  return `${header}\n${body}${note}`
}

export function createFsGlobTool(opts: ResolvedFsToolsOptions): Tool<FsGlobInput> {
  return defineTool<FsGlobInput>({
    name: 'fs.glob',
    description:
      'Find files by glob pattern under a root directory (defaults to the current directory). Gitignore-aware inside a git repository.',
    kind: 'search',
    permission: 'auto',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'A glob pattern, e.g. "**/*.ts" or "src/*.md".' },
        root: { type: 'string', description: 'Directory to search under. Defaults to the current directory.' },
        maxResults: {
          type: 'number',
          description: `How many matches to return (default ${opts.globMaxResultsDefault}, hard cap ${opts.globMaxResultsHardCap}).`,
        },
      },
      required: ['pattern'],
    },
    parse: parseFsGlobInput,
    subjects: async (input: FsGlobInput, ctx: ToolContext): Promise<readonly PolicySubject[]> => {
      const root = await resolveRoot(input.root, ctx)
      return [{ action: 'read', path: root }]
    },
    run: async (input: FsGlobInput, ctx: ToolContext): Promise<ToolOutcome> => {
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
      const glob = new Bun.Glob(input.pattern)
      const matched = files.filter(f => glob.match(f))

      const requested = Math.min(input.maxResults ?? opts.globMaxResultsDefault, opts.globMaxResultsHardCap)
      const shownList = matched.slice(0, requested)

      const result: FsGlobResult = {
        root,
        pattern: input.pattern,
        gitignoreAware,
        matches: shownList,
        totalMatched: matched.length,
        shown: shownList.length,
        truncated: matched.length > shownList.length,
      }
      return { ok: true, modelText: buildModelText(input, result), result }
    },
  })
}
