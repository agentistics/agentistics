export interface ShellRunOutput {
  stdout: string
  stderr: string
}

export interface ShellRunModelInput {
  output?: ShellRunOutput
}

/** The terminal presentation facts shared by the chat bubble and its focused tests. */
export function shellRunViewModel(run: ShellRunModelInput) {
  const out = run.output
  const hasOut = out !== undefined && (out.stdout !== '' || out.stderr !== '')
  const lines = hasOut ? [out.stdout, out.stderr].filter(t => t !== '').join('\n').split('\n').length : 0
  return { lines, hasOut, expandedByDefault: hasOut && lines <= 12 }
}
