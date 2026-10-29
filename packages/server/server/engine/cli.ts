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
import { EXPERIMENTAL_SENTENCE, flowsExperimentalOn, nativeExperimentalOn } from '../native-gate'

/** The verbs that belong to the native harness and the providers — experimental. */
export const NATIVE_VERBS: readonly EngineVerb[] = ['code', 'provider']
export const FLOW_VERBS: readonly EngineVerb[] = ['flow']

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
  /** The native harness and providers may be used here (`native-gate.ts`, the experimental flag). */
  nativeOn = true,
  flowsOn = true,
): { run: EngineCommand } | { refuse: string } {
  const s = cliStrings(lang)
  if (!status.present && FLOW_VERBS.includes(verb) && status.reason === 'community-build') {
    return { refuse: lang === 'pt' ? 'fluxos exigem o build oficial' : 'flows require the official build' }
  }
  // `code` and `provider` ARE the native harness and the providers: experimental (owner decision
  // 2026-10-03), refused in one sentence naming the command that turns them on. `ingest` is not.
  if (!nativeOn && NATIVE_VERBS.includes(verb)) return { refuse: EXPERIMENTAL_SENTENCE[lang] }
  if (!flowsOn && FLOW_VERBS.includes(verb)) return { refuse: lang === 'pt' ? 'experimental desligado: AGENTISTICS_FLOWS' : 'experimental disabled: AGENTISTICS_FLOWS' }
  if (!status.present) return { refuse: s.engineVerbAbsent(verb, status.reason) }
  const cmd = commands.find(c => c.verb === verb)
  return cmd ? { run: cmd } : { refuse: s.engineVerbNotProvided(verb) }
}

/** Loads the engine and runs (or refuses) the verb. Returns the exit code. */
export async function runEngineVerb(verb: EngineVerb, args: string[], lang: CliLang): Promise<number> {
  const { engine, engineStatus, loadEngine } = await import('./load')
  await loadEngine()
  const decided = resolveEngineVerb(verb, engineStatus(), engine()?.commands ?? [], lang, nativeExperimentalOn(), flowsExperimentalOn())
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
 * community user. The native verbs are the exception: hidden while the experimental flag is off.
 */
export function engineHelpLines(commands: readonly EngineCommand[] | null, nativeOn = true, flowsOn = true): string[] {
  const lines: string[] = []
  for (const verb of ENGINE_VERBS) {
    // `code` and `provider` are the experimental native harness: with the flag off they are not
    // documented here at all, exactly as before v2.103 (the verb still answers, in its sentence).
    if (!nativeOn && NATIVE_VERBS.includes(verb)) continue
    if (!flowsOn && FLOW_VERBS.includes(verb)) continue
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
  return engineHelpLines(engine()?.commands ?? null, nativeExperimentalOn(), flowsExperimentalOn()).join('\n')
}
