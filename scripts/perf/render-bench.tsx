/**
 * scripts/perf/render-bench.tsx — what rendering a long conversation's bubbles costs (PERF.1 step 3):
 * the chat's turns, read by the server's own reader from a synthetic transcript, rendered with the
 * web's ChatBubble (renderToString: the React work, without layout or paint, so a FLOOR on the first
 * paint), all 400 against the first window.
 *
 *   bun scripts/perf/render-bench.tsx <transcript.jsonl>
 */
// The bubbles read a few browser globals while rendering; a server render needs only stubs of them.
const g = globalThis as Record<string, unknown>
const store = new Map<string, string>()
g.window ??= globalThis
g.localStorage ??= { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) }
g.sessionStorage ??= g.localStorage
g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
g.document ??= { documentElement: { lang: 'en', style: { setProperty() {} }, dataset: {} }, addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' }
g.navigator ??= { language: 'en' }
const { renderToString } = await import('react-dom/server')
const { readChatWindow } = await import('../../packages/server/server/sessions/chat-tail')
const { ChatBubble } = await import('../../packages/web/src/components/sessions/ChatBubble')
const { INITIAL_TURNS } = await import('../../packages/web/src/lib/turnWindow')

const path = process.argv[2]
if (!path) { console.error('usage: render-bench.tsx <transcript.jsonl>'); process.exit(2) }
const { turns } = await readChatWindow(path, 400)
const render = (n: number) => {
  const xs: number[] = []
  for (let k = 0; k < 7; k++) {
    const t = performance.now()
    renderToString(<div>{turns.slice(-n).map((turn, i) => <ChatBubble key={i} turn={turn} lang="en" harness="claude" />)}</div>)
    xs.push(performance.now() - t)
  }
  xs.sort((a, b) => a - b)
  return Math.round(xs[3]!)
}
console.log(JSON.stringify({ turns: turns.length, all: render(turns.length), window: render(Math.min(INITIAL_TURNS, turns.length)), windowTurns: INITIAL_TURNS }))
