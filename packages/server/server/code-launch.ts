/**
 * code-launch.ts — PURE. How `agentop code <args>` opens the control center's `code` tab instead of the engine's
 * line mode (ES.6h). The engine's own `code` verb keeps parsing for the line mode; this mirrors only what the
 * COCKPIT needs to hand over: a first prompt or a session to resume, and the two flags the tab does not decide
 * (`--model`, `--cwd`). The same rules, the same sentences.
 */
import type { CodeLaunch } from '@agentistics/tui/control/code-types'

export interface CodeStartLaunch {
  launch: CodeLaunch
  model?: string
  cwd?: string
}

export type ParsedCodeLaunch = { ok: true; start: CodeStartLaunch } | { ok: false; message: string }

/** Yes only with a real terminal on BOTH ends and never for `ls` / `--help` (answers, not sessions). */
export function opensCockpit(args: string[], tty: { stdin: boolean; stdout: boolean }): boolean {
  if (!tty.stdin || !tty.stdout) return false
  const first = args[0]
  return first !== 'ls' && first !== '--help' && first !== '-h'
}

export function parseCodeLaunch(args: string[]): ParsedCodeLaunch {
  let model: string | undefined
  let cwd: string | undefined
  let resume: string | undefined
  const prompt: string[] = []
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!
    if (tok === '--model' || tok === '--cwd' || tok === '--resume') {
      const v = args[++i]
      const what = tok === '--model' ? 'a value' : tok === '--cwd' ? 'a directory' : 'a session id'
      if (v === undefined) return { ok: false, message: `agentop code: ${tok} needs ${what}.` }
      if (tok === '--model') model = v; else if (tok === '--cwd') cwd = v; else resume = v
    } else if (tok.startsWith('--')) return { ok: false, message: `agentop code: unknown flag "${tok}".` }
    else prompt.push(tok)
  }
  const text = prompt.length > 0 ? prompt.join(' ') : undefined
  if (resume !== undefined) {
    if (model !== undefined) return { ok: false, message: 'agentop code --resume: --model is not accepted when resuming — the session keeps its own model.' }
    if (cwd !== undefined) return { ok: false, message: 'agentop code --resume: --cwd is not accepted when resuming — the session keeps its own workspace.' }
    return { ok: true, start: { launch: { resume, ...(text ? { prompt: text } : {}) } } }
  }
  return { ok: true, start: { launch: { ...(text ? { prompt: text } : {}) }, ...(model ? { model } : {}), ...(cwd ? { cwd } : {}) } }
}
