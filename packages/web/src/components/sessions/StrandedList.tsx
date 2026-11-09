import * as React from 'react'
import { ChatBubble } from './ChatBubble'
import { echoAnchorId } from '../../lib/promptHistory'

/**
 * MENSAGENS.KILL — what a session that is no longer running was handed and never read, as 'Never read'
 * cards with the one action. Drawn by the chat under its turns AND by the "no transcript" notice, because
 * a hung session that is killed before it ever wrote a transcript is exactly where the person's words
 * are only here.
 */
export function StrandedList({ cards, sessionId, harness, lang, now, onPutBack }: {
  cards: readonly { text: string; at?: number }[]
  sessionId: string
  harness: string
  lang: 'pt' | 'en'
  now: number
  onPutBack: (text: string) => void
}) {
  const pt = lang === 'pt'
  return (
    <>
      {cards.map((q, i) => (
        <ChatBubble
          key={`stranded-${i}`}
          turn={{ role: 'user', text: q.text }}
          sessionId={sessionId}
          lang={lang}
          harness={harness}
          anchorId={echoAnchorId(sessionId, q.text)}
          awaiting
          stranded={{
            label: pt ? 'Colocar na caixa de mensagem' : 'Put back in the message box',
            hint: pt
              ? 'Devolve o texto à caixa de mensagem para você revisar e enviar de novo. Nada é reenviado sozinho.'
              : 'Puts the text back in the message box so you can review it and send it again. Nothing is resent by itself.',
            run: () => onPutBack(q.text),
          }}
          {...(q.at !== undefined ? { awaitingSinceMs: Math.max(0, now - q.at) } : {})}
        />
      ))}
    </>
  )
}
