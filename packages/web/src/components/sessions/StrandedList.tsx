import * as React from 'react'
import { ChatBubble } from './ChatBubble'
import { echoAnchorId } from '../../lib/promptHistory'
import { copyText } from '../../lib/clipboard'

/** The one action a stranded card offers, decided by whether the screen has a composer to put text back in. */
export function strandedActionKind(composer: boolean): 'put-back' | 'copy' {
  return composer ? 'put-back' : 'copy'
}

/**
 * MENSAGENS.KILL — what a session that is no longer running was handed and never read, as 'Never read'
 * cards with the one action. Drawn by the chat under its turns AND by the "no transcript" notice, because
 * a hung session that is killed before it ever wrote a transcript is exactly where the person's words
 * are only here.
 */
export function StrandedList({ cards, sessionId, harness, lang, now, onPutBack, composer }: {
  cards: readonly { text: string; at?: number }[]
  sessionId: string
  harness: string
  lang: 'pt' | 'en'
  now: number
  onPutBack: (text: string) => void
  /** Does this screen have a message box? Without one, put-back would write a draft nobody sees. */
  composer: boolean
}) {
  const pt = lang === 'pt'
  const kind = strandedActionKind(composer)
  const [copied, setCopied] = React.useState<number | null>(null)
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
          stranded={kind === 'put-back' ? {
            label: pt ? 'Colocar na caixa de mensagem' : 'Put back in the message box',
            hint: pt
              ? 'Devolve o texto à caixa de mensagem para você revisar e enviar de novo. Nada é reenviado sozinho.'
              : 'Puts the text back in the message box so you can review it and send it again. Nothing is resent by itself.',
            run: () => onPutBack(q.text),
          } : {
            label: copied === i ? (pt ? 'Copiado' : 'Copied') : (pt ? 'Copiar mensagem' : 'Copy message'),
            hint: pt
              ? 'Copia o texto para a área de transferência. Esta tela não tem caixa de mensagem, então o cartão fica aqui.'
              : 'Copies the text to the clipboard. This screen has no message box, so the card stays here.',
            run: () => { void copyText(q.text).then(ok => setCopied(ok ? i : null)) },
          }}
          {...(q.at !== undefined ? { awaitingSinceMs: Math.max(0, now - q.at) } : {})}
        />
      ))}
    </>
  )
}
