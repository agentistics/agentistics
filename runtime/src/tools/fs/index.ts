/**
 * tools/fs/index.ts — `createFsTools`: the two read-only search tools of the B3 catalogue
 * (`fs.glob`, `fs.grep`, spec §3). Both are `auto`-permission — they read a directory listing and
 * file contents, never write, and each states exactly one `PolicySubject`, the root it searched
 * (never one per candidate file: see `./candidates.ts` for how "never return a file outside root"
 * is enforced instead, structurally, before `run` ever sees a candidate).
 */
import type { Tool } from '../contract.ts'
import { createFsGlobTool, type FsGlobInput } from './glob.ts'
import { createFsGrepTool, type FsGrepInput } from './grep.ts'
import { resolveFsToolsOptions, type FsToolsOptions } from './options.ts'

export type { FsGlobInput, FsGlobResult } from './glob.ts'
export type { FsGrepInput, FsGrepMatch, FsGrepResult } from './grep.ts'
export type { FsToolsOptions, ResolvedFsToolsOptions } from './options.ts'

export function createFsTools(opts: FsToolsOptions = {}): { glob: Tool<FsGlobInput>; grep: Tool<FsGrepInput> } {
  const resolved = resolveFsToolsOptions(opts)
  return {
    glob: createFsGlobTool(resolved),
    grep: createFsGrepTool(resolved),
  }
}
