/**
 * engine/cli.ts — the engine's verbs at the command line, and how the help names them.
 *
 * `agentop code`, `agentop provider` and `agentop ingest` are RECOGNISED by every build. With an
 * engine that offers the verb, it runs; without one, the verb answers in a sentence and exits 2 — an
 * unknown verb and a verb this build lacks are different facts, and printing "Unknown command" for
 * the second would tell a community user the documentation is wrong.
 */
import type { EngineCommand, EngineStatus } from '@agentistics/engine-api'
import { cliStrings, ENGINE_VERB_HELP, ENGINE_VERBS, type CliLang, type EngineVerb } from '../cli-i18n'

/** Exit code of a verb this build cannot run. Not 1 (a failure of the verb) — it never ran. */
export const ENGINE_ABSENT_EXIT = 2

export function isEngineVerb(command: string | undefined): command is EngineVerb {
  return (ENGINE_VERBS as readonly (string | undefined)[]).includes(command)
}

/** PURE. What to do with an engine verb: run the command, or say why it cannot. */
export function resolveEngineVerb(
  verb: EngineVerb,
  status: EngineStatus,
  commands: readonly EngineCommand[],
  lang: CliLang,
): { run: EngineCommand } | { refuse: string } {
  const s = cliStrings(lang)
  if (!status.present) return { refuse: s.engineVerbAbsent(verb, status.reason) }
  const cmd = commands.find(c => c.verb === verb)
  return cmd ? { run: cmd } : { refuse: s.engineVerbNotProvided(verb) }
}

/** Loads the engine and runs (or refuses) the verb. Returns the exit code. */
export async function runEngineVerb(verb: EngineVerb, args: string[], lang: CliLang): Promise<number> {
  const { engine, engineStatus, loadEngine } = await import('./load')
  await loadEngine()
  // `agentop code` with a terminal on both ends IS the control center's `code` tab (D-TUI-3) when the
  // engine offers one (1.8 `codeTab`); its line mode stays for a pipe, `ls`, `--help`. A refusal
  // (the flag off, a bad argument) is printed HERE, before the alternate screen is entered.
  const codeTab = verb === 'code' ? engine()?.codeTab : undefined
  if (codeTab) {
    const decision = codeTab.launch(args, { stdin: Boolean(process.stdin.isTTY), stdout: Boolean(process.stdout.isTTY) }, lang)
    if (decision.kind === 'refuse') {
      console.error(decision.sentence)
      return decision.exit
    }
    if (decision.kind === 'tab') {
      const { runStart } = await import('../cli-start')
      const out = await runStart({
        launch: decision.launch,
        ...(decision.model ? { model: decision.model } : {}),
        ...(decision.cwd ? { cwd: decision.cwd } : {}),
      })
      return out === 'foreground' ? 0 : out
    }
  }
  const decided = resolveEngineVerb(verb, engineStatus(), engine()?.commands ?? [], lang)
  if ('refuse' in decided) {
    console.error(decided.refuse)
    return ENGINE_ABSENT_EXIT
  }
  return decided.run.run(args, {
    out: line => process.stdout.write(line.endsWith('\n') ? line : `${line}\n`),
    err: line => process.stderr.write(line.endsWith('\n') ? line : `${line}\n`),
  })
}

const NAME_COL = 16
const WRAP = 88

function wrap(text: string, first: string, indent: string): string[] {
  const out: string[] = []
  let line = first
  for (const word of text.split(/\s+/)) {
    if (line.length + word.length + 1 > WRAP && line.trim() !== first.trim()) {
      out.push(line.trimEnd())
      line = indent
    }
    line += (line.endsWith(' ') || line === '' ? '' : ' ') + word
  }
  out.push(line.trimEnd())
  return out
}

/**
 * PURE. The engine verbs' lines for `agentop --help`: the engine's own summary where it offers the
 * verb, else a one-liner marked `(official build)` — hiding the verbs would make the docs lie to a
 * community user.
 */
export function engineHelpLines(commands: readonly EngineCommand[] | null): string[] {
  const lines: string[] = []
  for (const verb of ENGINE_VERBS) {
    const cmd = commands?.find(c => c.verb === verb)
    const text = cmd ? cmd.summary.en : `${ENGINE_VERB_HELP[verb]} (official build)`
    lines.push(...wrap(text, `  ${verb.padEnd(NAME_COL - 2)}`, ' '.repeat(NAME_COL)))
  }
  return lines
}

/** The help's engine section for THIS build, loading the engine to ask what it offers. */
export async function engineHelpSection(): Promise<string> {
  const { engine, loadEngine } = await import('./load')
  await loadEngine({ log: () => {} })
  return engineHelpLines(engine()?.commands ?? null).join('\n')
}
