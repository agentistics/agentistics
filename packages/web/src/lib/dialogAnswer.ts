/**
 * dialogAnswer.ts — PURE. The `approve` request the COMPOSER sends when it holds a dialog's
 * write-your-own answer.
 *
 * On a STRUCTURED multi-select the card keeps the other ticks (`choices`), and the typed answer must
 * travel WITH them in one `choices` answer. Sent as a lone `choice` + `text` it replaced them: live
 * QA ticked Green, typed "Purple", and the session received only "Purple" (2026-10-24).
 */
export interface ComposerAnswer {
  number: number
  /** The card's other ticks, present only on a structured multi-select. */
  choices?: readonly number[]
}

export function composerAnswerRequest(id: string, answering: ComposerAnswer, text: string):
  { id: string; action: 'approve'; choice?: number; choices?: number[]; text: string } {
  if (answering.choices) {
    const choices = [...new Set([...answering.choices, answering.number])].sort((a, b) => a - b)
    return { id, action: 'approve', choices, text }
  }
  return { id, action: 'approve', choice: answering.number, text }
}
