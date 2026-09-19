/**
 * RepoSearchView — the tree, replaced by a flat list of what matched.
 *
 * It is a LAYER over the tree rather than a panel beside it, the same trade `ArtifactsAside` makes
 * for its list and its document: this column is already narrow, and a tree sharing it with a result
 * list would leave neither readable.
 *
 * TWO KINDS OF HIT, AND THEY ARE NOT THE SAME THING. A NAME hit says "a file is called this" and
 * opens at the top; a CONTENT hit says "line 214 of this file reads this" and opens THERE. Drawing
 * them as one indistinguishable row would hide the only reason a content hit is worth clicking, so
 * they differ in their icon, in what they show (a content hit carries `:line` and the matched line
 * under it) and — for a reader who gets none of that — in their accessible label.
 *
 * FIVE STATES, FIVE SENTENCES, and never one shared empty box: nothing typed yet, typed but too
 * short to spend a whole-repository grep on, a search still RUNNING, a search that FAILED, and a
 * query that genuinely matched NOTHING. The last two are the pair that matters — "no results" over
 * a request that never arrived is the confident zero this codebase refuses everywhere. A failure
 * shows the server's own already-localized sentence through `repoErrorText.ts`, which invents one
 * only for the refusals that arrive carrying none.
 *
 * A PARTIAL WINDOW SAYS SO, AT THE TOP. The server caps at `SEARCH_LIMIT` and reports `truncated`;
 * the notice goes ABOVE the rows because at the bottom of 200 results nobody reads it, and a reader
 * who believes they are looking at every match stops looking. The count is `hits.length` rather
 * than the server's own constant — this file has no business knowing that number, and the rows on
 * screen are the honest denominator.
 *
 * WHAT THIS COMPONENT ADDS to the already-tested `repoApi.ts` is the DEBOUNCE and the stale-answer
 * guard, and they live in `createSearchQueue` — exported, with an injectable delay, because this
 * repo has no jsdom stack (see `ConnectionCard.test.tsx`'s note) and a timer is not a fact a
 * statically rendered string can carry. `RepoSearchResults` is likewise exported and takes its
 * state as a prop, for the same reason: `useEffect` never runs under `renderToStaticMarkup`, so a
 * list that could only be reached by fetching could not be asserted at all.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, AlignLeft, ArrowLeft, File, FileSearch, Loader, Search, X } from 'lucide-react'
import { searchRepo, type RepoLang, type SearchHit, type SearchResult } from '../../lib/repoApi'
import { repoFailureText } from '../../lib/repoErrorText'
import { useIsMobile } from '../../hooks/useIsMobile'
import { RepoNote } from './repoNote'

export interface RepoSearchViewProps {
  sessionId: string
  /** A content hit opens at its own line; a name hit has none, and the editor opens at the top. */
  onOpenFile: (path: string, line?: number) => void
  onBack: () => void
  lang: 'pt' | 'en'
}

/**
 * Long enough that a search is worth what it costs, short enough not to be in the way.
 *
 * A one-character query makes the server `git grep` a whole checkout and answer with a truncated
 * 200 rows that name nothing in particular — a cost paid, on a timer, for a result nobody can use.
 * It is REFUSED IN WORDS rather than by doing nothing: a box that silently ignores what you typed
 * is indistinguishable from one that is broken.
 */
export const MIN_QUERY_LEN = 2

/** Long enough to swallow typing, short enough not to feel like a submit button. */
export const DEBOUNCE_MS = 250

/**
 * One matched line, capped.
 *
 * `git grep` answers with the WHOLE line, and one line of a minified bundle is measured in hundreds
 * of kilobytes. The row shows one line of a narrow column either way, so the cap costs nothing a
 * reader could have seen and saves the DOM a string nobody asked for. Leading indentation goes for
 * the same reason: it is the one part of a matched line guaranteed to say nothing.
 */
const SNIPPET_MAX = 200

export function snippetOf(text: string): string {
  const trimmed = text.trimStart()
  return trimmed.length > SNIPPET_MAX ? `${trimmed.slice(0, SNIPPET_MAX)}…` : trimmed
}

/** What the list has to say. Five phases, because they are five different facts. */
export type SearchState =
  | { phase: 'idle' }
  | { phase: 'short' }
  | { phase: 'searching' }
  | { phase: 'failed'; text: string }
  | { phase: 'results'; hits: SearchHit[]; truncated: boolean }

const IDLE: SearchState = { phase: 'idle' }
const SHORT: SearchState = { phase: 'short' }
const SEARCHING: SearchState = { phase: 'searching' }

/**
 * What a query is WORTH DOING, before anything is scheduled — pure, so the two cheap answers cost
 * no request and no timer at all.
 */
