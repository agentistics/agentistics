import { test, expect } from 'bun:test'
import { centralManifest, centralHtml, CENTRAL_APP_NAME, CENTRAL_THEME_COLOR, CENTRAL_HTML_ATTR } from './central-branding'

// The manifest vite-plugin-pwa emits, and the built shell (source index.html + the tags Vite
// injects). Kept verbatim so a change to either is caught here rather than in the dock.
const MANIFEST = JSON.stringify({
  name: 'Agentistics',
  short_name: 'Agentistics',
  description: 'Local analytics dashboard for AI coding assistants',
  start_url: '/',
  display: 'standalone',
  background_color: '#0f0f12',
  theme_color: '#D97706',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
  ],
})

const HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <link rel="icon" type="image/x-icon" href="/favicon.ico" />
    <meta name="apple-mobile-web-app-title" content="Agentistics" />
    <meta name="theme-color" content="#D97706" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <title>Agentistics</title>
    <script type="module" crossorigin src="/assets/index-a1b2c3.js"></script>
    <link rel="manifest" href="/manifest.webmanifest">
  </head>
  <body><div id="root"></div></body>
</html>`

test('centralManifest renames the app and swaps every icon', () => {
  const m = JSON.parse(centralManifest(MANIFEST))
  expect(m.name).toBe(CENTRAL_APP_NAME)
  expect(m.short_name).toBe(CENTRAL_APP_NAME)
  expect(m.theme_color).toBe(CENTRAL_THEME_COLOR)
  expect(m.icons.map((i: { src: string }) => i.src)).toEqual([
    '/icons/icon-central-192.png',
    '/icons/icon-central-512.png',
  ])
  // Everything else survives — sizes/purpose drive how the OS renders the installed icon.
  expect(m.icons[1]).toMatchObject({ sizes: '512x512', type: 'image/png', purpose: 'any maskable' })
  expect(m.start_url).toBe('/')
  expect(m.display).toBe('standalone')
  expect(m.background_color).toBe('#0f0f12')
})

test('centralHtml rewrites title, iOS name, touch icon, favicon and theme colour', () => {
  const html = centralHtml(HTML)
  expect(html).toContain(`<title>${CENTRAL_APP_NAME}</title>`)
  expect(html).toContain(`<meta name="apple-mobile-web-app-title" content="${CENTRAL_APP_NAME}" />`)
  expect(html).toContain(`<meta name="theme-color" content="${CENTRAL_THEME_COLOR}" />`)
  expect(html).toContain('href="/apple-touch-icon-central.png"')
  expect(html).toContain('href="/favicon-central.ico"')
  // No machine-branded reference may survive, or the dock shows the amber icon anyway.
  expect(html).not.toContain('"/favicon.ico"')
  expect(html).not.toContain('"/apple-touch-icon.png"')
  expect(html).not.toContain('#D97706')
})

test('centralHtml leaves the bundle and the manifest link alone', () => {
  const html = centralHtml(HTML)
  expect(html).toContain('src="/assets/index-a1b2c3.js"')
  expect(html).toContain('href="/manifest.webmanifest"')
})

test('a cosmetic rewrite can never break the shell or the manifest', () => {
  // Malformed / unexpected input is returned untouched rather than throwing or emitting junk.
  expect(centralManifest('not json at all')).toBe('not json at all')
  expect(centralManifest('null')).toBe('null')
  expect(centralHtml('<html><body>no head tags</body></html>'))
    .toBe('<html><body>no head tags</body></html>')
  // An icon entry with no usable src is passed through instead of being dropped.
  const odd = JSON.parse(centralManifest(JSON.stringify({ icons: [{ sizes: '1x1' }, null] })))
  expect(odd.icons).toEqual([{ sizes: '1x1' }, null])
})

test('centralManifest is idempotent — re-serving an already-branded manifest is stable', () => {
  const once = centralManifest(MANIFEST)
  expect(centralManifest(once)).toBe(once)
})

test('centralManifest swaps the MASKABLE icons too (what Android puts on the home screen)', () => {
  const m = JSON.parse(centralManifest(JSON.stringify({
    icons: [
      { src: '/icons/icon-192.png', purpose: 'any' },
      { src: '/icons/icon-192-maskable.png', purpose: 'maskable' },
      { src: '/icons/icon-512-maskable.png', purpose: 'maskable' },
    ],
  })))
  expect(m.icons.map((i: { src: string }) => i.src)).toEqual([
    '/icons/icon-central-192.png',
    '/icons/icon-central-192-maskable.png',
    '/icons/icon-central-512-maskable.png',
  ])
})

test('centralHtml marks the shell as a central and recolours the preboot mark only', () => {
  const shell = `<!DOCTYPE html>
<html lang="en">
  <head><meta name="theme-color" content="#FD8924" /><style>.x{color:#FD8924}</style></head>
  <body><div id="root"></div><div id="ag-preboot"><svg class="ag-preboot-mark" viewBox="1 1 54 54"><path stroke="#FD8924"/><path fill="#FD8924"/></svg></div></body>
</html>`
  const html = centralHtml(shell)
  expect(html).toContain(`<html ${CENTRAL_HTML_ATTR}="1" lang="en">`)
  const mark = html.match(/<svg class="ag-preboot-mark"[\s\S]*?<\/svg>/)![0]
  expect(mark).not.toContain('#FD8924')
  expect(mark).toContain(CENTRAL_THEME_COLOR)
  // Only the mark: an unrelated rule that happens to use the amber is not the logo.
  expect(html).toContain('.x{color:#FD8924}')
  // Idempotent: re-branding an already-branded shell adds no second attribute.
  expect(centralHtml(html).match(new RegExp(CENTRAL_HTML_ATTR, 'g'))!.length).toBe(1)
})

test('centralManifest swaps an icon whose URL carries a version query, and keeps the query', () => {
  const m = JSON.parse(centralManifest(JSON.stringify({
    icons: [{ src: '/icons/icon-192.png?v=abc12345', sizes: '192x192', type: 'image/png' }],
  })))
  expect(m.icons[0].src).toBe('/icons/icon-central-192.png?v=abc12345')
})

test('centralHtml swaps a favicon and touch icon that carry a version query', () => {
  const html = centralHtml('<link rel="icon" href="/favicon.ico?v=1"><link rel="apple-touch-icon" href="/apple-touch-icon.png?v=2">')
  expect(html).toContain('href="/favicon-central.ico?v=1"')
  expect(html).toContain('href="/apple-touch-icon-central.png?v=2"')
})
