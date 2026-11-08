/**
 * FLUXO.AVISOS 10 — a dev-only render of the REAL `ChatBubble` for a QUEUED message, with the actions its caption offers.
 * The actions come from the real pure rule (`queuedBubbleActions`), so what is drawn is what a session would offer.
 * Not shipped. Query: ?harness=claude|codex &working=1|0 &dialog=1 &many=1 &theme=dark|light &lang=pt|en
 */
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import '../../src/index.css'
import { ChatBubble } from '../../src/components/sessions/ChatBubble'
import { queuedBubbleActions } from '../../src/lib/queuedCards'

const q = new URLSearchParams(location.search)
const lang = (q.get('lang') ?? 'pt') as 'pt' | 'en'
const pt = lang === 'pt'
const harness = q.get('harness') ?? 'claude'
const working = q.get('working') !== '0'
const dialogOpen = q.get('dialog') === '1'
const many = q.get('many') === '1'
document.documentElement.setAttribute('data-theme', q.get('theme') === 'light' ? 'light' : 'dark')

const queued = many
  ? ['corrige a coluna de histórico', 'e depois manda o relatório para o time com os números de hoje']
  : ['corrige a coluna de histórico']
const run = (what: string) => () => { (window as unknown as { __ran?: string[] }).__ran = [...((window as unknown as { __ran?: string[] }).__ran ?? []), what] }

createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <div style={{ maxWidth: 720, margin: '24px auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12, background: 'var(--bg-primary, transparent)' }}>
      <ChatBubble turn={{ role: 'assistant', text: pt ? 'Estou ajustando a fila agora; termino em alguns minutos.' : 'Adjusting the queue now; a few minutes left.' }} sessionId="preview" lang={lang} harness={harness} />
      {queued.map((text, i) => {
        const a = queuedBubbleActions({ text, harness, working, dialogOpen, personQueued: queued.length, sendNowRunning: false, stopEnabled: true, pt })
        return (
          <ChatBubble
            key={i}
            turn={{ role: 'user', text }}
            sessionId="preview"
            lang={lang}
            harness={harness}
            awaiting
            awaitingWorking={working}
            awaitingSinceMs={(i + 2) * 61_000}
            awaitingActions={{
              ...(a.sendNow ? { sendNow: { ...a.sendNow, run: run('sendNow') } } : {}),
              ...(a.interrupt ? { interrupt: { ...a.interrupt, run: run('interrupt') } } : {}),
            }}
          />
        )
      })}
    </div>
  </MemoryRouter>,
)
