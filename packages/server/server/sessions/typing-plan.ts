/**
 * typing-plan.ts — how a PROMPT is typed into a pane, as pure steps (the IO is `backend-tmux.ts`'s).
 *
 * The web composer's message used to arrive as ONE `send-keys -l` burst, newlines included. A terminal UI
 * that reads input cannot tell a person typing from a clipboard paste except by TIMING, and Claude Code
 * treats a burst of several lines as a PASTE: it wrapped the owner's typed five-line message in
 * `<pasted_content>`, and the chat drew it as a collapsed "Texto colado · 5 linhas" block (reported
 * 2026-10-05). Only a real paste may become a pasted block, so a message with line breaks is typed
 * LINE BY LINE — each line a literal burst, each break the named `C-j` key (the very 0x0a byte the burst
 * carried, so what the harness receives is identical) — with a short gap between them that a paste does
 * not have. A single-line message is still one burst. `normalize` turns CRLF and CR into LF first, so a
 * message from a Windows clipboard types the same way.
 */
export type TypingStep = { kind: 'literal'; text: string } | { kind: 'newline' }

/** The pause between a line and the next: longer than a paste's, shorter than anything a person feels. */
export const NEWLINE_GAP_MS = 30

export function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

export function typingSteps(text: string): TypingStep[] {
  const lines = normalize(text).split('\n')
  if (lines.length === 1) return lines[0] === '' ? [] : [{ kind: 'literal', text: lines[0]! }]
  const out: TypingStep[] = []
  lines.forEach((line, i) => {
    if (line !== '') out.push({ kind: 'literal', text: line })
    if (i < lines.length - 1) out.push({ kind: 'newline' })
  })
  return out
}

/** The text a plan types, for the invariant that splitting never changes what arrives. */
export function stepsText(steps: readonly TypingStep[]): string {
  return steps.map(s => (s.kind === 'literal' ? s.text : '\n')).join('')
}
