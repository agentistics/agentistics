/**
 * present-turns.ts — the one door every chat turn passes before a person sees it (engine-api 1.29
 * `Engine.presentation`). The engine may strip what is transport metadata rather than words someone said and
 * drop a turn that leaves empty; with no engine, or one that offers no presentation, turns come back untouched.
 * A presenter that throws costs the pass, never the chat: the turns are shown as read.
 */
import type { ChatTurn } from '@agentistics/core'
import type { EnginePresentation } from '@agentistics/engine-api'
import { engine } from './load'

export function presentChatTurns<T extends ChatTurn>(turns: T[], presenter: EnginePresentation | undefined = engine()?.presentation): T[] {
  if (!presenter || turns.length === 0) return turns
  try {
    // The mirrors are kept EQUAL (`engine-api-mirrors.test.ts`), so the cast only names that fact.
    return presenter.chatTurns(turns as never) as unknown as T[]
  } catch {
    return turns
  }
}
