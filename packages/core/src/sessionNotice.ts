/**
 * sessionNotice.ts — PURE: the instruction line a `notice` (`agentistics_session_message` kind=notice)
 * carries into the receiving session, and how a surface recognises it.
 *
 * Owner, 27/11: "esses avisos aparecem como pergunta, não deveria. E a resposta do líder que recebeu o
 * aviso deve ser na thread do aviso e não como mensagem pro usuário". A notice asks nothing, so the
 * receiver is told — in the message itself — not to answer the person, and, when the sender is filed on
 * a task, WHERE a reaction goes: one comment in the notice's own thread.
 */

/** Every instruction line starts with this marker; a surface strips the line from the shown body. */
export const NOTICE_INSTRUCTION_MARK = '(notice: no reply to the user.'

export interface NoticeThreadRef {
  /** The task the thread lives on (`agentistics_task_comment` `ref`). */
  taskId: string
  threadId: string
}

/** The one line appended to a notice's body. Short on purpose: it is typed into a live session. */
export function noticeInstruction(thread?: NoticeThreadRef): string {
  return thread
    ? `${NOTICE_INSTRUCTION_MARK} If you must react, post ONE comment in its thread — agentistics_task_comment ref=${thread.taskId} threadId=${thread.threadId} — and end your turn with no chat text addressed to the user.)`
    : `${NOTICE_INSTRUCTION_MARK} If nothing needs doing, end your turn with no chat text addressed to the user.)`
}

/** The notice body without its instruction line (the line is for the model, not for the person). */
export function stripNoticeInstruction(body: string): string {
  return body
    .split('\n')
    .filter(line => !line.trimStart().startsWith(NOTICE_INSTRUCTION_MARK))
    .join('\n')
    .trimEnd()
}
