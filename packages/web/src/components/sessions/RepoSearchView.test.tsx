/**
 * What THIS component adds to an already-tested client.
 *
 * `repoApi.test.ts` owns the three outcomes of a call and `repoErrorText.test.ts` owns the wording;
 * neither is re-asserted here. What is left is the search view's own: the two kinds of hit staying
 * distinguishable, the truncation notice appearing when and only when the window really is partial,
 * the five states staying five different sentences, and the one piece of behaviour this file
 * contributes — a debounce that does not fire per keystroke and a stale answer that cannot
 * overwrite a fresher one.
 *
 * Rendering is `renderToStaticMarkup`, the stack `RepoTreeView.test.tsx` and
 * `pages/settings/primitives.test.tsx` already use: this repo has no `@testing-library/react`/jsdom
 * (see `ConnectionCard.test.tsx`'s own note), so typing cannot be simulated and `useEffect` never
 * runs. `RepoSearchResults` therefore takes its state as a prop and `createSearchQueue` takes its
 * delay, which is what makes both drivable directly — with the same arguments the component passes.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  createSearchQueue, queryState, RepoSearchResults, runSearch, snippetOf,
  type SearchState,
} from './RepoSearchView'
import type { RepoLang, SearchHit, SearchResult } from '../../lib/repoApi'

/**
 * `useIsMobile` reads `window.innerWidth` in its state initializer. Bun's runtime has no DOM and
 * this file renders to a string rather than to one, so the width is the only thing that must exist;
 * `useEffect` (where `matchMedia` lives) never runs under `renderToStaticMarkup`.
 */
const env = globalThis as unknown as { window?: { innerWidth: number } }
env.window ??= { innerWidth: 1280 }
const desktop = () => { env.window!.innerWidth = 1280 }
const phone = () => { env.window!.innerWidth = 390 }

// A `phone()` a test body restores by hand with its own trailing `desktop()` call is undone only on
// the SUCCESS path — an assertion that throws between the two leaves `innerWidth: 390` for whatever
// test runs next in the process. This global `window` is never removed either way, so the guard has
// to be a reset, not a teardown.
afterEach(() => desktop())

function noop() { /* these renders never open anything */ }

const NAME_HIT: SearchHit = { kind: 'name', path: 'packages/web/src/lib/repoApi.ts' }
const CONTENT_HIT: SearchHit = {
  kind: 'content', path: 'packages/web/src/lib/repoApi.ts', line: 214, text: '  const hits = []',
}

function render(state: SearchState, lang: 'pt' | 'en' = 'en', query = 'repoApi'): string {
  return renderToStaticMarkup(
    <RepoSearchResults state={state} query={query} lang={lang} onOpenFile={noop} />,
  )
}

function results(hits: SearchHit[], truncated = false): SearchState {
  return { phase: 'results', hits, truncated }
}

// --- what a query is worth doing -----------------------------------------------------------------

describe('queryState', () => {
  test('nothing typed is IDLE, and costs no request', () => {
    expect(queryState('')).toBe('idle')
    expect(queryState('   ')).toBe('idle')
  })

  test('one character is too short to grep a whole checkout for', () => {
    expect(queryState('a')).toBe('short')
    expect(queryState('  a  ')).toBe('short')
  })

  test('two characters is a search', () => {
    expect(queryState('ab')).toBe('search')
    expect(queryState(' repoApi ')).toBe('search')
  })
})

// --- the five states, five sentences -------------------------------------------------------------

