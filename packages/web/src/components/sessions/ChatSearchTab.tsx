/**
 * ChatSearchTab — "Buscar na conversa": search the WHOLE transcript of this session and list the
 * messages that carry the query.
 *
 * A PANEL LIKE THE OTHERS (`search` in `panelSlots.ts`): it opens from the rail, docks in the
 * bottom band, floats — the chrome is the panel system's, this component is only its body.
 *
 * THE PIECES ARE THE STUDIO'S FILE SEARCH (`RepoSearchView`): the same field, the same debounce and
 * stale-answer guard (`createSearchQueue`, here at 200 ms), the same state sentences (`RepoNote`) and
 * the same icon buttons. The result row is the chat's own vocabulary: who said it named like the
 * bubble names it, and the bubble's own time stamp (`chatSearchRow`).
 *
 * A RESULT IS A MESSAGE, and its menu offers what the chat bubble offers for one — Copy, Forward —
 * plus the one thing only a search needs: Go to the message. Forward and Go-to are the CHAT's own
 * (its forward modal, its turn window and flash), reached through `chatSearchBridge.ts`; every
 * outcome that is not "done" is SAID under the field, never a click that does nothing.
 *
 * SIX STATES, SIX SENTENCES — nothing typed, too short, searching, failed, the conversation cannot be
 * read (the chat's own refusal, verbatim), and a real "nothing matched" that names the query and
 * how many messages were looked at. An empty list is never allowed to stand for any of the others.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Loader, MessageSquareText, Search, User, X } from 'lucide-react'
import { CHAT_SEARCH_MIN_CHARS, type ChatSearchHit } from '@agentistics/core'
import { createSearchQueue, IconButton } from './RepoSearchView'
import { RepoNote } from './repoNote'
import { SessionRowMenu } from './SessionRowMenu'
import { HarnessMark } from './HarnessMark'
import { useIsMobile } from '../../hooks/useIsMobile'
import { fetchChatSearch, type ChatSearchResult } from '../../lib/chatSearchApi'
import { chatSearchMenu, chatSearchRow, type ChatSearchAction } from '../../lib/chatSearchRows'
import { requestChatSearch } from '../../lib/chatSearchBridge'
import { copyText } from '../../lib/clipboard'

/** Long enough to swallow typing, short enough to feel live (the owner's 200 ms). */
const DEBOUNCE_MS = 200

export type ChatSearchState =
  | { phase: 'idle' }
  | { phase: 'short' }
  | { phase: 'searching' }
  | { phase: 'failed'; text: string }
  | { phase: 'results'; result: ChatSearchResult }

export interface ChatSearchTabProps {
  sessionId: string
  lang: 'pt' | 'en'
  /** The session's harness, for naming who said an assistant message before the server answers. */
  harness?: string
  /**
   * The chat took the request (went to the message, or opened its forward picker). On a PHONE the
   * panel covers the chat, so the caller closes it here — a scroll or a picker under a full-screen
   * panel is an action the reader cannot see. Absent on desktop, where the chat is beside it.
   */
  onHandedToChat?: () => void
}

function shapeOf(q: string): 'idle' | 'short' | 'search' {
  const t = q.trim()
  if (t === '') return 'idle'
  return t.length < CHAT_SEARCH_MIN_CHARS ? 'short' : 'search'
}