export function queryState(q: string): 'idle' | 'short' | 'search' {
  const trimmed = q.trim()
  if (trimmed === '') return 'idle'
  return trimmed.length < MIN_QUERY_LEN ? 'short' : 'search'
}

/**
 * One search, one state. The three outcomes `repoApi` can answer with become exactly two phases:
 * a success is `results` (empty hits included — "nothing matched" is a real answer), and either
 * kind of failure is `failed` carrying the sentence a reader is owed.
 *
 * The searcher is an argument so this can be driven without a network, exactly as
 * `toggleDirectory` takes its loader.
 */
export async function runSearch(
  sessionId: string,
  q: string,
  lang: RepoLang,
  search: (sessionId: string, q: string, lang: RepoLang) => Promise<SearchResult> = searchRepo,
): Promise<SearchState> {
  const res = await search(sessionId, q, lang)
  if (res.ok) return { phase: 'results', hits: res.hits, truncated: res.truncated }
  return { phase: 'failed', text: repoFailureText(res, lang) }
}

export interface SearchQueue {
  /** Schedule `q`. A push inside the window REPLACES the pending one — this is the debounce. */
  push(q: string): void
  /** Run the pending query now. What `Enter` does: a reader who has finished typing says so. */
  flush(): void
  /** Forget the pending query AND invalidate any answer still in flight. */
  cancel(): void
}

/**
 * The debounce and the stale-answer guard, as one object.
 *
 * A keystroke per request would spend a `git grep` of a whole checkout on every letter of a word.
 * And even debounced, ANSWERS CAN OVERTAKE EACH OTHER: a slow search for `us` landing after a fast
 * one for `user` would replace the fresher list with the staler one, silently. The sequence number
 * is what closes that — only the most recently STARTED run may emit, and `cancel` bumps it too, so
 * a queue torn down with a request in flight can never write into an unmounted component.
 */
export function createSearchQueue(
  run: (q: string) => Promise<SearchState>,
  emit: (state: SearchState) => void,
  delayMs: number = DEBOUNCE_MS,
): SearchQueue {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: string | null = null
  let seq = 0

  const fire = () => {
    timer = null
    const q = pending
    pending = null
    if (q === null) return
    const mine = ++seq
    void run(q).then(state => { if (mine === seq) emit(state) })
  }

  return {
    push(q) {
      pending = q
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(fire, delayMs)
    },
    flush() {
      if (timer === null) return
      clearTimeout(timer)
      fire()
    },
    cancel() {
      if (timer !== null) clearTimeout(timer)
      timer = null
      pending = null
      seq++
    },
  }
}

export function RepoSearchView({ sessionId, onOpenFile, onBack, lang }: RepoSearchViewProps) {
  const isMobile = useIsMobile()
  const pt = lang === 'pt'
  const [q, setQ] = useState('')
  const [state, setState] = useState<SearchState>(IDLE)

  // Keyed on the session and the language: both change what the server would answer, so both must
  // start a fresh queue and cancel whatever the old one had in flight.
  const queue = useMemo(
    () => createSearchQueue(query => runSearch(sessionId, query, lang), setState),
    [sessionId, lang],
  )
  useEffect(() => () => queue.cancel(), [queue])

  useEffect(() => {
    const shape = queryState(q)
    if (shape !== 'search') {
      queue.cancel()
      setState(shape === 'idle' ? IDLE : SHORT)
      return
    }
    // Said BEFORE the debounce window, not after it: the box has to look busy from the keystroke,
    // or a quarter of a second reads as a control that did nothing.
    setState(SEARCHING)
    queue.push(q.trim())
  }, [q, queue])

  const tap = isMobile ? 44 : 24

  return (
    <div style={{
      flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column',
      boxSizing: 'border-box',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: isMobile ? '6px 8px' : '5px 8px',
        borderBottom: '1px solid var(--border-subtle)',
        minWidth: 0, boxSizing: 'border-box',
      }}>
        <IconButton
          label={pt ? 'Voltar para a árvore de arquivos' : 'Back to the file tree'}
          size={tap}
          onClick={onBack}
        >
          <ArrowLeft size={15} />
        </IconButton>
        <Search size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
        <input
          // Design item 8: Ctrl/Cmd+Shift+F switches to this view precisely so the query is ready
          // to type into — focusing it here covers every route in (the toolbar's own search
          // button included), not only the new shortcut.
          autoFocus
          value={q}
          onChange={ev => setQ(ev.target.value)}
          onKeyDown={ev => { if (ev.key === 'Enter') { ev.preventDefault(); queue.flush() } }}
          aria-label={pt ? 'Buscar nos arquivos da sessão' : 'Search this session’s files'}
          placeholder={pt ? 'Nome do arquivo ou conteúdo…' : 'File name or content…'}
          style={{
            flex: 1, minWidth: 0, boxSizing: 'border-box',
            background: 'transparent', border: 'none', outline: 'none',
            fontFamily: 'inherit', color: 'var(--text-primary)',
            // 16px on a phone is not a taste: below it, iOS Safari zooms the viewport on focus and
            // takes the workspace's sticky header with it.
            fontSize: isMobile ? 16 : 13,
            minHeight: isMobile ? 44 : undefined,
          }}
        />
        {q !== '' && (
          <IconButton
            label={pt ? 'Limpar a busca' : 'Clear the search'}
            size={tap}
            onClick={() => setQ('')}
          >
            <X size={14} />
          </IconButton>
        )}
      </div>

      <RepoSearchResults state={state} query={q.trim()} lang={lang} onOpenFile={onOpenFile} />
    </div>
  )
}