describe('the states', () => {
  test('idle, short, searching, failed and nothing-found are five different boxes', () => {
    desktop()
    const seen = [
      render({ phase: 'idle' }),
      render({ phase: 'short' }),
      render({ phase: 'searching' }),
      render({ phase: 'failed', text: 'The server did not answer.' }),
      render(results([])),
    ]
    expect(new Set(seen).size).toBe(5)
  })

  test('a search that FAILED is never drawn as a query that matched nothing', () => {
    desktop()
    const failed = render({ phase: 'failed', text: 'The server did not answer.' })
    const nothing = render(results([]))
    expect(failed).toContain('The server did not answer.')
    expect(failed).not.toContain('Nothing matched')
    expect(nothing).toContain('Nothing matched')
    expect(nothing).not.toContain('did not answer')
  })

  test('a search still RUNNING says so, and says it is busy', () => {
    desktop()
    const html = render({ phase: 'searching' })
    expect(html).toContain('Searching')
    expect(html).toContain('aria-busy="true"')
    expect(render(results([]))).toContain('aria-busy="false"')
  })

  test('the failure shows the sentence it was given, verbatim', () => {
    desktop()
    expect(render({ phase: 'failed', text: 'Esse caminho não existe mais.' }, 'pt'))
      .toContain('Esse caminho não existe mais.')
  })

  test('nothing-found names what was asked, rather than shrugging', () => {
    desktop()
    expect(render(results([]), 'en', 'widget')).toContain('widget')
  })

  test('every state is localized, and the two languages differ', () => {
    desktop()
    for (const state of [
      { phase: 'idle' } as const,
      { phase: 'short' } as const,
      { phase: 'searching' } as const,
      results([]),
      results([CONTENT_HIT]),
      results([CONTENT_HIT], true),
    ]) {
      expect(render(state, 'en')).not.toBe(render(state, 'pt'))
    }
  })
})

// --- the two kinds of hit ------------------------------------------------------------------------

describe('the two kinds of hit', () => {
  test('they are marked apart, not flattened into one indistinguishable row', () => {
    desktop()
    const html = render(results([NAME_HIT, CONTENT_HIT]))
    expect(html).toContain('data-hit-kind="name"')
    expect(html).toContain('data-hit-kind="content"')
  })

  test('a CONTENT hit carries its line number and the line that matched', () => {
    desktop()
    const html = render(results([CONTENT_HIT]))
    expect(html).toContain(':214')
    expect(html).toContain('const hits = []')
  })

  test('a NAME hit carries neither — there is no line, and inventing one would open the wrong place', () => {
    desktop()
    const html = render(results([NAME_HIT]))
    expect(html).not.toContain(':214')
    expect(html).not.toContain('const hits = []')
  })

  test('a reader who sees no icon is still told which kind a row is', () => {
    desktop()
    const en = render(results([NAME_HIT, CONTENT_HIT]))
    expect(en).toContain('aria-label="File packages/web/src/lib/repoApi.ts"')
    expect(en).toContain('aria-label="Line 214 of packages/web/src/lib/repoApi.ts"')
    const pt = render(results([CONTENT_HIT]), 'pt')
    expect(pt).toContain('Linha 214 de packages/web/src/lib/repoApi.ts')
  })

  test('the file name is shown, and the folder it sits in is shown dimmed beside it', () => {
    desktop()
    const html = render(results([NAME_HIT]))
    expect(html).toContain('repoApi.ts')
    expect(html).toContain('packages/web/src/lib')
    // …and the row is the whole path either way, for a pointer that hovers it.
    expect(html).toContain('title="packages/web/src/lib/repoApi.ts"')
  })

  test('one file matching on its name AND on several lines draws a row each', () => {
    desktop()
    const html = render(results([
      NAME_HIT,
      CONTENT_HIT,
      { kind: 'content', path: NAME_HIT.path, line: 9, text: 'import x' },
    ]))
    expect((html.match(/data-hit-kind=/g) ?? []).length).toBe(3)
  })
})

// --- the matched line ----------------------------------------------------------------------------

