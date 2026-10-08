export interface ShellRunOutput {
  stdout: string
  stderr: string
}

export interface ShellRunModelInput {
  output?: ShellRunOutput
}

/** What Claude Code writes as the stdout of a `!` command that printed nothing. It is not output. */
const NO_OUTPUT_PLACEHOLDER = '(Bash completed with no output)'

/** The terminal presentation facts shared by the chat bubble and its focused tests. */
export function shellRunViewModel(run: ShellRunModelInput) {
  const out = run.output
  const stdout = out && out.stdout.trim() !== NO_OUTPUT_PLACEHOLDER ? out.stdout : ''
  const hasOut = out !== undefined && (stdout !== '' || out.stderr !== '')
  const lines = hasOut ? [stdout, out.stderr].filter(t => t !== '').join('\n').split('\n').length : 0
  return { lines, hasOut, expandedByDefault: hasOut && lines <= 12 }
}
