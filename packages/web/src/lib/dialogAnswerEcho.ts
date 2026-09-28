/**
 * dialogAnswerEcho.ts — PURE: when a FREE-TEXT dialog answer's echo may be retired.
 *
 * An ordinary prompt's echo is retired by `pendingEchoes` (`@agentistics/core`), which waits for
 * the transcript's USER turns to contain the same text. A free-text answer to an `AskUserQuestion`
 * ("Type something.") cannot ever be retired that way: `fleet-web.ts`'s `answerSession` writes it
 * into the session as a digit-then-text-then-Enter sequence, and the harness records the RESULT as
 * a pure `tool_result` under the question's `tool_use` — "nobody's turn, and never a marker turn"
 * (see that file's own comment on why its attachments are deliberately not recorded either). So
 * `userTurns` never contains it, `pendingEchoes` never matches it, and the bubble sat on screen
 * forever captioned "delivered to the session — not read yet" for an answer that had, in fact, long
 * since been read. Reported as "mostra a resposta na fila para sempre mesmo tendo sido enviada".
 *
 * THE RETIREMENT SIGNAL IS THE DIALOG ITSELF. A free-text answer's echo is recorded together with
 * the IDENTITY of the dialog it was answering (`approvalIdentity`, taken at the moment it was sent).
 * The harness has necessarily consumed that answer — whatever it did with it — the instant the
 * session is no longer sitting on that SAME dialog: it may have closed outright, or moved on to
 * another question. Either way there is nothing further to wait for, so the echo goes.
 *
 * `currentIdentity` is `null` when the session has no dialog open at all, which retires everything
 * exactly as readily as a changed identity does — both are "that dialog is gone".
 */
export function dialogAnswersToRetire(
  /** Text answered → the dialog's identity at the moment it was sent. */
  pending: ReadonlyMap<string, string>,
  /** The identity of whichever dialog is open right now, or `null` for none. */
  currentIdentity: string | null,
): string[] {
  const out: string[] = []
  for (const [text, sentAgainst] of pending) {
    if (sentAgainst !== currentIdentity) out.push(text)
  }
  return out
}