describe('snippetOf', () => {
  test('leading indentation goes — it is the one part of a matched line that says nothing', () => {
    expect(snippetOf('        const hits = []')).toBe('const hits = []')
  })

  test('a minified line is cut, and SAYS it was cut', () => {
    const huge = `x${'y'.repeat(5000)}`
    const out = snippetOf(huge)
    expect(out.length).toBeLessThan(250)
    expect(out.endsWith('…')).toBe(true)
  })

  test('a line that fits is untouched, ellipsis included', () => {
    expect(snippetOf('const a = 1')).toBe('const a = 1')
    expect(snippetOf('const a = 1').endsWith('…')).toBe(false)
  })
})

// --- the truncation notice -----------------------------------------------------------------------

describe('a partial window says so', () => {
  test('`truncated` raises the notice, and it names how many are on screen', () => {
    desktop()
    const html = render(results([NAME_HIT, CONTENT_HIT], true))
    expect(html).toContain('first 2 matches')
    expect(html).toContain('there are more')
  })

  test('a COMPLETE result never claims to be partial', () => {
    desktop()
    const html = render(results([NAME_HIT, CONTENT_HIT], false))
    expect(html).not.toContain('there are more')
    expect(html).toContain('2 matches')
  })

  test('one match is one match, not "1 matches"', () => {
    desktop()
    expect(render(results([NAME_HIT]))).toContain('1 match.')
    expect(render(results([NAME_HIT]), 'pt')).toContain('1 resultado.')
  })

  test('the notice is ABOVE the rows — at the bottom of 200 of them it reaches nobody', () => {
    desktop()
    const html = render(results([NAME_HIT], true))
    expect(html.indexOf('there are more')).toBeLessThan(html.indexOf('data-hit-kind'))
  })

  test('an empty result draws no count row at all', () => {
    desktop()
    const html = render(results([], false))
    expect(html).not.toContain('0 matches')
  })
})

// --- mobile --------------------------------------------------------------------------------------

describe('mobile', () => {
  test('a row is at least 44px tall on a phone and stays dense on a desktop', () => {
    phone()
    expect(render(results([NAME_HIT]))).toContain('min-height:44px')
    desktop()
    expect(render(results([NAME_HIT]))).not.toContain('min-height:44px')
  })

  test('the row never sets a width that could exceed its column', () => {
    phone()
    const html = render(results([CONTENT_HIT]))
    expect(html).toContain('width:100%')
    expect(html).toContain('box-sizing:border-box')
    expect(html).toContain('overflow-x:hidden')
    desktop()
  })

  test('the scrolling region contains its overscroll, as this panel requires', () => {
    desktop()
    expect(render(results([NAME_HIT]))).toContain('overscroll-behavior:contain')
  })
})

// --- one search, one state -----------------------------------------------------------------------

function answering(result: SearchResult) {
  const calls: { q: string; lang: RepoLang }[] = []
  const search = (_id: string, q: string, lang: RepoLang) => {
    calls.push({ q, lang })
    return Promise.resolve(result)
  }
  return { calls, search }
}