export interface RepoSearchResultsProps {
  state: SearchState
  /** What was asked, so "nothing matched" can name it rather than being a bare shrug. */
  query: string
  lang: 'pt' | 'en'
  onOpenFile: (path: string, line?: number) => void
}

/**
 * The list itself — every state it can be in, given as a prop.
 *
 * Split out so the states can be rendered directly in a test: `useEffect` never runs under
 * `renderToStaticMarkup`, so a list reachable only by fetching would be permanently empty there.
 */
export function RepoSearchResults({ state, query, lang, onOpenFile }: RepoSearchResultsProps) {
  const isMobile = useIsMobile()
  const pt = lang === 'pt'

  return (
    <div
      role="region"
      aria-label={pt ? 'Resultados da busca' : 'Search results'}
      aria-busy={state.phase === 'searching'}
      style={{
        flex: 1, minHeight: 0, minWidth: 0,
        overflowY: 'auto', overflowX: 'hidden', overscrollBehavior: 'contain',
        display: 'flex', flexDirection: 'column',
      }}
    >
      {state.phase === 'idle' && (
        <RepoNote
          icon={<Search size={15} />}
          text={pt
            ? 'Digite para buscar os arquivos desta sessão por nome e pelo conteúdo.'
            : 'Type to search this session’s files by name, and their contents.'}
        />
      )}

      {state.phase === 'short' && (
        <RepoNote
          icon={<Search size={15} />}
          text={pt
            ? `Digite pelo menos ${MIN_QUERY_LEN} caracteres para buscar.`
            : `Type at least ${MIN_QUERY_LEN} characters to search.`}
        />
      )}

      {state.phase === 'searching' && (
        <RepoNote
          icon={<Loader size={15} className="ag-working-spin" />}
          text={pt ? 'Buscando…' : 'Searching…'}
        />
      )}

      {/* A failure is NOT an empty result. The sentence is the server's own wherever it wrote one. */}
      {state.phase === 'failed' && (
        <RepoNote
          icon={<AlertTriangle size={15} style={{ color: 'var(--accent-red)' }} />}
          text={state.text}
        />
      )}

      {state.phase === 'results' && state.hits.length === 0 && (
        <RepoNote
          icon={<FileSearch size={15} />}
          text={pt
            ? `Nada corresponde a “${query}”. Arquivos ignorados pelo git não são pesquisados.`
            : `Nothing matched “${query}”. Files the gitignore excludes are not searched.`}
        />
      )}

      {state.phase === 'results' && state.hits.length > 0 && (
        <>
          <Summary count={state.hits.length} truncated={state.truncated} lang={lang} />
          {state.hits.map((hit, i) => (
            <HitRow
              key={rowKey(hit, i)}
              hit={hit}
              isMobile={isMobile}
              lang={lang}
              onOpen={() => onOpenFile(hit.path, hit.kind === 'content' ? hit.line : undefined)}
            />
          ))}
        </>
      )}
    </div>
  )
}

/**
 * The index is part of the key on purpose: one file can match on its NAME and on several of its
 * LINES, and two hits on the same line are possible when a line matches twice. The server's order
 * is stable for one answer, so the index is the only thing that makes each row distinct.
 */
function rowKey(hit: SearchHit, i: number): string {
  return hit.kind === 'content' ? `c-${hit.path}-${hit.line}-${i}` : `n-${hit.path}-${i}`
}

/**
 * How many, and whether that is all of them.
 *
 * At the TOP, because the cap is a fact about the list you are ABOUT to read — at the bottom of 200
 * rows it reaches nobody, and a reader who believes they have seen every match stops looking.
 */
