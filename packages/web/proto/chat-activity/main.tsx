/**
 * CHAT.ACTIVITY prototype page. Query: ?option=A|B|C&theme=dark|light&state=collapsed|expanded&lang=pt|en
 * Real components (`ChatBubble`, `ToolActivity`, `WorkingNote` vocabulary) over mocked turns.
 */
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import '../../src/index.css'
import { ChatBubble, type ChatTurn } from '../../src/components/sessions/ChatBubble'
import { HarnessMark } from '../../src/components/sessions/HarnessMark'
import { ToolActivity, type ToolActivityVariant } from '../../src/components/sessions/ToolActivity'
import { groupConsecutive, groupPerExchange, type ChatItem, type TurnLike } from '../../src/lib/toolActivity'
import { NOW_RUNNING, SCENARIOS, type Scenario } from './mock'

const q = new URLSearchParams(location.search)
const option = (q.get('option') ?? 'A').toUpperCase() as 'A' | 'B' | 'C'
const theme = q.get('theme') === 'light' ? 'light' : 'dark'
const expanded = q.get('state') === 'expanded'
const lang = q.get('lang') === 'en' ? 'en' : 'pt'
document.documentElement.setAttribute('data-theme', theme)
document.body.style.background = 'var(--bg-base)'
document.body.style.margin = '0'

const VARIANT: Record<typeof option, ToolActivityVariant> = { A: 'divider', B: 'inline', C: 'live' }
const TITLE: Record<typeof option, [string, string]> = {
  A: ['A · uma linha por pedido', 'A · one line per request'],
  B: ['B · uma linha por sequência de ferramentas', 'B · one line per run of tools'],
  C: ['C · linha viva que recolhe ao terminar', 'C · live line that collapses when done'],
}

function Conversation({ s }: { s: Scenario }) {
  const items: ChatItem<TurnLike>[] = option === 'A' ? groupPerExchange(s.turns) : groupConsecutive(s.turns)
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.6 }}>
        <HarnessMark harness={s.harness} size={14} />{s.title}
      </div>
      {items.map((it, i) => it.type === 'turn'
        ? <ChatBubble key={i} turn={{ ...(it.turn as ChatTurn), tools: undefined } as ChatTurn} lang={lang} harness={s.harness} />
        : <ToolActivity key={it.group.key} group={it.group} lang={lang} variant={VARIANT[option]}
            defaultOpen={expanded} now={NOW_RUNNING} />)}
    </section>
  )
}

function Page() {
  const pt = lang === 'pt'
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)', color: 'var(--text-primary)', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <div style={{ maxWidth: 780, margin: '0 auto', padding: '20px 16px 48px', display: 'flex', flexDirection: 'column', gap: 28 }}>
        <header style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          <strong style={{ color: 'var(--text-primary)' }}>{TITLE[option][pt ? 0 : 1]}</strong>
          {' — '}{expanded ? (pt ? 'aberto' : 'expanded') : (pt ? 'recolhido' : 'collapsed')}
          {' · '}{theme}
        </header>
        {SCENARIOS.map(s => <Conversation key={s.harness} s={s} />)}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<BrowserRouter><Page /></BrowserRouter>)