export function ChatSearchTab({ sessionId, lang, harness, onHandedToChat }: ChatSearchTabProps) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const [q, setQ] = useState('')
  const [state, setState] = useState<ChatSearchState>({ phase: 'idle' })
  const [more, setMore] = useState(false)
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; hit: ChatSearchHit } | null>(null)

  const queue = useMemo(() => createSearchQueue<ChatSearchState>(async query => {
    const out = await fetchChatSearch(sessionId, query, lang)
    return out.ok ? { phase: 'results', result: out.result } : { phase: 'failed', text: out.text }
  }, setState, DEBOUNCE_MS), [sessionId, lang])
  useEffect(() => () => queue.cancel(), [queue])

  useEffect(() => {
    const shape = shapeOf(q)
    setNotice(null)
    if (shape !== 'search') {
      queue.cancel()
      setState({ phase: shape })
      return
    }
    setState({ phase: 'searching' })
    queue.push(q.trim())
  }, [q, queue])

  /** The next page, appended. A failure keeps what is on screen and says so. */
  const loadMore = useCallback(async () => {
    if (state.phase !== 'results') return
    const have = state.result
    setMore(true)
    const out = await fetchChatSearch(sessionId, have.query, lang, have.hits.length)
    setMore(false)
    if (!out.ok) { setNotice({ text: out.text, bad: true }); return }
    setState(s => s.phase === 'results' && s.result.query === have.query
      ? { phase: 'results', result: { ...out.result, hits: [...s.result.hits, ...out.result.hits] } }
      : s)
  }, [state, sessionId, lang])

  const pick = useCallback((action: ChatSearchAction, hit: ChatSearchHit) => {
    const turn = { role: hit.role, text: hit.text, ...(hit.at ? { at: hit.at } : {}) }
    if (action === 'copy') {
      void copyText(hit.text).then(ok => setNotice(ok
        ? { text: pt ? 'Mensagem copiada.' : 'Message copied.' }
        : { text: pt ? 'O navegador não liberou a área de transferência aqui.' : 'The browser did not allow the clipboard here.', bad: true }))
      return
    }
    const outcome = requestChatSearch(sessionId, { kind: action, turn })
    if (outcome === 'done') { setNotice(null); onHandedToChat?.(); return }
    setNotice({
      bad: true,
      text: outcome === 'no-chat'
        ? (pt
          ? 'O chat desta sessão não está aberto — abra a aba de chat para ir até a mensagem ou encaminhá-la.'
          : 'This session’s chat is not open — open the chat view to go to the message or forward it.')
        : (pt
          ? 'Essa mensagem é mais antiga que a parte da conversa que o chat carrega. Use Copiar para levá-la.'
          : 'That message is older than the part of the conversation the chat holds. Use Copy to take it.'),
    })
  }, [sessionId, pt, onHandedToChat])

  const tap = isMobile ? 44 : 24
  const result = state.phase === 'results' ? state.result : null
  const who = result?.harness ?? harness

  return (
    <div style={{
      flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', boxSizing: 'border-box',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
        padding: isMobile ? '6px 8px' : '5px 8px',
        borderBottom: '1px solid var(--border-subtle)', minWidth: 0, boxSizing: 'border-box',
      }}>
        <Search size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
        <input
          autoFocus={!isMobile}
          value={q}
          onChange={ev => setQ(ev.target.value)}
          onKeyDown={ev => {
            if (ev.key === 'Enter') { ev.preventDefault(); queue.flush() }
            if (ev.key === 'Escape' && q !== '') { ev.preventDefault(); setQ('') }
          }}
          aria-label={pt ? 'Buscar na conversa' : 'Search the conversation'}
          placeholder={pt ? 'Buscar na conversa…' : 'Search the conversation…'}
          style={{
            flex: 1, minWidth: 0, boxSizing: 'border-box',
            background: 'transparent', border: 'none', outline: 'none',
            fontFamily: 'inherit', color: 'var(--text-primary)',
            // 16px on a phone: below it iOS Safari zooms the viewport on focus.
            fontSize: isMobile ? 16 : 13,
            minHeight: isMobile ? 44 : undefined,
          }}
        />
        {q !== '' && (
          <IconButton label={pt ? 'Limpar a busca' : 'Clear the search'} size={tap} onClick={() => setQ('')}>
            <X size={14} />
          </IconButton>
        )}
      </div>

      {notice && (
        <p role="status" style={{
          margin: 0, padding: '6px 10px', flexShrink: 0, fontSize: 11, lineHeight: 1.5,
          color: notice.bad ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
          borderBottom: '1px solid var(--border-subtle)',
        }}>{notice.text}</p>
      )}

      <div
        role="region"
        aria-label={pt ? 'Resultados da busca na conversa' : 'Conversation search results'}
        aria-busy={state.phase === 'searching'}
        style={{
          flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto', overflowX: 'hidden',
          overscrollBehavior: 'contain', display: 'flex', flexDirection: 'column',
        }}
      >
        {state.phase === 'idle' && (
          <RepoNote icon={<MessageSquareText size={15} />} text={pt
            ? 'Digite para buscar em toda a conversa desta sessão — inclusive mensagens antigas que o chat não carregou. Maiúsculas e acentos não importam.'
            : 'Type to search this session’s whole conversation — older messages the chat has not loaded included. Case and accents do not matter.'} />
        )}
        {state.phase === 'short' && (
          <RepoNote icon={<Search size={15} />} text={pt
            ? `Digite pelo menos ${CHAT_SEARCH_MIN_CHARS} caracteres para buscar.`
            : `Type at least ${CHAT_SEARCH_MIN_CHARS} characters to search.`} />
        )}
        {state.phase === 'searching' && (
          <RepoNote icon={<Loader size={15} className="ag-working-spin" />} text={pt ? 'Buscando…' : 'Searching…'} />
        )}
        {state.phase === 'failed' && (
          <RepoNote icon={<AlertTriangle size={15} style={{ color: 'var(--accent-red)' }} />} text={state.text} />
        )}
        {result && result.unavailable && <RepoNote text={result.unavailable} />}
        {result && !result.unavailable && result.hits.length === 0 && (
          <RepoNote icon={<Search size={15} />} text={pt
            ? `Nada corresponde a “${result.query}” nas ${result.scanned} mensagens desta conversa.`
            : `Nothing matched “${result.query}” in this conversation’s ${result.scanned} messages.`} />
        )}
        {result && !result.unavailable && result.hits.length > 0 && (
          <>
            <div role="status" style={{
              padding: '6px 12px', fontSize: 11, lineHeight: 1.5, color: 'var(--text-tertiary)',
              borderBottom: '1px solid var(--border-subtle)', flexShrink: 0,
            }}>
              {pt
                ? `${result.total === 1 ? '1 mensagem' : `${result.total} mensagens`} de ${result.scanned} — mais recentes primeiro.`
                : `${result.total === 1 ? '1 message' : `${result.total} messages`} of ${result.scanned} — newest first.`}
            </div>
            {result.hits.map(hit => (
              <ResultRow
                key={hit.index}
                hit={hit}
                harness={who}
                lang={lang}
                isMobile={isMobile}
                onMenu={(x, y) => { setNotice(null); setMenu({ x, y, hit }) }}
              />
            ))}
            {result.hits.length < result.total && (
              <button
                type="button"
                className="ag-tap"
                disabled={more}
                onClick={() => { void loadMore() }}
                style={{
                  margin: '8px auto 12px', padding: '0 14px', minHeight: isMobile ? 44 : 28,
                  borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-elevated)',
                  color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 12, cursor: more ? 'default' : 'pointer',
                  flexShrink: 0,
                }}
              >
                {more
                  ? (pt ? 'Carregando…' : 'Loading…')
                  : (pt
                    ? `Mostrar mais (${result.total - result.hits.length})`
                    : `Show more (${result.total - result.hits.length})`)}
              </button>
            )}
          </>
        )}
      </div>

      {menu && (
        <SessionRowMenu
          x={menu.x} y={menu.y}
          entries={chatSearchMenu(lang)}
          onPick={action => pick(action as ChatSearchAction, menu.hit)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

/**
 * One result. A BUTTON: click (or Enter) opens the menu at the row, right-click opens it at the
 * pointer — the same two ways the gallery's rows open theirs.
 */
function ResultRow({ hit, harness, lang, isMobile, onMenu }: {
  hit: ChatSearchHit
  harness: string | undefined
  lang: 'pt' | 'en'
  isMobile: boolean
  onMenu: (x: number, y: number) => void
}) {
  const row = chatSearchRow(hit, harness, lang)
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <button
      ref={ref}
      type="button"
      aria-haspopup="menu"
      aria-label={`${row.who}${row.time ? `, ${row.time.full}` : ''}: ${hit.excerpt}`}
      onClick={ev => {
        const r = ref.current?.getBoundingClientRect()
        // A keyboard "click" has no pointer position; anchor the menu under the row's start.
        const fromKey = ev.clientX === 0 && ev.clientY === 0
        onMenu(fromKey && r ? r.left + 12 : ev.clientX, fromKey && r ? r.bottom : ev.clientY)
      }}
      onContextMenu={ev => { ev.preventDefault(); onMenu(ev.clientX, ev.clientY) }}
      onMouseEnter={ev => { ev.currentTarget.style.background = 'var(--bg-elevated)' }}
      onMouseLeave={ev => { ev.currentTarget.style.background = 'transparent' }}
      style={{
        display: 'block', width: '100%', boxSizing: 'border-box', minWidth: 0, textAlign: 'left',
        minHeight: isMobile ? 44 : undefined,
        padding: isMobile ? '8px 12px' : '6px 10px',
        background: 'transparent', border: 'none', borderBottom: '1px solid var(--border-subtle)',
        borderRadius: 0, cursor: 'pointer', fontFamily: 'inherit',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, fontSize: 11.5 }}>
        <span style={{ flexShrink: 0, display: 'inline-flex', color: row.mine ? 'var(--text-secondary)' : undefined }}>
          {row.mine ? <User size={12} /> : <HarnessMark harness={harness ?? ''} size={12} />}
        </span>
        <span style={{
          minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600,
          color: row.color ?? 'var(--text-secondary)',
        }}>{row.who}</span>
        {row.time && (
          <span title={row.time.full} style={{ marginLeft: 'auto', flexShrink: 0, color: 'var(--text-tertiary)', fontSize: 10.5 }}>
            {row.time.label}
          </span>
        )}
      </span>
      <span style={{
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
        marginTop: 3, minWidth: 0, overflowWrap: 'anywhere',
        fontSize: isMobile ? 13 : 12, lineHeight: 1.45, color: 'var(--text-primary)',
      }}>
        {row.segments.map((s, i) => s.mark
          ? (
            <mark key={i} style={{
              background: 'color-mix(in srgb, var(--anthropic-orange) 32%, transparent)',
              color: 'inherit', borderRadius: 2, padding: '0 1px',
            }}>{s.text}</mark>
          )
          : <span key={i}>{s.text}</span>)}
      </span>
    </button>
  )
}