function Summary({ count, truncated, lang }: { count: number; truncated: boolean; lang: 'pt' | 'en' }) {
  const pt = lang === 'pt'
  const text = truncated
    ? (pt
      ? `Mostrando os primeiros ${count} resultados — há mais. Refine a busca.`
      : `Showing the first ${count} matches — there are more. Narrow your search.`)
    : (pt
      ? (count === 1 ? '1 resultado.' : `${count} resultados.`)
      : (count === 1 ? '1 match.' : `${count} matches.`))
  return (
    <div
      role="status"
      style={{
        padding: '6px 12px', fontSize: 11, lineHeight: 1.5,
        color: truncated ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
        borderBottom: '1px solid var(--border-subtle)',
        minWidth: 0, boxSizing: 'border-box',
      }}
    >
      {text}
    </div>
  )
}

/**
 * One hit.
 *
 * THE FILE NAME COMES FIRST AND THE DIRECTORY AFTER IT, dimmed — the shape a quick-open list has
 * everywhere, and here it is what decides WHAT GETS TRUNCATED. A path drawn in its own order
 * ellipsizes from the right, which in a 390px column eats exactly the file name, the one part that
 * tells two rows apart; the folder is the part a reader can afford to lose. `box-sizing:
 * border-box` on a `width: 100%` button for the same reason `RepoTreeView` needs it — this column
 * must not scroll sideways at 390px.
 */
function HitRow({ hit, isMobile, lang, onOpen }: {
  hit: SearchHit
  isMobile: boolean
  lang: 'pt' | 'en'
  onOpen: () => void
}) {
  const pt = lang === 'pt'
  const cut = hit.path.lastIndexOf('/')
  const dir = cut === -1 ? '' : hit.path.slice(0, cut)
  const name = cut === -1 ? hit.path : hit.path.slice(cut + 1)
  const label = hit.kind === 'content'
    ? (pt ? `Linha ${hit.line} de ${hit.path}` : `Line ${hit.line} of ${hit.path}`)
    : (pt ? `Arquivo ${hit.path}` : `File ${hit.path}`)

  return (
    <button
      type="button"
      title={hit.kind === 'content' ? `${hit.path}:${hit.line}` : hit.path}
      aria-label={label}
      data-hit-kind={hit.kind}
      onClick={onOpen}
      onMouseEnter={ev => { ev.currentTarget.style.background = 'var(--bg-elevated)' }}
      onMouseLeave={ev => { ev.currentTarget.style.background = 'transparent' }}
      style={{
        display: 'block', width: '100%', boxSizing: 'border-box', minWidth: 0, textAlign: 'left',
        // 44px on a phone is the touch-target floor; a desktop row stays as dense as every other
        // list in this aside.
        minHeight: isMobile ? 44 : undefined,
        padding: isMobile ? '7px 12px' : '5px 10px',
        background: 'transparent', border: 'none',
        borderBottom: '1px solid var(--border-subtle)', borderRadius: 0,
        cursor: 'pointer', fontFamily: 'inherit',
      }}
    >
      <span style={{
        display: 'flex', alignItems: 'center', gap: 6, minWidth: 0,
        fontSize: isMobile ? 13 : 12.5, color: 'var(--text-primary)',
      }}>
        <span style={{ flexShrink: 0, display: 'inline-flex', color: 'var(--text-tertiary)' }}>
          {hit.kind === 'content' ? <AlignLeft size={12} /> : <File size={12} />}
        </span>
        <span style={{
          flexShrink: 0, maxWidth: '65%',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {name}
        </span>
        {hit.kind === 'content' && (
          <span style={{ flexShrink: 0, color: 'var(--text-tertiary)', fontSize: 11 }}>
            :{hit.line}
          </span>
        )}
        {dir !== '' && (
          <span style={{
            flex: 1, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            color: 'var(--text-tertiary)', fontSize: 11,
          }}>
            {dir}
          </span>
        )}
      </span>

      {/* The matched line is the whole reason a content hit is worth opening AT that line — without
          it the row says only "somewhere in this file", which the name hit above already said. */}
      {hit.kind === 'content' && (
        <span style={{
          display: 'block', marginTop: 2, minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 11, lineHeight: 1.45,
          color: 'var(--text-tertiary)',
        }}>
          {snippetOf(hit.text)}
        </span>
      )}
    </button>
  )
}

/** A control that is only an icon still has to be a 44px target on a phone, and still has a name. */
function IconButton({ label, size, onClick, children }: {
  label: string
  size: number
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: size, height: size, flexShrink: 0, boxSizing: 'border-box',
        padding: 0, background: 'transparent', border: 'none', borderRadius: 6,
        cursor: 'pointer', color: 'var(--text-tertiary)',
      }}
    >
      {children}
    </button>
  )
}
