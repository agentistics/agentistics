/** The final escape hatch row in the project list, shared by the empty and non-empty states. */
export function chooseFolderLabel(pt: boolean): string {
  return pt ? 'Não achou? Escolher outra pasta…' : 'Not here? Choose another folder…'
}
