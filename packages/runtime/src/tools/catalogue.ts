/**
 * tools/catalogue.ts — the v1 tool catalogue (spec 2026-09-20-runtime-b3-tool-catalogue.md §3) as
 * ONE value a host hands to `runToolLoop`.
 *
 * It exists so the set is stated once: a host that assembled the tools itself could forget one, or
 * build the shell without the sandbox launcher it probed. Every tool here is built by `defineTool`
 * and so still runs only through the gate; this module adds no path around the policy.
 *
 * Deliberately absent from v1 (§3, §7): git WRITE verbs (D-T6: v2), `agent.*` (v2, depth-capped per
 * D-T4), `mcp.*`, `web.*`, `browser.*` (D-T7: a gated runtime reached through delegation, never an
 * ordinary tool), `memory.note`, `artifact.attach`, and `MultiEdit` (zero uses in 587 real edits).
 *
 * LIFETIME: the shell's processes belong to the session. `dispose()` kills every process group the
 * catalogue started ("the shell dies with the session") and must be called when the session ends.
 */

import type { SandboxLauncher, Tool } from './contract.ts'
import { MINIMAL_TOOL_ENV, type ToolEnv } from './env.ts'
import { createFileTools, type FileTools, type FileToolsOptions } from './file/index.ts'
import { createFsTools } from './fs/index.ts'
import type { FsToolsOptions } from './fs/options.ts'
import { createGitTools, type GitToolsRuntimeOptions } from './git/index.ts'
import { createAskUserTool } from './interact/ask-user.ts'
import { createPlanTool } from './interact/plan.ts'
import { createShellTools, type ShellTools, type ShellToolsOptions } from './shell/index.ts'

export interface NativeToolsOptions {
  /**
   * The environment every spawned process (shell, git, the fs lister) sees. The HOST decides it; the
   * runtime never reads its own. Default `MINIMAL_TOOL_ENV`: a PATH and a locale, NOTHING from the
   * host — so no provider key reaches a shell the model drives unless the host passes it (`env.ts`).
   */
  env?: ToolEnv
  /** The sandbox the shell spawns through. Absent: no sandbox, and the launcher's sentence says so. */
  launcher?: SandboxLauncher
  shell?: Omit<ShellToolsOptions, 'launcher' | 'env'>
  file?: FileToolsOptions
  fs?: Omit<FsToolsOptions, 'env'>
  git?: Omit<GitToolsRuntimeOptions, 'env'>
}

export interface NativeTools {
  /** Every v1 tool, in the order they are declared to the model. */
  tools: readonly Tool<unknown>[]
  /** The file tools' shared read ledger and edit checkpoint (§5 recovery). */
  file: FileTools
  shell: ShellTools
  /** The model's own checklist, for a host to draw. */
  plan: ReturnType<typeof createPlanTool>['plan']
  /** Kills every process the shell started. Idempotent. */
  dispose(): Promise<void>
}

export function createNativeTools(opts: NativeToolsOptions = {}): NativeTools {
  const file = createFileTools(opts.file)
  const env = opts.env ?? MINIMAL_TOOL_ENV
  const fs = createFsTools({ ...opts.fs, env })
  const shell = createShellTools({ ...opts.shell, launcher: opts.launcher, env })
  const git = createGitTools({ ...opts.git, env })
  const plan = createPlanTool()
  const ask = createAskUserTool()
  const tools = [
    file.read, file.patch, file.write,
    fs.glob, fs.grep,
    shell.start, shell.read, shell.write, shell.stop,
    git.status, git.diff, git.log,
    plan.tool, ask,
  ] as readonly Tool<unknown>[]
  return { tools, file, shell, plan: plan.plan, dispose: () => shell.dispose() }
}