describe('runSearch', () => {
  test('a success becomes results, truncation carried through', async () => {
    const { search } = answering({ ok: true, hits: [NAME_HIT], truncated: true })
    expect(await runSearch('s1', 'repo', 'en', search))
      .toEqual({ phase: 'results', hits: [NAME_HIT], truncated: true })
  })

  test('a query that matched nothing is a RESULT, not a failure', async () => {
    const { search } = answering({ ok: true, hits: [], truncated: false })
    expect(await runSearch('s1', 'zzz', 'en', search))
      .toEqual({ phase: 'results', hits: [], truncated: false })
  })

  test('a refusal the server worded lands verbatim', async () => {
    const { search } = answering({
      ok: false, failure: 'refused', status: 404, reason: 'not-found',
      message: 'Essa sessão não tem mais um diretório.',
    })
    expect(await runSearch('s1', 'repo', 'pt', search))
      .toEqual({ phase: 'failed', text: 'Essa sessão não tem mais um diretório.' })
  })

  test('a gate refusal carries no sentence, so the UI supplies one in the reader’s language', async () => {
    const gate: SearchResult = {
      ok: false, failure: 'refused', status: 403, reason: 'editor_disabled',
    }
    const en = await runSearch('s1', 'repo', 'en', answering(gate).search)
    const pt = await runSearch('s1', 'repo', 'pt', answering(gate).search)
    expect(en).toEqual({ phase: 'failed', text: expect.stringContaining('Settings → Sessions') })
    expect(pt).toEqual({ phase: 'failed', text: expect.stringContaining('Configurações → Sessões') })
  })

  test('an unreachable server is SAID — never an empty result list', async () => {
    const { search } = answering({ ok: false, failure: 'unreachable', cause: 'timeout' })
    const state = await runSearch('s1', 'repo', 'en', search)
    expect(state.phase).toBe('failed')
    expect(state.phase === 'failed' && state.text.length > 0).toBe(true)
  })

  test('the reader’s language travels with the request', async () => {
    const { calls, search } = answering({ ok: true, hits: [], truncated: false })
    await runSearch('s1', 'repo', 'pt', search)
    expect(calls).toEqual([{ q: 'repo', lang: 'pt' }])
  })
})

// --- the debounce and the stale-answer guard -----------------------------------------------------

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** A queue with a short window and a controllable searcher — the component's wiring, minus React. */
function queued(run: (q: string) => Promise<SearchState>, delayMs = 10) {
  const seen: SearchState[] = []
  const queue = createSearchQueue(run, state => { seen.push(state) }, delayMs)
  return { queue, seen }
}

describe('createSearchQueue', () => {
  test('typing a word is ONE search, not one per keystroke', async () => {
    const calls: string[] = []
    const { queue } = queued(q => { calls.push(q); return Promise.resolve(results([])) })

    for (const q of ['re', 'rep', 'repo']) queue.push(q)
    expect(calls).toEqual([])

    await tick(30)
    expect(calls).toEqual(['repo'])
  })

  test('a pause between words costs one search each — the debounce is a window, not a lock', async () => {
    const calls: string[] = []
    const { queue } = queued(q => { calls.push(q); return Promise.resolve(results([])) })

    queue.push('one')
    await tick(30)
    queue.push('two')
    await tick(30)
    expect(calls).toEqual(['one', 'two'])
  })

  test('Enter runs the pending query NOW, and does not run it twice', async () => {
    const calls: string[] = []
    const { queue } = queued(q => { calls.push(q); return Promise.resolve(results([])) }, 1000)

    queue.push('repo')
    queue.flush()
    expect(calls).toEqual(['repo'])

    queue.flush() // nothing pending — a second press must not repeat the search
    await tick(20)
    expect(calls).toEqual(['repo'])
  })

  test('a SLOW answer cannot overwrite the fresher one that overtook it', async () => {
    const slow = results([NAME_HIT])
    const fast = results([CONTENT_HIT])
    const { queue, seen } = queued(q => (
      q === 'slow' ? tick(40).then(() => slow) : Promise.resolve(fast)
    ), 1)

    queue.push('slow')
    await tick(10)      // the slow request has started and is still in flight
    queue.push('fast')
    await tick(80)      // long enough for BOTH to have resolved

    expect(seen).toEqual([fast])
  })

  test('cancel forgets a pending query', async () => {
    const calls: string[] = []
    const { queue } = queued(q => { calls.push(q); return Promise.resolve(results([])) })
    queue.push('repo')
    queue.cancel()
    await tick(30)
    expect(calls).toEqual([])
  })

  test('cancel also invalidates an answer already in flight — an unmounted view emits nothing', async () => {
    const { queue, seen } = queued(() => tick(20).then(() => results([NAME_HIT])), 1)
    queue.push('repo')
    await tick(10)   // in flight
    queue.cancel()
    await tick(40)
    expect(seen).toEqual([])
  })
})
