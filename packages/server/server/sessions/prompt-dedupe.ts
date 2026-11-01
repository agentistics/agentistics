/**
 * prompt-dedupe.ts — PURE. A protocol-stated approval prompt that says the same thing twice.
 *
 * opencode's permission request carries the file both as its title and as its location, and the
 * prompt reaches the host as "<path> <path>" (measured on a real `write` approval, 2026-10-31).
 * The card then drew the path twice. A prompt that is exactly one block repeated, separated by
 * whitespace, is shown once; anything else (a different second part, a repeat that is only a
 * prefix) is left untouched, because dropping text a person agrees to is the expensive direction.
 */
export function dedupeRepeatedPrompt(prompt: string): string {
  const text = prompt.trim()
  if (text === '') return prompt
  const mid = Math.floor(text.length / 2)
  // The two halves are separated by whitespace, so the split sits within one char of the middle.
  for (const at of [mid, mid - 1, mid + 1]) {
    if (at <= 0 || at >= text.length) continue
    const head = text.slice(0, at).trimEnd()
    const tail = text.slice(at).trimStart()
    if (head !== '' && head === tail && /\s/.test(text.slice(head.length, text.length - tail.length) || 'x')) return head
  }
  return prompt
}
